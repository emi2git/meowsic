"""Clean-up: find sheet pages with screen junk (trim.py) and songs with odd titles; trim pages with undo.

Scan results are cached in work/cleanup.json (by file and its modified time), so only new or changed
pages are looked at again. Every trim keeps the page as it was in items/<folder>/.history/, so undo
can put it back, all the way to the original.
"""
import json
import re
import shutil
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from . import trim
from .db import folder_path, get_item, now_ms
from .items import cfg, conn, must_item, update_item

router = APIRouter(prefix='/api')
_lock = threading.Lock()
_scan = {'running': False, 'done': 0, 'total': 0, 'started': 0}


def _cache_file(cf) -> Path:
    d = cf.data / 'work'
    d.mkdir(exist_ok=True)
    return d / 'cleanup.json'


def _load(cf) -> dict:
    try: return json.loads(_cache_file(cf).read_text())
    except Exception: return {'pages': {}, 'ok': []}


def _save(cf, data):
    tmp = _cache_file(cf).with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(_cache_file(cf))


def _pages(c, books=True):
    """(item_id, page, file, folder) of every live sheet page; books=False leaves book pages out
    (books are scanned songbooks: they never need trimming, so the scan does not look at them)."""
    return c.execute('SELECT p.item_id, p.page, p.file, i.folder FROM sheet_page p JOIN item i ON i.id = p.item_id '
                     'WHERE i.deleted_at IS NULL AND i.folder IS NOT NULL'
                     + ('' if books else ' AND NOT COALESCE((SELECT book FROM sheet WHERE item_id = i.id), 0)')
                     + ' ORDER BY i.created_at DESC, p.page').fetchall()


CACHE_V = 3


def _snaps(d: Path, page) -> list[Path]:
    """Earlier versions of a page kept by trims, oldest first (the first is the original photo)."""
    h = d / '.history'
    if not h.is_dir(): return []
    return sorted((p for p in h.glob(f'p{page}-*') if p.suffix != '.json'), key=lambda p: int(p.stem.split('-')[1]))


def _analyze(d: Path, page, file):
    snaps = _snaps(d, page)
    try: return trim.analyze(d / file, snaps[0] if snaps else None)
    except Exception: return {'trim': None, 'dots': None}


def _run_scan(app):
    cf = app.state.cfg
    try:
        c = app.state.connect()
        try: rows = _pages(c, books=False)
        finally: c.close()
        with _lock: data = _load(cf)
        if data.get('v') != CACHE_V: data['pages'] = {}
        _scan.update(total=len(rows), done=0)
        for k, (iid, page, file, folder) in enumerate(rows):
            d = cf.items_dir / folder
            key = f'{iid}:{page}'
            try: mt = int((d / file).stat().st_mtime)
            except OSError: _scan['done'] = k + 1; continue
            old = data['pages'].get(key)
            if not old or old[0] != mt or old[2] != file:
                data['pages'][key] = [mt, _analyze(d, page, file), file]
            _scan['done'] = k + 1
            if k % 200 == 0:
                with _lock: _save(cf, {**_load(cf), 'v': CACHE_V, 'pages': data['pages']})
        with _lock: _save(cf, {**_load(cf), 'v': CACHE_V, 'pages': data['pages']})
    finally:
        _scan['running'] = False


def start_scan(app):
    if _scan['running']: return
    _scan.update(running=True, started=now_ms())
    threading.Thread(target=_run_scan, args=(app,), daemon=True).start()


# ---------- odd titles ----------
ODD = [
    (re.compile(r'^\s*$|^untitled\b', re.I), 'no title'),
    (re.compile(r'^(img|dsc|dscn|pxl|scan|screenshot|photo|image|file|document|page)[\s_-]*\d', re.I), 'camera / file name'),
    (re.compile(r'\.(jpe?g|png|heic|pdf|gif|tiff?)$', re.I), 'file extension'),
    (re.compile(r'^[\d\s_.-]+$'), 'only numbers'),
    (re.compile(r'_'), 'underscores'),
    (re.compile(r'\(\d+\)\s*$'), 'copy number'),
    (re.compile(r'[A-Za-zÀ-ỹ]\d+\s*$'), 'number stuck to a word'),
    (re.compile(r'\s(p|pg|page|trang)?\s*\d{1,2}\s*$', re.I), 'page number at the end'),
    (re.compile(r'\s{2,}|^\s|\s$'), 'extra spaces'),
]


def odd_title(title: str, kind: str):
    t = title or ''
    for rx, why in ODD:
        if rx.search(t): return why
    letters = [ch for ch in t if ch.isalpha()]
    if len(letters) < 2: return 'too short'
    if t == t.lower(): return 'all lower case'
    if len(letters) > 6 and t == t.upper(): return 'ALL CAPS'
    return None


def dot_issues(pages) -> list[str]:
    """What the reader-app page dots say about how the photos were grouped into this song."""
    seen = [p['dots'] for p in pages if p.get('dots')]
    if not seen: return []
    n = len(pages)
    counts = sorted({x['count'] for x in seen})
    out = []
    if len(counts) > 1:
        out.append(('mixed', f"page dots disagree ({' / '.join(map(str, counts))} pages) — photos of different songs mixed?"))
    elif counts[0] > n:
        missing = sorted(set(range(1, counts[0] + 1)) - {x['lit'] for x in seen if x.get('lit')})
        out.append(('incomplete', f"incomplete: {n} of {counts[0]} pages" + (f" (missing page {', '.join(map(str, missing))})" if missing and len(missing) <= 6 else '')))
    elif counts[0] < n:
        out.append(('extra', f"page dots say {counts[0]} page{'s' if counts[0] > 1 else ''}, the song has {n} — extra pages?"))
    lits = [p['dots']['lit'] if p.get('dots') else None for p in pages]
    known = [l for l in lits if l]
    if len(known) != len(set(known)):
        dup = sorted({l for l in known if known.count(l) > 1})
        out.append(('twice', f"the same page twice (dot {', '.join(map(str, dup))})"))
    elif known != sorted(known):
        out.append(('order', 'pages out of order (dots ' + ' '.join(str(l or '?') for l in lits) + ')'))
    return out


@router.get('/cleanup')
def cleanup_state(request: Request, id: str | None = None, c=Depends(conn), cf=Depends(cfg)):
    """Every sheet song with its pages and issues, plus odd titles. ?id= = just that song."""
    with _lock: data = _load(cf)
    if data.get('v') != CACHE_V: data['pages'] = {}
    ok = set(data.get('ok', []))
    # only sheets: books (scanned songbooks) are left out everywhere — songs, titles, counts and the scan
    items = {r[0]: {'id': r[0], 'title': r[1], 'kind': r[2], 'folder': r[3], 'pages': []}
             for r in c.execute("SELECT id, title, kind, folder FROM item WHERE deleted_at IS NULL AND kind = 'sheet'"
                                ' AND NOT COALESCE((SELECT book FROM sheet WHERE item_id = item.id), 0)' + (' AND id=?' if id else ''), (id,) if id else ())}
    notes = data.get('notes', {})
    missing = False
    for iid, page, file, folder in _pages(c, books=False):
        if iid not in items: continue
        key = f'{iid}:{page}'
        ent = data['pages'].get(key)
        if not ent: missing = True
        res = (ent or [0, None])[1] or {}
        steps = _steps(folder_path(cf, folder), page)
        crop = _crop_of(steps)
        skip = key in ok
        t, box = (None, None) if skip else (res.get('trim'), res.get('box'))
        if crop:  # the scan looked at the cropped file: say it on the original photo, like everything else here
            on = lambda b: {k: round(v, 4) for k, v in _compose(crop, {**FULL, **{k: b[k] for k in ('top', 'bottom')}}).items()}
            if t: t = {**t, **on(t)}
            if box: box = on(box)
        items[iid]['pages'].append({'page': page, 'file': file, 'trim': t, 'dots': res.get('dots'), 'box': box,
                                    'crop': crop, 'trims': len(_stack(steps)), 'scanned': bool(ent)})
    songs, odd = [], []
    for it in items.values():
        why = odd_title(it['title'], it['kind'])
        if why and f'title:{it["id"]}' not in ok: odd.append({'id': it['id'], 'title': it['title'], 'kind': it['kind'], 'why': why})
        issues = []
        if not it['pages']: issues.append({'kind': 'empty', 'text': 'no pages'})
        nt = sum(1 for p in it['pages'] if p['trim'])
        if nt: issues.append({'kind': 'trim', 'text': f"{nt} page{'s' if nt > 1 else ''} to trim"})
        issues += [{'kind': k, 'text': t} for k, t in dot_issues(it['pages'])]
        if why and f'title:{it["id"]}' not in ok: issues.append({'kind': 'title', 'text': f'title: {why}'})
        songs.append({'id': it['id'], 'title': it['title'], 'book': False, 'pages': it['pages'], 'issues': issues,
                      'note': (notes.get(it['id']) or {}).get('text', ''),
                      'reviewed': f'song:{it["id"]}' in ok, 'trimmed': sum(p['trims'] > 0 for p in it['pages'])})
    if missing and not _scan['running']:
        start_scan(request.app)  # pages not looked at yet
    songs.sort(key=lambda x: x['title'].lower())
    return {'scan': dict(_scan), 'songs': songs, 'titles': sorted(odd, key=lambda x: x['title'].lower())}


@router.post('/cleanup/scan')
def cleanup_scan(request: Request):
    start_scan(request.app)
    return dict(_scan)


@router.post('/cleanup/ok')
def cleanup_ok(body: dict = Body(...), cf=Depends(cfg)):
    """Mark a page ('<id>:<page>') or a title ('title:<id>') as fine; {undo: true} takes that back."""
    key = body.get('key') or ''
    with _lock:
        data = _load(cf)
        s = set(data.get('ok', []))
        (s.discard if body.get('undo') else s.add)(key)
        data['ok'] = sorted(s)
        _save(cf, data)
    return {'ok': True}


def _page_row(c, item_id, page):
    r = c.execute('SELECT file FROM sheet_page WHERE item_id=? AND page=?', (item_id, page)).fetchone()
    if not r: raise HTTPException(404, 'No such page')
    return r[0]


@router.get('/cleanup/sort')
def sort_get(cf=Depends(cfg)):
    """'Go through sheets': {id: 'keep' | 'delete'} decided so far."""
    with _lock: return {'decisions': _load(cf).get('sort', {})}


@router.post('/cleanup/sort')
def sort_set(body: dict = Body(...), cf=Depends(cfg)):
    """{id, decision: 'keep' | 'delete' | null} (null = not decided); or {clear: [ids]} after deleting."""
    with _lock:
        data = _load(cf)
        d = data.setdefault('sort', {})
        for i in body.get('clear') or []: d.pop(i, None)
        if body.get('id'):
            if body.get('decision') in ('keep', 'delete'): d[body['id']] = body['decision']
            else: d.pop(body['id'], None)
        _save(cf, data)
        return {'decisions': d}


@router.get('/cleanup/notes')
def notes_get(c=Depends(conn), cf=Depends(cfg)):
    """Notes for Claude, newest first: [{id, title, text, at}] (title = the item's current title)."""
    with _lock: notes = _load(cf).get('notes', {})
    out = []
    for iid, n in notes.items():
        if not (n.get('text') or '').strip(): continue
        r = c.execute('SELECT title FROM item WHERE id=?', (iid,)).fetchone()
        out.append({'id': iid, 'title': r[0] if r else '', 'text': n['text'], 'at': n.get('at', 0)})
    return sorted(out, key=lambda x: -x['at'])


@router.post('/cleanup/notes')
def notes_set(body: dict = Body(...), cf=Depends(cfg)):
    """{id, text}: what should happen to that sheet, for Claude to do later. Empty text removes it."""
    iid, text = body.get('id'), (body.get('text') or '').strip()
    if not iid: raise HTTPException(400, 'No id')
    with _lock:
        data = _load(cf)
        notes = data.setdefault('notes', {})
        if text: notes[iid] = {'text': text, 'at': now_ms()}
        else: notes.pop(iid, None)
        _save(cf, data)
    return {'id': iid, 'text': text}


# Suggested names (made by Claude from outside): {item_id: {title?, artist?, why, at, status, ...}} in cleanup.json.
# Accepted / dismissed ones stay (status + what changed) but are no longer shown; every rename goes to
# <data>/history/renames-cleanup.jsonl, which is only ever appended to.
def _history(cf, line: dict):
    d = cf.data / 'history'
    d.mkdir(exist_ok=True)
    with open(d / 'renames-cleanup.jsonl', 'a') as f: f.write(json.dumps(line, ensure_ascii=False) + '\n')


@router.get('/cleanup/suggest')
def suggest_get(c=Depends(conn), cf=Depends(cfg)):
    """Open suggestions: [{id, title, artist (current), suggest: {title?, artist?}, why, at}], oldest first."""
    with _lock: sug = _load(cf).get('suggest', {})
    out = []
    for iid, s in sug.items():
        if s.get('status', 'open') != 'open': continue
        r = c.execute('SELECT title, artist FROM item WHERE id=? AND deleted_at IS NULL', (iid,)).fetchone()
        if not r: continue
        out.append({'id': iid, 'title': r[0], 'artist': r[1] or '', 'why': s.get('why', ''), 'at': s.get('at', 0),
                    'suggest': {k: s[k] for k in ('title', 'artist') if s.get(k) is not None}})
    return sorted(out, key=lambda x: x['at'])


@router.post('/cleanup/suggest')
def suggest_set(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{id, title?, artist?, why}: add or replace the suggestion for that item."""
    iid = body.get('id')
    if not iid: raise HTTPException(400, 'No id')
    must_item(c, iid)
    ent = {k: str(body[k]).strip() for k in ('title', 'artist') if body.get(k) is not None}
    if not ent.get('title') and 'artist' not in ent: raise HTTPException(400, 'Suggest a title or an artist')
    ent.update(why=(body.get('why') or '').strip(), at=now_ms(), status='open')
    with _lock:
        data = _load(cf)
        data.setdefault('suggest', {})[iid] = ent
        _save(cf, data)
    return {'id': iid, **ent}


@router.post('/cleanup/suggest/{item_id}/done')
def suggest_done(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{action: 'accept', title?, artist?} renames the item (like PATCH /items/{id}); 'dismiss' keeps the name;
    'undo' takes the last accept / dismiss back (an accept is renamed back to the old name)."""
    act = body.get('action')
    if act not in ('accept', 'dismiss', 'undo'): raise HTTPException(400, 'action must be accept, dismiss or undo')
    with _lock: ent = _load(cf).get('suggest', {}).get(item_id)
    if not ent: raise HTTPException(404, 'No suggestion for that item')
    it = must_item(c, item_id)
    t = now_ms()
    if act == 'accept':
        if ent.get('status', 'open') != 'open': raise HTTPException(409, 'Already done')
        new = {k: str(body.get(k, ent.get(k))).strip() for k in ('title', 'artist') if body.get(k, ent.get(k)) is not None}
        if 'title' in new and not new['title']: new.pop('title')
        new = {k: v for k, v in new.items() if v != (it.get(k) or '')}
        old = {k: it.get(k) or '' for k in new}
        if new:
            update_item(item_id, dict(new), c, cf)
            _history(cf, {'at': t, 'id': item_id, 'old': old, 'new': new, 'why': ent.get('why', ''), 'via': 'suggest'})
        ent.update(status='accepted', doneAt=t, old=old, new=new)
    elif act == 'dismiss':
        if ent.get('status', 'open') != 'open': raise HTTPException(409, 'Already done')
        ent.update(status='dismissed', doneAt=t)
    else:
        if ent.get('status') == 'accepted' and ent.get('old'):
            update_item(item_id, dict(ent['old']), c, cf)
            _history(cf, {'at': t, 'id': item_id, 'old': ent.get('new', {}), 'new': ent['old'], 'why': 'undo', 'via': 'suggest'})
        for k in ('doneAt', 'old', 'new'): ent.pop(k, None)
        ent['status'] = 'open'
    with _lock:
        data = _load(cf)
        data.setdefault('suggest', {})[item_id] = ent
        _save(cf, data)
    return {'id': item_id, 'status': ent['status'], 'item': get_item(c, item_id)}


FULL = {'top': 0.0, 'bottom': 1.0, 'left': 0.0, 'right': 1.0}


def _steps(d: Path, page) -> list[dict]:
    """The trims of a page, oldest first: {ts, img (Path | None), meta (Path | None), crop, abs}.
    The oldest image is the original photo. Old-style trims keep an image of the page before each trim and
    a .json crop relative to that image; new trims write only a .json with the crop of the original (abs)."""
    h = d / '.history'
    if not h.is_dir(): return []
    by = {}
    for f in h.glob(f'p{page}-*'):
        try: ts = int(f.stem.split('-')[1])
        except (IndexError, ValueError): continue
        e = by.setdefault(ts, {'ts': ts, 'img': None, 'meta': None})
        e['meta' if f.suffix == '.json' else 'img'] = f
    out = []
    for ts in sorted(by):
        e = by[ts]
        try: m = json.loads(e['meta'].read_text()) if e['meta'] else {}
        except Exception: m = {}
        e['op'] = m.get('op', 'trim')
        e['crop'] = {k: float(m.get(k, FULL[k])) for k in FULL}
        e['abs'] = bool(m.get('abs'))
        out.append(e)
    return out


def _stack(steps) -> list[dict]:
    """Replay the append-only history: the active crops of the original, oldest first. Undo and
    'Original photo' are entries too ({op: 'undo'} / {op: 'reset'}): nothing in .history is ever removed."""
    st = []
    for e in steps:
        if e['op'] == 'undo':
            if st: st.pop()
        elif e['op'] == 'reset': st = []
        else: st.append(dict(e['crop']) if e['abs'] or not st else _compose(st[-1], e['crop']))
    return st


def _add(d: Path, page, steps, meta) -> Path:
    """Append one entry to the page's history (always a new file)."""
    h = d / '.history'
    h.mkdir(exist_ok=True)
    ts = max([now_ms()] + [e['ts'] + 1 for e in steps])
    while any(h.glob(f'p{page}-{ts}.*')): ts += 1
    f = h / f'p{page}-{ts}.json'
    f.write_text(json.dumps(meta))
    return f


def _compose(outer, inner):
    """inner is a crop of the image that outer cut out of the original: the same box on the original."""
    o = outer or FULL
    h, w = o['bottom'] - o['top'], o['right'] - o['left']
    return {'top': o['top'] + inner['top'] * h, 'bottom': o['top'] + inner['bottom'] * h,
            'left': o['left'] + inner['left'] * w, 'right': o['left'] + inner['right'] * w}


def _crop_of(steps) -> dict | None:
    """The crop of the original photo the page shows now (None = the whole original)."""
    st = _stack(steps)
    return {k: round(v, 4) for k, v in st[-1].items()} if st else None


def _original(steps):
    return next((e['img'] for e in steps if e['img']), None)


def _restroke(c, item_id, page, a, b):
    """Notes are kept relative to the page file: it was crop a of the original, now it is crop b."""
    a, b = a or FULL, b or FULL
    if a == b: return
    def f(x, y):
        ox, oy = a['left'] + x * (a['right'] - a['left']), a['top'] + y * (a['bottom'] - a['top'])
        return [(ox - b['left']) / (b['right'] - b['left']), (oy - b['top']) / (b['bottom'] - b['top'])]
    r = c.execute('SELECT strokes FROM annotation WHERE item_id=? AND page=?', (item_id, str(page))).fetchone()
    if not r: return
    strokes = json.loads(r[0])
    for s in strokes:
        s['pts'] = [f(x, y) + rest for x, y, *rest in s.get('pts', [])]
    c.execute('UPDATE annotation SET strokes=? WHERE item_id=? AND page=?', (json.dumps(strokes), item_id, str(page)))


def _render(d: Path, file, steps):
    """Make the page file again from the original photo and the crop the steps give."""
    orig, crop = _original(steps), _crop_of(steps)
    if not orig: return
    if crop: trim.crop(orig, d / file, crop['top'], crop['bottom'], crop['left'], crop['right'])
    else: shutil.copy2(orig, d / file)


@router.get('/items/{item_id}/pages/{page}/original')
def page_original(item_id: str, page: int, c=Depends(conn), cf=Depends(cfg)):
    """The original photo of a page: the oldest kept version if it was trimmed, else the page file."""
    it = must_item(c, item_id)
    d = folder_path(cf, it['folder'])
    file = _page_row(c, item_id, page)
    p = _original(_steps(d, page)) or d / file
    if not p.is_file(): raise HTTPException(404, 'No such file')
    return FileResponse(p, media_type={'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}.get(p.suffix.lower()))


@router.post('/items/{item_id}/pages/{page}/trim')
def trim_page(item_id: str, page: int, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """Crop the page to {top, bottom, left, right} of its ORIGINAL photo (a trimmed page is cut from the
    original again, never from the cropped file). The original is kept once in .history; undo goes back
    one crop."""
    it = must_item(c, item_id)
    box = {k: float(body.get(k, FULL[k])) for k in FULL}
    top, bottom, left, right = box['top'], box['bottom'], box['left'], box['right']
    if not (0 <= top < bottom <= 1 and 0 <= left < right <= 1) or bottom - top < 0.2 or right - left < 0.2:
        raise HTTPException(400, 'Bad trim')
    d = folder_path(cf, it['folder'])
    file = _page_row(c, item_id, page)
    src = d / file
    steps = _steps(d, page)
    before = _crop_of(steps)
    meta = _add(d, page, steps, {'op': 'trim', **box, 'abs': True})
    orig = _original(steps)
    if not orig:  # first trim: keep the original photo (same stamp as this entry)
        orig = meta.with_suffix(src.suffix)
        shutil.copy2(src, orig)
    trim.crop(orig, src, top, bottom, left, right)
    _restroke(c, item_id, page, before, box)
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))
    _forget(cf, item_id, page, src)
    return get_item(c, item_id)


@router.post('/items/{item_id}/pages/{page}/untrim')
def untrim_page(item_id: str, page: int, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    """Undo the last trim of a page (back to the crop before it); {all: true} = back to the original."""
    it = must_item(c, item_id)
    d = folder_path(cf, it['folder'])
    file = _page_row(c, item_id, page)
    steps = _steps(d, page)
    if not _stack(steps): raise HTTPException(404, 'Nothing to undo')
    before = _crop_of(steps)
    _add(d, page, steps, {'op': 'reset' if body.get('all') else 'undo'})  # history only grows
    steps = _steps(d, page)
    _render(d, file, steps)
    _restroke(c, item_id, page, before, _crop_of(steps))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))
    _forget(cf, item_id, page, d / file)
    return get_item(c, item_id)


def _forget(cf, item_id, page, path=None):
    """The page file changed: look at it again now."""
    with _lock:
        data = _load(cf)
        key = f'{item_id}:{page}'
        if path is None: data['pages'].pop(key, None)
        else: data['pages'][key] = [int(path.stat().st_mtime), _analyze(path.parent, page, path.name), path.name]
        data['v'] = CACHE_V
        _save(cf, data)
