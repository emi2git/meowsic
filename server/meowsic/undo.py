"""Activities: every activity row can carry how to roll it back, and POST /api/activity/{id}/undo does it.

activity.undo is JSON {steps: [{op, ...}, ...]} (or {none: why} = cannot be rolled back). A rollback replays the
steps newest first through the normal code paths (items.update_item, pages.set_book, cleanup.trim_page…), so
folders, files and history stay consistent. Those code paths log nothing while it runs (db.quiet): the rollback
writes one row itself ('rollback', "Rolled back: …"), and the rolled-back row is kept, marked undone_at / undone_by.

Before anything changes every step is checked: 'ok', 'skip' (already the way it was, or gone: nothing to do) or
'conflict' (changed since: rolling back would clobber a later change). Conflicts refuse the whole rollback (409);
{force: true} goes ahead only when every conflicting step is safe to force (FORCE_OK).

Step ops (see record_undo for how they are written):
  fields   {id, title, old: {title|artist|album|key|version|tags}, new: {...}}  PATCH, bulk tags / versions, tag rename / delete
  trash    {ids, titles}            moved to the Trash  -> restore
  restore  {ids, titles}            back from the Trash -> Trash again
  created  {ids, titles}            new items (AI score, job results, Photos imports) -> Trash
  book     {ids, titles, on}        made books / sheets -> the other way
  split    {id, new, take, n, ...}  pages split off    -> put back in their old places
  join     {id, other, n, m, tags}  sheets joined      -> split again, the other back from the Trash
  booksplit {book, at, title}       book → sheets      -> booksplit.unmake
  crop     {id, page, before, after}  trim / untrim     -> the crop before
  mark     {key, before, after, later}  Clean up "fine" marks
  later    {key, before, after}     Clean up "later" marks
  suggest  {id, old, new, title}    name suggestion accepted -> renamed back (the suggestion opens again)
  script   {log}                    a one-off script's history log, replayed in reverse (changed items skipped)
  vocal    {id, title, before: {audio, bpm, history}, after: {audio, bpm}}  Make it sing -> the earlier take / none (voice.undo_vocal)
  credit   {id, title, old: {artist|source}, new, files: [{file, history, sha}]}  credited to Meowsic -> back (creditfix.undo_step)
  musicxml {id, title, file, before, beforeSha, afterSha}  Fit lyrics saved into the score -> the file before, from .history (lyricsedit.undo_musicxml)
Jobs (job table) are rolled back here too: a running one is stopped (cancelled), and what it made goes to the Trash.
"""
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from . import cleanstate as cs
from .db import get_item, job_json, now_ms, quiet, uid
from .items import cfg, conn
from .undolog import FIELDS, _q, record_undo  # noqa: F401  (record_undo: re-exported)

router = APIRouter(prefix='/api')

FORCE_OK = {'fields', 'crop', 'mark', 'later', 'trash', 'restore', 'created', 'vocal', 'credit', 'musicxml'}  # forcing these only overwrites a later edit of the same field
JOB_MADE = ('transcribe', 'version', 'omr')  # job kinds whose result is a list of new item ids
NOT_UNDOABLE = {  # types logged without rollback info: why
    'delete': 'Deleted for good — the files are gone, there is nothing to bring back.',
    'print': 'Printing changes nothing in the library.',
    'rollback': 'This is a rollback itself. Undo the change again from the library instead.',
    'unbooksplit': 'This put a book back together already; make the sheets again in Manage library → Books.',
    'photo-unimport': 'This undid a From Photos import already; add the photos again from Add music → From Photos.',
    'unsongsplit': 'This put a sheet back together already; split it again in Manage library → Split songs.',
    'migrate': 'This one-off change kept no history log.',
    'tags-job': 'AI tag suggestions change nothing until you apply them.',
}


# ---------- what a rollback would do (shown before asking) ----------

def describe(step) -> str:
    op = step.get('op')
    if op == 'fields':
        bits = []
        for k, o in step['old'].items():
            if k == 'tags': bits.append('tags back to ' + (', '.join(o) or 'none'))
            elif k == 'title': bits.append(f'title back to {_q(o)}')
            else: bits.append(f'{k} back to {_q(o) if o else "none"}')
        return f'{_q(step.get("title", ""))}: ' + ', '.join(bits)
    n = len(step.get('ids') or [])
    names = ', '.join(_q(t) for t in (step.get('titles') or [])[:3]) + (f' and {n - 3} more' if n > 3 else '')
    if op == 'trash': return f'Bring {names or f"{n} items"} back from the Trash'
    if op == 'restore': return f'Move {names or f"{n} items"} to the Trash again'
    if op == 'created': return f'Move {names or f"{n} new items"} to the Trash'
    if op == 'book': return f'Make {names} {"sheets" if step.get("on") else "books"} again'
    if op == 'split': return f'Put pages {", ".join(map(str, step["take"]))} of {_q(step.get("newTitle", ""))} back into {_q(step.get("title", ""))}'
    if op == 'join': return f'Take {_q(step.get("otherTitle", ""))} out of {_q(step.get("title", ""))} again (back from the Trash)'
    if op == 'booksplit': return f'Put the pages of the new sheets back into the {"book" if step.get("books", True) else "sheet"} {_q(step.get("title", ""))}'
    if op == 'crop': return f'{_q(step.get("title", ""))} page {step["page"]}: ' + ('back to the original photo' if not step.get('before') else 'back to the crop before')
    if op == 'mark': return f'{"Mark" if step.get("before") else "Unmark"} {step["key"]} {"as fine" if step.get("before") else ""}'.strip()
    if op == 'later': return f'{"Leave" if step.get("before") else "Take the later mark off"} {step["key"]}{" for later" if step.get("before") else ""}'
    if op == 'suggest': return f'Rename {_q(step.get("title", ""))} back to ' + ' · '.join(_q(v) for v in step.get('old', {}).values())
    if op == 'photoimport': return f'Remove the {len(step.get("titles") or [])} sheet(s) this import made ({names or ""}); the photos count as new again'.replace(' ()', '')
    if op == 'credit': return f'{_q(step.get("title", ""))}: ' + ', '.join([f'{k} back to {_q(v) if v else "none"}' for k, v in step['old'].items()] + (['the MusicXML credit back (from .history)'] if step.get('files') else []))
    if op == 'script': return f'Replay {step["log"]} in reverse (items changed since are skipped)'
    if op == 'vocal': return f'{_q(step.get("title", ""))}: ' + ('back to the earlier sung take' if (step.get('before') or {}).get('audio') else 'no sung voice (the take stays in .history)')
    if op == 'musicxml': return f'{_q(step.get("title", ""))}: back to the score before the {step.get("what") or "change"} (now kept in .history)'
    return op or '?'


# ---------- one-off scripts: their history logs ----------

LOG_RE = re.compile(r'history[/:]\s*([\w.\-]+\.jsonl?)')
SCRIPT_TYPES = ('migrate', 'rename', 'tags', 'make-tags', 'version', 'change')


def legacy(row) -> dict | None:
    """Rows written before rollback info existed: a one-off script that names its history log can still be replayed."""
    if row['type'] not in SCRIPT_TYPES: return None
    d = row['detail'] or ''
    m = LOG_RE.search(d)
    if not m or 'undo of' in d or '-undo-' in m.group(1): return None
    return {'steps': [{'op': 'script', 'log': f'history/{m.group(1)}'}]}


def _log_entries(path: Path):
    """The changes in a history log, oldest first, whatever script wrote it (.jsonl lines or a .json file)."""
    text = path.read_text()
    if path.suffix == '.jsonl':
        return [json.loads(x) for x in text.splitlines() if x.strip()]
    d = json.loads(text)
    if isinstance(d, list): return d
    for k in ('changes', 'items', 'entries', 'log'):
        if isinstance(d.get(k), list): return [{**({'tag': d['tag']} if 'tag' in d and isinstance(e, dict) else {}), **e} if isinstance(e, dict) else e for e in d[k]]
    if isinstance(d.get('ids'), list) and (d.get('tag') or d.get('tags')):  # {tag(s), ids}: tags added to these items
        tags = [d['tag']] if d.get('tag') else list(d['tags'])
        return [{'id': i, 'added': tags} for i in d['ids']]
    return []


def _as_fields(e, name):
    """(old, new) field dicts for one log entry, or None."""
    for a, b in (('before', 'after'), ('old', 'new')):
        if a in e and b in e:
            o, n = e[a], e[b]
            if n is None: return None
            if not isinstance(n, dict):  # versions-*.jsonl: before / after are the version
                fld = 'version' if 'version' in name or e.get('via') == 'fill_sheet_versions' else 'key' if 'key' in name else 'title'
                return {fld: o}, {fld: n}
            o = o if isinstance(o, dict) else {}
            return {k: o.get(k, '' if k != 'tags' else []) for k in n if k in FIELDS}, {k: v for k, v in n.items() if k in FIELDS}
    return None


def replay_script(c, cf, step, mode):
    """Put back what a script's log changed, newest first; items that look different now are skipped."""
    from .items import update_item
    rel = step['log']
    path = (cf.data / rel).resolve()
    if not path.is_relative_to((cf.data / 'history').resolve()) or not path.is_file():
        return [{'status': 'conflict', 'what': rel, 'why': 'the history log is missing'}]
    try: entries = _log_entries(path)
    except (ValueError, OSError) as e: return [{'status': 'conflict', 'what': rel, 'why': f'the history log cannot be read: {e}'}]
    if entries and isinstance(entries[0], dict) and 'folder' in entries[0]:  # folders-*.jsonl: migrate_id_folders.py --undo
        if mode == 'check': return [{'status': 'ok', 'what': f'{len(entries)} folder moves in {rel}'}]
        from .idfolders import undo as folders_undo
        c.commit()  # it uses its own connection
        res = folders_undo(cf.data, path, out=lambda *a: None)
        return [{'status': 'done', 'what': f'{res["items"]} folder(s) moved back'}] + \
               ([{'status': 'skip', 'what': f'{res["skipped"]} folder(s)', 'why': 'already back or changed since'}] if res['skipped'] else [])
    out = []
    for e in reversed(entries):
        if not isinstance(e, dict) or not e.get('id'):
            out.append({'status': 'skip', 'what': str(e)[:60], 'why': 'not a change this can read'}); continue
        it = get_item(c, e['id'])
        what = _q(it['title'] if it else e.get('title') or e['id'])
        if not it: out.append({'status': 'skip', 'what': what, 'why': 'deleted for good since'}); continue
        if 'added' in e or 'removed' in e:  # tag batches: {id, added: [...], removed: [...]}
            add = [e['added']] if isinstance(e.get('added'), str) else list(e.get('added') or [])
            rem = [e['removed']] if isinstance(e.get('removed'), str) else list(e.get('removed') or [])
            if not all(t in it['tags'] for t in add) or any(t in it['tags'] for t in rem):
                out.append({'status': 'skip', 'what': what, 'why': 'tags changed since'}); continue
            if mode != 'check':
                update_item(e['id'], {'tags': [*[t for t in it['tags'] if t not in add], *rem]}, c, cf)
            out.append({'status': 'ok', 'what': what}); continue
        f = _as_fields(e, path.name)
        if not f: out.append({'status': 'skip', 'what': what, 'why': 'not a change this can read'}); continue
        old, new = f
        if _matches(it, old) and not _matches(it, new): out.append({'status': 'skip', 'what': what, 'why': 'already back'}); continue
        if not _matches(it, new): out.append({'status': 'skip', 'what': what, 'why': 'changed since'}); continue
        if mode != 'check': update_item(e['id'], dict(old), c, cf)
        out.append({'status': 'ok', 'what': what})
    return out


# ---------- checking and doing each step ----------

def _same(k, a, b):
    if k == 'tags': return set(a or []) == set(b or [])
    return (a if a is not None else '') == (b if b is not None else '')


def _matches(it, vals: dict):
    return all(_same(k, it.get(k), v) for k, v in vals.items())


def _fields(c, cf, s, mode):
    from .items import update_item
    it = get_item(c, s['id'])
    what = _q(it['title'] if it else s.get('title', s['id']))
    if not it: return [{'status': 'skip', 'what': what, 'why': 'deleted for good since'}]
    if _matches(it, s['old']) and not _matches(it, s['new']): return [{'status': 'skip', 'what': what, 'why': 'already back'}]
    if not _matches(it, s['new']):
        changed = [k for k, v in s['new'].items() if not _same(k, it.get(k), v)]
        r = {'status': 'conflict', 'what': what, 'why': f'{", ".join(changed)} changed since'}
        if mode != 'force': return [r]
    if mode != 'check': update_item(s['id'], dict(s['old']), c, cf)
    return [{'status': 'ok', 'what': what}]


def _each(c, s, want_deleted):
    """Split ids into ok / skipped by whether they are in the Trash now."""
    ok, res = [], []
    for i, t in zip(s['ids'], s.get('titles') or [''] * len(s['ids'])):
        r = c.execute('SELECT title, deleted_at FROM item WHERE id=?', (i,)).fetchone()
        what = _q(r[0] if r else t or i)
        if not r: res.append({'status': 'skip', 'what': what, 'why': 'deleted for good since'})
        elif (r[1] is not None) != want_deleted: res.append({'status': 'skip', 'what': what, 'why': 'already back' if want_deleted else 'already in the Trash'})
        else: ok.append(i); res.append({'status': 'ok', 'what': what})
    return ok, res


def _trash(c, cf, s, mode):  # was moved to the Trash: restore
    from .items import restore
    ok, res = _each(c, s, True)
    if ok and mode != 'check': restore({'ids': ok}, c)
    return res


def _untrash(c, cf, s, mode):  # restore / created: to the Trash
    from .items import trash
    ok, res = _each(c, s, False)
    if ok and mode != 'check': trash({'ids': ok}, c)
    return res


def _book(c, cf, s, mode):
    from .pages import set_book
    ok, res = [], []
    for i in s['ids']:
        it = get_item(c, i)
        if not it: res.append({'status': 'skip', 'what': i, 'why': 'deleted for good since'}); continue
        if bool(it.get('book')) != bool(s['on']): res.append({'status': 'skip', 'what': _q(it['title']), 'why': 'already back'}); continue
        ok.append(i); res.append({'status': 'ok', 'what': _q(it['title'])})
    if ok and mode != 'check': set_book({'ids': ok, 'book': not s['on']}, c, cf)
    return res


def _split(c, cf, s, mode):
    from .items import purge
    from .pages import _forget_items, _relayout, _rows
    it, new = get_item(c, s['id']), get_item(c, s['new'])
    what = _q(s.get('newTitle', ''))
    if not it or it['deleted']: return [{'status': 'conflict', 'what': what, 'why': f'{_q(s.get("title", ""))} is gone or in the Trash'}]
    if not new: return [{'status': 'conflict', 'what': what, 'why': 'deleted for good since'}]
    if new['deleted'] or new['pages'] != len(s['take']) or it['pages'] != s['n'] - len(s['take']):
        return [{'status': 'conflict', 'what': what, 'why': 'pages changed since (or it is in the Trash)'}]
    if mode == 'check': return [{'status': 'ok', 'what': what}]
    rest, back = _rows(c, s['id']), _rows(c, s['new'])
    take = set(s['take'])
    order = [(back if p in take else rest).pop(0) for p in range(1, s['n'] + 1)]
    _relayout(c, cf, s['id'], order)
    purge({'ids': [s['new']]}, c, cf)  # just made by the split, empty now
    _forget_items(c, s['id'], s['new'])
    return [{'status': 'ok', 'what': what}]


def _join(c, cf, s, mode):
    from .items import restore
    from .pages import _forget_items, _relayout, _rows
    it, other = get_item(c, s['id']), get_item(c, s['other'])
    what = _q(s.get('otherTitle', ''))
    if not it or it['deleted']: return [{'status': 'conflict', 'what': what, 'why': f'{_q(s.get("title", ""))} is gone or in the Trash'}]
    if not other: return [{'status': 'conflict', 'what': what, 'why': 'deleted for good since'}]
    if not other['deleted'] or other['pages'] or it['pages'] != s['n'] + s['m']:
        return [{'status': 'conflict', 'what': what, 'why': 'pages changed since'}]
    if mode == 'check': return [{'status': 'ok', 'what': what}]
    rows = _rows(c, s['id'])
    _relayout(c, cf, s['other'], rows[s['n']:])
    _relayout(c, cf, s['id'], _rows(c, s['id']))
    c.executemany('DELETE FROM item_tag WHERE item_id=? AND tag=?', [(s['id'], t) for t in s.get('tags') or []])
    restore({'ids': [s['other']]}, c)
    _forget_items(c, s['id'], s['other'])
    return [{'status': 'ok', 'what': what}]


def _booksplit(c, cf, s, mode):
    from .booksplit import unmake
    what = _q(s.get('title', ''))
    stack = cs.split_undo_stack(c, s['book'])
    if not any(r.get('at') == s['at'] for r in stack): return [{'status': 'skip', 'what': what, 'why': 'already put back (Manage library)'}]
    if stack[-1].get('at') != s['at']: return [{'status': 'conflict', 'what': what, 'why': 'the book was split again later: roll that back first'}]
    if mode == 'check':
        rec = stack[-1]
        if len(c.execute('SELECT 1 FROM sheet_page WHERE item_id=?', (s['book'],)).fetchall()) != rec['lead']:
            return [{'status': 'conflict', 'what': what, 'why': 'the book has changed since'}]
        for m in rec['sheets']:
            x = get_item(c, m['id'])
            if not x or x['deleted'] or x['pages'] != m['pages']:
                return [{'status': 'conflict', 'what': what, 'why': f'{_q(m["title"])} has changed since'}]
        return [{'status': 'ok', 'what': what}]
    unmake(s['book'], c=c, cf=cf, books=s.get('books', True))
    return [{'status': 'ok', 'what': what}]


def _close(a, b):
    if not a or not b: return not a and not b
    return all(abs(float(a.get(k, d)) - float(b.get(k, d))) < 2e-3 for k, d in (('top', 0), ('bottom', 1), ('left', 0), ('right', 1)))


def _crop(c, cf, s, mode):
    from .cleanup import _crop_of, _steps, trim_page, untrim_page
    from .db import folder_path
    it = get_item(c, s['id'])
    what = f'{_q(it["title"] if it else s.get("title", ""))} p{s["page"]}'
    if not it or not it.get('folder') or s['page'] > len(it.get('pageFiles') or []):
        return [{'status': 'skip', 'what': what, 'why': 'the page is gone'}]
    now = _crop_of(_steps(folder_path(cf, it['folder']), s['page']))
    if _close(now, s.get('before')): return [{'status': 'skip', 'what': what, 'why': 'already back'}]
    if not _close(now, s.get('after')):
        if mode != 'force': return [{'status': 'conflict', 'what': what, 'why': 'cropped again since'}]
    if mode != 'check':
        if s.get('before'): trim_page(s['id'], s['page'], dict(s['before']), c, cf)
        else: untrim_page(s['id'], s['page'], {'all': True}, c, cf)
    return [{'status': 'ok', 'what': what}]


def _mark(c, cf, s, mode):
    key = s['key']
    on = key in cs.marks(c)
    if on == bool(s['before']): return [{'status': 'skip', 'what': key, 'why': 'already back'}]
    if on != bool(s['after']) and mode != 'force': return [{'status': 'conflict', 'what': key, 'why': 'changed since'}]
    if mode != 'check':
        cs.mark(c, key, bool(s['before']))
        p = cs.parse_key(key)
        if s.get('later') and p and p[0] == 'page': cs.later(c, p[1], p[2], True)
    return [{'status': 'ok', 'what': key}]


def _later(c, cf, s, mode):
    key = s['key']
    p = cs.parse_key(key)
    on = key in cs.later_keys(c)
    if on == bool(s['before']): return [{'status': 'skip', 'what': key, 'why': 'already back'}]
    if on != bool(s['after']) and mode != 'force': return [{'status': 'conflict', 'what': key, 'why': 'changed since'}]
    if mode != 'check': cs.later(c, p[1], p[2], bool(s['before']))
    return [{'status': 'ok', 'what': key}]


def _suggest(c, cf, s, mode):
    from .cleanup import suggest_done
    it = get_item(c, s['id'])
    what = _q(it['title'] if it else s.get('title', ''))
    ent = cs.suggestion(c, s['id'])
    if not it: return [{'status': 'skip', 'what': what, 'why': 'deleted for good since'}]
    if not ent or ent.get('status') != 'accepted': return [{'status': 'skip', 'what': what, 'why': 'already undone (Manage library → Titles)'}]
    if not _matches(it, s.get('new') or {}): return [{'status': 'conflict', 'what': what, 'why': 'renamed again since'}]
    if mode != 'check': suggest_done(s['id'], {'action': 'undo'}, c, cf)
    return [{'status': 'ok', 'what': what}]


def _photoimport(c, cf, s, mode):
    from .photoimport import undo as unimport
    r = c.execute('SELECT record, undone_at FROM photo_import WHERE id=?', (s['import'],)).fetchone()
    what = ', '.join(_q(t) for t in (s.get('titles') or [])[:3]) or s['import']
    if not r: return [{'status': 'conflict', 'what': what, 'why': 'the import record is gone'}]
    if r[1]: return [{'status': 'skip', 'what': what, 'why': 'already undone (From Photos)'}]
    for m in json.loads(r[0])['sheets']:
        it = get_item(c, m['id'])
        if it and (it['pages'] != m['pages'] or it['kind'] != 'sheet'):
            return [{'status': 'conflict', 'what': _q(it['title']), 'why': 'pages changed since (added, split or joined)'}]
    if mode != 'check': unimport(s['import'], c=c, cf=cf)
    return [{'status': 'ok', 'what': what}]


def _script(c, cf, s, mode):
    res = replay_script(c, cf, s, mode)
    return [r if r['status'] != 'conflict' or r['why'].startswith('the history log') else {**r, 'status': 'skip'} for r in res]


def _credit(c, cf, s, mode):  # Scores credited to Meowsic -> back (creditfix.py)
    from .creditfix import undo_step
    return undo_step(c, cf, s, mode)


def _vocal(c, cf, s, mode):  # Make it sing -> the earlier take (voice.py)
    from .voice import undo_vocal
    return undo_vocal(c, cf, s, mode)


def _musicxml(c, cf, s, mode):  # Fit lyrics -> the MusicXML before (lyricsedit.py)
    from .lyricsedit import undo_musicxml
    return undo_musicxml(c, cf, s, mode)


OPS = {'fields': _fields, 'trash': _trash, 'restore': _untrash, 'created': _untrash, 'book': _book, 'split': _split,
       'join': _join, 'booksplit': _booksplit, 'crop': _crop, 'mark': _mark, 'later': _later, 'suggest': _suggest, 'script': _script, 'photoimport': _photoimport,
       'vocal': _vocal, 'credit': _credit, 'musicxml': _musicxml}


# ---------- listing ----------

def _undo_of_row(row):
    try: u = json.loads(row['undo']) if row['undo'] else None
    except ValueError: u = None
    return u if u is not None else legacy(row)


def row_json(row, job_undone=None) -> dict:
    a = {k: row[k] for k in ('id', 'type', 'title', 'detail', 'at')}
    a.update(status='done', undoneAt=row['undone_at'], undoneBy=row['undone_by'], undoOf=row['undo_of'])
    u = _undo_of_row(row)
    steps = (u or {}).get('steps') or []
    if row['undone_at']: a['action'] = None
    elif steps: a['action'] = 'undo'
    else: a['action'], a['noUndo'] = None, (u or {}).get('none') or NOT_UNDOABLE.get(row['type']) or 'Kept no undo information (logged before Activities could roll things back).'
    if steps: a['undoText'] = [describe(s) for s in reversed(steps[-8:])] + ([f'… and {len(steps) - 8} more'] if len(steps) > 8 else [])
    return a


def job_activity(j: dict, undone: dict) -> dict:
    a = {**j, 'type': j['kind'], 'at': j['startedAt'], 'undoneAt': None, 'undoneBy': None}
    if j['id'] in undone: a['undoneAt'], a['undoneBy'] = undone[j['id']]
    made = j['result'] if isinstance(j.get('result'), list) else []
    if j['status'] in ('queued', 'running'):
        a['action'] = 'stop'
        a['undoText'] = ['Stop the job'] + ([f'Move the {len(made)} item(s) it made so far to the Trash'] if made else [])
    elif a['undoneAt']: a['action'] = None
    elif j['kind'] in JOB_MADE and made:
        a['action'], a['undoText'] = 'undo', [f'Move the {len(made)} item(s) it made to the Trash']
    else:
        a['action'] = None
        a['noUndo'] = (NOT_UNDOABLE['tags-job'] if j['kind'] == 'tags' else 'Undo it from its “Made … sing” row.' if j['kind'] == 'sing' and j['status'] == 'done'
                       else 'Nothing was made, nothing to roll back.')
    return a


def list_activity(c, limit=500):
    rows = c.execute('SELECT * FROM activity ORDER BY at DESC LIMIT ?', (limit,)).fetchall()
    undone = {r['undo_of']: (r['at'], r['id']) for r in c.execute("SELECT undo_of, at, id FROM activity WHERE type='rollback' AND undo_of LIKE 'job-%'")}
    js = [job_activity(job_json(r), undone) for r in c.execute('SELECT * FROM job ORDER BY started_at DESC')]
    return sorted([row_json(r) for r in rows] + js, key=lambda a: -a['at'])[:limit]


@router.get('/activity')
def get_activity(limit: int = 500, c=Depends(conn)):
    """Change events plus jobs, newest first; each with action 'undo' | 'stop' | None, undoText, noUndo, undoneAt."""
    return list_activity(c, limit)


# ---------- rolling back ----------

def _summary(res):
    done = [r for r in res if r['status'] in ('ok', 'done')]
    skipped = [r for r in res if r['status'] == 'skip']
    return done, skipped


def _rollback_row(c, of_id, label, done, skipped):
    detail = f'{len(done)} change(s) rolled back' + (f'; {len(skipped)} skipped: ' + '; '.join(f'{r["what"]} ({r["why"]})' for r in skipped[:5]) if skipped else '')
    rid = uid('act')
    c.execute("INSERT INTO activity(id, type, title, detail, at, undo, undo_of) VALUES (?,?,?,?,?,?,?)",
              (rid, 'rollback', f'Rolled back: {label}', detail, now_ms(), json.dumps({'none': NOT_UNDOABLE['rollback']}), of_id))
    return rid


def _undo_job(c, cf, job_id):
    from .items import trash
    from .jobs import cancel_job
    r = c.execute('SELECT * FROM job WHERE id=?', (job_id,)).fetchone()
    if not r: raise HTTPException(404, 'No such activity')
    j = job_json(r)
    if c.execute("SELECT 1 FROM activity WHERE type='rollback' AND undo_of=?", (job_id,)).fetchone():
        raise HTTPException(409, {'message': 'Already rolled back', 'reason': 'done'})
    running = j['status'] in ('queued', 'running')
    if running: cancel_job(job_id, c)
    c.commit()
    if running: time.sleep(0.3)  # a runner saving its items right now: let it finish (save_outputs checks cancelled first)
    made = json.loads(c.execute('SELECT result FROM job WHERE id=?', (job_id,)).fetchone()[0] or 'null')
    made = made if isinstance(made, list) and j['kind'] in JOB_MADE else []
    if not running and not made:
        raise HTTPException(409, {'message': NOT_UNDOABLE['tags-job'] if j['kind'] == 'tags' else 'Nothing to roll back: the job made nothing.', 'reason': 'not-undoable'})
    ok, res = _each(c, {'ids': made}, False)
    with quiet():
        if ok: trash({'ids': ok}, c)
    res = ([{'status': 'done', 'what': 'job stopped'}] if running else []) + res
    done, skipped = _summary(res)
    rid = _rollback_row(c, job_id, ('Stopped ' if running else '') + (j['title'] or j['kind']), done, skipped)
    c.commit()
    return {'ok': True, 'id': job_id, 'rollback': rid, 'stopped': running, 'changed': len([r for r in done if r['what'] != 'job stopped']),
            'skipped': skipped, 'message': ('Stopped' if running else 'Rolled back') + (f' — {len(ok)} item(s) moved to the Trash' if ok else '')}


def undo_activity(c, cf, act_id, force=False):
    if act_id.startswith('job-'): return _undo_job(c, cf, act_id)
    row = c.execute('SELECT * FROM activity WHERE id=?', (act_id,)).fetchone()
    if not row: raise HTTPException(404, 'No such activity')
    if row['undone_at']:
        raise HTTPException(409, {'message': f'Already rolled back ({time.strftime("%d %b %H:%M", time.localtime(row["undone_at"] / 1000))})', 'reason': 'done'})
    u = _undo_of_row(row)
    steps = (u or {}).get('steps') or []
    if not steps:
        a = row_json(row)
        raise HTTPException(409, {'message': f'This can’t be rolled back: {a.get("noUndo")}', 'reason': 'not-undoable'})
    steps = list(reversed(steps))
    checks = []
    for s in steps:
        fn = OPS.get(s.get('op'))
        if not fn: raise HTTPException(409, {'message': f'Unknown change {s.get("op")!r}: cannot roll it back', 'reason': 'not-undoable'})
        checks.append(fn(c, cf, s, 'check'))
    conflicts = [(s, r) for s, rs in zip(steps, checks) for r in rs if r['status'] == 'conflict']
    can_force = all(s['op'] in FORCE_OK for s, _ in conflicts)
    if conflicts and not (force and can_force):
        lines = [f'{r["what"]}: {r["why"]}' for _, r in conflicts]
        raise HTTPException(409, {'message': 'Changed since — rolling back would undo later changes: ' + '; '.join(lines[:5]) + (f' (and {len(lines) - 5} more)' if len(lines) > 5 else ''),
                                  'reason': 'conflict', 'conflicts': lines, 'canForce': can_force})
    res, error = [], None
    with quiet():
        for s in steps:
            try:
                res += OPS[s['op']](c, cf, s, 'force' if force else 'apply')
                c.commit()
            except HTTPException as e:
                c.rollback(); error = e.detail if isinstance(e.detail, str) else (e.detail or {}).get('message', str(e.detail)); break
            except Exception as e:
                c.rollback(); error = str(e); break
    done, skipped = _summary(res)
    if error:
        if done: c.execute('UPDATE activity SET detail=? WHERE id=?', (f'{row["detail"]} · partly rolled back ({len(done)} done) — stopped: {error}'.strip(' ·'), act_id)); c.commit()
        raise HTTPException(409, {'message': f'Stopped: {error}' + (f' ({len(done)} change(s) were rolled back before that; Undo again does the rest)' if done else ''), 'reason': 'failed', 'changed': len(done)})
    label = row['title'] or row['type']
    rid = _rollback_row(c, act_id, label, done, skipped)
    c.execute('UPDATE activity SET undone_at=?, undone_by=? WHERE id=?', (now_ms(), rid, act_id))
    c.commit()
    msg = f'Rolled back {len(done)} change(s)' if done else 'Nothing to change — it was already back'
    return {'ok': True, 'id': act_id, 'rollback': rid, 'changed': len(done), 'skipped': skipped,
            'message': msg + (f'; {len(skipped)} skipped' if skipped and done else ''), 'forced': bool(force and conflicts)}


@router.post('/activity/{act_id}/undo')
def post_undo(act_id: str, body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    """Roll one activity back (or stop a running job and roll back what it made). {force: true} = go ahead over
    later edits of the same fields / crops / marks. 409 {message, reason: not-undoable | done | conflict | failed}."""
    return undo_activity(c, cf, act_id, bool((body or {}).get('force')))
