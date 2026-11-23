"""Books → sheets: some books are really sheets grouped together. In Clean up you mark the page where each
new sheet starts (with its title); the marks are kept in the book_split_mark table so you can stop and go on
later (and Claude can read them). make-sheets moves each page range into a new normal sheet (one call) and keeps
a record in book_split_undo; unmake puts every page back (the record stays, marked undone)."""
import re
import shutil

from fastapi import APIRouter, Body, Depends, HTTPException

from . import cleanstate as cs
from .db import folder_path, get_item, log_event, now_ms, uid, write_item
from .items import cfg, conn, must_item
from .pages import _forget_items, _relayout, _rows

router = APIRouter(prefix='/api')


def _book(c, item_id, live=True):
    it = must_item(c, item_id)
    if it['kind'] != 'sheet' or not it.get('book') or not it.get('folder'): raise HTTPException(400, 'Not a book')
    if live and it['deleted']: raise HTTPException(400, 'This book is in the Trash')
    return it


def title_guess(text: str | None):
    """A title from a page's OCR text: the first short line that reads like words, else None."""
    for line in (text or '').splitlines()[:6]:
        t = re.sub(r'\s+', ' ', line).strip(' .-_|·•:')
        t = re.sub(r'\s*\d{1,3}$', '', t).strip()  # page number at the end
        letters = sum(ch.isalpha() for ch in t)
        if 3 <= len(t) <= 60 and letters >= 3 and letters >= 0.6 * len(t.replace(' ', '')):
            return t
    return None


def _clean(starts, n) -> dict[str, str]:
    """{page: title} with pages 1..n, or 400."""
    if not isinstance(starts, dict): raise HTTPException(400, 'starts must be {page: title}')
    out = {}
    for p, t in starts.items():
        try: k = int(p)
        except (TypeError, ValueError): raise HTTPException(400, f'Bad page {p!r}')
        if not 1 <= k <= n: raise HTTPException(400, f'There is no page {k}')
        out[str(k)] = str(t or '').strip()[:200]
    return out


@router.get('/books/split')
def books_list(c=Depends(conn)):
    """Every live book with its page count and the sheet starts marked so far."""
    rows = c.execute("SELECT i.id, i.title, s.pages, i.updated_at FROM item i JOIN sheet s ON s.item_id = i.id "
                     "WHERE i.deleted_at IS NULL AND i.kind = 'sheet' AND s.book = 1 AND i.folder IS NOT NULL").fetchall()
    undo = cs.can_unmake(c)
    books = [{'id': r[0], 'title': r[1], 'pages': r[2], 'updatedAt': r[3], 'starts': cs.split_starts(c, r[0]), 'canUnmake': r[0] in undo} for r in rows]
    return {'books': sorted(books, key=lambda b: b['title'].lower())}


@router.get('/books/{book_id}/split')
def book_get(book_id: str, c=Depends(conn)):
    """One book: its marks plus a title guess for every page whose OCR text looks like a title."""
    it = _book(c, book_id)
    guess = {str(r['page']): g for r in _rows(c, book_id) if (g := title_guess(r.get('ocr_text')))}
    return {'id': book_id, 'title': it['title'], 'pages': it['pages'], 'updatedAt': it['updatedAt'], 'files': it['pageFiles'],
            'starts': cs.split_starts(c, book_id), 'guess': guess}


@router.post('/books/{book_id}/split')
def book_mark(book_id: str, body: dict = Body(...), c=Depends(conn)):
    """{page, on: bool, title?} marks / unmarks one start (or sets its title); {starts: {page: title}} replaces all."""
    it = _book(c, book_id)
    if 'starts' in body:
        starts = _clean(body['starts'], it['pages'])
    else:
        starts = cs.split_starts(c, book_id)
        k = str(next(iter(_clean({body.get('page'): ''}, it['pages']))))
        if body.get('on', True): starts[k] = str(body.get('title') if body.get('title') is not None else starts.get(k, '')).strip()[:200]
        else: starts.pop(k, None)
    cs.split_put(c, book_id, starts)
    return {'starts': cs.split_starts(c, book_id)}


@router.post('/books/{book_id}/make-sheets')
def make_sheets(book_id: str, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    """Each marked start → a new sheet with the pages up to the next start (same artist and tags as the book).
    Pages before the first start stay in the book; a book left with no pages goes to the Trash.
    {starts?} = use these marks instead of the saved ones."""
    it = _book(c, book_id)
    rows = _rows(c, book_id)
    n = len(rows)
    saved = cs.split_starts(c, book_id)
    starts = _clean(body['starts'], n) if body.get('starts') is not None else saved
    if not starts: raise HTTPException(400, 'Mark where a sheet starts first')
    pages = sorted(int(p) for p in starts)
    lead = pages[0] - 1
    t = now_ms()
    made = []
    for k, s in enumerate(pages):
        end = pages[k + 1] - 1 if k + 1 < len(pages) else n
        title = starts[str(s)].strip() or f'{it["title"]} — p{s}'
        new = {'id': uid('s'), 'kind': 'sheet', 'title': title, 'artist': it.get('artist') or '', 'tags': it['tags'],
               'source': it.get('source') or 'photos', 'pages': 0, 'createdAt': t + k, 'updatedAt': t, 'originAt': it.get('originAt')}
        write_item(c, new, new=True)
        _relayout(c, cf, new['id'], [r for r in rows if s <= r['page'] <= end])
        made.append({'id': new['id'], 'title': title, 'start': s, 'end': end, 'pages': end - s + 1})
    _relayout(c, cf, book_id, [r for r in rows if r['page'] <= lead])
    trashed = lead == 0
    if trashed: c.execute('UPDATE item SET deleted_at=? WHERE id=?', (now_ms(), book_id))
    rec = {'at': t, 'lead': lead, 'trashed': trashed, 'sheets': made, 'starts': starts}
    cs.split_undo_push(c, book_id, rec)
    cs.split_put(c, book_id, {})
    _forget_items(c, book_id, *[m['id'] for m in made])
    log_event(c, 'booksplit', it['title'], f'{len(made)} sheet{"s" if len(made) != 1 else ""}: ' + ', '.join(f'“{m["title"]}” p{m["start"]}–{m["end"]}' for m in made)
              + (' · book now empty → Trash' if trashed else f' · {lead} page{"s" if lead != 1 else ""} left in the book'))
    return {'book': get_item(c, book_id), 'sheets': [get_item(c, m['id']) for m in made], 'undo': rec}


@router.post('/books/{book_id}/unmake')
def unmake(book_id: str, c=Depends(conn), cf=Depends(cfg)):
    """Undo the last make-sheets: every page goes back into the book in its old order, the new sheets are
    removed for good (they were just made), the book comes back from the Trash and the marks come back."""
    it = _book(c, book_id, live=False)
    stack = cs.split_undo_stack(c, book_id)
    if not stack: raise HTTPException(400, 'Nothing to undo for this book')
    rec = stack[-1]
    if len(_rows(c, book_id)) != rec['lead']: raise HTTPException(409, 'The book has changed since — cannot put the pages back')
    rows = _rows(c, book_id)
    for m in rec['sheets']:
        s = get_item(c, m['id'])
        if not s or s['deleted'] or s['pages'] != m['pages']:
            raise HTTPException(409, f'“{m["title"]}” has changed since — cannot put the pages back')
        rows += _rows(c, m['id'])
    _relayout(c, cf, book_id, rows)
    for m in rec['sheets']:
        r = c.execute('DELETE FROM item WHERE id=? RETURNING folder', (m['id'],)).fetchone()
        try: d = folder_path(cf, r[0]) if r and r[0] else None
        except ValueError: d = None
        if d and d.is_dir() and d.resolve().parent == cf.items_dir.resolve(): shutil.rmtree(d)
    c.execute('UPDATE item SET deleted_at=NULL, updated_at=? WHERE id=?', (now_ms(), book_id))
    cs.split_undo_pop(c, book_id)
    cs.split_put(c, book_id, rec.get('starts') or {})
    _forget_items(c, book_id, *[m['id'] for m in rec['sheets']])
    log_event(c, 'unbooksplit', it['title'], f'{len(rec["sheets"])} sheets put back into the book')
    return {'book': get_item(c, book_id), 'removed': [m['id'] for m in rec['sheets']], 'starts': rec.get('starts') or {}}
