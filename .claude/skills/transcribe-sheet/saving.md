# Saving and fixing on the live library

All calls go to `https://localhost:5180/api/…` (live, read-write). Tests never use it: use `scripts/dev-server`.

## Safety (every write)
1. `GET /api/items/{id}/editsession` must say `active: false`. Otherwise the write gets 423: wait and retry later, and never work around it.
2. `~/Documents/Meowsic/work/server.log` must show no `/api/items/{id}/…editnotes|preview|draft|lyrics` request in the last 10 min.
   `server/scripts/credit_transcribed.py` has a ready `recently_edited()` to copy. (On 2026-11-24 an agent's save
   during the user's edit cost the user 30 min of work.)
3. Never restart, signal, kill or `lldb` / `py-spy` attach the live server (a failed attach killed it on 2026-11-24).
   Only the deploy agent restarts it.
4. Never write to `~/git/apps/meowsic`, and never put temp files there.

## A new score (the normal case)
`POST /api/items`:
```json
{"kind":"score","title":"<as printed>","artist":"<composer>","album":"<musical / album>",
 "version":"original|lead","key":"F","tags":["Musical","English","From a sheet"],
 "source":"From the sheet “<sheet title>”","musicxmlText":"<the MusicXML>","groupId":"<optional: same-song group>"}
```
- Score versions: `original, vocal, lead, duet, accomp, clear, pro, easy` (`db.SCORE_VERSIONS`). **A piano score is
  `original`**; `piano` is a *sheet* version, and the API refuses it for scores.
- The server writes the credits (`db.credit_xml`): composer = `artist`, plus arranger "Transcribed by Meowsic" (from
  `score_byline`). Autofill fills an empty artist / album from the library but **never the key**, so set `key` yourself.
- Use the title as printed. Add the `Verified` tag only when the user asks (it is the user's badge).
- Read the item back (`GET /api/items/{id}`, `GET …/musicxml`) and check that it loads and `staves` is right.
- An old score whose credits say "Read by Meowsic": `POST /api/items/{id}/credit {dryRun}` (logged). For many scores:
  `server/.venv/bin/python server/scripts/credit_transcribed.py --dry-run`.

## Fixing an existing score (logged, undoable)
`POST /api/items/{id}/editnotes/preview` and then `POST /api/items/{id}/editnotes {sha, ops:[…], mode:'this'|'new'}`.
Get `sha` from the GET. A changed score gives 409: reload and redo, never force. Each save = one Activities row with a 24 h
Undo. **Never `PUT …/musicxml`** (it writes no Activities row).

Bars are **0-based** and staves 1-based (1 = top). The ops most used here:
| Op | Shape |
|---|---|
| replace a bar | `{op:'alt', bar, measure:'<measure>…</measure>'}` (keeps the words by onset, `barcheck.carry_lyrics`; check the words after thinning a bar) |
| chord symbol | `{op:'chord', bar, on, text}`: `on` in **quarters from the bar start, from 0**; `text:''` removes it. Every score needs chords over the whole piece (SKILL.md §1a); add a missing set in **one** save (many `chord` ops). On a voice + piano score it writes into the piano part |
| remove a staff | `{op:'delstaff', staff}` (e.g. an arranged LH on a lead score) |
| lyrics | `{op:'lyrics', staff, verse, notes:[{ref, text, syllabic, extend?}]}`, or the lyrics route below |
| clef | `{op:'clef', bar, staff, clef:'treble'\|'bass', until?}` |
| 8va / 8vb | `{op:'ottava', staff, from_bar, to_bar, shift:8\|-8\|15\|-15\|0, from_beat?, to_beat?}` (pitches stay = sounding) |
| pedal marks off | `{op:'unpedal', staff?}` (`pedalops.py`; if a server is older and refuses the op, report it and don't hand-edit) |
| note fixes | `pitch {refs, by}`, `set {refs, midis}`, `len {refs, q}`, `tie`, `slur`, `delete`, `add`, `shift` |
| structure | `pickup {beats}`, `keysig {bar, fifths}`, `timesig {bar, beats, beatType}`, `repeat {bar, kind}`, `ending {bars, number}`, `insbar`, `delbar`, `bartime`, `fillbar` |
The full list is in the docstrings of `staffmove.edit()`, `barops.py`, `structops.py`, `chordops.py` and `octaveops.py`.

Lyrics route: `GET /api/items/{id}/lyrics?line=` (notes + refs + sha), `POST …/lyrics/preview`,
`POST …/lyrics {line, verse, notes, holds, sha, mode}`.

Item info (title / artist / album / tags / key / version): `PATCH /api/items/{id}`, one Activities row each.

If a fix can't be expressed with logged ops, don't do it some other way. List it in the report (or get the app fixed
first, as with the D.S. tie on `m-1dapqsx`).
