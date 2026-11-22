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


def _run_scan(app):
    cf = app.state.cfg
    try:
        c = app.state.connect()
        try: rows = _pages(c)
        finally: c.close()
        with _lock: data = _load(cf)
        _scan.update(total=len(rows), done=0)
        for k, (iid, page, file, folder) in enumerate(rows):
            p = cf.items_dir / folder / file
            key = f'{iid}:{page}'
            try: mt = int(p.stat().st_mtime)
            except OSError: _scan['done'] = k + 1; continue
            old = data['pages'].get(key)
            if not old or old[0] != mt or old[2] != file:
                try: res = trim.analyze(p)
                except Exception: res = None
                if res: res = {'top': float(res['top']), 'bottom': float(res['bottom']), 'reasons': res['reasons']}
                data['pages'][key] = [mt, res, file]
            _scan['done'] = k + 1
            if k % 200 == 0:
                with _lock: _save(cf, {**_load(cf), 'pages': data['pages']})
        with _lock: _save(cf, {**_load(cf), 'pages': data['pages']})
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


@router.get('/cleanup')
def cleanup_state(request: Request, c=Depends(conn), cf=Depends(cfg)):
    with _lock: data = _load(cf)
    ok = set(data.get('ok', []))
    hist = {}
    pages = []
    titles = {r[0]: (r[1], r[2]) for r in c.execute('SELECT id, title, kind FROM item WHERE deleted_at IS NULL')}
    for iid, page, file, folder in _pages(c):
        key = f'{iid}:{page}'
        h = folder_path(cf, folder) / '.history'
        n = len([p for p in h.glob(f'p{page}-*') if p.suffix != '.json']) if h.is_dir() else 0
        if n: hist[key] = n
        res = (data['pages'].get(key) or [0, None])[1]
        if (res and key not in ok) or n:
            pages.append({'id': iid, 'page': page, 'file': file, 'title': titles.get(iid, ('',))[0],
                          'suggest': res if key not in ok else None, 'trims': n})
    odd = []
    for iid, (title, kind) in titles.items():
        why = odd_title(title, kind)
        if why and f'title:{iid}' not in ok: odd.append({'id': iid, 'title': title, 'kind': kind, 'why': why})
    if not _scan['running'] and any(f'{iid}:{pg}' not in data['pages'] for iid, pg, _f, _d in _pages(c)):
        start_scan(request.app)  # new pages since the last scan
    return {'scan': dict(_scan), 'pages': pages, 'titles': sorted(odd, key=lambda x: x['title'].lower())}


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
    res = None
    if path is not None:
        try: res = trim.analyze(path)
        except Exception: res = None
        if res: res = {'top': float(res['top']), 'bottom': float(res['bottom']), 'reasons': res['reasons']}
    with _lock:
        data = _load(cf)
        if path is None: data['pages'].pop(f'{item_id}:{page}', None)
        else: data['pages'][f'{item_id}:{page}'] = [int(path.stat().st_mtime), res, path.name]
        _save(cf, data)
