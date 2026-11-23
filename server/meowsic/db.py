"""Paths, SQLite connection and row <-> JSON helpers."""
import contextvars
import json
import os
import re
import secrets
import sqlite3
import string
import time
import unicodedata
from urllib.parse import urlparse
from contextlib import contextmanager
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
    @property
    def work_dir(self): return self.data / 'work'  # transcription cache, one folder per job (rebuildable)

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
    scols = [r[1] for r in c.execute('PRAGMA table_info(sheet)')]
    if scols and 'book' not in scols:  # books (many pages, many songs) are sheets with book=1, kept in items/Books/
        c.execute('ALTER TABLE sheet ADD COLUMN book INTEGER NOT NULL DEFAULT 0')
    if scols and 'version' not in scols:  # Lead / Piano / Duet ('' = not known); scripts/fill_sheet_versions.py fills it once
        c.execute("ALTER TABLE sheet ADD COLUMN version TEXT NOT NULL DEFAULT ''")
    if scols and 'key' not in scols:  # the key ('F', 'Am'); scripts/move_title_keys.py moves '(F)' out of titles
        c.execute("ALTER TABLE sheet ADD COLUMN key TEXT NOT NULL DEFAULT ''")
    mcols = [r[1] for r in c.execute('PRAGMA table_info(score)')]
    if mcols and 'ai' not in mcols:  # AI music (scores Claude composed) are scores with ai=1
        c.execute('ALTER TABLE score ADD COLUMN ai INTEGER NOT NULL DEFAULT 0')
    if mcols and 'source_url' not in mcols:  # the full YouTube / Facebook link; `source` is just the platform
        c.execute("ALTER TABLE score ADD COLUMN source_url TEXT NOT NULL DEFAULT ''")
    if mcols and 'staves' not in mcols:  # staves in the MusicXML (1 = lead sheet, 2 = piano grand staff); NULL = not read yet
        c.execute('ALTER TABLE score ADD COLUMN staves INTEGER')
    acols = [r[1] for r in c.execute('PRAGMA table_info(activity)')]
    for col, typ in (('undo', 'TEXT'), ('undone_at', 'INTEGER'), ('undone_by', 'TEXT'), ('undo_of', 'TEXT'), ('final_at', 'INTEGER')):  # Activities: rollback info (undo.py)
        if acols and col not in acols:
            c.execute(f'ALTER TABLE activity ADD COLUMN {col} {typ}')
    for col, typ in (('vocal_audio', 'TEXT'), ('vocal_bpm', 'REAL')):  # "Make it sing (beta)"
        if mcols and col not in mcols:
            c.execute(f'ALTER TABLE score ADD COLUMN {col} {typ}')
    jcols = [r[1] for r in c.execute('PRAGMA table_info(job)')]
    if jcols and 'params' not in jcols:
        c.execute("ALTER TABLE job ADD COLUMN params TEXT NOT NULL DEFAULT '{}'")
    c.executescript(SCHEMA.read_text())
    job_sql = (c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='job'").fetchone() or [''])[0]
    if "'sing'" not in job_sql:  # job kinds 'tags' (AI suggestions), 'omr' (photo → score), 'lyrics' (words from a sheet), 'sing' (make it sing) added later: rebuild the table with the new CHECK, rows kept
        create = re.search(r'CREATE TABLE IF NOT EXISTS job \(.*?\n\);', SCHEMA.read_text(), re.S).group(0)
        cols = ','.join(r[1] for r in c.execute('PRAGMA table_info(job)'))
        c.executescript(f'BEGIN; ALTER TABLE job RENAME TO job_old; {create} INSERT INTO job({cols}) SELECT {cols} FROM job_old; DROP TABLE job_old; COMMIT;')
    migrate_sources(c)
    from .sheetversion import migrate_staves
    migrate_staves(cfg, c)
    c.commit()
    migrate_cleanup_json(cfg, c)
    c.close()


def migrate_cleanup_json(cfg: Config, c):
    """Clean up state used to live in work/cleanup.json: copy it into the tables once, keep the file renamed."""
    from .cleanstate import import_json
    try: n = import_json(c, cfg.work_dir / 'cleanup.json')
    except Exception as e:  # a broken file stays where it is; the tables start empty
        c.rollback()
        log_event(c, 'migrate', 'Clean up state', f'work/cleanup.json not imported: {e}')
        c.commit()
        return
    if n:
        log_event(c, 'migrate', 'Clean up state', f'work/cleanup.json → database (kept as work/{n.pop("file")}): '
                  + ', '.join(f'{v} {k}' for k, v in n.items() if v))
        c.commit()


YOUTUBE = {'youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'}
FACEBOOK = {'facebook.com', 'fb.watch', 'm.facebook.com', 'fb.com', 'web.facebook.com'}
AI_SOURCE = 'Meowsic'            # every score Meowsic makes is credited "Meowsic" (composer, source, AI pieces' artist)
OLD_CREDITS = ('Meowsic AI',)    # earlier names for it: read and shown as "Meowsic"


def credit_xml(x: str) -> str:
    """The MusicXML with one composer credit, "Meowsic" (other creators go; the song's artist stays in the item's Artist)."""
    x = re.sub(r'<creator\b[^>]*>[\s\S]*?</creator>|<creator\b[^>]*/>', '', x)
    c = f'<creator type="composer">{AI_SOURCE}</creator>'
    if '<identification>' in x: return x.replace('<identification>', '<identification>' + c, 1)
    if re.search(r'<identification\s*/>', x): return re.sub(r'<identification\s*/>', '<identification>' + c + '</identification>', x, count=1)
    return re.sub(r'(<part-list\b)', '<identification>' + c + r'</identification>\1', x, count=1)


def platform_of(url: str) -> str:
    """'YouTube' | 'Facebook' | the link's host name ('' when there is none)."""
    url = (url or '').strip()
    if not url: return ''
    host = (urlparse(url if '://' in url else 'https://' + url).hostname or '').lower()
    if host.startswith('www.'): host = host[4:]
    return 'YouTube' if host in YOUTUBE else 'Facebook' if host in FACEBOOK else host


OLD_LINK_SOURCE = re.compile(r'^(YouTube|Facebook) · (\S+)$')


def migrate_sources(c):
    """Old score sources -> the new shape (runs every start, does nothing once done):
    'YouTube · youtu.be/x' -> source 'YouTube' + source_url (the job's original link when there is one);
    versions made from a score get their group's link; AI pieces: 'Composed by Claude' -> 'Meowsic', no 'AI Studio' tag."""
    fixed = 0
    rows = c.execute("SELECT item_id, source FROM score WHERE source LIKE 'YouTube · %' OR source LIKE 'Facebook · %'").fetchall()
    if rows:
        job_url = {}
        for r in c.execute("SELECT params, result FROM job WHERE result IS NOT NULL AND params LIKE '%\"url\"%'"):
            try: url, ids = json.loads(r[0]).get('url'), json.loads(r[1])
            except (ValueError, TypeError, AttributeError): continue
            for i in ids if url and isinstance(ids, list) else []: job_url[i] = url
        for item_id, source in rows:
            m = OLD_LINK_SOURCE.match(source)
            url = job_url.get(item_id) or (('' if m.group(2).startswith('http') else 'https://') + m.group(2) if m else '')
            c.execute("UPDATE score SET source=?, source_url=CASE WHEN source_url='' THEN ? ELSE source_url END WHERE item_id=?",
                      (platform_of(url) or (m.group(1) if m else source), url, item_id))
            fixed += 1
    # versions made from a score: the link of the recording they came from
    fixed += c.execute("""UPDATE score SET source_url=(SELECT p.source_url FROM score p WHERE p.group_id=score.group_id AND p.source_url<>'' LIMIT 1)
        WHERE source_url='' AND group_id IS NOT NULL AND source LIKE 'From the score%'
          AND EXISTS (SELECT 1 FROM score p WHERE p.group_id=score.group_id AND p.source_url<>'')""").rowcount
    ai = c.execute("UPDATE score SET source=? WHERE ai=1 AND source='Composed by Claude'", (AI_SOURCE,)).rowcount
    tagged = c.execute("DELETE FROM item_tag WHERE tag='AI Studio'").rowcount
    c.execute("DELETE FROM tag WHERE name='AI Studio'")
    if fixed or ai or tagged:
        log_event(c, 'migrate', 'Score sources', f'{fixed} link source(s) → platform + original link; {ai} AI piece(s) → Meowsic; '
                  f'AI Studio tag removed from {tagged} item(s)')


# ---------- item folders: items/<id>/ (books: items/Books/<book name>/) ----------

def folder_name(item_id: str, title: str = '') -> str:
    """A sheet's or score's folder is its id: items/<id>/ with files '<id> <n>.jpg', '<id>.musicxml'…,
    so a rename never moves a file. (Older items may still have '<id> <title>' folders: they keep working,
    and server/scripts/migrate_id_folders.py moves them to the id scheme.) Books are named after the
    title instead: see book_folder."""
    return item_id


BOOKS = 'Books'  # books live in items/Books/<book name>/, their pages are '<book name> <n>.<ext>'


def folder_path(cfg: Config, folder: str) -> Path:
    """items/<folder>; a book's folder is 'Books/<name>' (one level, nothing else may hold a '/')."""
    sub = folder[len(BOOKS) + 1:] if folder and folder.startswith(BOOKS + '/') else folder
    if not sub or '/' in sub or '\\' in sub or sub.startswith('.') or sub == BOOKS:
        raise ValueError('bad folder')
    return cfg.items_dir / folder


def folder_base(folder: str) -> str:
    """What the page files are named after: the folder's own name ('Books/X' -> 'X')."""
    return folder.rsplit('/', 1)[-1]


def book_folder(cfg: Config, title: str, own: str | None = None) -> str:
    """'Books/<title>' (cleaned like any folder name); ' (2)', ' (3)'… when another book has that name."""
    t = ''.join(ch for ch in unicodedata.normalize('NFC', title or '') if ch >= ' ')
    t = t.replace('/', '-').replace(':', '-').strip().lstrip('.').strip()[:100].strip() or 'Book'
    name, n = t, 1
    while (cfg.items_dir / BOOKS / name).exists() and f'{BOOKS}/{name}' != own:
        n += 1; name = f'{t} ({n})'
    return f'{BOOKS}/{name}'


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
    'sheet': ('sheet', {'source': 'source', 'pages': 'pages', 'book': 'book', 'version': 'version', 'key': 'key'}),
    'chords': ('chord_chart', {'source': 'source', 'url': 'url', 'key': 'key', 'capo': 'capo', 'text': 'text'}),
    'score': ('score', {'version': 'version', 'musicxml': 'musicxml', 'musicxmlOriginal': 'musicxml_original',
                        'midi': 'midi', 'pdf': 'pdf', 'key': 'key', 'bpm': 'bpm', 'source': 'source', 'groupId': 'group_id', 'ai': 'ai',
                        'sourceUrl': 'source_url', 'staves': 'staves', 'vocalAudio': 'vocal_audio', 'vocalBpm': 'vocal_bpm'}),
}
SHEET_VERSIONS = ('', 'lead', 'piano', 'duet')  # shown as Lead / Piano / Duet
SCORE_VERSIONS = ('original', 'vocal', 'lead', 'duet', 'accomp', 'clear', 'pro', 'easy')
KIND_DEFAULTS = {
    'sheet': {'source': 'photos', 'pages': 0, 'book': 0, 'version': '', 'key': ''},
    'chords': {'source': 'pasted', 'url': '', 'key': '', 'capo': 0, 'text': ''},
    'score': {'version': 'original', 'musicxml': '', 'key': '', 'source': '', 'ai': 0, 'sourceUrl': '', 'staves': None},
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
    New sheets and scores get the folder '<id>'."""
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


# While a rollback runs (undo.py), the normal code paths it calls log nothing: the rollback writes one row itself.
_quiet = contextvars.ContextVar('meowsic_quiet', default=False)


def quiet_now() -> bool:
    return _quiet.get()


@contextmanager
def quiet():
    tok = _quiet.set(True)
    try: yield
    finally: _quiet.reset(tok)


def log_event(c, type_, title, detail='', undo=None):
    """One Activities row; returns its id (None while quiet). `undo`: rollback info (see undo.record_undo)."""
    if _quiet.get(): return None
    aid = uid('act')
    c.execute('INSERT INTO activity(id, type, title, detail, at, undo) VALUES (?,?,?,?,?,?)',
              (aid, type_, title or '', detail or '', now_ms(), json.dumps(undo, ensure_ascii=False) if undo is not None else None))
    return aid


def job_json(row) -> dict:
    j = dict(row)
    return {
        'id': j['id'], 'kind': j['kind'], 'gen': j['kind'] in ('version', 'lyrics'), 'title': j['title'], 'source': j['source'],
        'outputs': json.loads(j['outputs']), 'status': j['status'], 'stage': j['stage'], 'progress': j['progress'],
        'log': json.loads(j['log']), 'result': json.loads(j['result']) if j['result'] else None,
        'startedAt': j['started_at'], 'doneAt': j['done_at'], 'dismissed': bool(j['dismissed']),
    }
