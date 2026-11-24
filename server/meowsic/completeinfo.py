"""Manage library → Complete info: one sheet at a time, tap its Key and Version.

The queue = live items whose Key or Version is still empty (or "?" / "unknown") after the AI fill
(metafill.py): sheets first (books are many songs, left out), then scores (their version is the arrangement,
so only the key), then chord charts. Most played first, then by title. Skip sends one to the end of the queue;
"Don't know" hides it until Reset. Both live in info_mark, so every device sees the same queue.
Each card carries a suggestion when one is cheap to make: the title ("Canon In D"), "Key of G" or the first chord
on page 1, how its staves join (grand staff = Piano), all from the page reading the AI fill already cached
(work/metafill-ocr.json; nothing is read again here), or a score's MusicXML key signature.
Saving is the normal PATCH /api/items/{id}, so Activities and Undo work as for any edit."""
import json
import threading
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from .db import folder_path, get_item, now_ms
from .items import cfg, conn, must_item

router = APIRouter(prefix='/api/completeinfo')
UNKNOWN = {'', '?', '??', 'unknown', 'none', 'n/a', '-', 'not set'}
KIND_ORDER = {'sheet': 0, 'score': 1, 'chords': 2}
_lock = threading.Lock()
_ocr = {'path': None, 'mtime': None, 'data': {}}


def ensure_schema(c):
    c.execute("""CREATE TABLE IF NOT EXISTS info_mark (  -- Complete info: 'skip' (to the end) | 'unknown' (hidden until Reset)
        item_id TEXT PRIMARY KEY, how TEXT NOT NULL CHECK (how IN ('skip','unknown')), at INTEGER NOT NULL)""")
    c.commit()


def missing(v) -> bool:
    return str(v or '').strip().lower() in UNKNOWN


def needs(it) -> list:
    if it.get('deleted') or it.get('book'): return []
    out = ['key'] if missing(it.get('key')) else []
    if it['kind'] in ('sheet', 'chords') and missing(it.get('version')): out.append('version')
    return out


def marks(c) -> dict:
    return {r[0]: (r[1], r[2]) for r in c.execute('SELECT item_id, how, at FROM info_mark')}


def todo(c):
    """[(item, need)] still to do (marks not applied)."""
    out = []
    for (i,) in c.execute("SELECT id FROM item WHERE deleted_at IS NULL AND kind IN ('sheet','score','chords')"):
        it = get_item(c, i)
        n = needs(it)
        if n: out.append((it, n))
    return out


# ---------- suggestions (cheap: cached page reading, MusicXML) ----------

def ocr_cache(cf) -> dict:
    p = cf.work_dir / 'metafill-ocr.json'
    try: m = p.stat().st_mtime_ns
    except OSError: return {}
    with _lock:
        if _ocr['path'] != p or _ocr['mtime'] != m:
            try: data = json.loads(p.read_text())
            except (OSError, ValueError): data = {}
            _ocr.update(path=p, mtime=m, data=data)
        return _ocr['data']


def page1(cf, it, cache):
    files = it.get('pageFiles') or []
    if not files or not it.get('folder') or not cache: return None
    try: p = folder_path(cf, it['folder']) / files[0]
    except ValueError: return None
    try: got = cache.get(f'{p}|{p.stat().st_mtime_ns}')
    except OSError: return None
    return None if not got or got.get('error') else got


def suggest(cf, it, need, cache) -> dict:
    from . import metafill as mf
    from .sheetversion import guess as guess_version
    out = {}
    pg = page1(cf, it, cache) if it['kind'] == 'sheet' else None
    lines = (pg or {}).get('lines') or []
    if 'key' in need:
        k, why = mf.key_in_title(it['title']), 'the title'
        if not k and lines: k, why = mf.key_in_text(' '.join(l['text'] for l in lines)), 'page 1 says so'
        if not k and lines:
            ch = mf.chord_lines(lines, 0.04)
            if len(ch) >= 2: k, why = ch[0], f'first chord on page 1 ({len(ch)} chords there)'
        if not k and it['kind'] == 'chords':
            k, why = mf.key_in_text(it.get('text') or ''), 'the chord chart'
        if it['kind'] == 'score':
            k, why = None, ''
            if it.get('musicxml') and it.get('folder'):
                try: k, why = mf.xml_key((folder_path(cf, it['folder']) / it['musicxml']).read_text(errors='replace')), 'its key signature'
                except (OSError, ValueError): pass
        elif k and k.endswith(' major'): k = k[:-6]
        if k: out['key'] = {'value': k, 'why': why}
    if 'version' in need:
        v, why = guess_version(it['title'], it.get('tags') or []), 'the title / tags'
        if not v and pg:
            v, how = mf.version_from_page(pg)
            why = 'page 1 text' if how == 'text' else 'how the staves join on page 1'
            if not v:  # looser than the AI fill: most systems on page 1
                sys_ = [n for n in pg.get('systems') or [] if n]
                if sys_:
                    multi = sum(1 for n in sys_ if n >= 2)
                    if multi > len(sys_) / 2: v, why = 'piano', 'most staves on page 1 are joined in pairs'
                    elif multi == 0 and len(sys_) >= 2: v, why = 'lead', 'single staves on page 1'
        if v: out['version'] = {'value': v, 'why': why}
    return out


# ---------- the API ----------

@router.get('')
def queue(c=Depends(conn), cf=Depends(cfg)):
    """{items: [{id, kind, title, artist, pages, key, version, need, suggest, skipped}], count, hidden}."""
    mk, cache, rows, hidden = marks(c), ocr_cache(cf), [], 0
    for it, need in todo(c):
        m = mk.get(it['id'])
        if m and m[0] == 'unknown': hidden += 1; continue
        rows.append({'id': it['id'], 'kind': it['kind'], 'title': it['title'], 'artist': it.get('artist') or '',
                     'pages': it.get('pages') or len(it.get('pageFiles') or []), 'key': it.get('key') or '', 'version': it.get('version') or '',
                     'updatedAt': it.get('updatedAt') or 0, 'need': need, 'suggest': suggest(cf, it, need, cache),
                     'skipped': m[1] if m else 0, '_play': it.get('playCount') or 0})
    rows.sort(key=lambda r: (bool(r['skipped']), r['skipped'], KIND_ORDER.get(r['kind'], 9), -r['_play'], r['title'].lower()))
    for r in rows: del r['_play']
    return {'items': rows, 'count': len(rows), 'hidden': hidden}


@router.get('/count')
def count(c=Depends(conn)):
    mk = marks(c)
    return {'count': sum(1 for it, _ in todo(c) if mk.get(it['id'], ('',))[0] != 'unknown')}


@router.put('/{item_id}/mark')
def put_mark(item_id: str, body: dict = Body(...), c=Depends(conn)):
    """{how: 'skip' | 'unknown'}: Skip = to the end of the queue; Don't know = hidden until Reset."""
    how = body.get('how')
    if how not in ('skip', 'unknown'): raise HTTPException(400, "how must be 'skip' or 'unknown'")
    must_item(c, item_id)
    c.execute('INSERT OR REPLACE INTO info_mark(item_id, how, at) VALUES (?,?,?)', (item_id, how, now_ms()))
    return {'ok': True}


@router.delete('/{item_id}/mark')
def del_mark(item_id: str, c=Depends(conn)):
    c.execute('DELETE FROM info_mark WHERE item_id=?', (item_id,))
    return {'ok': True}


@router.post('/reset')
def reset(body: dict = Body(default={}), c=Depends(conn)):
    """Bring back the "Don't know" ones (and, with {all: true}, forget the skips too)."""
    n = c.execute('DELETE FROM info_mark' + ('' if body.get('all') else " WHERE how='unknown'")).rowcount
    return {'ok': True, 'reset': n}
