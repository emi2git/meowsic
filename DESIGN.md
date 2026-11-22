# Meowsic 2.0 — design (phase 2: backend)

## Where things live
| What | Where |
|---|---|
| Code | `~/git/apps/meowsic` (branch `v2`; old iPad app = tag `v1`) |
| Web UI (PWA) | `web/` — built in phase 1 with a mock store (`web/js/store.js`) |
| Server | `server/` — Python 3.12 + FastAPI, serves `web/` and `/api/*` |
| Migration | `migrate/` — one-off importers from the three old apps |
| Database | `~/Documents/Meowsic/meowsic.db` (SQLite, schema in `server/schema.sql`) |
| Files | `~/Documents/Meowsic/items/<item_id>/` (pages/001.jpg…, original.pdf, *.musicxml, *.mid, *.pdf) |
| Transcription cache | `~/Documents/Meowsic/work/<id>/` (rebuildable) |
| Backups | `~/Documents/Meowsic/backups/` (daily copy of the db, keep 30) |
| AI models | `~/ai/models` only (never in git); list in `models.json` |
| Log | `~/Library/Logs/Meowsic.log` |
| Launcher | `~/Applications/Meowsic.app` |

Old data is **read-only** for Meowsic 2.0: `~/Documents/Meowsic/Meowsic.store` (Meowsic 1), `~/Documents/Emi Songbook/library.json`,
`~/Documents/Emi Music Note/`. Never modify or move them.

## Rules
- Runs on this Mac only (port 5180, home Wi-Fi). The second MacBook (`ssh_server`) is not used yet.
- No cloud, no API keys. AI runs locally (see `docs/model-candidates.md`).
- Purchased content (scans, lyrics) never goes to GitHub or any server: `items/` and the db stay in `~/Documents/Meowsic`.
- Each score version is its own item (tag = version name). No collections — tags do that job.
- Kinds: sheet (photos / PDF pages), chords (ChordPro text), score (MusicXML + MIDI).
