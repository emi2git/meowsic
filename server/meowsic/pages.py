"""Split and join sheets for real: page photos move between item folders and are renamed
'<folder> <n>.<ext>'; trim history (.history/p<n>-*), annotations and page rows move with them."""
import json
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from .db import book_folder, folder_base, folder_name, folder_path, get_item, log_event, now_ms, uid, write_item
from .items import cfg, conn, ids_of, move_folder, must_item

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
        c.execute('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at, ocr_text) VALUES (?,?,?,?,?,?)',
                  (item_id, k, name, r.get('sha256'), r.get('captured_at'), r.get('ocr_text')))
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
    write_item(c, new, new=True)
    _relayout(c, cf, new['id'], [r for r in rows if r['page'] in take])
    _relayout(c, cf, item_id, [r for r in _rows(c, item_id)])
    log_event(c, 'split', it['title'], f'pages {", ".join(map(str, take))} → “{title}”')
    _forget_items(c, item_id, new['id'])
    return {'item': get_item(c, item_id), 'new': get_item(c, new['id'])}


@router.post('/items/{item_id}/join')
def join(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{other: id} → the other sheet's pages are added after this one's; the other goes to the Trash (empty)."""
    it, other = _sheet(c, item_id), _sheet(c, str(body.get('other')))
    if other['id'] == item_id: raise HTTPException(400, 'Pick another sheet')
    _relayout(c, cf, item_id, _rows(c, item_id) + _rows(c, other['id']))
    c.execute('UPDATE sheet SET pages=0 WHERE item_id=?', (other['id'],))
    for (tag,) in c.execute('SELECT tag FROM item_tag WHERE item_id=?', (other['id'],)).fetchall():
        c.execute('INSERT OR IGNORE INTO item_tag(item_id, tag) VALUES (?,?)', (item_id, tag))
    c.execute('UPDATE item SET deleted_at=? WHERE id=?', (now_ms(), other['id']))
    log_event(c, 'join', it['title'], f'+ “{other["title"]}”')
    _forget_items(c, item_id, other['id'])
    return {'item': get_item(c, item_id)}


@router.post('/items/book')
def set_book(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{ids, book: true|false} → sheets become books (folder items/Books/<title>/) or back to sheets."""
    on, done = bool(body.get('book', True)), []
    for i in ids_of(body):
        it = get_item(c, i)
        if not it or it['kind'] != 'sheet' or not it.get('folder') or bool(it.get('book')) == on: continue
        new = book_folder(cf, it['title']) if on else folder_name(it['id'], it['title'])
        move_folder(c, cf, it, new)
        if get_item(c, i)['folder'] != new: raise HTTPException(500, f'Could not move the files of “{it["title"]}”')
        c.execute('UPDATE sheet SET book=? WHERE item_id=?', (int(on), i))
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), i))
        done.append(it['title'])
    if done: log_event(c, 'book' if on else 'unbook', done[0] if len(done) == 1 else f'{len(done)} sheets', 'now a book' if on else 'now a sheet')
    return {'ok': True, 'count': len(done), 'items': [get_item(c, i) for i in ids_of(body)]}
