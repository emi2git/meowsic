# AI model candidates (to compare later)

Researched 2026-11-22. Current = what Emi Music Note uses today. Test each candidate side by side on our own recordings and sheets before switching.

| Job | Current | Candidates | Notes |
|---|---|---|---|
| Piano notes (audio → notes) | transkun 2.0 | Rubato (2026) | transkun still top on MAESTRO (~93% note F1); weak on pop with voice/guitar. Rubato: slightly higher F1, score-friendly timing; check code release. |
| Voice / instrument separation | HTDemucs | Mel-Band RoFormer (vocals); BS-RoFormer | RoFormer family best open models for vocals; keep Demucs as fast fallback / multi-stem. |
| Vocal melody (lead sheet, piano + vocals) | from piano notes | Mel-RoFormer vocal melody transcription (2024) | Writes the sung melody directly. |
| Piano easy | music21 rules | Difficulty-controlled simplification (Nov 2025, 0.3M params, MusicXML in/out, code + model released) | Mostly simplifies the accompaniment. |
| Arrangement (song → piano cover) | music21 rules | Pop2Piano (2022, style control); Etude (2025, faithful but dense) | |
| Chords | basic guess | ChordFormer (2025); Chord Mini app | Large chord vocabulary (7ths, sus…). |
| Beat / bars | beat_this | — | Nothing better found. |
| Sheet photo → notes (OMR) | Audiveris 5.10 | LEGATO / LEGATO 2 (2025–26); ScanScore (Audiveris-based UI) | No fair benchmark found; test on our sheets. |
| Lyrics | mlx-whisper large-v3-turbo | — | |

Sources: arXiv 2610.29222 (transkun SOTA), 2605.24291 (Rubato), 2310.01809 (Mel-Band RoFormer), 2409.04702 (Mel-RoFormer vocal melody), 2511.16228 (difficulty simplification), 2211.00895 (Pop2Piano), 2509.16522 (Etude), 2512.22621 (chord recognition review), 2506.19065 / 2607.05769 (LEGATO).

## Test recordings (from the user, 2026-11-22)

Use these when comparing models side by side.

| # | Link | What it is |
|---|---|---|
| 1 | https://www.youtube.com/watch?v=b5qFDGFqiUA | Vocals + piano |
| 2 | https://www.youtube.com/watch?v=-gY_3HaIK44 | Piano |
| 3 | https://www.facebook.com/reel/1048625037748000 | Piano |
| 4 | https://www.facebook.com/reel/1477861190079337 | Live recording; long to fetch |

Notes: YouTube links are trimmed to the video (playlist/radio parameters dropped). Facebook reels need a downloader that supports Facebook (yt-dlp does).
