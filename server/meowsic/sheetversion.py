"""Sheet versions (Lead / Piano / Duet): a one-time guess from titles and tags (scripts/fill_sheet_versions.py).

Duet  = the title or a tag says duet / 4 hands / four hands / primo / secondo;
Lead  = the sheet has the tag "Super Easy" or "Lead sheet";
else  = left blank (no guessing Piano from nothing). Books (mixed content) are left alone.
Only blank versions are filled, so running it again changes nothing. Every change goes to
<data>/history/versions-<ts>.jsonl (before / after), which is never removed."""
import json
import re
import sqlite3
import time

from .db import Config, init_db, log_event, now_ms

DUET = re.compile(r'duet|\b(?:4|four)[\s-]*hands?\b|\bprimo\b|\bsecondo\b', re.I)
LEAD_TAGS = {'super easy', 'lead sheet'}


def guess(title: str, tags) -> str:
    if DUET.search(title or '') or any(DUET.search(t) for t in tags): return 'duet'
    if any(t.strip().lower() in LEAD_TAGS for t in tags): return 'lead'
    return ''


def fill(data, *, dry_run=False, backup=True) -> dict:
    cfg = Config.from_env(data)
    if not dry_run: init_db(cfg)  # adds sheet.version on an older db
    c = sqlite3.connect(cfg.db_path)
    c.row_factory = sqlite3.Row
    has_col = 'version' in [r[1] for r in c.execute('PRAGMA table_info(sheet)')]
    rows = c.execute(f"""SELECT item.id, item.title, {'sheet.version' if has_col else "''"} AS version, sheet.book FROM item JOIN sheet ON sheet.item_id = item.id
                         WHERE item.deleted_at IS NULL ORDER BY item.title""").fetchall()
    changes, counts = [], {'duet': 0, 'lead': 0, 'blank': 0, 'kept': 0, 'books': 0}
    for r in rows:
        if r['book']: counts['books'] += 1; continue
        if r['version']: counts['kept'] += 1; continue
        tags = [t[0] for t in c.execute('SELECT tag FROM item_tag WHERE item_id=?', (r['id'],))]
        v = guess(r['title'], tags)
        if not v: counts['blank'] += 1; continue
        counts[v] += 1
        changes.append({'id': r['id'], 'title': r['title'], 'tags': tags, 'before': r['version'], 'after': v})
    log = None
    if changes and not dry_run:
        ts = time.strftime('%Y%m%d-%H%M%S')
        if backup:
            cfg.backups_dir.mkdir(exist_ok=True)
            with sqlite3.connect(cfg.backups_dir / f'meowsic-before-versions-{ts}.db') as b: c.backup(b)
        h = cfg.data / 'history'
        h.mkdir(exist_ok=True)
        log = h / f'versions-{ts}.jsonl'
        t = now_ms()
        with open(log, 'a') as f:
            for ch in changes:
                c.execute('UPDATE sheet SET version=? WHERE item_id=?', (ch['after'], ch['id']))
                c.execute('UPDATE item SET updated_at=? WHERE id=?', (t, ch['id']))
                f.write(json.dumps({'at': t, **ch, 'via': 'fill_sheet_versions'}, ensure_ascii=False) + '\n')
        log_event(c, 'migrate', 'Sheet versions', f"{counts['duet']} Duet, {counts['lead']} Lead (log: history/{log.name})")
        c.commit()
    c.close()
    return {'changes': changes, 'counts': counts, 'log': str(log) if log else None}
