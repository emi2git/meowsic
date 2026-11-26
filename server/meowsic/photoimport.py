"""Add music → From Photos: the photos in one Apple Photos album (default "SHEET") that are not in the
library yet become sheets.

  GET  /api/photos/album?name=SHEET         the album: every photo, and which are already in the library
  POST /api/photos/sessions {name, ids?}    fetch the new photos (originals; iCloud ones are downloaded) and
                                            look at each page (title, page dots, crop box, layout) in the background
  GET  /api/photos/sessions/{sid}           progress, the pages, and the proposed songs
  GET  /api/photos/sessions/{sid}/pages/{id}/image?w=   the fetched photo (w = a small JPEG)
  POST /api/photos/sessions/{sid}/import {songs: [{title, pages: [{id, crop}]}], tags?}
                                            → one sheet per song, pages in that order, crops kept undoable
  POST /api/photos/imports/{iid}/undo       the sheets made by that import are removed; the photos are new again
  GET  /api/photos/imports                  recent imports (to undo after a reload)
  POST /api/photos/skip {session?, ids}     "not a sheet": never offered again (until restored)
  POST /api/photos/unskip {ids}             restore skipped photos
  GET  /api/photos/skipped?name=            the skipped photos of that album

Handled photos are remembered (table photo_handled, by Photos id and sha256): one that was added or skipped is
never offered again, even after its sheet is deleted or emptied from the Trash. Undo of an import forgets its
"added" rows. photo_check keeps each album's last check (when the last whole import's session looked): after
that, only photos added to Photos later ("added", else the capture date) are offered. No last check yet: every
photo that is not in the library.

Photos is only read, never changed (no album is made or touched): migrate/photos_album.py (osxphotos, in
migrate/.venv) lists and copies. MEOWSIC_FAKE_PHOTOS=<folder> uses <folder>/<album>/ instead (tests):
image files, dates from <album>/dates.json {file: ms} or the file's modified time.

A photo is "in the library" when a page has its Photos id (sheet_page.photo_id, set here), when a page has
the same image (sha256, like every upload), or when migrate.py imported it from Meowsic 1 (its manifest).
"""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from . import cleanstate as cs
from . import grouping, titles, trim
from .db import folder_path, get_item, log_event, now_ms, quiet, uid, write_item
from .autofill import fill_from_library, log_fill
from .undolog import record_undo
from .items import IMAGE_EXT, cfg, conn

router = APIRouter(prefix='/api')
REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / 'migrate' / 'photos_album.py'
DEFAULT_ALBUM = 'SHEET'
_lock = threading.Lock()
_sessions: dict[str, dict] = {}   # sid -> state (also saved as work/photoimport/<sid>/session.json)
KEEP_SESSIONS = 4


# ---------- schema (columns added after the first schema) ----------

def ensure_schema(c):
    cols = [r[1] for r in c.execute('PRAGMA table_info(sheet_page)')]
    if cols and 'photo_id' not in cols:  # the Apple Photos id of the photo a page came from
        c.execute('ALTER TABLE sheet_page ADD COLUMN photo_id TEXT')
    c.execute('CREATE INDEX IF NOT EXISTS sheet_page_photo ON sheet_page(photo_id)')
    c.execute('CREATE INDEX IF NOT EXISTS sheet_page_sha ON sheet_page(sha256)')
    c.execute("""CREATE TABLE IF NOT EXISTS photo_handled (  -- photos added or skipped: never offered again
        photo_id TEXT PRIMARY KEY, sha256 TEXT, album TEXT, state TEXT NOT NULL, at INTEGER NOT NULL,
        item_id TEXT, import_id TEXT, filename TEXT, date INTEGER)""")
    c.execute('CREATE INDEX IF NOT EXISTS photo_handled_sha ON photo_handled(sha256)')
    c.execute('CREATE TABLE IF NOT EXISTS photo_check (album TEXT PRIMARY KEY, at INTEGER NOT NULL)')  # last check per album (lower case)
    c.execute("""CREATE TABLE IF NOT EXISTS photo_import (  -- every From Photos import; undo sets undone_at (rows stay)
        id TEXT PRIMARY KEY, album TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL, undone_at INTEGER)""")
    c.commit()


# ---------- the Photos source ----------

def _helper_python() -> Path | None:
    for p in (os.environ.get('MEOWSIC_PHOTOS_PY'), REPO / 'migrate' / '.venv' / 'bin' / 'python',
              Path.home() / 'git' / 'apps' / 'meowsic' / 'migrate' / '.venv' / 'bin' / 'python'):
        if p and Path(p).exists(): return Path(p)
    return None


def _run_helper(args, timeout):
    py = _helper_python()
    if not py or not HELPER.is_file():
        return {'error': 'setup', 'message': 'Reading Photos is not set up on this Mac: migrate/.venv with osxphotos is missing '
                '(cd migrate && python3 -m venv .venv && .venv/bin/pip install osxphotos pillow).'}
    try:
        r = subprocess.run([str(py), str(HELPER), *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'error': 'failed', 'message': 'Photos took too long to answer. Try again.'}
    try: return json.loads(r.stdout)
    except ValueError: return {'error': 'failed', 'message': (r.stderr or 'photos_album.py failed').strip().splitlines()[-1][:300]}


def _fake_dir(name):
    root = Path(os.environ['MEOWSIC_FAKE_PHOTOS'])
    for d in sorted(root.iterdir()) if root.is_dir() else []:
        if d.is_dir() and d.name.strip().lower() == name.strip().lower(): return d
    return None


def _sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def list_album(cf, name) -> dict:
    """{album, photos: [{id, date, filename, w, h, local, sha256}]} or {error, message, albums?}."""
    if os.environ.get('MEOWSIC_FAKE_PHOTOS'):
        d = _fake_dir(name)
        root = Path(os.environ['MEOWSIC_FAKE_PHOTOS'])
        if not d: return {'error': 'no-album', 'message': f'There is no album “{name}” in Photos.', 'albums': sorted(x.name for x in root.iterdir() if x.is_dir()) if root.is_dir() else []}
        try: dates = json.loads((d / 'dates.json').read_text())
        except Exception: dates = {}
        from PIL import Image
        photos = []
        for f in sorted(d.iterdir()):
            if f.suffix.lower() not in IMAGE_EXT: continue
            try:
                with Image.open(f) as im: w, h = im.size
            except Exception: w = h = 0
            photos.append({'id': 'fake-' + f.stem, 'date': int(dates.get(f.name) or f.stat().st_mtime * 1000), 'filename': f.name,
                           'added': int(f.stat().st_mtime * 1000),
                           'w': w, 'h': h, 'local': True, 'sha256': _sha(f)})
        return {'album': d.name, 'photos': photos}
    cf.work_dir.mkdir(parents=True, exist_ok=True)
    return _run_helper(['list', name, str(cf.work_dir / 'photos-sha.json')], 300)


def fetch(cf, name, ids, out: Path) -> dict:
    """{id: {file, sha256, quality, note} | {error}}: copies into out/."""
    if os.environ.get('MEOWSIC_FAKE_PHOTOS'):
        d = _fake_dir(name)
        res = {}
        for k, i in enumerate(ids):
            f = next((x for x in (d.iterdir() if d else []) if 'fake-' + x.stem == i and x.suffix.lower() in IMAGE_EXT), None)
            if not f: res[i] = {'error': 'This photo is not in Photos any more'}; continue
            dst = out / f'{k + 1:04d}{".jpg" if f.suffix.lower() == ".jpeg" else f.suffix.lower()}'
            shutil.copyfile(f, dst)
            res[i] = {'file': dst.name, 'sha256': _sha(f), 'quality': 'original', 'note': ''}
        return res
    return _run_helper(['fetch', str(out), *ids], 120 + 60 * len(ids))


def _migrated(cf) -> dict[str, str]:
    """Photos id -> sha256 of the page migrate.py made from it (Meowsic 1 sheets)."""
    try: m = json.loads((cf.data / 'migrate' / 'manifest.json').read_text())
    except Exception: return {}
    out = {}
    for ent in m.values():
        shas = iter(ent.get('shas') or [])
        for pl in ent.get('plan') or []:
            if pl.get('quality'):
                s = next(shas, None)
                if s: out[pl['asset'].split('/')[0]] = s
    return out


def in_library(c, cf, photos) -> dict[str, dict]:
    """id -> {itemId, title, deleted, how} for the photos that are already pages somewhere."""
    def where(col, val):
        return c.execute(f'SELECT p.item_id, i.title, i.deleted_at FROM sheet_page p JOIN item i ON i.id=p.item_id WHERE p.{col}=? LIMIT 1', (val,)).fetchone()
    mig, out = _migrated(cf), {}
    for p in photos:
        r, how = where('photo_id', p['id']), 'photo'
        if not r and p.get('sha256'): r, how = where('sha256', p['sha256']), 'same image'
        if not r and p['id'] in mig: r, how = where('sha256', mig[p['id']]), 'from Meowsic 1'
        if r: out[p['id']] = {'itemId': r[0], 'title': r[1], 'deleted': r[2] is not None, 'how': how}
    return out


def handled(c, photos) -> dict[str, dict]:
    """id -> {state: added | skipped, at, itemId, filename} for photos added or skipped before (by id, else same sha)."""
    out = {}
    for p in photos:
        r = c.execute('SELECT state, at, item_id, filename FROM photo_handled WHERE photo_id=?', (p['id'],)).fetchone()
        if not r and p.get('sha256'):
            r = c.execute('SELECT state, at, item_id, filename FROM photo_handled WHERE sha256=? LIMIT 1', (p['sha256'],)).fetchone()
        if r: out[p['id']] = {'state': r[0], 'at': r[1], 'itemId': r[2], 'filename': r[3]}
    return out


def last_check(c, album) -> int | None:
    r = c.execute('SELECT at FROM photo_check WHERE album=?', (album.lower(),)).fetchone()
    return r[0] if r else None


def _mark(c, cf, res):
    """The album's photos in capture order, each marked: inLibrary, handled, old, new (= offered). → (photos, lastCheck)"""
    photos = sorted((p for p in res['photos'] if not p.get('ismovie')), key=lambda p: (p.get('date') or 0, p.get('filename') or ''))
    have, done, lc = in_library(c, cf, photos), handled(c, photos), last_check(c, res['album'])
    for p in photos:
        h = done.get(p['id'])
        back = bool(h and h['state'] == 'restored')  # skipped, then restored: offered again however old
        p['inLibrary'], p['handled'] = have.get(p['id']), None if back else h
        p['old'] = not back and bool(lc and (p.get('added') or p.get('date') or 0) <= lc)  # in the album before the last check
        p['new'] = not p['inLibrary'] and not p['handled'] and not p['old']
    return photos, lc


@router.get('/photos/album')
def album(name: str = '', c=Depends(conn), cf=Depends(cfg)):
    name = (name or _setting(c, 'photosAlbum') or DEFAULT_ALBUM).strip() or DEFAULT_ALBUM
    res = list_album(cf, name)
    if 'error' in res: return {'name': name, **res, 'photos': []}
    photos, lc = _mark(c, cf, res)
    last = _last_import(c)
    return {'name': name, 'album': res['album'], 'photos': photos, 'new': sum(1 for p in photos if p['new']),
            'skipped': sum(1 for p in photos if (p['handled'] or {}).get('state') == 'skipped'), 'lastCheck': lc,
            'fake': bool(os.environ.get('MEOWSIC_FAKE_PHOTOS')), 'lastImport': last}


def _setting(c, key):
    r = c.execute('SELECT value FROM setting WHERE key=?', (key,)).fetchone()
    try: return json.loads(r[0]) if r else None
    except ValueError: return None


# ---------- sessions: fetch + look at each page (background) ----------

def _sdir(cf, sid) -> Path:
    if not sid.startswith('pi-') or '/' in sid or '..' in sid: raise HTTPException(404, 'No such import')
    return cf.work_dir / 'photoimport' / sid


def _save(cf, st):
    d = _sdir(cf, st['id'])
    tmp = d / 'session.tmp'
    tmp.write_text(json.dumps(st, ensure_ascii=False))
    tmp.replace(d / 'session.json')


def _get(cf, sid) -> dict:
    with _lock:
        st = _sessions.get(sid)
    if st: return st
    try: st = json.loads((_sdir(cf, sid) / 'session.json').read_text())
    except (OSError, ValueError): raise HTTPException(404, 'This import is gone — look at the album again')
    if st.get('status') in ('fetching', 'reading'): st['status'] = 'failed'; st['error'] = 'The Mac restarted while reading the photos — look again'
    with _lock: _sessions[sid] = st
    return st


def _prune(cf):
    root = cf.work_dir / 'photoimport'
    olds = sorted((d for d in root.iterdir() if d.is_dir() and d.name.startswith('pi-')), key=lambda d: d.stat().st_mtime)[:-KEEP_SESSIONS] if root.is_dir() else []
    for d in olds:
        shutil.rmtree(d, ignore_errors=True)
        with _lock: _sessions.pop(d.name, None)
    if olds:  # their pages' cached Vision lines go too
        pre = tuple(f'work/photoimport/{d.name}/' for d in olds)
        with titles._lock:
            data = titles._load(cf)
            keep = {k: v for k, v in data.items() if not k.startswith(pre)}
            if len(keep) != len(data): titles._save(cf, keep)


def _analyze(cf, st, words):
    d = _sdir(cf, st['id'])
    try:
        st['status'] = 'fetching'
        got = fetch(cf, st['album'], [p['id'] for p in st['pages']], d)
        if 'error' in got and isinstance(got.get('error'), str): raise RuntimeError(got.get('message') or got['error'])
        c = sqlite_connect(cf)
        try:
            for p in st['pages']:
                r = got.get(p['id']) or {'error': 'not fetched'}
                p.update({k: r.get(k) for k in ('file', 'sha256', 'quality', 'note', 'error') if r.get(k) is not None})
                if p.get('sha256') and not p.get('error'):
                    dup = c.execute('SELECT p.item_id, i.title FROM sheet_page p JOIN item i ON i.id=p.item_id WHERE p.sha256=? LIMIT 1', (p['sha256'],)).fetchone()
                    if dup: p['dup'] = {'itemId': dup[0], 'title': dup[1]}
        finally: c.close()
        st['status'] = 'reading'
        _save(cf, st)
        vision = titles.available()
        for p in st['pages']:
            if p.get('error'): st['done'] += 1; continue
            f = d / p['file']
            try: a = trim.analyze(f)
            except Exception: a = {'trim': None, 'dots': None, 'box': None}
            p['dots'], p['box'], p['trim'] = a.get('dots'), a.get('box'), a.get('trim')
            p['layout'] = grouping.layout(f)
            p['title'] = {'title': '', 'confidence': 0.0}
            if vision:
                try:
                    t = titles.detect(cf, f, None, words)
                    p['title'] = {k: t.get(k) for k in ('title', 'confidence', 'alts') if k in t}
                    lines = titles.page_lines(cf, f)
                    p['staff'] = lines.get('staff')
                except Exception as e:
                    p['title'] = {'title': '', 'confidence': 0.0, 'error': str(e)[:200]}
            st['done'] += 1
            if st['done'] % 3 == 0: _save(cf, st)
        ok = [p for p in st['pages'] if not p.get('error')]
        prop = grouping.propose(ok)
        for p, r in zip(ok, prop): p['start'], p['score'], p['sure'], p['why'] = r['start'], r['score'], r['sure'], r['why']
        st['status'] = 'ready'
    except Exception as e:
        st['status'], st['error'] = 'failed', str(e)[:400]
    st['readyAt'] = now_ms()
    _save(cf, st)


def sqlite_connect(cf):
    from .db import connect
    return connect(cf)


@router.post('/photos/sessions', status_code=201)
def start(request: Request, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    """{name?, ids?} → look at the album's new photos (or just `ids`, in that order)."""
    name = (body.get('name') or _setting(c, 'photosAlbum') or DEFAULT_ALBUM).strip() or DEFAULT_ALBUM
    res = list_album(cf, name)
    if 'error' in res: raise HTTPException(400, res.get('message') or res['error'])
    photos, _ = _mark(c, cf, res)
    if body.get('ids'):  # just these, in this order: any that is not in the library
        by = {p['id']: p for p in photos}
        photos = [by[i] for i in body['ids'] if i in by and not by[i]['inLibrary']]
    else: photos = [p for p in photos if p['new']]
    if not photos: raise HTTPException(409, 'Nothing new in this album — every photo was added or skipped already')
    sid = 'pi-' + uid('x')[2:] + str(int(time.time()))[-4:]
    d = cf.work_dir / 'photoimport' / sid
    d.mkdir(parents=True)
    st = {'id': sid, 'album': res['album'], 'status': 'queued', 'done': 0, 'total': len(photos), 'at': now_ms(), 'error': None,
          'whole': not body.get('ids'),  # every new photo (not a chosen few): its import moves the album's last check
          'pages': [{'id': p['id'], 'date': p.get('date'), 'added': p.get('added'), 'filename': p.get('filename'), 'w': p.get('w'), 'h': p.get('h')} for p in photos],
          'imports': []}
    with _lock: _sessions[sid] = st
    _save(cf, st)
    _prune(cf)
    words = titles.library_words(c)
    threading.Thread(target=_analyze, args=(cf, st, words), daemon=True).start()
    return _public(st)


def _public(st):
    return {k: st[k] for k in ('id', 'album', 'status', 'done', 'total', 'at', 'error', 'pages', 'imports')}


@router.get('/photos/sessions/{sid}')
def session(sid: str, cf=Depends(cfg)):
    return _public(_get(cf, sid))


@router.get('/photos/sessions/{sid}/pages/{pid}/image')
def page_image(sid: str, pid: str, w: int = 0, cf=Depends(cfg)):
    st = _get(cf, sid)
    p = next((x for x in st['pages'] if x['id'] == pid), None)
    if not p or not p.get('file'): raise HTTPException(404, 'Not fetched')
    f = _sdir(cf, sid) / p['file']
    if not f.is_file(): raise HTTPException(404, 'No such file')
    if not w: return FileResponse(f, headers={'Cache-Control': 'max-age=3600'})
    from PIL import Image, ImageOps
    w = max(60, min(int(w), 1000))
    t = f.with_name(f'{f.stem}.w{w}.jpg')
    if not t.is_file():
        im = ImageOps.exif_transpose(Image.open(f)).convert('RGB')
        im.thumbnail((w, w * 3)); im.save(t, 'JPEG', quality=80)
    return FileResponse(t, media_type='image/jpeg', headers={'Cache-Control': 'max-age=3600'})


# ---------- import + undo ----------

def _box(b):
    if not b: return None
    try: b = {k: float(b.get(k, d)) for k, d in (('top', 0), ('bottom', 1), ('left', 0), ('right', 1))}
    except (TypeError, ValueError, AttributeError): raise HTTPException(400, 'Bad crop')
    if b['top'] <= 0.001 and b['bottom'] >= 0.999 and b['left'] <= 0.001 and b['right'] >= 0.999: return None
    if not (0 <= b['top'] < b['bottom'] <= 1 and 0 <= b['left'] < b['right'] <= 1) or b['bottom'] - b['top'] < 0.2 or b['right'] - b['left'] < 0.2:
        raise HTTPException(400, 'Bad crop')
    return b


@router.post('/photos/sessions/{sid}/import')
def do_import(sid: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{songs: [{title, pages: [{id, crop?}]}], tags?: [..]} → one new sheet per song."""
    from .cleanup import trim_page
    st = _get(cf, sid)
    if st['status'] != 'ready': raise HTTPException(409, 'The photos are not read yet')
    by = {p['id']: p for p in st['pages']}
    songs = body.get('songs') or []
    if not songs or not all(isinstance(s, dict) and s.get('pages') for s in songs): raise HTTPException(400, 'Nothing to add')
    seen = set()
    for s in songs:
        for pg in s['pages']:
            p = by.get(pg.get('id'))
            if not p or not p.get('file') or p.get('error'): raise HTTPException(400, 'A photo is not available')
            if p['id'] in seen: raise HTTPException(400, 'A photo is in two songs')
            seen.add(p['id'])
    have = in_library(c, cf, [by[i] for i in seen])
    if have: raise HTTPException(409, f'{len(have)} of these photos are in the library already — look at the album again')
    tags = [t for t in (body.get('tags') or []) if isinstance(t, str) and t.strip()]
    d0 = _sdir(cf, sid)
    t = now_ms()
    made, fills = [], []
    for k, s in enumerate(songs):
        pages = [by[pg['id']] for pg in s['pages']]
        title = str(s.get('title') or '').strip()[:200] or 'Untitled'
        dates = [p['date'] for p in pages if p.get('date')]
        it = {'id': uid('s'), 'kind': 'sheet', 'title': title, 'artist': str(s.get('artist') or '').strip()[:200], 'tags': tags,
              'source': 'photos', 'pages': 0, 'createdAt': t + k, 'updatedAt': t, 'originAt': min(dates) if dates else t}
        fills.append((it, fill_from_library(c, it)))
        write_item(c, it, new=True)
        it = get_item(c, it['id'])
        d = folder_path(cf, it['folder'])
        d.mkdir(parents=True, exist_ok=True)
        for n, p in enumerate(pages, 1):
            ext = Path(p['file']).suffix.lower()
            rel = f'{it["folder"]} {n}{ext}'
            shutil.copyfile(d0 / p['file'], d / rel)
            c.execute('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at, photo_id) VALUES (?,?,?,?,?,?)',
                      (it['id'], n, rel, p.get('sha256'), p.get('date'), p['id']))
        c.execute('UPDATE sheet SET pages=? WHERE item_id=?', (len(pages), it['id']))
        cropped = 0
        for n, pg in enumerate(s['pages'], 1):
            b = _box(pg.get('crop'))
            if b:  # the photo stays in .history, crop undoable (part of this import's Activities row, not a row of its own)
                with quiet(): trim_page(it['id'], n, b, c=c, cf=cf)
                cropped += 1
        made.append({'id': it['id'], 'title': title, 'pages': len(pages), 'photos': [p['id'] for p in pages], 'cropped': cropped})
    iid = uid('imp')
    for m in made:
        for pid in m['photos']:
            p = by[pid]
            c.execute('INSERT OR REPLACE INTO photo_handled(photo_id, sha256, album, state, at, item_id, import_id, filename, date) VALUES (?,?,?,?,?,?,?,?,?)',
                      (pid, p.get('sha256'), st['album'], 'added', t, m['id'], iid, p.get('filename'), p.get('date')))
    prev, check = last_check(c, st['album']), None
    if st.get('whole', True):  # the last check = when this session looked; a photo that could not be fetched stays newer
        bad = [(p.get('added') or p.get('date') or 0) - 1 for p in st['pages'] if p.get('error')]
        check = max(min([st['at'], *bad]), prev or 0)
        c.execute('INSERT OR REPLACE INTO photo_check(album, at) VALUES (?,?)', (st['album'].lower(), check))
    rec = {'id': iid, 'album': st['album'], 'session': sid, 'at': t, 'sheets': made, 'prevCheck': prev, 'check': check}
    c.execute('INSERT INTO photo_import(id, album, at, record) VALUES (?,?,?,?)', (iid, st['album'], t, json.dumps(rec, ensure_ascii=False)))
    n = len(made)
    aid = log_event(c, 'photo-import', made[0]['title'] if n == 1 else f'{n} sheets', f'From Photos (album “{st["album"]}”): '
                    + ', '.join(f'“{m["title"]}” ({m["pages"]} p)' for m in made))
    record_undo(c, aid, {'op': 'photoimport', 'import': iid, 'titles': [m['title'] for m in made]})  # Activities: Undo = this file's undo()
    log_fill(c, fills)
    st['imports'].append(iid)
    _save(cf, st)
    return {'import': rec, 'items': [get_item(c, m['id']) for m in made]}


def _last_import(c):
    r = c.execute('SELECT record FROM photo_import WHERE undone_at IS NULL ORDER BY at DESC LIMIT 1').fetchone()
    return json.loads(r[0]) if r else None


@router.get('/photos/imports')
def imports(c=Depends(conn)):
    return [{**json.loads(r[0]), 'undoneAt': r[1]} for r in c.execute('SELECT record, undone_at FROM photo_import ORDER BY at DESC LIMIT 20')]


@router.post('/photos/imports/{iid}/undo')
def undo(iid: str, c=Depends(conn), cf=Depends(cfg)):
    """Remove the sheets that import made (for good: they were just made) — the photos count as new again."""
    r = c.execute('SELECT record, undone_at FROM photo_import WHERE id=?', (iid,)).fetchone()
    if not r: raise HTTPException(404, 'No such import')
    if r[1]: raise HTTPException(409, 'This import was undone already')
    rec = json.loads(r[0])
    for m in rec['sheets']:
        it = get_item(c, m['id'])
        if it and (it['pages'] != m['pages'] or it['kind'] != 'sheet'):
            raise HTTPException(409, f'“{it["title"]}” has changed since (pages added, split or joined) — cannot undo')
    gone = []
    for m in rec['sheets']:
        row = c.execute('DELETE FROM item WHERE id=? RETURNING folder', (m['id'],)).fetchone()
        if not row: continue
        gone.append(m['id'])
        try: d = folder_path(cf, row[0]) if row[0] else None
        except ValueError: d = None
        if d and d.is_dir() and d.resolve().parent == cf.items_dir.resolve(): shutil.rmtree(d)
    cs.forget_items(c, *gone)
    c.execute("UPDATE photo_handled SET state='restored', item_id=NULL, import_id=NULL WHERE import_id=? AND state='added'", (iid,))
    if rec.get('check') and last_check(c, rec['album']) == rec['check']:  # the last check goes back too
        if rec.get('prevCheck'): c.execute('UPDATE photo_check SET at=? WHERE album=?', (rec['prevCheck'], rec['album'].lower()))
        else: c.execute('DELETE FROM photo_check WHERE album=?', (rec['album'].lower(),))
    c.execute('UPDATE photo_import SET undone_at=? WHERE id=?', (now_ms(), iid))
    log_event(c, 'photo-unimport', f'{len(gone)} sheets' if len(gone) != 1 else rec['sheets'][0]['title'],
              f'Undo From Photos: removed {len(gone)} sheet{"s" if len(gone) != 1 else ""}; the photos are new again')
    return {'removed': gone, 'session': rec.get('session')}


# ---------- skipped photos ("not a sheet") ----------

@router.post('/photos/skip')
def skip(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{session?, album?, ids} → these photos are never offered again (Show skipped → Restore brings them back)."""
    ids = [i for i in (body.get('ids') or []) if isinstance(i, str) and i]
    if not ids: raise HTTPException(400, 'No photos')
    st = _get(cf, body['session']) if body.get('session') else None
    pages = {p['id']: p for p in st['pages']} if st else {}
    album = (st or {}).get('album') or str(body.get('album') or '')
    t = now_ms()
    for i in ids:
        if c.execute("SELECT 1 FROM photo_handled WHERE photo_id=? AND state='added'", (i,)).fetchone(): continue
        p = pages.get(i, {})
        c.execute('INSERT OR REPLACE INTO photo_handled(photo_id, sha256, album, state, at, filename, date) VALUES (?,?,?,?,?,?,?)',
                  (i, p.get('sha256'), album, 'skipped', t, p.get('filename'), p.get('date')))
    c.commit()
    return {'skipped': ids}


@router.post('/photos/unskip')
def unskip(body: dict = Body(...), c=Depends(conn)):
    """{ids} → offered again (also when they are older than the last check)."""
    ids = [i for i in (body.get('ids') or []) if isinstance(i, str)]
    for i in ids: c.execute("UPDATE photo_handled SET state='restored', at=? WHERE photo_id=? AND state='skipped'", (now_ms(), i))
    c.commit()
    return {'restored': ids}


@router.get('/photos/skipped')
def skipped(name: str = '', c=Depends(conn)):
    q, args = "SELECT photo_id, filename, date, at, album FROM photo_handled WHERE state='skipped'", []
    if name: q += ' AND lower(album)=?'; args.append(name.strip().lower())
    return [{'id': r[0], 'filename': r[1], 'date': r[2], 'at': r[3], 'album': r[4]} for r in c.execute(q + ' ORDER BY date, filename', args)]
