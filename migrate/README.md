# migrate — one-off import into Meowsic 2.0

`migrate.py` imports four old sources into `~/Documents/Meowsic/meowsic.db` + `~/Documents/Meowsic/items/`
(schema: `../server/schema.sql`, plus the additive columns `item.folder` and `item.origin_at`).

| Source | What becomes what |
|---|---|
| Meowsic 1 `~/Documents/Meowsic/Meowsic.store` | sheets (pages exported from Apple Photos), chord charts, score, tags, play sessions; soft-deleted → Trash |
| Emi Songbook `~/Documents/Emi Songbook/library.json` | chord charts (ChordPro), collections → tags; duplicates of Meowsic 1 charts skipped |
| Emi Music Note `~/Documents/Emi Music Note/<slug>/` | one score per transcription (version `original`, tag `Original`) |
| iCloud `Desktop/2023 Music sheet` | sheets grouped by file name; each PDF = one sheet (pages rendered with `pdftoppm`); exact duplicates (sha256) and titles already imported are skipped |

All sources are read-only. The Meowsic 1 store is copied to a temp folder before it is opened.

## Run

```sh
cd ~/git/apps/meowsic/migrate
python3 -m venv .venv && .venv/bin/pip install osxphotos pillow   # once (.venv is not in git)
.venv/bin/python migrate.py --dry-run    # counts only, writes nothing
.venv/bin/python migrate.py              # real run
.venv/bin/python migrate.py --verify     # re-count from the db, check every referenced file exists
```

Options: `--out DIR` (default `~/Documents/Meowsic`), `--only meowsic1,songbook,musicnote,folder`.
Needs `pdftoppm` (`brew install poppler`). The first run reads iCloud files, so they get downloaded.

## Re-running

Safe at any time. Every item has `legacy_ref` (e.g. `meowsic1:sheet:<asset id>`, `songbook:hac-4285`,
`musicnote:<slug>`, `folder2023:<path of first file>`) and a stable id derived from it, so existing items are
skipped and never changed. The one exception: Meowsic 1 sheets whose pages were only in iCloud get their pages
rebuilt once the photos are downloaded in Photos (or a local preview gets replaced by the original) — but only
if the sheet was not edited or annotated in Meowsic 2.0 since.

To fetch iCloud-only photos first: open Photos → Settings → iCloud → "Download Originals to this Mac",
wait, then re-run.

## Layout

`items/<id> <title>/` with files named after the folder: `<id> <title> 1.jpg` … (real extension),
`<id> <title>.pdf` for PDF sheets, `<id> <title>.musicxml` / `.mid` / `.pdf` for scores. Chord charts have no folder.

## Output

Reports (titles, so they stay on this Mac): `~/Documents/Meowsic/migrate/report-*.txt` and `manifest.json`
(which Meowsic 1 pages came from originals, previews or were missing — used by re-runs).
One `activity` row of type `import` per source (`act-import-<source>`, updated on re-run).
