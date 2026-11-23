-- Meowsic 2.0 database (SQLite). One file: ~/Documents/Meowsic/meowsic.db
-- Files (page images, PDFs, MusicXML, MIDI) live under ~/Documents/Meowsic/items/<item_id>/ ('<id> <n>.jpg',
-- '<id>.musicxml'…; renames never move them); books under items/Books/<book name>/ ('<book name> <n>.jpg').
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS item (
  id          TEXT PRIMARY KEY,               -- 's-…' sheet, 'c-…' chords, 'm-…' score
  kind        TEXT NOT NULL CHECK (kind IN ('sheet','chords','score')),
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,              -- ms since epoch
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,                        -- set = in Trash
  -- per-item view state the UI remembers
  zoom        TEXT,                           -- sheet: 'two' | number; score: number
  rate        REAL,                           -- score playback tempo factor
  transpose   INTEGER,                        -- chords / score
  printed_at  INTEGER,                        -- last time it was printed (Printed / Never printed)
  legacy_ref  TEXT,                           -- where it came from in an old app (for migration re-runs)
  folder      TEXT,                           -- files live in items/<folder>/: '<id>' (older: '<id> <title>'), books 'Books/<title>'; NULL for chord charts
  origin_at   INTEGER                         -- original date: photo capture / file date / transcription / chord fetch (ms)
);

CREATE TABLE IF NOT EXISTS sheet (            -- kind = 'sheet'
  item_id   TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  source    TEXT NOT NULL CHECK (source IN ('photos','pdf')),
  pages     INTEGER NOT NULL,
  book      INTEGER NOT NULL DEFAULT 0,       -- 1 = a book (many songs); files in items/Books/<title>/
  version   TEXT NOT NULL DEFAULT '',         -- 'lead' | 'piano' | 'duet'; '' = not known
  key       TEXT NOT NULL DEFAULT ''          -- 'C', 'Am', 'F#m', 'Eb major' (as written); '' = not known
);
CREATE TABLE IF NOT EXISTS sheet_page (
  item_id      TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL,              -- 1-based
  file         TEXT NOT NULL,                 -- relative to items/<folder>/, e.g. 's-k3j9x2a 1.jpg'
  sha256       TEXT,                          -- blocks duplicate imports
  captured_at  INTEGER,
  ocr_text     TEXT,
  PRIMARY KEY (item_id, page)
);

CREATE TABLE IF NOT EXISTS chord_chart (      -- kind = 'chords'
  item_id   TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  source    TEXT NOT NULL,                    -- 'ultimate-guitar' | 'hopamchuan' | 'pasted'
  url       TEXT NOT NULL DEFAULT '',
  key       TEXT NOT NULL DEFAULT '',
  capo      INTEGER NOT NULL DEFAULT 0,
  text      TEXT NOT NULL                     -- ChordPro: "[C]Twinkle [F]little…", {c: Verse}
);

CREATE TABLE IF NOT EXISTS score (            -- kind = 'score'; each version is its own item
  item_id     TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,                  -- original | vocal | lead | duet | accomp | clear | pro | easy (shown as Lead / Duet / Piano)
  musicxml    TEXT NOT NULL,                  -- file under items/<id>/ (edited notes are saved back here)
  musicxml_original TEXT,                     -- untouched copy, for "Revert note edits"
  midi        TEXT,
  pdf         TEXT,
  key         TEXT NOT NULL DEFAULT '',
  bpm         REAL,
  source      TEXT NOT NULL DEFAULT '',       -- 'YouTube' | 'Facebook' | 'Audio file · …' | 'From the score “…”' | 'Meowsic AI'
  group_id    TEXT,                           -- versions made from the same recording share this
  ai          INTEGER NOT NULL DEFAULT 0,     -- 1 = composed by Claude (source 'Meowsic AI'); added only by ~/git/scripts/meowsic-add-ai-score.py
  source_url  TEXT NOT NULL DEFAULT ''        -- the full original link (YouTube / Facebook); versions keep their parent's
);

CREATE TABLE IF NOT EXISTS tag (
  name        TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS item_tag (
  item_id TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL REFERENCES tag(name) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS annotation (       -- ink + text boxes, page-relative coordinates 0..1
  item_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page     TEXT NOT NULL,                     -- sheet page number, or 'score-<version>'
  strokes  TEXT NOT NULL,                     -- JSON array: {tool:'blue'|'red', pts:[[x,y]…]} | {tool:'text', pts:[[x,y]], text, color}
  PRIMARY KEY (item_id, page)
);

CREATE TABLE IF NOT EXISTS play_session (
  item_id    TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS play_item ON play_session(item_id, opened_at);

CREATE TABLE IF NOT EXISTS job (              -- transcriptions, "make another version", AI tag suggestions
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('transcribe','version','tags','omr')),
  title       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  outputs     TEXT NOT NULL,                  -- JSON array of versions
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  stage       INTEGER NOT NULL DEFAULT 0,
  progress    REAL NOT NULL DEFAULT 0,
  log         TEXT NOT NULL DEFAULT '[]',     -- JSON array of {t, msg}
  result      TEXT,                           -- JSON: created item ids; tags jobs: {suggestions} or {groups}
  started_at  INTEGER NOT NULL,
  done_at     INTEGER,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  params      TEXT NOT NULL DEFAULT '{}'      -- JSON: url, upload, fromItemId, artist, tags (what the runner needs)
);

CREATE TABLE IF NOT EXISTS activity (         -- the Logs page (jobs are listed from `job`)
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL,                      -- add-sheet | add-chords | bin | restore | delete | print | make-tags | import
  title   TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------- Clean up state (was work/cleanup.json; init_db imports that file once and keeps it renamed) ----------
-- State tables follow their item (ON DELETE CASCADE). History tables (logs, undo records, suggestions) have no
-- foreign key and rows are never deleted ("keep all history"): they only change state (undone_at, status).

CREATE TABLE IF NOT EXISTS page_scan (        -- cache of the trim / page-dot scan (rebuildable)
  item_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page     INTEGER NOT NULL,
  file     TEXT NOT NULL,                     -- the page file the scan looked at
  mtime    INTEGER NOT NULL,                  -- its modified time (s): a changed file is scanned again
  result   TEXT NOT NULL,                     -- JSON {trim, dots, box}
  v        INTEGER NOT NULL,                  -- scan version (cleanup.CACHE_V); another version = not scanned
  PRIMARY KEY (item_id, page)
);

CREATE TABLE IF NOT EXISTS cleanup_mark (     -- "fine as it is": key '<id>:<page>' (page), 'title:<id>', 'song:<id>'
  key      TEXT PRIMARY KEY,
  item_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('page','title','song')),
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cleanup_mark_item ON cleanup_mark(item_id);

CREATE TABLE IF NOT EXISTS sheet_decision (   -- "Go through sheets": keep / delete
  item_id   TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  decision  TEXT NOT NULL CHECK (decision IN ('keep','delete')),
  at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_note (       -- notes for Claude (empty text = no note; the row stays)
  item_id  TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version_decision ( -- "Versions": keep / delete per item (versions.py); the log keeps every change
  item_id   TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  decision  TEXT NOT NULL CHECK (decision IN ('keep','delete')),
  at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS version_log (      -- history of every keep / delete / clear / trashed (append only)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL,
  group_key  TEXT NOT NULL DEFAULT '',
  op         TEXT NOT NULL,                   -- keep | delete | clear | trashed
  at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS version_notsame (  -- "these are not the same song": the group's items then; undo sets undone_at
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key  TEXT NOT NULL,
  item_ids   TEXT NOT NULL,                   -- JSON list; the group hides while its items are all in here
  at         INTEGER NOT NULL,
  undone_at  INTEGER
);

CREATE TABLE IF NOT EXISTS page_later (       -- pages left for later (the current marks)
  item_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page     INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (item_id, page)
);
CREATE TABLE IF NOT EXISTS page_later_log (   -- history of every later / undo / cropped / kept (append only)
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  TEXT NOT NULL,
  page     INTEGER NOT NULL,
  op       TEXT NOT NULL,                     -- later | undo | cropped | kept
  at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crop_frame (       -- saved crop frames 1 and 2 (box on the original photo)
  slot  TEXT PRIMARY KEY CHECK (slot IN ('1','2')),
  box   TEXT NOT NULL,                        -- JSON {top, bottom, left, right}
  at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS name_suggestion (  -- suggested names; replaced / accepted / dismissed rows stay
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  TEXT NOT NULL,
  title    TEXT,                              -- NULL = no title suggested
  artist   TEXT,                              -- NULL = no artist suggested
  why      TEXT NOT NULL DEFAULT '',
  status   TEXT NOT NULL CHECK (status IN ('open','accepted','dismissed','replaced')),
  old      TEXT,                              -- JSON: the name an accept changed (for undo)
  new      TEXT,                              -- JSON: … and what it became
  at         INTEGER NOT NULL,
  done_at    INTEGER,
  undone_at  INTEGER                          -- an accept / dismiss taken back: this row stays, an open copy follows
);
CREATE INDEX IF NOT EXISTS name_suggestion_item ON name_suggestion(item_id, id);

CREATE TABLE IF NOT EXISTS book_split_mark (  -- Books → sheets: the pages where a new sheet starts
  book_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page     INTEGER NOT NULL,
  title    TEXT NOT NULL DEFAULT '',
  at       INTEGER NOT NULL,
  PRIMARY KEY (book_id, page)
);
CREATE TABLE IF NOT EXISTS book_split_undo (  -- every make-sheets; unmake sets undone_at (rows stay)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,                -- order within the book
  record     TEXT NOT NULL,                   -- JSON {at, lead, trashed, sheets, starts}
  at         INTEGER NOT NULL,
  undone_at  INTEGER
);
CREATE INDEX IF NOT EXISTS book_split_undo_book ON book_split_undo(book_id, seq);
