"""Paths, SQLite connection and row <-> JSON helpers."""
import json
import os
import secrets
import sqlite3
import string
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
SCHEMA = SERVER_DIR / 'schema.sql'
WEB_DIR = SERVER_DIR.parent / 'web'


@dataclass
class Config:
    data: Path  # ~/Documents/Meowsic (never touch Meowsic.store* / .Meowsic_SUPPORT there)

    @property
    def db_path(self): return self.data / 'meowsic.db'
    @property
    def items_dir(self): return self.data / 'items'
    @property
    def backups_dir(self): return self.data / 'backups'

    @classmethod
    def from_env(cls, data=None):
        return cls(Path(data or os.environ.get('MEOWSIC_DATA') or Path.home() / 'Documents' / 'Meowsic').expanduser())


def now_ms(): return int(time.time() * 1000)


def uid(prefix):
    # same shape as the UI's ids: 's-k3j9x2a'
    return prefix + '-' + ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(7))


def connect(cfg: Config) -> sqlite3.Connection:
    c = sqlite3.connect(cfg.db_path, timeout=10, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys = ON')
    return c


def init_db(cfg: Config):
    """Create the data folders and the db from schema.sql (all statements are IF NOT EXISTS)."""
    cfg.data.mkdir(parents=True, exist_ok=True)
    cfg.items_dir.mkdir(exist_ok=True)
    c = connect(cfg)
    cols = [r[1] for r in c.execute('PRAGMA table_info(item)')]
    for col, typ in (('folder', 'TEXT'), ('origin_at', 'INTEGER')):  # columns added after the first schema
        if cols and col not in cols:
            c.execute(f'ALTER TABLE item ADD COLUMN {col} {typ}')
    c.executescript(SCHEMA.read_text())
    c.close()


# ---------- item folders: items/<folder>/, named after the title ----------

def folder_name(item_id: str, title: str) -> str:
    """'<id> <title>': title with '/' and ':' as '-', no leading dots, Unicode kept, cut to 100 chars.
    The id keeps names unique, so no '(2)' suffixes."""
    t = ''.join(ch for ch in unicodedata.normalize('NFC', title or '') if ch >= ' ')
    t = t.replace('/', '-').replace(':', '-').strip().lstrip('.').strip()[:100].strip()
    return f'{item_id} {t}' if t else item_id


def folder_path(cfg: Config, folder: str) -> Path:
    if not folder or '/' in folder or '\\' in folder or folder.startswith('.'):
        raise ValueError('bad folder')
    return cfg.items_dir / folder


def rebase(name: str, old: str, new: str):
    """'Memory 1.jpg' -> 'Moon 1.jpg' when the folder goes Memory -> Moon; None if the name is not title-based."""
    if name.startswith(old) and name[len(old):len(old) + 1] in (' ', '.'):
        return new + name[len(old):]
    return None


# ---------- items ----------

ITEM_COLS = {  # JSON name -> item column
    'title': 'title', 'artist': 'artist', 'createdAt': 'created_at', 'updatedAt': 'updated_at',
    'deletedAt': 'deleted_at', 'zoom': 'zoom', 'rate': 'rate', 'transpose': 'transpose',
    'printedAt': 'printed_at', 'legacyRef': 'legacy_ref', 'folder': 'folder', 'originAt': 'origin_at',
}
KIND_COLS = {  # kind -> (table, {JSON name -> column})
    'sheet': ('sheet', {'source': 'source', 'pages': 'pages'}),
    'chords': ('chord_chart', {'source': 'source', 'url': 'url', 'key': 'key', 'capo': 'capo', 'text': 'text'}),
    'score': ('score', {'version': 'version', 'musicxml': 'musicxml', 'musicxmlOriginal': 'musicxml_original',
                        'midi': 'midi', 'pdf': 'pdf', 'key': 'key', 'bpm': 'bpm', 'source': 'source', 'groupId': 'group_id'}),
}
KIND_DEFAULTS = {
    'sheet': {'source': 'photos', 'pages': 0},
    'chords': {'source': 'pasted', 'url': '', 'key': '', 'capo': 0, 'text': ''},
    'score': {'version': 'original', 'musicxml': '', 'key': '', 'source': ''},
}


def zoom_in(v):  # 'two' | number -> TEXT
    return None if v is None else json.dumps(v)


def zoom_out(v):
    if v is None: return None
    try: return json.loads(v)
    except ValueError: return v


def item_json(c: sqlite3.Connection, row) -> dict:
    it = {'id': row['id'], 'kind': row['kind']}
    for k, col in ITEM_COLS.items():
        it[k] = row[col]
    it['zoom'] = zoom_out(row['zoom'])
    it['deleted'] = row['deleted_at'] is not None
    table, cols = KIND_COLS[row['kind']]
    sub = c.execute(f'SELECT * FROM {table} WHERE item_id=?', (row['id'],)).fetchone()
    for k, col in cols.items():
        it[k] = sub[col] if sub else KIND_DEFAULTS[row['kind']].get(k)
    it['tags'] = [r[0] for r in c.execute('SELECT tag FROM item_tag JOIN tag ON tag.name=item_tag.tag WHERE item_id=? ORDER BY tag.rowid', (row['id'],))]
    if row['kind'] == 'sheet':
        pages = c.execute('SELECT file, captured_at FROM sheet_page WHERE item_id=? ORDER BY page', (row['id'],)).fetchall()
        it['pageFiles'], it['pageDates'] = [p[0] for p in pages], [p[1] for p in pages]
    p = c.execute('SELECT COUNT(*), MAX(opened_at) FROM play_session WHERE item_id=?', (row['id'],)).fetchone()
    it['playCount'], it['lastPlayed'] = p[0], p[1] or 0
    it['hasStrokes'] = c.execute("SELECT 1 FROM annotation WHERE item_id=? AND strokes NOT IN ('[]','') LIMIT 1", (row['id'],)).fetchone() is not None
    return it


def get_item(c, item_id):
    row = c.execute('SELECT * FROM item WHERE id=?', (item_id,)).fetchone()
    return item_json(c, row) if row else None


def ensure_tags(c, tags):
    for t in tags:
        c.execute('INSERT OR IGNORE INTO tag(name) VALUES (?)', (t,))


def write_item(c, it: dict, *, new: bool):
    """Insert or update one item from its JSON shape (only the keys present are written on update).
    New sheets and scores get the folder '<id> <title>'."""
    kind = it['kind']
    if new and kind != 'chords' and not it.get('folder'):
        it['folder'] = folder_name(it['id'], it['title'])
    table, cols = KIND_COLS[kind]
    vals = {col: (zoom_in(it[k]) if k == 'zoom' else it[k]) for k, col in ITEM_COLS.items() if k in it}
    if 'deleted' in it and 'deletedAt' not in it:
        vals['deleted_at'] = (it.get('deletedAt') or now_ms()) if it['deleted'] else None
    sub = {col: it[k] for k, col in cols.items() if k in it}
    if new:
        vals = {'id': it['id'], 'kind': kind, **vals}
        sub = {'item_id': it['id'], **{cols[k]: v for k, v in KIND_DEFAULTS[kind].items()}, **sub}
        c.execute(f'INSERT INTO item({",".join(vals)}) VALUES ({",".join("?" * len(vals))})', list(vals.values()))
        c.execute(f'INSERT INTO {table}({",".join(sub)}) VALUES ({",".join("?" * len(sub))})', list(sub.values()))
    else:
        if vals:
            c.execute(f'UPDATE item SET {",".join(f"{k}=?" for k in vals)} WHERE id=?', [*vals.values(), it['id']])
        if sub:
            c.execute(f'UPDATE {table} SET {",".join(f"{k}=?" for k in sub)} WHERE item_id=?', [*sub.values(), it['id']])
    if 'tags' in it:
        tags = list(dict.fromkeys(t.strip() for t in it['tags'] if t and t.strip()))
        ensure_tags(c, tags)
        c.execute('DELETE FROM item_tag WHERE item_id=?', (it['id'],))
        c.executemany('INSERT INTO item_tag(item_id, tag) VALUES (?,?)', [(it['id'], t) for t in tags])


def log_event(c, type_, title, detail=''):
    c.execute('INSERT INTO activity(id, type, title, detail, at) VALUES (?,?,?,?,?)',
              (uid('act'), type_, title or '', detail or '', now_ms()))


def job_json(row) -> dict:
    j = dict(row)
    return {
        'id': j['id'], 'kind': j['kind'], 'gen': j['kind'] == 'version', 'title': j['title'], 'source': j['source'],
        'outputs': json.loads(j['outputs']), 'status': j['status'], 'stage': j['stage'], 'progress': j['progress'],
        'log': json.loads(j['log']), 'result': json.loads(j['result']) if j['result'] else None,
        'startedAt': j['started_at'], 'doneAt': j['done_at'], 'dismissed': bool(j['dismissed']),
    }
