"""Clean up → Versions: the library's items that are the same song, side by side, to pick which to delete.

Items are the same song when their titles are the same once normalised (case, diacritics, punctuation,
"(C)", "(Easy Piano)", "- Sheet Music", "(part 2)", " — p7", "Piano Solo"… ignored), or when they are score
versions with the same group_id. Books are left out; items in the Trash too.

State (tables in schema.sql): version_decision (keep / delete per item, follows the item), version_log
(every change, append only), version_notsame ("these are not the same song": the group hides while all
its items are in the mark; undo sets undone_at, the row stays).
"""
import json
import re
import unicodedata

from fastapi import APIRouter, Body, Depends, HTTPException

from .cleanstate import now_ms
from .items import conn

router = APIRouter(prefix='/api')

# words that only say what kind of copy it is, never which song
NOISE = {'sheet', 'sheets', 'music', 'piano', 'solo', 'easy', 'easier', 'pdf', 'score', 'lead', 'version', 'simplified', 'simple',
         'arrangement', 'arranged', 'arr', 'beginner', 'beginners', 'intermediate', 'advanced', 'chords', 'chord', 'tab', 'tabs',
         'vocal', 'vocals', 'duet', 'accompaniment', 'accomp', 'notes', 'free', 'printable', 'lyrics', 'with', 'and', 'for',
         'part', 'pt', 'page', 'pages', 'p', 'key', 'in', 'major', 'minor', 'transposed', 'original', 'full', 'big', 'hands',
         'both', 'right', 'left', 'hand', 'level', 'grade', 'ukulele', 'guitar', 'lesson', 'tutorial', 'cover', 'midi',
         'musicxml', 'omr', 'copy', 'new', 'old', 'v', 'ver', 'edit', 'edited', 'scan', 'scanned', 'photo', 'photos'}
KEYNAME = re.compile(r'[a-g](?:#|b|sharp|flat)?m?(?:maj|min)?\d?')
NUMLIKE = re.compile(r'(?:p|pg|pt|page|part|v)?\d+[a-z]?')
# trailing phrases (no dash before them) that only say what kind of copy it is
TAIL = re.compile(r'\s+(?:piano solo|easy piano|piano sheet music|sheet music|piano sheet|piano score|lead sheet|piano version|easy version'
                  r'|piano arrangement|for piano|for solo piano|solo piano|(?:part|pt|page|p) ?\d+|p\d+)$')
EXT = re.compile(r'\.(?:pdf|jpe?g|png|heic|musicxml|mxl|xml|mid|midi|txt|cho|chopro)$', re.I)
BRACKETS = re.compile(r'\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}|（[^（）]*）')
DASHES = re.compile(r'\s*[–—|]\s*|\s+-\s+|\s+-(?=\S)|(?<=\S)-\s+|_-_')


def fold(s: str) -> str:
    """Lower case, no diacritics (Vietnamese đ → d too), punctuation → spaces, single spaces."""
    s = unicodedata.normalize('NFKD', str(s or '').replace('đ', 'd').replace('Đ', 'D'))
    s = ''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = re.sub(r"['’`´]", '', s)
    return ' '.join(re.sub(r'[\W_]+', ' ', s).split())


def _noise(part: str) -> bool:
    toks = part.split()
    return bool(toks) and all(t in NOISE or KEYNAME.fullmatch(t) or NUMLIKE.fullmatch(t) for t in toks)


def _tidy(s: str) -> str:
    while True:
        s2 = TAIL.sub('', s).strip()
        s2 = re.sub(r'^(?:the|a|an) (?=\S)', '', s2)  # "The Music Of The Night" = "Music Of The Night"
        if s2 == s: return s
        s = s2


def title_keys(title: str) -> tuple[str, list[str]]:
    """(the song a title names, the names its dash parts give on their own). "A Whole New World - Aladdin" ->
    ('whole new world aladdin', ['whole new world']): the first part joins a group only when it is another item's whole name."""
    t = EXT.sub('', str(title or '').strip())
    for _ in range(3): t = BRACKETS.sub(' ', t)  # nested brackets
    t = re.sub(r'[()\[\]{}（）]', ' ', t)
    parts = [p for p in (fold(p) for p in DASHES.split(t)) if p]
    keep = parts[:1] + [p for p in parts[1:] if not _noise(p)]
    full = _tidy(' '.join(keep)) or fold(title)
    first = _tidy(keep[0]) if len(keep) > 1 else ''  # the song comes first; later parts are artists, shows, collections
    subs = [first] if len(first) >= 6 and first != full else []
    return full, subs


def norm_title(title: str) -> str:
    """The song a title names: what two copies of the same song have in common."""
    return title_keys(title)[0]


def _cols(c, table):
    return {r[1] for r in c.execute(f'PRAGMA table_info({table})')}


def _items(c) -> list[dict]:
    """Every live item that is not a book, with what a version card shows."""
    has_sv = 'version' in _cols(c, 'sheet')  # sheet.version (Lead / Piano / Duet) may not exist yet
    rows = c.execute(f'''SELECT i.id, i.kind, i.title, i.artist, i.created_at, i.updated_at, i.origin_at,
        s.pages, s.source AS s_source, s.book, {'s.version' if has_sv else 'NULL'} AS s_version,
        m.version AS m_version, m.key AS m_key, m.source AS m_source, m.group_id, m.pdf, m.ai,
        ch.key AS c_key, ch.source AS c_source, ch.capo, substr(ch.text, 1, 600) AS c_text,
        (SELECT COUNT(*) FROM play_session p WHERE p.item_id = i.id) AS plays,
        (SELECT MAX(opened_at) FROM play_session p WHERE p.item_id = i.id) AS last_played
        FROM item i LEFT JOIN sheet s ON s.item_id = i.id LEFT JOIN score m ON m.item_id = i.id LEFT JOIN chord_chart ch ON ch.item_id = i.id
        WHERE i.deleted_at IS NULL AND NOT COALESCE(s.book, 0)''').fetchall()
    tags = {}
    for iid, tag in c.execute('SELECT item_id, tag FROM item_tag JOIN tag ON tag.name = item_tag.tag ORDER BY tag.rowid'):
        tags.setdefault(iid, []).append(tag)
    out = []
    for r in rows:
        k = r['kind']
        it = {'id': r['id'], 'kind': k, 'title': r['title'], 'artist': r['artist'], 'createdAt': r['created_at'],
              'updatedAt': r['updated_at'], 'originAt': r['origin_at'], 'tags': tags.get(r['id'], []),
              'playCount': r['plays'], 'lastPlayed': r['last_played'] or 0}
        if k == 'sheet': it.update(pages=r['pages'] or 0, source=r['s_source'] or '', version=r['s_version'] or '')
        elif k == 'score': it.update(version=r['m_version'] or '', key=r['m_key'] or '', source=r['m_source'] or '', groupId=r['group_id'] or '',
                                     pdf=bool(r['pdf']), ai=bool(r['ai']))
        else: it.update(key=r['c_key'] or '', source=r['c_source'] or '', capo=r['capo'] or 0, text=r['c_text'] or '')
        out.append(it)
    return out


def _marks(c) -> list[set]:
    return [set(json.loads(r[0])) for r in c.execute('SELECT item_ids FROM version_notsame WHERE undone_at IS NULL')]


def groups(c, items=None) -> list[dict]:
    """[{key, title, ids, notSame}] of every group with 2+ items: biggest first, then A–Z."""
    items = _items(c) if items is None else items
    parent = {it['id']: it['id'] for it in items}

    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x

    def join(a, b): parent[find(a)] = find(b)
    by_norm, by_group, norm, subs = {}, {}, {}, {}
    for it in items:
        n, subs[it['id']] = title_keys(it['title'])
        norm[it['id']] = n
        if n in by_norm: join(it['id'], by_norm[n])
        else: by_norm[n] = it['id']
        g = it.get('groupId') if it['kind'] == 'score' else ''
        if g:
            if g in by_group: join(it['id'], by_group[g])
            else: by_group[g] = it['id']
    for iid, ss in subs.items():  # "A Whole New World - Aladdin" joins "A Whole New World"
        for x in ss:
            if x in by_norm: join(iid, by_norm[x])
    comp = {}
    for it in items: comp.setdefault(find(it['id']), []).append(it)
    marks = _marks(c)
    out = []
    for members in comp.values():
        if len(members) < 2: continue
        members.sort(key=lambda x: (x['createdAt'] or 0, x['id']))  # oldest first
        ns = [norm[x['id']] for x in members]
        key = 't:' + min(set(ns), key=lambda n: (-ns.count(n), len(n), n))  # the most common name (unique: names never span groups)
        ids = [x['id'] for x in members]
        # the name to show: a title that is just the song (no "(C)", "- Sheet Music"…), the most used, then the oldest
        plain = [x['title'] for x in members if fold(x['title']) in (key[2:], f'the {key[2:]}', f'a {key[2:]}', f'an {key[2:]}')] or [x['title'] for x in members]
        title = min(plain, key=lambda t: (-plain.count(t), t.isupper(), len(t), plain.index(t)))
        out.append({'key': key, 'title': title, 'ids': ids, 'notSame': any(set(ids) <= m for m in marks)})
    out.sort(key=lambda g: (-len(g['ids']), fold(g['title']), g['key']))
    return out


def decisions(c) -> dict:
    return {r[0]: r[1] for r in c.execute('SELECT item_id, decision FROM version_decision ORDER BY at, rowid')}


def decide(c, item_id, decision, group_key='', op=None):
    """keep | delete | None (not decided). Every change is logged."""
    if decision in ('keep', 'delete'):
        if not c.execute('SELECT 1 FROM item WHERE id=?', (item_id,)).fetchone(): return False
        c.execute('INSERT OR REPLACE INTO version_decision(item_id, decision, at) VALUES (?,?,?)', (item_id, decision, now_ms()))
    else:
        c.execute('DELETE FROM version_decision WHERE item_id=?', (item_id,))
    c.execute('INSERT INTO version_log(item_id, group_key, op, at) VALUES (?,?,?,?)', (item_id, group_key or '', op or decision or 'clear', now_ms()))
    return True


def not_same(c, key, ids, on=True):
    if on:
        c.execute('INSERT INTO version_notsame(group_key, item_ids, at) VALUES (?,?,?)', (key, json.dumps(sorted(ids)), now_ms()))
        return
    # take back every mark that covers this group (they stay, undone)
    want = set(ids)
    for r in c.execute('SELECT id, item_ids FROM version_notsame WHERE undone_at IS NULL').fetchall():
        if want <= set(json.loads(r[1])):
            c.execute('UPDATE version_notsame SET undone_at=? WHERE id=?', (now_ms(), r[0]))


def state(c) -> dict:
    items = _items(c)
    gs = groups(c, items)
    shown = [g for g in gs if not g['notSame']]
    ids = {i for g in gs for i in g['ids']}
    return {'groups': gs, 'items': {it['id']: it for it in items if it['id'] in ids},
            'decisions': {k: v for k, v in decisions(c).items() if k in ids},
            'counts': {'groups': len(shown), 'items': sum(len(g['ids']) for g in shown), 'notSame': len(gs) - len(shown)}}


@router.get('/versions')
def get_versions(c=Depends(conn)):
    """{groups: [{key, title, ids, notSame}], items: {id: card}, decisions: {id: keep|delete}, counts}."""
    return state(c)


@router.post('/versions/decide')
def post_decide(body: dict = Body(...), c=Depends(conn)):
    """{set: {id: 'keep' | 'delete' | null}, key?}; or {id, decision, key?}; or {clear: [ids]} after a delete (op 'trashed')."""
    sets = dict(body.get('set') or {})
    if body.get('id'): sets[body['id']] = body.get('decision')
    for iid, d in sets.items():
        if d not in ('keep', 'delete', None): raise HTTPException(400, 'decision is keep, delete or null')
        if d and not decide(c, iid, d, body.get('key', '')): raise HTTPException(404, 'No such item')
        if not d: decide(c, iid, None, body.get('key', ''))
    for iid in body.get('clear') or []: decide(c, iid, None, body.get('key', ''), op='trashed')
    return {'decisions': decisions(c)}


@router.post('/versions/notsame')
def post_not_same(body: dict = Body(...), c=Depends(conn)):
    """{key, ids}: these are not the same song (the group hides); {key, ids, undo: true} takes it back."""
    ids = [str(i) for i in body.get('ids') or []]
    if not ids: raise HTTPException(400, 'No ids')
    not_same(c, str(body.get('key') or ''), ids, on=not body.get('undo'))
    return state(c)
