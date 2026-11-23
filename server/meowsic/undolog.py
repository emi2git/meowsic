"""Writing rollback info onto Activities rows (the rollback itself is undo.py). Only needs db.py, so any module
(items, pages, cleanup, the Photos import…) can import it at the top:

    from .undolog import record_undo
    aid = log_event(c, 'import-photos', title, detail)
    record_undo(c, aid, {'op': 'created', 'ids': ids, 'titles': titles})       # or record_undo(c, 'import-photos', step, title, detail)
"""
import json
import re

from .db import now_ms, quiet_now, uid

FIELDS = ('title', 'artist', 'key', 'version', 'tags')


def _steps_of(payload):
    if payload is None: return None, []
    if isinstance(payload, dict) and 'none' in payload: return payload['none'], []
    if isinstance(payload, dict) and 'steps' in payload: return None, list(payload['steps'])
    if isinstance(payload, dict): return None, [payload]
    return None, list(payload)


def _same_key(a, b):
    if a.get('op') != b.get('op'): return False
    if a['op'] == 'fields': return a.get('id') == b.get('id')
    if a['op'] == 'crop': return (a.get('id'), a.get('page')) == (b.get('id'), b.get('page'))
    if a['op'] in ('mark', 'later'): return a.get('key') == b.get('key')
    return False


def merge_steps(old: list, new: list) -> list:
    """Add steps to a row: a second change of the same field / page / mark keeps the first 'before' and the last 'after'."""
    out = [dict(s) for s in old]
    for s in new:
        prev = next((p for p in reversed(out) if _same_key(p, s)), None)
        if not prev: out.append(dict(s)); continue
        if s['op'] == 'fields':
            for k, v in s.get('new', {}).items():
                if k not in prev['old']: prev['old'][k] = s['old'].get(k)
                prev['new'][k] = v
            prev['title'] = s.get('title', prev.get('title'))
        else:
            prev['after'] = s.get('after')
    return out


def record_undo(c, act, payload, title=None, detail=None, *, type_=None, group=None, window=0):
    """Attach rollback info to an Activities row and return its id (None while a rollback runs).

    act:     an activity id ('act-…') — its steps are added to (made with that id when it is new: the UI may pick
             the id so several requests land in one row) — or a type ('rename', 'import-photos', …) for a new row.
    payload: one step {op, …}, a list of steps, {steps: […]}, or {none: why} (logged, not undoable).
    title / detail: strings, or functions of the merged steps (so a growing row keeps a right summary).
    group / window: with a type, add to the newest row of that type with the same group made in the last `window` ms."""
    if quiet_now(): return None
    none, steps = _steps_of(payload)
    row = None
    if isinstance(act, str) and act.startswith('act-'):
        row = c.execute('SELECT * FROM activity WHERE id=?', (act,)).fetchone()
        if row is None:
            if not re.fullmatch(r'act-[a-z0-9]{3,24}', act): act = uid('act')
            return _insert(c, act, type_ or 'change', title, detail, none, steps)
    elif group is not None:
        r = c.execute('SELECT * FROM activity WHERE type=? AND undone_at IS NULL AND at>=? ORDER BY at DESC LIMIT 1',
                      (act, now_ms() - window)).fetchone()
        if r and (json.loads(r['undo'] or '{}').get('group') == group): row = r
    if row is None:
        return _insert(c, uid('act'), type_ or act, title, detail, none, steps, group)
    u = json.loads(row['undo'] or '{}')
    merged = merge_steps(u.get('steps') or [], steps)
    u = {**u, 'steps': merged}
    u.pop('none', None)
    t = title(merged) if callable(title) else (title if title is not None else row['title'])
    d = detail(merged) if callable(detail) else (detail if detail is not None else row['detail'])
    c.execute('UPDATE activity SET undo=?, title=?, detail=? WHERE id=?', (json.dumps(u, ensure_ascii=False), t or '', d or '', row['id']))
    return row['id']


def _insert(c, aid, type_, title, detail, none, steps, group=None):
    u = {'none': none} if none else {'steps': steps, **({'group': group} if group is not None else {})}
    t = title(steps) if callable(title) else title
    d = detail(steps) if callable(detail) else detail
    c.execute('INSERT INTO activity(id, type, title, detail, at, undo) VALUES (?,?,?,?,?,?)',
              (aid, type_, t or '', d or '', now_ms(), json.dumps(u, ensure_ascii=False)))
    return aid


def fields_step(it: dict, new: dict):
    """A 'fields' step for one item and a patch, or None when nothing tracked changes."""
    old, nw = {}, {}
    for k in FIELDS:
        if k not in new: continue
        a, b = it.get(k), new[k]
        if k == 'tags':
            a, b = list(a or []), list(dict.fromkeys(t.strip() for t in (b or []) if t and t.strip()))
            if set(a) == set(b): continue
        else:
            a, b = a if a is not None else '', b if b is not None else ''
            if a == b: continue
        old[k], nw[k] = a, b
    return {'op': 'fields', 'id': it['id'], 'title': new.get('title') or it.get('title') or '', 'old': old, 'new': nw} if nw else None


def _q(s): return f'“{s}”'


def _one(xs, word):
    return xs[0] if len(xs) == 1 else f'{len(xs)} {word}'


def edit_title(steps):
    ids = [s['id'] for s in steps if s['op'] == 'fields']
    return steps[-1]['title'] if len(set(ids)) == 1 else f'{len(set(ids))} items'


def edit_detail(steps):
    parts = []
    for s in steps[:6]:
        if s['op'] != 'fields': continue
        bits = []
        for k, v in s['new'].items():
            o = s['old'].get(k)
            if k == 'tags':
                add, rem = [t for t in v if t not in (o or [])], [t for t in (o or []) if t not in v]
                bits.append(' '.join([*(f'+{t}' for t in add), *(f'−{t}' for t in rem)]) or 'tags')
            elif k == 'title': bits.append(f'was {_q(o)}')
            else: bits.append(f'{k} {_q(o) if o else "—"} → {_q(v) if v else "—"}')
        parts.append((f'{s["title"]}: ' if len(steps) > 1 else '') + ', '.join(bits))
    return '; '.join(parts) + (f'; and {len(steps) - 6} more' if len(steps) > 6 else '')


