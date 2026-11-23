"""Keys written into sheet titles -> the sheet's key field (scripts/move_title_keys.py, one time).

"A Little Bit Of You (F)" -> title "A Little Bit Of You", key "F". Recognised at the END of the title only:
"(X)", "[X]", " - X", " – X", " — X", where X is a key: A–G, then #, b, ♯ or ♭, then m / min / maj / minor /
major (with or without a space): C, Am, F#m, Bb, Eb major, C major. The key is kept as written ("Am" stays Am).
Anything else in brackets ("(Easy Piano)", "(OST)", "(Book 2)", "(part 2)") is left alone.
Renames go through items.update_item (the normal rename path: books' folders follow their titles).
Every change goes to <data>/history/title-keys-<ts>.jsonl (before / after title + key), which is never removed;
undo() puts back what a log changed, where the item still looks the way the log left it."""
import json
import re
import time
from pathlib import Path

from .db import Config, connect, get_item, init_db, log_event, now_ms, quiet

KEY = r'[A-G](?:#|b|♯|♭)?(?:\s?(?:minor|major|min|maj|m))?'
TRAILING = re.compile(rf'^(?P<title>.*?)\s*(?:\(\s*(?P<k1>{KEY})\s*\)|\[\s*(?P<k2>{KEY})\s*\]|\s[-–—]\s*(?P<k3>{KEY}))\s*$')


def split_key(title: str):
    """(title without the key, key) — or None when the title does not end in a key."""
    m = TRAILING.match(title or '')
    if not m: return None
    rest = re.sub(r'[\s\-–—:,]+$', '', m['title']).strip()
    if not rest: return None
    return rest, m['k1'] or m['k2'] or m['k3']


def plan(c):
    """What would change: sheets (books too) not in the Trash whose title ends in a key."""
    out = []
    for r in c.execute("""SELECT item.id, item.title, sheet.key FROM item JOIN sheet ON sheet.item_id = item.id
                          WHERE item.deleted_at IS NULL ORDER BY item.title""").fetchall():
        s = split_key(r['title'])
        if not s: continue
        title, key = s
        cur = r['key'] or ''
        if cur and cur.replace(' ', '').lower() != key.replace(' ', '').lower():
            out.append({'id': r['id'], 'skip': f'already has key {cur!r}', 'before': {'title': r['title'], 'key': cur}, 'after': None})
            continue
        out.append({'id': r['id'], 'before': {'title': r['title'], 'key': cur}, 'after': {'title': title, 'key': cur or key}})
    return out


def _rename(c, cf, item_id, title, key):
    from .items import update_item  # the normal rename path
    with quiet(): update_item(item_id, {'title': title, 'key': key}, c, cf)  # one Activities row for the whole run (below)


def run(data, *, dry_run=False) -> dict:
    cf = Config.from_env(data)
    if not dry_run: init_db(cf)  # adds sheet.key on an older db
    c = connect(cf)
    if 'key' not in [r[1] for r in c.execute('PRAGMA table_info(sheet)')]:  # dry run on an older db
        rows = c.execute("""SELECT item.id, item.title FROM item JOIN sheet ON sheet.item_id = item.id WHERE item.deleted_at IS NULL ORDER BY item.title""").fetchall()
        changes = [{'id': r['id'], 'before': {'title': r['title'], 'key': ''}, 'after': {'title': s[0], 'key': s[1]}} for r in rows if (s := split_key(r['title']))]
        c.close()
        return {'changes': changes, 'skipped': [], 'log': None}
    p = plan(c)
    changes, skipped = [x for x in p if x['after']], [x for x in p if not x['after']]
    log = None
    if changes and not dry_run:
        h = cf.data / 'history'
        h.mkdir(exist_ok=True)
        log = h / f'title-keys-{time.strftime("%Y%m%d-%H%M%S")}.jsonl'
        t = now_ms()
        with open(log, 'a') as f:
            for ch in changes:
                _rename(c, cf, ch['id'], ch['after']['title'], ch['after']['key'])
                c.commit()
                f.write(json.dumps({'at': t, **ch, 'via': 'move_title_keys'}, ensure_ascii=False) + '\n')
        log_event(c, 'migrate', 'Keys out of sheet titles', f'{len(changes)} sheet(s) (log: history/{log.name})',
                  undo={'steps': [{'op': 'script', 'log': f'history/{log.name}'}]})  # Activities: Undo replays the log
        c.commit()
    c.close()
    return {'changes': changes, 'skipped': skipped, 'log': str(log) if log else None}


def undo(data, log, *, dry_run=False) -> dict:
    cf = Config.from_env(data)
    c = connect(cf)
    back, skipped = [], []
    for line in Path(log).read_text().splitlines():
        ch = json.loads(line)
        it = get_item(c, ch['id'])
        if not it or it['title'] != ch['after']['title'] or (it.get('key') or '') != ch['after']['key']:
            skipped.append(ch); continue
        back.append(ch)
        if not dry_run: _rename(c, cf, ch['id'], ch['before']['title'], ch['before']['key']); c.commit()
    if back and not dry_run:
        h = cf.data / 'history'
        with open(h / f'title-keys-undo-{time.strftime("%Y%m%d-%H%M%S")}.jsonl', 'a') as f:
            for ch in back: f.write(json.dumps({'at': now_ms(), 'id': ch['id'], 'before': ch['after'], 'after': ch['before'], 'via': 'move_title_keys --undo'}, ensure_ascii=False) + '\n')
        log_event(c, 'migrate', 'Keys back into sheet titles', f'{len(back)} sheet(s) (undo of {Path(log).name})')
        c.commit()
    c.close()
    return {'back': back, 'skipped': skipped}
