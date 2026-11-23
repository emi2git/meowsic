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

from . import trim
from .db import folder_path, get_item, now_ms
from .items import cfg, conn, must_item

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


def _pages(c):
    return c.execute('SELECT p.item_id, p.page, p.file, i.folder FROM sheet_page p JOIN item i ON i.id = p.item_id '
                     'WHERE i.deleted_at IS NULL AND i.folder IS NOT NULL ORDER BY i.created_at DESC, p.page').fetchall()


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
        try: rows = _pages(c)
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
    items = {r[0]: {'id': r[0], 'title': r[1], 'kind': r[2], 'folder': r[3], 'book': bool(r[4]), 'pages': []}
             for r in c.execute('SELECT id, title, kind, folder, (SELECT book FROM sheet WHERE item_id=item.id) FROM item WHERE deleted_at IS NULL' + (' AND id=?' if id else ''), (id,) if id else ())}
    missing = False
    for iid, page, file, folder in _pages(c):
        if iid not in items: continue
        key = f'{iid}:{page}'
        ent = data['pages'].get(key)
        if not ent: missing = True
        res = (ent or [0, None])[1] or {}
        n = len(_snaps(folder_path(cf, folder), page))
        items[iid]['pages'].append({'page': page, 'file': file, 'trim': None if key in ok else res.get('trim'),
                                    'dots': res.get('dots'), 'box': None if key in ok else res.get('box'), 'trims': n, 'scanned': bool(ent)})
    songs, odd = [], []
    for it in items.values():
        why = odd_title(it['title'], it['kind'])
        if why and f'title:{it["id"]}' not in ok: odd.append({'id': it['id'], 'title': it['title'], 'kind': it['kind'], 'why': why})
        if it['kind'] != 'sheet': continue
        issues = []
        if not it['pages']: issues.append({'kind': 'empty', 'text': 'no pages'})
        nt = sum(1 for p in it['pages'] if p['trim'])
        if nt: issues.append({'kind': 'trim', 'text': f"{nt} page{'s' if nt > 1 else ''} to trim"})
        if not it['book']: issues += [{'kind': k, 'text': t} for k, t in dot_issues(it['pages'])]  # a book holds many songs: grouping checks don't apply
        if why and f'title:{it["id"]}' not in ok: issues.append({'kind': 'title', 'text': f'title: {why}'})
        songs.append({'id': it['id'], 'title': it['title'], 'book': it['book'], 'pages': it['pages'], 'issues': issues,
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


def _shift_strokes(c, item_id, page, f):
    r = c.execute('SELECT strokes FROM annotation WHERE item_id=? AND page=?', (item_id, str(page))).fetchone()
    if not r: return
    strokes = json.loads(r[0])
    for s in strokes:
        s['pts'] = [[x, f(y)] for x, y, *rest in s.get('pts', [])]
    c.execute('UPDATE annotation SET strokes=? WHERE item_id=? AND page=?', (json.dumps(strokes), item_id, str(page)))


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


@router.post('/items/{item_id}/pages/{page}/trim')
def trim_page(item_id: str, page: int, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    top, bottom = float(body.get('top', 0)), float(body.get('bottom', 1))
    left, right = float(body.get('left', 0)), float(body.get('right', 1))
    if not (0 <= top < bottom <= 1 and 0 <= left < right <= 1) or bottom - top < 0.2 or right - left < 0.2:
        raise HTTPException(400, 'Bad trim')
    d = folder_path(cf, it['folder'])
    file = _page_row(c, item_id, page)
    src = d / file
    h = d / '.history'
    h.mkdir(exist_ok=True)
    snap = h / f'p{page}-{now_ms()}{src.suffix}'
    shutil.copy2(src, snap)
    snap.with_suffix('.json').write_text(json.dumps({'top': top, 'bottom': bottom, 'left': left, 'right': right}))
    trim.crop(src, src, top, bottom, left, right)
    _shift_strokes(c, item_id, page, lambda y: (y - top) / (bottom - top))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))
    _forget(cf, item_id, page, src)
    return get_item(c, item_id)


@router.post('/items/{item_id}/pages/{page}/untrim')
def untrim_page(item_id: str, page: int, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    """Undo the last trim of a page ({all: true} = back to the original)."""
    it = must_item(c, item_id)
    d = folder_path(cf, it['folder'])
    file = _page_row(c, item_id, page)
    h = d / '.history'
    snaps = sorted((p for p in h.glob(f'p{page}-*') if p.suffix != '.json'), key=lambda p: int(p.stem.split('-')[1])) if h.is_dir() else []
    if not snaps: raise HTTPException(404, 'Nothing to undo')
    undo = snaps if body.get('all') else [snaps[-1]]
    shutil.copy2(undo[0], d / file)
    for snap in reversed(undo):  # newest first: put the notes back where they were
        meta = snap.with_suffix('.json')
        if meta.exists():
            m = json.loads(meta.read_text())
            _shift_strokes(c, item_id, page, lambda y, m=m: m['top'] + y * (m['bottom'] - m['top']))
            meta.unlink()
        snap.unlink()
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
