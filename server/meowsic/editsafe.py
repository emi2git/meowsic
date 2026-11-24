"""Edit notes can never lose the user's edits (web/js/views/editnotes.js; Nov 2026, after 30 min of edits were lost
to a 409 when an agent saved the same score meanwhile).

1. Edit sessions — a presence lock. The editor starts one when it opens and beats every ~25 s; it lives while
   beat_at is younger than TTL_MS (so a crashed tab or a sleeping iPad lets go by itself) and is kept in the DB
   (a server restart keeps it). While a session is active, every other API write to that item (edit notes, lyrics,
   check bars, simple piano, MusicXML put / revert, page edits, a lyrics job …) gets 423 Locked — unless the
   request carries an active session id of that item in the X-Edit-Session header (the editor's own calls).
   lock_middleware (app.py) does the check by URL; jobs.create_job and items.trash check the item ids in the body.
2. Drafts on disk: <data>/drafts/<item id>/draft-<session>.json ({session, sha, ops, savedAt, n, title}) and
   draft-<session>.musicxml (the edited result) — written by the editor every ~30 s of edits and when the page is
   hidden; deleted when that session saves. base-<sha>.musicxml: the score as the editor opened it, so previews
   and the save always replay the ops on the text they were made on, even after another client changed the file.
3. rebase(): at Save, when the file changed since the editor opened it, the user's ops are replayed on the CURRENT
   file. An op is applied only when the bars it touches read the same in both (notes, attributes, chord names; the
   verse for a lyrics op); its note refs are mapped onto the current file. What can't apply is left out of the
   merge, and staffmove.save also keeps the full edited score as a new version "<title> (my edits)".

GET  /api/items/{id}/editsession                -> {active, sessions: [{since, beatAt}]}
POST /api/items/{id}/editsession       {session, sha?}  start / heartbeat -> {ok, session, others}
POST /api/items/{id}/editsession/end   {session}        (a sendBeacon on pagehide is fine)
GET  /api/items/{id}/editnotes/draft            -> {drafts: [{session, sha, n, savedAt, title}]} newest first
GET  /api/items/{id}/editnotes/draft/{session}  -> the draft with its ops
POST /api/items/{id}/editnotes/draft   {session, sha, ops, xml?}  (also a heartbeat)
DELETE /api/items/{id}/editnotes/draft?session=  one draft, or every draft of the item
"""
import json
import re
import time
import xml.etree.ElementTree as ET

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from .db import now_ms

router = APIRouter(prefix='/api')
TTL_MS = 120_000  # a session with no heartbeat for 2 minutes is over
HEADER = 'x-edit-session'
SID = re.compile(r'^[A-Za-z0-9_-]{4,64}$')
PRUNE_S = 30 * 86400  # drafts / base copies older than 30 days go
WRITE = {'POST', 'PUT', 'PATCH', 'DELETE'}
PATH = re.compile(r'^/api/(?:items|sheets)/([^/]+)(/.*)?$')
NOT_ITEMS = {'version', 'trash', 'restore', 'purge', 'book'}  # /api/items/<these>: bulk endpoints, ids in the body
FREE = re.compile(r'^/(editsession(/end)?|editnotes/(preview|clip|draft(/[^/]+)?)|lyrics/preview|simplepiano/preview)$')  # no write


def _sid(s):
    if not isinstance(s, str) or not SID.match(s): raise HTTPException(400, 'session: 4–64 letters, digits, - or _')
    return s


def active(c, item_id):
    return c.execute('SELECT id, started_at, beat_at FROM edit_session WHERE item_id=? AND beat_at>? ORDER BY started_at',
                     (item_id, now_ms() - TTL_MS)).fetchall()


def lock_error(c, item_id, session=None):
    """None when a write to item_id may go ahead, else the 423 message."""
    rows = active(c, item_id)
    if not rows or (session and any(r[0] == session for r in rows)): return None
    since = time.strftime('%H:%M', time.localtime(rows[0][1] / 1000))
    return (f'Locked: Edit notes is open on this score (since {since}). Nothing was changed. '
            'Wait until it is saved or closed (it lets go 2 minutes after the editor stops), then try again.')


def check(c, item_id, session=None):
    msg = lock_error(c, item_id, session)
    if msg: raise HTTPException(423, msg)


async def lock_middleware(request: Request, call_next):
    if request.method in WRITE:
        m = PATH.match(request.url.path)
        if m and m.group(1) not in NOT_ITEMS and not FREE.match(m.group(2) or ''):
            c = request.app.state.connect()
            try: msg = lock_error(c, m.group(1), request.headers.get(HEADER))
            finally: c.close()
            if msg: return JSONResponse({'detail': msg, 'locked': True}, status_code=423)
    return await call_next(request)


# ---------- files ----------

def drafts_dir(cf, item_id, make=False):
    if not re.match(r'^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$', item_id or ''): raise HTTPException(400, 'Bad item id')
    d = cf.data / 'drafts' / item_id
    if make: d.mkdir(parents=True, exist_ok=True)
    return d


def _prune(d):
    old = time.time() - PRUNE_S
    for f in d.glob('*'):
        try:
            if f.stat().st_mtime < old: f.unlink()
        except OSError: pass


def keep_base(cf, item_id, text):
    """The score as an editor opened it: base-<sha>.musicxml (once per sha)."""
    from .staffmove import _sha
    d = drafts_dir(cf, item_id, make=True)
    p = d / f'base-{_sha(text)}.musicxml'
    if not p.exists():
        _prune(d)
        tmp = p.with_suffix('.tmp'); tmp.write_text(text, encoding='utf-8'); tmp.replace(p)
    else: p.touch()
    return p


def base_text(cf, it, sha):
    """The text with this sha: the kept base copy, else a copy in the item's .history (or its original)."""
    from .staffmove import _sha
    if not sha or not re.match(r'^[0-9a-f]{6,64}$', sha): return None
    p = drafts_dir(cf, it['id']) / f'base-{sha}.musicxml'
    if p.is_file(): return p.read_text(encoding='utf-8')
    try:
        from .items import item_dir
        d = item_dir(cf, it)
    except HTTPException: return None
    cands = sorted((d / '.history').glob('*.musicxml'), key=lambda f: -f.stat().st_mtime)[:400] if (d / '.history').is_dir() else []
    for f in [*cands, *d.glob('*.musicxml')]:
        try: t = f.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError): continue
        if _sha(t) == sha: return t
    return None


def _write(p, text):
    tmp = p.with_name(p.name + '.tmp'); tmp.write_text(text, encoding='utf-8'); tmp.replace(p)


def drop_draft(cf, item_id, session=None):
    d = drafts_dir(cf, item_id)
    if not d.is_dir(): return 0
    n = 0
    for f in d.glob('draft-*'):
        if session is None or f.name in (f'draft-{session}.json', f'draft-{session}.musicxml'):
            try: f.unlink(); n += 1
            except OSError: pass
    return n


def _beat(c, item_id, session, sha=''):
    t = now_ms()
    c.execute('INSERT INTO edit_session(id, item_id, started_at, beat_at, base_sha) VALUES (?,?,?,?,?) '
              'ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at, item_id=excluded.item_id, '
              "base_sha=CASE WHEN excluded.base_sha<>'' THEN excluded.base_sha ELSE edit_session.base_sha END",
              (session, item_id, t, t, sha or ''))
    c.execute('DELETE FROM edit_session WHERE beat_at<?', (t - 24 * 3600 * 1000,))


# ---------- the endpoints ----------

from .items import cfg as _cfg, conn as _conn, must_item as _must  # noqa: E402


@router.get('/items/{item_id}/editsession')
def get_session(item_id: str, c=Depends(_conn)):
    rows = active(c, item_id)
    return {'active': bool(rows), 'sessions': [{'since': r[1], 'beatAt': r[2]} for r in rows]}


@router.post('/items/{item_id}/editsession')
def start_session(item_id: str, body: dict = Body(...), c=Depends(_conn), cf=Depends(_cfg)):
    it = _must(c, item_id)
    s = _sid(body.get('session'))
    sha = body.get('sha') or ''
    _beat(c, item_id, s, sha)  # editors of one score don't lock each other out: Save merges (rebase)
    if it.get('kind') == 'score' and it.get('musicxml') and not body.get('beat'):
        from .staffmove import _sha, _xml_path
        try:
            text = _xml_path(cf, it).read_text(encoding='utf-8')
            if not sha or _sha(text) == sha: keep_base(cf, item_id, text)
        except HTTPException: pass
    return {'ok': True, 'session': s, 'others': len([r for r in active(c, item_id) if r[0] != s])}


@router.post('/items/{item_id}/editsession/end')
async def end_session(item_id: str, request: Request):
    try: body = json.loads((await request.body()) or b'{}')
    except ValueError: body = {}
    s = body.get('session') if isinstance(body, dict) else None
    if not s: raise HTTPException(400, 'session is required')
    c = request.app.state.connect()
    try: c.execute('DELETE FROM edit_session WHERE id=? AND item_id=?', (s, item_id)); c.commit()
    finally: c.close()
    return {'ok': True}


@router.get('/items/{item_id}/editnotes/draft')
def list_drafts(item_id: str, cf=Depends(_cfg)):
    d = drafts_dir(cf, item_id)
    out = []
    for f in d.glob('draft-*.json') if d.is_dir() else []:
        try: j = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError): continue
        out.append({k: j.get(k) for k in ('session', 'sha', 'n', 'savedAt', 'title')})
    return {'drafts': sorted(out, key=lambda x: -(x['savedAt'] or 0))}


@router.get('/items/{item_id}/editnotes/draft/{session}')
def get_draft(item_id: str, session: str, cf=Depends(_cfg)):
    f = drafts_dir(cf, item_id) / f'draft-{_sid(session)}.json'
    if not f.is_file(): raise HTTPException(404, 'No such draft')
    return json.loads(f.read_text(encoding='utf-8'))


@router.post('/items/{item_id}/editnotes/draft')
def put_draft(item_id: str, request: Request, body: dict = Body(...), c=Depends(_conn), cf=Depends(_cfg)):
    it = _must(c, item_id)
    s = _sid(body.get('session') or request.headers.get(HEADER))
    ops = body.get('ops')
    if not isinstance(ops, list): raise HTTPException(400, 'ops: a list of edits')
    _beat(c, item_id, s)
    d = drafts_dir(cf, item_id, make=True)
    j = {'session': s, 'item': item_id, 'sha': body.get('sha') or '', 'ops': ops, 'n': int(body.get('n') or len(ops)),
         'savedAt': now_ms(), 'title': it.get('title') or ''}
    _write(d / f'draft-{s}.json', json.dumps(j, ensure_ascii=False))
    if isinstance(body.get('xml'), str) and body['xml'].lstrip().startswith('<'): _write(d / f'draft-{s}.musicxml', body['xml'])
    return {'ok': True, 'savedAt': j['savedAt']}


@router.delete('/items/{item_id}/editnotes/draft')
def delete_draft(item_id: str, session: str = '', cf=Depends(_cfg)):
    return {'ok': True, 'deleted': drop_draft(cf, item_id, _sid(session) if session else None)}


# ---------- rebase: the user's ops on top of the current file ----------

LOCAL = {'move', 'pitch', 'fill', 'delete', 'add', 'set', 'respell', 'accidental', 'courtesy', 'tie', 'slur', 'unslur', 'len',
         'restdel', 'shift', 'chord', 'unmark', 'alt', 'fillbar', 'clearbar', 'addhand', 'bartime'}


def _kind(op): return op.get('op') or ('move' if 'to' in op else '')


def _bars(text):
    """Per bar of the edit part: (signature, [refs in order]); signature = its notes (no refs, no words), its
    attributes and its chord names."""
    from .staffmove import edit_part, notes
    root = ET.fromstring(text.encode('utf-8'))
    _, part, _ = edit_part(root)
    if part is None: return [], {}
    ms = part.findall('measure')
    per = [[] for _ in ms]
    where = {}
    for n in notes(root):
        if n['bar'] >= len(per): continue
        where[n['ref']] = (n['bar'], len(per[n['bar']]))
        per[n['bar']].append(n)
    out = []
    for m, ns in zip(ms, per):
        extra = ''.join(ET.tostring(e, encoding='unicode') for e in m if e.tag in ('attributes', 'harmony', 'barline'))
        sig = (tuple((n['on'], n['dur'], n['staff'], n['midi'], n['voice'], bool(n.get('rest')), bool(n.get('tie')), bool(n.get('slur'))) for n in ns),
               re.sub(r'\s+', '', extra))
        out.append((sig, [n['ref'] for n in ns]))
    return out, where


def _words(text, op):
    """A lyrics op's verse on its staff: [(ref order, text)] — compared whole before a verse is written again."""
    root = ET.fromstring(text.encode('utf-8'))
    from .staffmove import edit_part
    _, part, _ = edit_part(root)
    verse, staff = str(op.get('verse') or '1'), str(op.get('staff') or '1')
    out = []
    for i, n in enumerate(part.iter('note') if part is not None else []):
        if (n.findtext('staff') or '1').strip() != staff: continue
        for ly in n.findall('lyric'):
            if (ly.get('number') or '1') == verse: out.append((len(out), ly.findtext('text') or '', ly.findtext('syllabic') or ''))
    return out


def _op_bars(op, where):
    """The bars an op touches (0-based), or None: the whole score."""
    if _kind(op) not in LOCAL or (_kind(op) == 'restdel' and op.get('how') == 'ripple'): return None
    bs = set()
    for r in op.get('refs') or []:
        if r not in where: return None
        bs.add(where[r][0])
    for k in ('bar',):
        if isinstance(op.get(k), int): bs.add(op[k])
    for b in op.get('bars') or []:
        if isinstance(b, int): bs.add(b)
    if not bs: return None
    return bs | {max(bs) + 1}  # ties, a longer rest, a bar's own time: the next bar may change too


def _map_refs(op, rmap):
    o = json.loads(json.dumps(op))
    if 'refs' in o: o['refs'] = [rmap[r] for r in o['refs']]
    if isinstance(o.get('notes'), list):
        for x in o['notes']:
            if isinstance(x, dict) and 'ref' in x: x['ref'] = rmap[int(x['ref'])]
    return o


def rebase(base, cur, ops):
    """Replay ops (made on `base`) on `cur`. -> (merged text, applied: [op index], failed: [(op index, why)])."""
    from .staffmove import edit_ex
    b, t, applied, failed = base, cur, [], []
    for i, op in enumerate(ops):
        try: b_next = edit_ex(b, op)[0]
        except HTTPException as e: failed.append((i, str(e.detail))); continue  # it didn't work on the base either
        try:
            bb, bw = _bars(b)
            tb, tw = _bars(t)
            want = _op_bars(op, bw)
            span = range(len(bb)) if want is None else sorted(x for x in want if x < len(bb))
            if want is None and len(bb) != len(tb): raise ValueError('the bars changed')
            rmap = {}
            for k in span:
                if k >= len(tb) or bb[k][0] != tb[k][0]: raise ValueError(f'bar {k + 1} changed')
                rmap.update(zip(bb[k][1], tb[k][1]))
            if _kind(op) == 'lyrics' and _words(b, op) != _words(t, op): raise ValueError('the words changed')
            t = edit_ex(t, _map_refs(op, rmap))[0]
            applied.append(i)
        except (ValueError, KeyError, TypeError, HTTPException) as e:
            failed.append((i, getattr(e, 'detail', None) or str(e)))
        b = b_next
    return t, applied, failed
