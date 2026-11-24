# Meowsic 2.0

One app for all the family's sheet music, chord charts, books and scores. It replaces the old iPad Meowsic, Emi Songbook and Emi
Music Note. It is a web app (PWA) served from the Mac over HTTPS, used on the Mac, iPad and iPhone, and it works offline
with what was opened before.

- **Read and play**: sheets and books page by page, chord charts in any key with piano / ukulele shapes, scores drawn and
  played on piano, with zoom per device, kids note names, ink and printing.
- **Add music**: photos or PDFs, the Photos album, chord search, a recording or link turned into a score, or a sheet
  read into a score (beta).
- **Edit**: Edit notes (notes, rests, bars, staves, repeats, lyrics, MIDI keyboard), Simple piano versions, Check bars.
- **Manage library**: fix pages and crops, split / join songs, books, complete song info, Trash. Every change has Undo for 24 hours.
- Everything stays on this Mac. All AI runs offline, and nothing is sent to outside services.

Open https://localhost:5180 on the Mac, or https://192.168.1.50:5180 on the iPad / iPhone (they trust the Meowsic
certificate once). `~/Applications/Meowsic.app` starts the server if it is not running.

**For engineers and Claude sessions: read [CLAUDE.md](CLAUDE.md) first.** It covers where things live, how to run, test
and deploy, and the rules. More: [docs/architecture.md](docs/architecture.md), [TASKS.md](TASKS.md), [WORKLOG.md](WORKLOG.md).
