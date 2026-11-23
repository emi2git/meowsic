-- Meowsic 2.0 database (SQLite). One file: ~/Documents/Meowsic/meowsic.db
-- Files (page images, PDFs, MusicXML, MIDI) live under ~/Documents/Meowsic/items/<item_id>/.
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
  folder      TEXT,                           -- files live in items/<folder>/ (named after the title); NULL for chord charts
  origin_at   INTEGER                         -- original date: photo capture / file date / transcription / chord fetch (ms)
);

CREATE TABLE IF NOT EXISTS sheet (            -- kind = 'sheet'
  item_id   TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  source    TEXT NOT NULL CHECK (source IN ('photos','pdf')),
  pages     INTEGER NOT NULL,
  book      INTEGER NOT NULL DEFAULT 0        -- 1 = a book (many songs); files in items/Books/<title>/
);
CREATE TABLE IF NOT EXISTS sheet_page (
  item_id      TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL,              -- 1-based
  file         TEXT NOT NULL,                 -- relative to items/<item_id>/, e.g. pages/001.jpg
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
  version     TEXT NOT NULL,                  -- original | vocal | lead | duet | accomp | easy | pro
  musicxml    TEXT NOT NULL,                  -- file under items/<id>/ (edited notes are saved back here)
  musicxml_original TEXT,                     -- untouched copy, for "Revert note edits"
  midi        TEXT,
  pdf         TEXT,
  key         TEXT NOT NULL DEFAULT '',
  bpm         REAL,
  source      TEXT NOT NULL DEFAULT '',       -- 'YouTube · …' | 'Audio file · …' | 'From the score “…”'
  group_id    TEXT,                           -- versions made from the same recording share this
  ai          INTEGER NOT NULL DEFAULT 0      -- 1 = composed by Claude (AI music); added only by ~/git/scripts/meowsic-add-ai-score.py
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
