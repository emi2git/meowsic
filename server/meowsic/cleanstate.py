"""Clean up state in the database (it used to be work/cleanup.json).

State tables (page_scan, cleanup_mark, sheet_decision, sheet_note, page_later, crop_frame, book_split_mark) follow
their item. History (page_later_log, name_suggestion, book_split_undo) is never deleted: rows only change state.
`import_json` reads an old cleanup.json once (init_db does it) and renames the file, never deletes it.
"""
import json
import time
from pathlib import Path

CACHE_V = 3  # scan version: page_scan rows of another version count as not scanned


def now_ms(): return int(time.time() * 1000)


def parse_key(key: str):
    """'title:<id>' | 'song:<id>' | '<id>:<page>' -> (kind, item_id, page | None); None when it is none of those."""
    key = str(key or '')
    for kind in ('title', 'song'):
        if key.startswith(kind + ':') and len(key) > len(kind) + 1: return kind, key[len(kind) + 1:], None
    iid, sep, page = key.rpartition(':')
    if sep and iid and page.isdigit(): return 'page', iid, int(page)
    return None


def _exists(c, item_id): return c.execute('SELECT 1 FROM item WHERE id=?', (item_id,)).fetchone() is not None


# ---------- scan cache ----------

def scan_all(c) -> dict:
    """{'<id>:<page>': [mtime, result, file]} of the current scan version."""
    return {f'{r[0]}:{r[1]}': [r[2], json.loads(r[3]), r[4]]
            for r in c.execute('SELECT item_id, page, mtime, result, file FROM page_scan WHERE v=?', (CACHE_V,))}


def scan_put(c, item_id, page, mtime, result, file):
    c.execute('INSERT OR REPLACE INTO page_scan(item_id, page, file, mtime, result, v) VALUES (?,?,?,?,?,?)',
              (item_id, int(page), file, int(mtime), json.dumps(result), CACHE_V))


def scan_forget(c, item_id, page):
    c.execute('DELETE FROM page_scan WHERE item_id=? AND page=?', (item_id, int(page)))


def forget_items(c, *ids):
    """Pages of these items moved (split / join / book split): their scans and page marks no longer fit."""
    for i in ids:
        c.execute('DELETE FROM page_scan WHERE item_id=?', (i,))
        c.execute("DELETE FROM cleanup_mark WHERE item_id=? AND kind='page'", (i,))


# ---------- ok marks ----------

def marks(c) -> set:
    return {r[0] for r in c.execute('SELECT key FROM cleanup_mark')}


def mark(c, key, on=True, at=None):
    """Add (or take back) one mark; False when the key or its item is unknown."""
    p = parse_key(key)
    if not p: return False
    if not on:
        c.execute('DELETE FROM cleanup_mark WHERE key=?', (key,))
        return True
    if not _exists(c, p[1]): return False
    c.execute('INSERT OR IGNORE INTO cleanup_mark(key, item_id, kind, at) VALUES (?,?,?,?)', (key, p[1], p[0], at or now_ms()))
    return True


# ---------- later ----------

def later_keys(c) -> set:
    return {f'{r[0]}:{r[1]}' for r in c.execute('SELECT item_id, page FROM page_later')}


def later_log(c) -> list[dict]:
    return [{'key': f'{r[0]}:{r[1]}', 'op': r[2], 'at': r[3]}
            for r in c.execute('SELECT item_id, page, op, at FROM page_later_log ORDER BY id')]


def _log_later(c, item_id, page, op, at=None):
    c.execute('INSERT INTO page_later_log(item_id, page, op, at) VALUES (?,?,?,?)', (item_id, int(page), op, at or now_ms()))


def later(c, item_id, page, on=True):
    """Leave a page for later (on) or take the mark off; every change is logged. Returns the mark now."""
    if on and _exists(c, item_id):
        c.execute('INSERT OR IGNORE INTO page_later(item_id, page, at) VALUES (?,?,?)', (item_id, int(page), now_ms()))
    elif not on:
        c.execute('DELETE FROM page_later WHERE item_id=? AND page=?', (item_id, int(page)))
    _log_later(c, item_id, page, 'later' if on else 'undo')
    return c.execute('SELECT 1 FROM page_later WHERE item_id=? AND page=?', (item_id, int(page))).fetchone() is not None


def unlater(c, item_id, page, why):
    """A page left for later was cropped / kept: its mark goes (the log keeps it)."""
    if c.execute('DELETE FROM page_later WHERE item_id=? AND page=?', (item_id, int(page))).rowcount:
        _log_later(c, item_id, page, why)


# ---------- crop frames ----------

def frames(c) -> dict:
    f = {r[0]: json.loads(r[1]) for r in c.execute('SELECT slot, box FROM crop_frame')}
    return {k: f.get(k) for k in ('1', '2')}


def frame_set(c, slot, box):
    if box is None: c.execute('DELETE FROM crop_frame WHERE slot=?', (slot,))
    else: c.execute('INSERT OR REPLACE INTO crop_frame(slot, box, at) VALUES (?,?,?)', (slot, json.dumps(box), now_ms()))


# ---------- go through sheets ----------

def decisions(c) -> dict:
    return {r[0]: r[1] for r in c.execute('SELECT item_id, decision FROM sheet_decision ORDER BY at, rowid')}


def decide(c, item_id, decision):
    if decision in ('keep', 'delete'):
        if _exists(c, item_id):
            c.execute('INSERT OR REPLACE INTO sheet_decision(item_id, decision, at) VALUES (?,?,?)', (item_id, decision, now_ms()))
    else:
        c.execute('DELETE FROM sheet_decision WHERE item_id=?', (item_id,))


# ---------- notes for Claude ----------

def notes(c) -> dict:
    """{item_id: {text, at}} of the notes that say something."""
    return {r[0]: {'text': r[1], 'at': r[2]} for r in c.execute("SELECT item_id, text, at FROM sheet_note WHERE text <> ''")}


def note_set(c, item_id, text, at=None):
    if not _exists(c, item_id): return False
    c.execute('INSERT OR REPLACE INTO sheet_note(item_id, text, at) VALUES (?,?,?)', (item_id, text, at or now_ms()))
    return True


# ---------- suggested names ----------

def _sug(r) -> dict:
    e = {k: r[k] for k in ('title', 'artist') if r[k] is not None}
    e.update(why=r['why'], at=r['at'], status=r['status'])
    if r['done_at'] is not None: e['doneAt'] = r['done_at']
    if r['old'] is not None: e['old'] = json.loads(r['old'])
    if r['new'] is not None: e['new'] = json.loads(r['new'])
    return e


def _sug_row(c, item_id):
    return c.execute("SELECT * FROM name_suggestion WHERE item_id=? AND status <> 'replaced' AND undone_at IS NULL ORDER BY id DESC LIMIT 1", (item_id,)).fetchone()


def suggestions(c) -> dict:
    """{item_id: entry} — each item's current suggestion (the same shape cleanup.json had)."""
    rows = c.execute("SELECT * FROM name_suggestion WHERE id IN (SELECT MAX(id) FROM name_suggestion WHERE status <> 'replaced' AND undone_at IS NULL GROUP BY item_id)")
    return {r['item_id']: _sug(r) for r in rows}


def suggestion(c, item_id):
    r = _sug_row(c, item_id)
    return _sug(r) if r else None


def suggest_add(c, item_id, ent: dict):
    """A new suggestion for the item; an older one still open becomes 'replaced' (kept)."""
    c.execute("UPDATE name_suggestion SET status='replaced' WHERE item_id=? AND status='open'", (item_id,))
    c.execute('INSERT INTO name_suggestion(item_id, title, artist, why, status, old, new, at, done_at) VALUES (?,?,?,?,?,?,?,?,?)',
              (item_id, ent.get('title'), ent.get('artist'), ent.get('why', ''), ent.get('status', 'open'),
               json.dumps(ent['old'], ensure_ascii=False) if ent.get('old') is not None else None,
               json.dumps(ent['new'], ensure_ascii=False) if ent.get('new') is not None else None,
               ent.get('at') or now_ms(), ent.get('doneAt')))


def suggest_update(c, item_id, ent: dict):
    """Write the state of the item's current suggestion (status, doneAt, old, new)."""
    r = _sug_row(c, item_id)
    if not r: return
    c.execute('UPDATE name_suggestion SET status=?, done_at=?, old=?, new=? WHERE id=?',
              (ent['status'], ent.get('doneAt'),
               json.dumps(ent['old'], ensure_ascii=False) if ent.get('old') is not None else None,
               json.dumps(ent['new'], ensure_ascii=False) if ent.get('new') is not None else None, r['id']))


def suggest_undo(c, item_id):
    """Take the accept / dismiss back: that row stays (undone_at), an open copy of the suggestion follows."""
    r = _sug_row(c, item_id)
    if not r or r['status'] == 'open': return
    c.execute('UPDATE name_suggestion SET undone_at=? WHERE id=?', (now_ms(), r['id']))
    c.execute("INSERT INTO name_suggestion(item_id, title, artist, why, status, at) VALUES (?,?,?,?,'open',?)",
              (item_id, r['title'], r['artist'], r['why'], r['at']))


# ---------- books → sheets ----------

def split_starts(c, book_id) -> dict[str, str]:
    return {str(r[0]): r[1] for r in c.execute('SELECT page, title FROM book_split_mark WHERE book_id=? ORDER BY page', (book_id,))}


def split_put(c, book_id, starts: dict, at=None):
    """Replace the book's marks ({page: title}); {} removes them."""
    c.execute('DELETE FROM book_split_mark WHERE book_id=?', (book_id,))
    t = at or now_ms()
    c.executemany('INSERT INTO book_split_mark(book_id, page, title, at) VALUES (?,?,?,?)',
                  [(book_id, int(p), str(v or ''), t) for p, v in starts.items()])


def split_undo_stack(c, book_id) -> list[dict]:
    """make-sheets records not undone yet, oldest first."""
    return [json.loads(r[0]) for r in c.execute('SELECT record FROM book_split_undo WHERE book_id=? AND undone_at IS NULL ORDER BY seq', (book_id,))]


def split_undo_push(c, book_id, rec: dict, undone_at=None):
    seq = (c.execute('SELECT MAX(seq) FROM book_split_undo WHERE book_id=?', (book_id,)).fetchone()[0] or 0) + 1
    c.execute('INSERT INTO book_split_undo(book_id, seq, record, at, undone_at) VALUES (?,?,?,?,?)',
              (book_id, seq, json.dumps(rec, ensure_ascii=False), rec.get('at') or now_ms(), undone_at))


def split_undo_pop(c, book_id):
    """The last record is undone: it stays, marked undone_at."""
    r = c.execute('SELECT id FROM book_split_undo WHERE book_id=? AND undone_at IS NULL ORDER BY seq DESC LIMIT 1', (book_id,)).fetchone()
    if r: c.execute('UPDATE book_split_undo SET undone_at=? WHERE id=?', (now_ms(), r[0]))


def can_unmake(c) -> set:
    return {r[0] for r in c.execute('SELECT DISTINCT book_id FROM book_split_undo WHERE undone_at IS NULL')}


# ---------- one-time import of work/cleanup.json ----------

def import_json(c, path: Path) -> dict | None:
    """Copy an old cleanup.json into the tables (rows already there win), then rename the file to
    cleanup.json.imported-<ts>. Entries of items that no longer exist are skipped (they stay in the renamed
    file). Returns counts, or None when there is no file."""
    if not path.is_file(): return None
    data = json.loads(path.read_text() or '{}')
    n = {k: 0 for k in ('pages', 'ok', 'later', 'later_log', 'frames', 'sort', 'notes', 'suggest', 'booksplit', 'booksplit_undo', 'skipped')}
    live = {r[0] for r in c.execute('SELECT id FROM item')}
    t = now_ms()

    def ok(iid):
        if iid in live: return True
        n['skipped'] += 1
        return False

    have = {(r[0], r[1]) for r in c.execute('SELECT item_id, page FROM page_scan')}
    for key, ent in (data.get('pages') or {}).items():
        p = parse_key(key)
        if not p or p[0] != 'page' or not ok(p[1]) or (p[1], p[2]) in have: continue
        try: mt, res, file = ent[0], ent[1], ent[2]
        except (IndexError, TypeError, KeyError): continue
        c.execute('INSERT INTO page_scan(item_id, page, file, mtime, result, v) VALUES (?,?,?,?,?,?)',
                  (p[1], p[2], file, int(mt), json.dumps(res), int(data.get('v') or 0)))
        n['pages'] += 1
    for key in data.get('ok') or []:
        p = parse_key(key)
        if p and ok(p[1]) and c.execute('INSERT OR IGNORE INTO cleanup_mark(key, item_id, kind, at) VALUES (?,?,?,?)', (key, p[1], p[0], t)).rowcount:
            n['ok'] += 1
    log = data.get('later_log') or []
    first = {}
    for e in log: first.setdefault(e.get('key'), e.get('at'))
    for key in data.get('later') or []:
        p = parse_key(key)
        if p and p[0] == 'page' and ok(p[1]) and c.execute('INSERT OR IGNORE INTO page_later(item_id, page, at) VALUES (?,?,?)',
                                                           (p[1], p[2], first.get(key) or t)).rowcount:
            n['later'] += 1
    if not c.execute('SELECT 1 FROM page_later_log LIMIT 1').fetchone():  # history: kept even for items gone since
        for e in log:
            p = parse_key(e.get('key'))
            if p and p[0] == 'page':
                c.execute('INSERT INTO page_later_log(item_id, page, op, at) VALUES (?,?,?,?)', (p[1], p[2], e.get('op') or 'later', e.get('at') or t))
                n['later_log'] += 1
    for slot, box in (data.get('frames') or {}).items():
        if str(slot) in ('1', '2') and box and c.execute('INSERT OR IGNORE INTO crop_frame(slot, box, at) VALUES (?,?,?)',
                                                         (str(slot), json.dumps(box), t)).rowcount:
            n['frames'] += 1
    for iid, d in (data.get('sort') or {}).items():
        if d in ('keep', 'delete') and ok(iid) and c.execute('INSERT OR IGNORE INTO sheet_decision(item_id, decision, at) VALUES (?,?,?)',
                                                             (iid, d, t)).rowcount:
            n['sort'] += 1
    for iid, e in (data.get('notes') or {}).items():
        if ok(iid) and c.execute('INSERT OR IGNORE INTO sheet_note(item_id, text, at) VALUES (?,?,?)',
                                 (iid, str((e or {}).get('text') or ''), (e or {}).get('at') or t)).rowcount:
            n['notes'] += 1
    sug_have = {r[0] for r in c.execute('SELECT DISTINCT item_id FROM name_suggestion')}
    for iid, e in (data.get('suggest') or {}).items():  # history: kept even for items gone since
        if iid in sug_have or not isinstance(e, dict): continue
        e = dict(e)
        if e.get('status') not in ('open', 'accepted', 'dismissed'): e['status'] = 'open'
        suggest_add(c, iid, e)
        n['suggest'] += 1
    for bid, e in (data.get('booksplit') or {}).items():
        starts = (e or {}).get('starts') or {}
        if starts and ok(bid) and not split_starts(c, bid):
            split_put(c, bid, {str(k): v for k, v in starts.items() if str(k).isdigit()}, (e or {}).get('at'))
            n['booksplit'] += 1
    undo_have = {r[0] for r in c.execute('SELECT DISTINCT book_id FROM book_split_undo')}
    for bid, stack in (data.get('booksplit_undo') or {}).items():  # history: kept even for books gone since
        if bid in undo_have: continue
        for rec in stack or []:
            split_undo_push(c, bid, rec)
            n['booksplit_undo'] += 1
    c.commit()
    dest = path.with_name(f'{path.name}.imported-{time.strftime("%Y%m%d-%H%M%S")}')
    k = 1
    while dest.exists(): k += 1; dest = dest.with_name(f'{path.name}.imported-{time.strftime("%Y%m%d-%H%M%S")}-{k}')
    path.rename(dest)
    n['file'] = dest.name
    return n
