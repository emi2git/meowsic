# Meowsic 2.0

One app for all sheet music, chord charts and scores: the old iPad Meowsic, Emi Songbook and
Emi Music Note in one. A web app (PWA) served from the Mac, used on Mac, iPad and iPhone.

**Status: phase 1 — UI with mock data.** Nothing talks to a server yet; changes are kept in the
browser only (Settings → Reset mock data). The old iPad app is kept as git tag `v1`.

## Run the UI preview

    cd web && python3 -m http.server 5180 --bind 0.0.0.0

Open http://localhost:5180 on the Mac, or http://<mac-name>.local:5180 on an iPad / iPhone on
the same Wi-Fi. The microphone (tuner) needs https, which arrives with the server in phase 2.

## Layout

    web/
      index.html, css/app.css, manifest.webmanifest, icon.svg
      js/app.js          shell + router (sidebar on iPad/Mac, tab bar on iPhone)
      js/store.js        mock store (phase 2 swaps this for the Mac server + offline cache)
      js/mock.js         mock library (public-domain lyrics and tunes; drawn sheet pages)
      js/chords.js       chord parsing, transpose, ukulele shapes (from Emi Songbook)
      js/chordchart.js   chord charts: easiest key, rendering
      js/musicxml.js     mock scores: MusicXML + playback notes
      js/audio.js        piano playback, metronome, tuner
      js/views/          library, item viewers, performance, add, organize, print, stats/tools/settings
      vendor/            OpenSheetMusicDisplay, Salamander piano samples (CC BY 3.0)
