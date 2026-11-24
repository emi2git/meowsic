"""Feedback (Utilities → Feedback, #/feedback): notes the user sends about the app, for Claude to work through.

Quick feedback (the speech-bubble button in a score, sheet or chord view) also sends what it is about:
item_id / item_kind / item_title and a small context JSON ({page, pages, bar, timeSec, zoom, version, device, view}).

Status: new → in_progress → fixed (or wontfix). Fixed / Won't fix rows are locked: no edit, no remove (409).
Nothing is ever deleted: Remove sets removed_at; every edit, status change and removal first copies the row's
previous state into feedback_history. The user only writes text; Claude sets the status
(PATCH {status, fixNote}, or ~/git/scripts/meowsic-feedback.py).
"""
import json

from fastapi import APIRouter, Body, Depends, HTTPException

from .db import now_ms, uid
from .items import conn

STATUSES = ('new', 'in_progress', 'fixed', 'wontfix')
LOCKED = ('fixed', 'wontfix')
MAX_TEXT = 20000
MAX_CTX = 4000

router = APIRouter(prefix='/api/feedback')


# ===== migration: feedback tables (own block, runs every start, IF NOT EXISTS) =====
def ensure_schema(c):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','fixed','wontfix')),
        fixed_at INTEGER,
        fix_note TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '',
        removed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_at);
    CREATE TABLE IF NOT EXISTS feedback_history (  -- the row as it was before each change (never pruned)
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedback_id TEXT NOT NULL REFERENCES feedback(id),
        change TEXT NOT NULL,          -- 'edit' | 'status' | 'remove'
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        fix_note TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_history_fb ON feedback_history(feedback_id);
    """)
    # quick feedback from an item view: what it was about (added later; older tables get the columns)
    have = {r[1] for r in c.execute('PRAGMA table_info(feedback)')}
    for col, decl in (('item_id', "TEXT NOT NULL DEFAULT ''"), ('item_kind', "TEXT NOT NULL DEFAULT ''"),
                      ('item_title', "TEXT NOT NULL DEFAULT ''"), ('context', "TEXT NOT NULL DEFAULT '{}'")):
        if col not in have: c.execute(f'ALTER TABLE feedback ADD COLUMN {col} {decl}')
    c.commit()
# ===== end feedback migration =====


def _ctx(raw):
    try:
        v = json.loads(raw or '{}')
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


def fb_json(r) -> dict:
    keys = r.keys()
    item = {'id': r['item_id'], 'kind': r['item_kind'], 'title': r['item_title']} if 'item_id' in keys and r['item_id'] else None
    return {'item': item, 'context': _ctx(r['context']) if 'context' in keys else {},
            'id': r['id'], 'text': r['text'], 'createdAt': r['created_at'], 'updatedAt': r['updated_at'], 'status': r['status'],
            'fixedAt': r['fixed_at'], 'fixNote': r['fix_note'], 'device': r['device'], 'removedAt': r['removed_at'],
            'locked': r['status'] in LOCKED}


def _get(c, fid):
    r = c.execute('SELECT * FROM feedback WHERE id=?', (fid,)).fetchone()
    if not r: raise HTTPException(404, 'No such feedback')
    return r


def _history(c, r, change):
    c.execute('INSERT INTO feedback_history(feedback_id, change, text, status, fix_note, at) VALUES (?,?,?,?,?,?)',
              (r['id'], change, r['text'], r['status'], r['fix_note'], now_ms()))


def _text(v):
    t = (v or '').strip() if isinstance(v, str) else ''
    if not t: raise HTTPException(400, 'Feedback text is empty')
    return t[:MAX_TEXT]


@router.get('')
def list_feedback(removed: bool = False, c=Depends(conn)):
    """Newest first. ?removed=1 includes removed ones."""
    q = 'SELECT * FROM feedback' + ('' if removed else ' WHERE removed_at IS NULL') + ' ORDER BY created_at DESC, rowid DESC'
    return [fb_json(r) for r in c.execute(q)]


@router.get('/{fid}')
def get_feedback(fid: str, c=Depends(conn)):
    r = fb_json(_get(c, fid))
    r['history'] = [dict(h) for h in c.execute('SELECT change, text, status, fix_note AS fixNote, at FROM feedback_history WHERE feedback_id=? ORDER BY id', (fid,))]
    return r


@router.post('', status_code=201)
def add_feedback(body: dict = Body(...), c=Depends(conn)):
    """{text, device?, id?, createdAt?, item?: {id, kind, title}, context?: {…}}: the app sends its own id so a retried (offline outbox) send is not stored twice."""
    text = _text(body.get('text'))
    fid = str(body.get('id') or '') or uid('fb')
    old = c.execute('SELECT * FROM feedback WHERE id=?', (fid,)).fetchone()
    if old: return fb_json(old)
    now = now_ms()
    at = body.get('createdAt') if isinstance(body.get('createdAt'), int) and 0 < body['createdAt'] <= now + 60000 else now
    item = body.get('item') if isinstance(body.get('item'), dict) else {}
    ctx = body.get('context') if isinstance(body.get('context'), dict) else {}
    ctx_s = json.dumps(ctx, ensure_ascii=False)
    if len(ctx_s) > MAX_CTX: ctx_s = '{}'
    c.execute('INSERT INTO feedback(id, text, created_at, updated_at, status, device, item_id, item_kind, item_title, context)'
              ' VALUES (?,?,?,?,?,?,?,?,?,?)',
              (fid, text, at, now, 'new', str(body.get('device') or '')[:60], str(item.get('id') or '')[:120],
               str(item.get('kind') or '')[:20], str(item.get('title') or '')[:300], ctx_s))
    return fb_json(_get(c, fid))


@router.patch('/{fid}')
def patch_feedback(fid: str, body: dict = Body(...), c=Depends(conn)):
    """{text} — the user's edit (refused once Fixed / Won't fix); {status, fixNote} — Claude's."""
    r = _get(c, fid)
    if r['removed_at'] is not None: raise HTTPException(409, 'This feedback was removed')
    now = now_ms()
    if 'text' in body:
        if r['status'] in LOCKED: raise HTTPException(409, 'Fixed feedback can no longer be edited')
        text = _text(body['text'])
        if text != r['text']:
            _history(c, r, 'edit')
            c.execute('UPDATE feedback SET text=?, updated_at=? WHERE id=?', (text, now, fid))
            r = _get(c, fid)
    if 'status' in body or 'fixNote' in body:
        st = body.get('status', r['status'])
        if st not in STATUSES: raise HTTPException(400, f'status must be one of {", ".join(STATUSES)}')
        note = str(body.get('fixNote', r['fix_note']) or '')
        if st != r['status'] or note != r['fix_note']:
            _history(c, r, 'status')
            fixed_at = (r['fixed_at'] or now) if st in LOCKED else None
            c.execute('UPDATE feedback SET status=?, fix_note=?, fixed_at=?, updated_at=? WHERE id=?', (st, note, fixed_at, now, fid))
    return fb_json(_get(c, fid))


@router.delete('/{fid}')
def remove_feedback(fid: str, c=Depends(conn)):
    """Soft remove: the row stays with removed_at (and a history row)."""
    r = _get(c, fid)
    if r['status'] in LOCKED: raise HTTPException(409, 'Fixed feedback can no longer be removed')
    if r['removed_at'] is None:
        _history(c, r, 'remove')
        now = now_ms()
        c.execute('UPDATE feedback SET removed_at=?, updated_at=? WHERE id=?', (now, now, fid))
    return fb_json(_get(c, fid))
