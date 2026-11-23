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


# ---------- score staves: what the notes are, not what the version says ----------
# Lead  = one part, one staff (a melody line, usually with chords / lyrics)
# Piano = a grand staff: right hand + left hand (one part with <staves>2</staves>, or two staves)
# The count is cached in score.staves (NULL = not read yet, 0 = no file / unreadable).
import xml.etree.ElementTree as ET  # noqa: E402

_STAVES = re.compile(r'<staves>\s*(\d+)\s*</staves>')
_PART = re.compile(r'<part[\s>]')


def staves_of(text) -> int:
    """Total staves over all parts: each <part> counts its largest <staves> (1 when it has none)."""
    if isinstance(text, bytes): text = text.decode('utf-8', 'replace')
    if not text or not text.strip(): return 0
    try:
        root = ET.fromstring(text.encode('utf-8'))
        parts = [p for p in root.iter() if p.tag.rsplit('}', 1)[-1] == 'part']
        n = 0
        for p in parts:
            vals = [int(s.text) for s in p.iter() if s.tag.rsplit('}', 1)[-1] == 'staves' and (s.text or '').strip().isdigit()]
            n += max(vals or [1])
        return n
    except ET.ParseError:  # broken file: count by text
        return sum(max([int(x) for x in _STAVES.findall(ch)] or [1]) for ch in _PART.split(text)[1:])


def score_file_staves(cfg, folder: str, name: str) -> int:
    from .db import folder_path
    if not folder or not name: return 0
    try: p = folder_path(cfg, folder) / name
    except ValueError: return 0
    if not p.is_file(): return 0
    try: return staves_of(p.read_text(errors='replace'))
    except OSError: return 0


def refresh_staves(c, cfg, item_id: str) -> int:
    """Read the score's MusicXML again and cache its staff count (after every save / import)."""
    r = c.execute('SELECT item.folder, score.musicxml FROM score JOIN item ON item.id = score.item_id WHERE item_id=?', (item_id,)).fetchone()
    if not r: return 0
    n = score_file_staves(cfg, r[0], r[1])
    c.execute('UPDATE score SET staves=? WHERE item_id=?', (n, item_id))
    return n


def migrate_staves(cfg, c) -> dict:
    """Fill score.staves where it is not read yet; Meowsic AI scores (ai=1) with one staff are lead sheets:
    their version becomes 'lead'. Each version change goes to <data>/history/score-versions-<ts>.jsonl
    (kept). Running it again changes nothing."""
    filled = 0
    for iid, folder, name in c.execute('SELECT score.item_id, item.folder, score.musicxml FROM score JOIN item ON item.id = score.item_id '
                                       'WHERE score.staves IS NULL').fetchall():
        c.execute('UPDATE score SET staves=? WHERE item_id=?', (score_file_staves(cfg, folder, name), iid))
        filled += 1
    rows = c.execute("""SELECT item.id, item.title, score.version, score.staves FROM score JOIN item ON item.id = score.item_id
                        WHERE score.ai = 1 AND score.staves = 1 AND score.version <> 'lead' ORDER BY item.title""").fetchall()
    log = None
    if rows:
        h = cfg.data / 'history'
        h.mkdir(exist_ok=True)
        log = h / f'score-versions-{time.strftime("%Y%m%d-%H%M%S")}.jsonl'
        t = now_ms()
        with open(log, 'a') as f:
            for iid, title, before, st in rows:
                c.execute("UPDATE score SET version='lead' WHERE item_id=?", (iid,))
                c.execute('UPDATE item SET updated_at=? WHERE id=?', (t, iid))
                f.write(json.dumps({'at': t, 'id': iid, 'title': title, 'staves': st, 'before': before, 'after': 'lead',
                                    'via': 'score_staves_migration'}, ensure_ascii=False) + '\n')
        log_event(c, 'migrate', 'Score versions', f'{len(rows)} Meowsic AI score(s) with one staff → Lead (log: history/{log.name})')
    return {'filled': filled, 'lead': len(rows), 'log': str(log) if log else None}
