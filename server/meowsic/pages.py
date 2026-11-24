"""Split and join sheets for real: page photos move between item folders and are renamed
'<folder> <n>.<ext>'; trim history (.history/p<n>-*), annotations and page rows move with them."""
import json
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from .db import book_folder, folder_base, folder_name, folder_path, get_item, log_event, now_ms, uid, write_item
from .items import cfg, conn, ids_of, move_folder, must_item
from .autofill import fill_from_library, log_fill
from .undolog import record_undo

router = APIRouter(prefix='/api')


def _rows(c, item_id):
    return [dict(r) for r in c.execute('SELECT * FROM sheet_page WHERE item_id=? ORDER BY page', (item_id,))]


def _relayout(c, cf, item_id, pages: list[dict]):
    """Make `pages` (rows, each with its current item_id/page/file) the pages 1..n of item_id, in order."""
    it = get_item(c, item_id)
    dst = folder_path(cf, it['folder'])
    dst.mkdir(parents=True, exist_ok=True)
    (dst / '.history').mkdir(exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    staged = []
    # 1. move every file (and its history) to a temporary name in the destination folder
    for k, r in enumerate(pages, 1):
        src_dir = folder_path(cf, get_item(c, r['item_id'])['folder'])
        f = src_dir / r['file']
        tmp = dst / f'.mv-{tag}-{k}{f.suffix.lower()}'
        os.rename(f, tmp)
        hist = []
        if (src_dir / '.history').is_dir():
            for h in (src_dir / '.history').glob(f'p{r["page"]}-*'):
                t = dst / '.history' / f'.mv-{tag}-{k}-{h.name.split("-", 1)[1]}'
                os.rename(h, t); hist.append(t)
        ann = c.execute('SELECT strokes FROM annotation WHERE item_id=? AND page=?', (r['item_id'], str(r['page']))).fetchone()
        c.execute('DELETE FROM annotation WHERE item_id=? AND page=?', (r['item_id'], str(r['page'])))
        c.execute('DELETE FROM sheet_page WHERE item_id=? AND page=?', (r['item_id'], r['page']))
        staged.append((r, tmp, hist, ann[0] if ann else None))
    # 2. final names and rows
    for k, (r, tmp, hist, ann) in enumerate(staged, 1):
        name = f'{folder_base(it["folder"])} {k}{tmp.suffix}'
        os.rename(tmp, dst / name)
        for h in hist:
            os.rename(h, dst / '.history' / f'p{k}-{h.name.split("-", 3)[3]}')
        c.execute('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at, ocr_text, photo_id) VALUES (?,?,?,?,?,?,?)',
                  (item_id, k, name, r.get('sha256'), r.get('captured_at'), r.get('ocr_text'), r.get('photo_id')))
        if ann: c.execute('INSERT OR REPLACE INTO annotation(item_id, page, strokes) VALUES (?,?,?)', (item_id, str(k), ann))
    c.execute('UPDATE sheet SET pages=? WHERE item_id=?', (len(pages), item_id))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))


def _forget_items(c, *ids):
    """Pages moved: their Clean up scans and page marks no longer fit."""
    from .cleanstate import forget_items
    forget_items(c, *ids)


def _sheet(c, item_id):
    it = must_item(c, item_id)
    if it['kind'] != 'sheet' or not it.get('folder'): raise HTTPException(400, 'Only sheets have pages')
    return it


@router.post('/items/{item_id}/split')
def split(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{pages: [n, ...], title?} → those pages become a new sheet (same artist and tags)."""
    it = _sheet(c, item_id)
    rows = _rows(c, item_id)
    take = sorted({int(p) for p in body.get('pages', [])})
    if not take or any(p < 1 or p > len(rows) for p in take) or len(take) == len(rows):
        raise HTTPException(400, 'Pick some pages, not all of them')
    title = str(body.get('title') or '').strip() or f'{it["title"]} (part 2)'
    t = now_ms()
    new = {'id': uid('s'), 'kind': 'sheet', 'title': title, 'artist': it.get('artist') or '', 'tags': it['tags'],
           'source': it.get('source') or 'photos', 'pages': 0, 'createdAt': t, 'updatedAt': t, 'originAt': it.get('originAt')}
    filled = fill_from_library(c, new, exclude=(item_id,))  # the sheet it came from is not the same song
    write_item(c, new, new=True)
    _relayout(c, cf, new['id'], [r for r in rows if r['page'] in take])
    _relayout(c, cf, item_id, [r for r in _rows(c, item_id)])
    aid = log_event(c, 'split', it['title'], f'pages {", ".join(map(str, take))} → “{title}”')
    record_undo(c, aid, {'op': 'split', 'id': item_id, 'new': new['id'], 'take': take, 'n': len(rows), 'title': it['title'], 'newTitle': title})
    _forget_items(c, item_id, new['id'])
    log_fill(c, [(new, filled)])
    return {'item': get_item(c, item_id), 'new': get_item(c, new['id'])}


@router.post('/items/{item_id}/join')
def join(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{other: id} → the other sheet's pages are added after this one's; the other goes to the Trash (empty)."""
    it, other = _sheet(c, item_id), _sheet(c, str(body.get('other')))
    if other['id'] == item_id: raise HTTPException(400, 'Pick another sheet')
    n, m, had = len(_rows(c, item_id)), len(_rows(c, other['id'])), set(it['tags'])  # for the undo
    _relayout(c, cf, item_id, _rows(c, item_id) + _rows(c, other['id']))
    c.execute('UPDATE sheet SET pages=0 WHERE item_id=?', (other['id'],))
    for (tag,) in c.execute('SELECT tag FROM item_tag WHERE item_id=?', (other['id'],)).fetchall():
        c.execute('INSERT OR IGNORE INTO item_tag(item_id, tag) VALUES (?,?)', (item_id, tag))
    c.execute('UPDATE item SET deleted_at=? WHERE id=?', (now_ms(), other['id']))
    aid = log_event(c, 'join', it['title'], f'+ “{other["title"]}”')
    record_undo(c, aid, {'op': 'join', 'id': item_id, 'other': other['id'], 'n': n, 'm': m, 'title': it['title'], 'otherTitle': other['title'],
                         'tags': [t for t in other['tags'] if t not in had]})
    _forget_items(c, item_id, other['id'])
    return {'item': get_item(c, item_id), 'other': get_item(c, other['id']), 'activity': aid}


@router.post('/items/book')
def set_book(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{ids, book: true|false} → sheets become books (folder items/Books/<title>/) or back to sheets."""
    on, done, ids = bool(body.get('book', True)), [], []
    for i in ids_of(body):
        it = get_item(c, i)
        if not it or it['kind'] != 'sheet' or not it.get('folder') or bool(it.get('book')) == on: continue
        new = book_folder(cf, it['title']) if on else folder_name(it['id'], it['title'])
        move_folder(c, cf, it, new)
        if get_item(c, i)['folder'] != new: raise HTTPException(500, f'Could not move the files of “{it["title"]}”')
        c.execute('UPDATE sheet SET book=? WHERE item_id=?', (int(on), i))
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), i))
        done.append(it['title']); ids.append(i)
    if done:
        aid = log_event(c, 'book' if on else 'unbook', done[0] if len(done) == 1 else f'{len(done)} sheets', 'now a book' if on else 'now a sheet')
        record_undo(c, aid, {'op': 'book', 'ids': ids, 'titles': done, 'on': on})
    return {'ok': True, 'count': len(done), 'items': [get_item(c, i) for i in ids_of(body)]}


# ---------- Organize pages: reorder and delete pages ----------
# Deleted pages are never removed: the photo goes to items/<folder>/.history/deleted-<tag>-p<n>.<ext> (its trim
# history to deleted-<tag>-p<n>-<rest>), its row and ink go into the Activities row, so Undo puts it back exactly.

def _sig(cf, item_id, c):
    """What the page files are now (size + mtime survive renames): undo refuses if they changed since."""
    it = get_item(c, item_id)
    d = folder_path(cf, it['folder'])
    out = []
    for r in _rows(c, item_id):
        try: st = (d / r['file']).stat(); out.append([st.st_size, st.st_mtime_ns])
        except OSError: out.append(None)
    return out


def _remap(starts: dict, order: list[int]) -> dict:
    """Song-start marks follow their page: {old page: title} -> {new position: title}."""
    return {str(k): starts[str(o)] for k, o in enumerate(order, 1) if str(o) in starts}


def arrange_pages(c, cf, item_id, order: list[int]):
    """order = the old page numbers in their new order; pages left out are deleted (kept in .history).
    Every page left out = the sheet goes to the Trash (its pages stay, so Restore brings it all back)."""
    from . import cleanstate as cs
    it = _sheet(c, item_id)
    if it['deleted']: raise HTTPException(400, 'This sheet is in the Trash')
    rows = _rows(c, item_id)
    n = len(rows)
    try: order = [int(p) for p in order]
    except (TypeError, ValueError): raise HTTPException(400, 'order must be page numbers')
    if len(set(order)) != len(order) or any(not 1 <= p <= n for p in order): raise HTTPException(400, f'order must be pages 1–{n}, each once')
    gone = [p for p in range(1, n + 1) if p not in order]
    if not order:  # nothing left: the sheet goes to the Trash as it is
        c.execute('UPDATE item SET deleted_at=?, updated_at=? WHERE id=?', (now_ms(), now_ms(), item_id))
        aid = log_event(c, 'pages', it['title'], 'every page deleted → the sheet went to the Trash')
        record_undo(c, aid, {'op': 'trash', 'ids': [item_id], 'titles': [it['title']]})
        return {'item': get_item(c, item_id), 'activity': aid, 'trashed': True, 'starts': cs.split_starts(c, item_id)}
    if order == list(range(1, n + 1)): raise HTTPException(400, 'Nothing changes')
    d = folder_path(cf, it['folder'])
    h = d / '.history'
    h.mkdir(parents=True, exist_ok=True)
    tag = f'{now_ms()}x{uuid.uuid4().hex[:6]}'  # the time in the name: the daily clean-up keeps it 24 h (and while Undo can use it)
    deleted = []
    by = {r['page']: r for r in rows}
    for p in gone:
        r = by[p]
        f = d / r['file']
        stash = f'deleted-{tag}-p{p}{f.suffix.lower()}'
        os.rename(f, h / stash)
        hist = []
        for x in sorted(h.glob(f'p{p}-*')):
            nm = f'deleted-{tag}-p{p}-{x.name.split("-", 1)[1]}'
            os.rename(x, h / nm); hist.append(nm)
        ann = c.execute('SELECT strokes FROM annotation WHERE item_id=? AND page=?', (item_id, str(p))).fetchone()
        c.execute('DELETE FROM annotation WHERE item_id=? AND page=?', (item_id, str(p)))
        c.execute('DELETE FROM sheet_page WHERE item_id=? AND page=?', (item_id, p))
        deleted.append({'page': p, 'stash': stash, 'hist': hist, 'ann': ann[0] if ann else None,
                        'row': {k: r.get(k) for k in ('file', 'sha256', 'captured_at', 'ocr_text', 'photo_id')}})
    _relayout(c, cf, item_id, [by[p] for p in order])
    starts = cs.split_starts(c, item_id)
    cs.split_put(c, item_id, _remap(starts, order))
    _forget_items(c, item_id)
    bits = ([f'deleted page{"s" if len(gone) != 1 else ""} {", ".join(map(str, gone))}'] if gone else []) + \
           ([f'new order {", ".join(map(str, order))}'] if order != sorted(order) else [])
    aid = log_event(c, 'pages', it['title'], ' · '.join(bits))
    record_undo(c, aid, {'op': 'pages', 'id': item_id, 'title': it['title'], 'n': n, 'order': order, 'deleted': deleted,
                         'starts': starts, 'after': _sig(cf, item_id, c)})
    return {'item': get_item(c, item_id), 'activity': aid, 'trashed': False, 'starts': cs.split_starts(c, item_id)}


def unarrange(c, cf, s, mode):
    """Activities Undo of a 'pages' step: deleted pages back from .history, every page back in its old place."""
    from . import cleanstate as cs
    it = get_item(c, s['id'])
    what = f'“{s.get("title", "")}”'
    if not it: return [{'status': 'conflict', 'what': what, 'why': 'deleted for good since'}]
    if it['deleted']: return [{'status': 'conflict', 'what': what, 'why': 'it is in the Trash'}]
    d = folder_path(cf, it['folder'])
    h = d / '.history'
    if _sig(cf, s['id'], c) != s['after']: return [{'status': 'conflict', 'what': what, 'why': 'its pages changed since'}]
    if any(not (h / x['stash']).is_file() for x in s['deleted']): return [{'status': 'conflict', 'what': what, 'why': 'a deleted page is missing from .history'}]
    if mode == 'check': return [{'status': 'ok', 'what': what}]
    rows = _rows(c, s['id'])
    m = len(rows)
    back = {}
    for k, x in enumerate(s['deleted'], m + 1):  # each deleted page comes back as an extra page m+1…, then the relayout
        name = f'.rs-{uuid.uuid4().hex[:8]}{Path(x["stash"]).suffix}'
        os.rename(h / x['stash'], d / name)
        for nm in x['hist']:
            os.rename(h / nm, h / f'p{k}-{nm.split("-", 3)[3]}')
        r = {**x['row'], 'item_id': s['id'], 'page': k, 'file': name}
        c.execute('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at, ocr_text, photo_id) VALUES (?,?,?,?,?,?,?)',
                  (s['id'], k, name, r.get('sha256'), r.get('captured_at'), r.get('ocr_text'), r.get('photo_id')))
        if x.get('ann') is not None: c.execute('INSERT OR REPLACE INTO annotation(item_id, page, strokes) VALUES (?,?,?)', (s['id'], str(k), x['ann']))
        back[x['page']] = r
    pos = {o: rows[k] for k, o in enumerate(s['order'])}
    _relayout(c, cf, s['id'], [pos.get(p) or back[p] for p in range(1, s['n'] + 1)])
    cs.split_put(c, s['id'], s.get('starts') or {})
    _forget_items(c, s['id'])
    return [{'status': 'ok', 'what': what}]


@router.post('/items/{item_id}/pages/arrange')
def arrange(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{order: [old page numbers in the new order]} — pages left out are deleted (kept in .history, Undo brings them back)."""
    return arrange_pages(c, cf, item_id, body.get('order') or [])


@router.post('/items/{item_id}/pages/{page}/delete')
def delete_page(item_id: str, page: int, c=Depends(conn), cf=Depends(cfg)):
    n = len(_rows(c, item_id))
    if not 1 <= page <= n: raise HTTPException(404, 'No such page')
    return arrange_pages(c, cf, item_id, [p for p in range(1, n + 1) if p != page])


@router.post('/items/{item_id}/pages/{page}/move')
def move_page(item_id: str, page: int, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{to: new position} — page `page` moves there, the others shift."""
    order = list(range(1, len(_rows(c, item_id)) + 1))
    if page not in order: raise HTTPException(404, 'No such page')
    order.remove(page); order.insert(max(0, min(len(order), int(body.get('to', page)) - 1)), page)
    return arrange_pages(c, cf, item_id, order)
