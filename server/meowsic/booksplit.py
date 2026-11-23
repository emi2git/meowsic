"""Split songs: a book — or any sheet — that holds several songs. In Manage library you mark the page where
each new song starts (with its title); the marks are kept in the book_split_mark table so you can stop and go
on later (and Claude can read them). make-sheets moves each page range into a new normal sheet (one call) and
keeps a record in book_split_undo; unmake puts every page back (the record stays, marked undone).

  /api/books/…   books: pages before the first start stay in the book (an emptied book goes to the Trash)
  /api/sheets/…  any sheet: page 1 always starts the first song, which stays in this sheet (its title can
                 change with the mark on page 1); every later start becomes a new sheet"""
import re
import shutil

from fastapi import APIRouter, Body, Depends, HTTPException

from . import cleanstate as cs
from . import grouping, titles
from .db import folder_path, get_item, log_event, now_ms, uid, write_item
from .items import cfg, conn, must_item
from .pages import _forget_items, _relayout, _rows
from .undolog import record_undo

router = APIRouter(prefix='/api')


def _book(c, item_id, live=True, books=True):
    """books=True: a book (/api/books/…); False: a sheet that is not a book (/api/sheets/…)."""
    it = must_item(c, item_id)
    if it['kind'] != 'sheet' or not it.get('folder'): raise HTTPException(400, 'Not a book' if books else 'Not a sheet')
    if bool(it.get('book')) != books: raise HTTPException(400, 'Not a book' if books else 'This is a book — split it in Books → sheets')
    if live and it['deleted']: raise HTTPException(400, 'This book is in the Trash' if books else 'This sheet is in the Trash')
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


def book_get(book_id: str, c=None, books=True):
    """One book: its marks plus a title guess for every page whose OCR text looks like a title."""
    it = _book(c, book_id, books=books)
    guess = {str(r['page']): g for r in _rows(c, book_id) if (g := title_guess(r.get('ocr_text')))}
    return {'id': book_id, 'title': it['title'], 'pages': it['pages'], 'updatedAt': it['updatedAt'], 'files': it['pageFiles'],
            'starts': cs.split_starts(c, book_id), 'guess': guess}


def book_mark(book_id: str, body: dict = Body(...), c=None, books=True):
    """{page, on: bool, title?} marks / unmarks one start (or sets its title); {starts: {page: title}} replaces all."""
    it = _book(c, book_id, books=books)
    if 'starts' in body:
        starts = _clean(body['starts'], it['pages'])
    else:
        starts = cs.split_starts(c, book_id)
        k = str(next(iter(_clean({body.get('page'): ''}, it['pages']))))
        if body.get('on', True): starts[k] = str(body.get('title') if body.get('title') is not None else starts.get(k, '')).strip()[:200]
        else: starts.pop(k, None)
    cs.split_put(c, book_id, starts)
    return {'starts': cs.split_starts(c, book_id)}


def make_sheets(book_id: str, body: dict = Body(default={}), c=None, cf=None, books=True):
    """Each marked start → a new sheet with the pages up to the next start (same artist and tags as the book).
    Books: pages before the first start stay in the book; a book left with no pages goes to the Trash.
    Sheets: page 1 always starts the first song, which stays in the sheet (renamed to the title marked on
    page 1, if any). {starts?} = use these marks instead of the saved ones."""
    it = _book(c, book_id, books=books)
    rows = _rows(c, book_id)
    n = len(rows)
    saved = cs.split_starts(c, book_id)
    starts = _clean(body['starts'], n) if body.get('starts') is not None else saved
    keep_title = None
    if not books:
        first = (starts.pop('1', '') or '').strip()
        if first and first != it['title']: keep_title = first
    if not starts: raise HTTPException(400, 'Mark where a sheet starts first' if books else 'Mark where the next song starts first')
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
    rec = {'at': t, 'lead': lead, 'trashed': trashed, 'sheets': made, 'starts': {**({'1': keep_title or ''} if not books else {}), **starts},
           'kind': 'book' if books else 'sheet'}
    if keep_title:
        rec['oldTitle'], rec['newTitle'] = it['title'], keep_title
        c.execute('UPDATE item SET title=?, updated_at=? WHERE id=?', (keep_title, now_ms(), book_id))
    cs.split_undo_push(c, book_id, rec)
    cs.split_put(c, book_id, {})
    _forget_items(c, book_id, *[m['id'] for m in made])
    what = 'book' if books else 'sheet'
    aid = log_event(c, 'booksplit' if books else 'songsplit', it['title'], f'{len(made)} {"sheet" if books else "new sheet"}{"s" if len(made) != 1 else ""}: ' + ', '.join(f'“{m["title"]}” p{m["start"]}–{m["end"]}' for m in made)
              + (f' · {what} now empty → Trash' if trashed else f' · {lead} page{"s" if lead != 1 else ""} left in the {what}')
              + (f' · renamed “{keep_title}”' if keep_title else ''))
    record_undo(c, aid, {'op': 'booksplit', 'book': book_id, 'at': t, 'title': it['title'], 'n': len(made), 'books': books})
    return {'book': get_item(c, book_id), 'sheets': [get_item(c, m['id']) for m in made], 'undo': rec}


def unmake(book_id: str, c=None, cf=None, books=True):
    """Undo the last make-sheets: every page goes back into the book in its old order, the new sheets are
    removed for good (they were just made), the book comes back from the Trash and the marks come back."""
    it = _book(c, book_id, live=False, books=books)
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
    if rec.get('oldTitle') and get_item(c, book_id)['title'] == rec.get('newTitle'):
        c.execute('UPDATE item SET title=? WHERE id=?', (rec['oldTitle'], book_id))
    cs.split_undo_pop(c, book_id)
    cs.split_put(c, book_id, rec.get('starts') or {})
    _forget_items(c, book_id, *[m['id'] for m in rec['sheets']])
    log_event(c, 'unbooksplit' if books else 'unsongsplit', it['title'], f'{len(rec["sheets"])} sheets put back into the {"book" if books else "sheet"}')
    return {'book': get_item(c, book_id), 'removed': [m['id'] for m in rec['sheets']], 'starts': rec.get('starts') or {}}


# ---------- any sheet: Manage library → Split songs ----------

def _hint(c, cf, ids) -> dict[str, list[str]]:
    """Why a sheet probably holds several songs — from what is known already (no new Vision reading):
    the page-dot scan (one '1 of n' after page 1, or the dot counts change) and titles read before."""
    out = {}
    scans = cs.scan_all(c)
    with titles._lock: cache = titles._load(cf)
    for iid, folder in ids:
        rows = c.execute('SELECT page, file FROM sheet_page WHERE item_id=? ORDER BY page', (iid,)).fetchall()
        pages = []
        for page, file in rows:
            ent = scans.get(f'{iid}:{page}')
            res = (ent or [0, None])[1] or {}
            lines = cache.get(f'items/{folder}/{file}')
            t = titles.pick(lines) if lines and 'lines' in lines else {}
            pages.append({'dots': res.get('dots'), 'title': {'title': t.get('title', ''), 'confidence': t.get('confidence', 0)} if t else None,
                          'staff': (lines or {}).get('staff')})
        why = []
        for k in grouping.several_songs(pages):
            p = pages[k - 1]
            if (p.get('dots') or {}).get('lit') == 1: why.append(f'page {k} is page 1 of {p["dots"]["count"]} (page dots)')
            elif (p.get('title') or {}).get('title'): why.append(f'page {k} has its own title “{p["title"]["title"]}”')
            else: why.append(f'a new song seems to start on page {k}')
        if why: out[iid] = why
    return out


@router.get('/sheets/split')
def sheets_list(c=Depends(conn), cf=Depends(cfg)):
    """Every live sheet (not a book) with 2+ pages: marks so far, can it be undone, and why it probably holds
    several songs (several: [...]) — those first, then A–Z."""
    rows = c.execute("SELECT i.id, i.title, s.pages, i.updated_at, i.folder FROM item i JOIN sheet s ON s.item_id = i.id "
                     "WHERE i.deleted_at IS NULL AND i.kind = 'sheet' AND s.book = 0 AND i.folder IS NOT NULL AND s.pages >= 2").fetchall()
    undo = cs.can_unmake(c)
    hint = _hint(c, cf, [(r[0], r[4]) for r in rows])
    out = [{'id': r[0], 'title': r[1], 'pages': r[2], 'updatedAt': r[3], 'starts': cs.split_starts(c, r[0]), 'canUnmake': r[0] in undo,
            'several': hint.get(r[0], [])} for r in rows]
    return {'sheets': sorted(out, key=lambda b: (not b['several'], b['title'].lower()))}


@router.get('/sheets/{item_id}/split')
def sheet_get(item_id: str, detect: bool = False, c=Depends(conn), cf=Depends(cfg)):
    """One sheet: its marks, and (detect=1) where new songs probably start, read off every page
    (title, page dots, music at the top, layout): suggest {page: {title, confidence, sure, why}}."""
    r = book_get(item_id, c=c, books=False)
    if not detect: return r
    from .cleanup import _analyze, _original, _steps
    it = get_item(c, item_id)
    d = folder_path(cf, it['folder'])
    words = titles.library_words(c, item_id)
    pages = []
    for row in _rows(c, item_id):
        src = _original(_steps(d, row['page'])) or d / row['file']  # a cropped page: read the whole photo
        a = _analyze(d, row['page'], row['file'])
        t, staff = {'title': '', 'confidence': 0.0}, None
        if titles.available():
            try:
                t = titles.detect(cf, src, None, words)
                staff = titles.page_lines(cf, src).get('staff')
            except Exception: pass
        pages.append({'date': row.get('captured_at'), 'dots': a.get('dots'), 'title': t, 'staff': staff, 'layout': grouping.layout(src)})
    prop = grouping.propose(pages)
    r['suggest'] = {str(k + 1): {'title': p['title'].get('title', '') if (p['title'].get('confidence') or 0) >= grouping.TITLE_MIN else '',
                                 'confidence': p['title'].get('confidence', 0), 'start': pr['start'], 'sure': pr['sure'], 'why': pr['why']}
                    for k, (p, pr) in enumerate(zip(pages, prop))}
    return r


@router.post('/sheets/{item_id}/split')
def sheet_mark(item_id: str, body: dict = Body(...), c=Depends(conn)):
    return book_mark(item_id, body, c=c, books=False)


@router.post('/sheets/{item_id}/make-sheets')
def sheet_make(item_id: str, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    return make_sheets(item_id, body, c=c, cf=cf, books=False)


@router.post('/sheets/{item_id}/unmake')
def sheet_unmake(item_id: str, c=Depends(conn), cf=Depends(cfg)):
    return unmake(item_id, c=c, cf=cf, books=False)


@router.get('/books/{book_id}/split')
def book_get_route(book_id: str, c=Depends(conn)):
    return book_get(book_id, c=c)


@router.post('/books/{book_id}/split')
def book_mark_route(book_id: str, body: dict = Body(...), c=Depends(conn)):
    return book_mark(book_id, body, c=c)


@router.post('/books/{book_id}/make-sheets')
def make_sheets_route(book_id: str, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    return make_sheets(book_id, body, c=c, cf=cf)


@router.post('/books/{book_id}/unmake')
def unmake_route(book_id: str, c=Depends(conn), cf=Depends(cfg)):
    return unmake(book_id, c=c, cf=cf)
