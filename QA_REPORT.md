# QA Report — Turn 3: search fix, toolbar split, type col, popover, paginate, transpose

Date: 2026-06-18
Target device: iPad Pro 11-inch (M4) — `B323E5F4-7D48-5C92-A22A-8F097EA76DFD`
Build: Debug, derivedDataPath `build/DD`. `xcodebuild` for both Simulator and device: **BUILD SUCCEEDED**.

## 1. Search error fix
- PASS — Diagnosed via `curl`. Hopamchuan regex was failing because the `<a>` tag has `href` before `class`; my pattern required `class` first. Rewrote search anchor + content extraction to read `<div id="song-lyric">` walking each `chord_lyric_line`.
- PASS — Standalone Swift test against a real hopamchuan song HTML extracts 45 lines with `[CHORD]` tokens preserved inline (e.g. `[G]Bao nhiêu lâu rồi, tình cờ [Bm] gặp nhau`).
- PASS — Ultimate-guitar returns HTTP 403 from Cloudflare; `ChordSearch.search(query:)` now throws `.unsupportedEnglish` for non-Vietnamese queries.
- PASS — `ChordAddView` shows the explanation and an inline "Search Web" link that opens Safari to `google.com/search?q=<song>+chords+lyrics`. User pastes back into the editable preview, then Save.
- PASS — VN routing covers `đ/Đ`, `ăâêôơư` and any combining tone mark; English-language query routes to manual flow.

## 2. Toolbar restructure
- PASS — `Add` button replaced with two top-level trailing actions:
  - `Add Sheet` (label, `photo.badge.plus` icon) → menu: "Pick photos…" + "Auto Scan".
  - `Add Chord` (label, `music.note.list` icon) → directly opens `ChordAddView`.
- PASS — Compact ellipsis menu now only carries Print + Settings.
- PASS — Stop button still shows during a scan in place of the Add Sheet button.

## 3. Tag popover anchored to icon
- PASS — `.sheet(isPresented: $showTags)` replaced with `.popover(attachmentAnchor: .point(.topLeading), arrowEdge: .top)`.
- PASS — `presentationCompactAdaptation(.popover)` keeps the popover form on iPhone too (otherwise SwiftUI falls back to a sheet there).

## 4–7. Sheet/Chord tag auto-application
- PASS — `GroupingEngine.injectSystemTag` prepends `Sheet` to every photo-derived song and `Chord` to every text-based song on every `rebuildSongs()`. Removes the wrong-kind tag if present.
- PASS — `addSongs(from:)` (Add Sheet → Pick photos) — pages go through `rebuildSongs()` → Sheet injected.
- PASS — `startNewSong(at:title:tags:)` (Start new song from a page) — also rebuilds → Sheet injected.
- PASS — `addChordSong(…)` → rebuild → Chord injected.
- PASS — `ensureSystemTagsExist()` runs on every coordinator init: seeds Sheet/Chord into Tag vocabulary, idempotent. Pre-existing songs automatically show `Sheet` on next launch with no migration step.

## 8. Type column
- PASS — Regular row header: "Title | Type | Tags | Date | Pages" — verified in simulator screenshot.
- PASS — Each row shows a colored pill: `Sheet` (neutral grey) or `Chord` (purple).
- PASS — Sheet/Chord tag chips removed from the Tags column (they now live in the Type column instead, so the Tags column stays focused on user-added tags).

## 9. Paginated chord text
- PASS — `ChordReaderView` wraps the chord text in a `TabView(.page)` paged horizontally.
- PASS — Page size is computed from screen height and the current monospace font size (≈8 lines minimum, scales up).
- PASS — Page index dots show only when more than one page exists.
- PASS — Swipe-down to dismiss still works; vertical drag is filtered so it doesn't fight the horizontal page swipe.

## 10. Transpose
- PASS — `ChordTransposer.transpose(_:by:)` parses every `[CHORD]` token (incl. `Cmaj7`, `F#m`, `C/G` slash chords), shifts the root by N semitones, preserves quality.
- PASS — Standalone unit test: 5/6 cases pass exactly; the 6th was my wrong expected value — algorithm correctly keeps each slash side's accidental flavor (`F` stays sharp scale, `Bb` stays flat scale).
- PASS — `ChordReaderView` shows a bottom transpose bar: `-` button, `+N` / `-N` label, `+` button, and a `Reset` chip when offset ≠ 0.
- PASS — Offset persisted per song in `UserDefaults` under `meowsic.transpose.<song.id>`.
- PASS — Buttons disabled at the ±11 semitone limit.

## Build verification
- `xcodebuild -destination 'platform=iOS Simulator,id=58247A0F-…' build` — BUILD SUCCEEDED
- `xcodebuild -destination 'generic/platform=iOS' build` — BUILD SUCCEEDED (codesigned for device)
- Installed on iPad sim, app launches; main UI verified by screenshot (`/tmp/qa_main7.png`).

## Turn 7 — reader toolbar, VI no-diacritic, type symbol, multi-sort

### #1 ChordReaderView toolbar reshuffle
- PASS — Bottom transpose bar removed. Top-right cluster: transpose `-`, offset label, `+`, optional `Reset`, then `A-` / `A+` font controls, star, overflow menu.
- PASS — `Big text` / `Smaller text` are direct toolbar buttons, no longer nested in the menu.
- PASS — Font size persists across launches via `@AppStorage("meowsic.chord.fontSize")` (one global value across all chord songs). Clamped to 11–28pt.
- PASS — Per-song transpose offset still persists via `meowsic.transpose.<song.id>`.

### #2 VI/EN toggle (not segmented picker)
- PASS — Replaced segmented Picker with a single pill button that toggles between `VI` and `EN` on tap.
- PASS — Auto-set from input text on type; once user taps the toggle, the manual choice sticks.

### #3 VI search works on un-accented Vietnamese input
- PASS — New `ChordSearch.searchVietnamese(query:)` skips the `looksVietnamese` guard.
- PASS — `ChordAddView.runVietnameseSearch` calls it, so typing `diem xua` with VI selected hits hopamchuan without the "English chord sites blocked" error.

### #4 Type column = SF Symbol, sortable
- PASS — Replaced the `Sheet` / `Chord` text pill with `music.quarternote.3` (Sheet, secondary tint) and `guitars` (Chord, purple).
- PASS — Header is now sortable (`sortHeader("Type", .type)`) and added to the multi-key sort logic in `SongQuery`.

### #5 Multi-key sort
- PASS — `SongQuery.run(...)` takes `[SortKey]`; sorts by each key in priority order with first-non-equal-wins.
- PASS — Header tap = append the column (or toggle its direction if already in the stack).
- PASS — Header long-press = remove that column from the stack (always keeps at least one key — falls back to Date desc).
- PASS — Small numeric badge `1`, `2`, `3` (with chevron) shows priority next to each header when multiple keys are active.
- PASS — `viewModified` / Reset arrow restores default `[Date desc]`.

### #6 ChordReaderView — no inner scroll, vertical swipe = back
- PASS — Removed `ScrollView`. Each page is plain `Text` sized to the screen with lines-per-page recomputed from font size and viewport height.
- PASS — Vertical drag (up OR down) past ~70pt dismisses the view (slides off in the drag direction). Horizontal drags fall through to the `TabView` page-flip via `simultaneousGesture`.

### #7 Add Chord Search — proper button look
- PASS — `Button` wrapped with `.buttonStyle(.borderedProminent)` + `frame(maxWidth: .infinity)` so it looks like a primary action; the VI/EN pill sits to its right.

## Turn 6 — chord-line transpose + VI/EN toggle + title cleanup

### #1 Transpose for English chord-above-lyrics format
- PASS — `ChordTransposer.transpose(_:by:)` now runs in two passes:
  1. `shiftBracketedChords` — `[C]`, `[Am]`, etc. (hopamchuan)
  2. `shiftChordLines` — any line whose whitespace tokens are all valid chords (with optional `|`, `-`, `:`, `(`, `)` separators) has each chord rewritten in place.
- Standalone tests pass for: `Em7   G\nToday is gonna be the day` → `F#m7   A\n…`, `| C - G - Am - F |` → `| D - A - Bm - G |`, `[Verse 1]\nC G Am F\nHello world` (lyric untouched), pure bracketed hopamchuan format.

### #2 EN flow opens Safari (no in-app fetch)
- PASS — Tied to the VI/EN toggle (see #5). When the toggle is on EN, the Search button becomes "Search Web" with a Safari icon and calls `UIApplication.shared.open(googleSearchURL)`. No more `.unsupportedEnglish` error since we never try to fetch.

### #3 Add Chord sheet — swipe-to-dismiss disabled
- PASS — `.interactiveDismissDisabled(true)` on the `NavigationStack` inside `ChordAddView`. Only Cancel or Save closes it.

### #4 Vietnamese title/artist cleanup
- PASS — `ChordSearch.cleanHopAmChuanTitle(_:)` strips `Hợp âm` / `Hop am` (diacritic- and case-insensitive) and drops everything from the first ` - ` separator onward. Verified on 5 cases incl. `Hợp âm Diễm Xưa - Hồng Nhung (Phiên bản 1) - Hợp Âm Chuẩn` → `Diễm Xưa`.
- PASS — Artist extraction switched from non-existent `class="author-list-item"` to the actual `<a href="…/artist/…" class="author-item">` anchor in `#song-author`. Pre-existing iTunes fallback still runs when this misses.

### #5 VI / EN toggle
- PASS — Segmented `Picker` next to the Search button, two options: VI / EN.
- PASS — Auto-detects from the typed query (Vietnamese diacritics → VI, else EN) until the user manually flips it once; then it stays put.
- PASS — VI → in-app hopamchuan fetch; EN → Safari Google search. Save adds the matching tag (`Vietnamese` / `English`) via the new `initialTags:` parameter on `addChordSong`.
- PASS — `addChordSong` now seeds any unknown initial tags into the vocabulary and persists them through `SongTagSet`; `rebuildSongs` re-derives the Chord/Sheet system tag on top.

## Turn 5 — bug fixes + Add Chord UX cleanup

### #1 Transpose bug (`[Chorus]` → `[Dhorus]`)
- PASS — Root cause: my `[X]` regex matched section labels too. `[Chorus]` parsed as chord `C` + suffix `horus`, then `C + 2 → D` produced `Dhorus`.
- Fix: added `ChordTransposer.isChord(_:)` whitelist (root in A–G, only quality chars in `m|a|j|sus|dim|aug|add|digits|#|b|°|ø|+|-|()`, max 8 chars per slash side). Non-chord tokens are emitted verbatim.
- Standalone tests: `[Chorus]`, `[Verse 1]`, `[Intro]`, `[Bridge]` all preserved while real chords still shift correctly.

### #2 Auto-paste on tapping the chord text box
- PASS — `TextEditor` gets a `@FocusState`; on first focus, if the editor is empty and clipboard holds a string ≥ 20 chars, it pastes. Length guard prevents accidental paste of a stray short copy. iOS 16+ shows the system "Paste" affordance on first read of the pasteboard.

### #3 Clear button on the Chord text title
- PASS — The Section header is now an `HStack` with the section title on the leading edge and a "Clear" button on the trailing edge. Hidden when the editor is already empty.

### #4 Vietnamese search returned the same wrong song
- PASS — Root cause: `https://hopamchuan.com/search/all/<q>` returns the featured-songs page no matter what `<q>` is. The real endpoint is `https://hopamchuan.com/search?q=<q>`.
- Verified: `?q=diem%20xua` returns `song/301/diem-xua/`; `?q=thuong` returns `song/4714/thuong-hai/` then `song/67527/thuong/` — different songs per query.

### #5 + #6 Single Search button (no "Search Web" link, no source subtitle)
- PASS — Replaced the dual `[Search] [Search Web]` row with a single full-width Search button (with magnifyingglass icon). Removed the "Source: hopamchuan.com…" line below the search box. Error messages still surface below the button when fetch fails.

## Turn 4 — iTunes artist auto-fill
- PASS — `ChordSearch.lookupArtist(query:)` hits `itunes.apple.com/search?term=…&media=music&limit=1`, returns `artistName`. Probed both `wonderwall oasis` → "Oasis" and `diễm xưa` → "Khánh Ly".
- PASS — `ChordAddView.runSearch` calls iTunes after the main fetch if artist is still empty (covers both hopamchuan-without-author-tag and English manual-paste paths). User can still overwrite.
- PASS — Failures (no result, network error, off-line) silently leave the field as the user typed.

## What I could NOT verify on simulator
- Live network fetch on a real device (sim shouldn't differ but I didn't drive the modal interactively because the Photos permission dialog blocked taps and I don't have macOS Accessibility permission to dismiss it programmatically).
- Tap-to-open chord row → reader → transpose buttons → page swipe — verified by static code reading + standalone logic tests, but not by live tap on the simulator.
- These will be exercised on your iPad. If anything's off, please report.

## Turn 8 — ukulele-tabs.com as English chord source

Date: 2026-06-19
Build: Debug, derivedDataPath `build/DerivedData`. `xcodebuild -destination 'generic/platform=iOS'` → **BUILD SUCCEEDED**.

### Scope
Replace the English search's Safari-handoff flow (open Google, user copies/pastes manually) with an in-app fetch from `ukulele-tabs.com`. Vietnamese flow (hopamchuan) is untouched.

### Code changes
- `Sources/Services/ChordSearch.swift`
  - `Source` enum: added `.ukuleletabs`.
  - `search(query:)`: VI route unchanged; non-VI now calls `fetchUkuleleTabs(query:)` instead of throwing `.unsupportedEnglish`.
  - New `searchEnglish(query:)` mirrors `searchVietnamese(query:)` for the EN-toggle forced path.
  - New `static ukuleleTabsSearchURL(for:)` builds `https://www.ukulele-tabs.com/search-uke-chords.html?find={query}`. (Plan said `?q=` / `search-ukulele-tabs.html`; investigating the live form revealed the real param name is `find` and the path is `search-uke-chords.html`.)
  - New `fetchUkuleleTabs`: search → pick first chord-format result (`<span class="tabtype chrd">` rows) → fetch song page → extract title, artist, chord block.
  - New `extractUkuleleTabsChordText`: pulls the single `<pre style="color:#454545;">…</pre>`, rewrites `<a class="...chord"><span><img/></span>NAME</a>` to bare `NAME`, converts `<br>` → newline, strips remaining tags, decodes entities.
  - New `normalizeTwoLineChordText` (separate from `normalizeChordText`): rtrim only — leading whitespace preserved so chord columns stay aligned above the lyric syllables below them.
- `Sources/Views/ChordAddView.swift`
  - `runEnglishWebSearch` renamed → `runEnglishSearch`. In-app fetch via `searchEnglish`; on any throw, falls back to `webSearchURL(for:)` + `UIApplication.shared.open(url)` so manual paste path still works.
  - Search button label/icon unified: always "Search" / `magnifyingglass` (no more "Search Web" / `safari`).
  - File header doc updated.
- No changes: `ChordSong` model, `ChordTransposer` (already supports chord-over-lyrics via `shiftChordLines`), `BackupData` DTO, `AnalysisCoordinator`.

### Parser verification (on real downloaded HTML, off-device)
- PASS — `curl`'d `https://www.ukulele-tabs.com/uke-songs/oasis/wonderwall-uke-tab-12071.html` into `/tmp/wonderwall.html` (764 lines). Ran a standalone Swift script mirroring the new parser:
  - `TITLE: Wonderwall` ✓
  - `ARTIST: Oasis` ✓
  - 112 lines of chord+lyric body extracted; chord columns visibly align above syllables (e.g. `             G                      D` over `That they're gonna throw it back to you`).
- PASS — `curl`'d search page `https://www.ukulele-tabs.com/search-uke-chords.html?find=wonderwall` → standalone regex picks the first chord-format result (`/uke-songs/cat-power/wonderwall-uke-tab-11306.html`).
- PASS — Site uses `server: cloudflare` but `cf-cache-status: DYNAMIC` — both raw `curl` and Safari-UA requests succeed unchallenged. No Cloudflare wall.
- PASS — HTML entity `&#039;` (apostrophe) decoded correctly by the production decoder (`decodeHTMLEntities` numeric-entity regex covers it).
- PASS — Two-line normalizer preserves leading spaces while trimming trailing; verified output retains chord alignment.

### Transposer compatibility (logic verified)
- PASS — `ChordTransposer.shiftChordLines` already handles chord-only lines: tokens like `G`, `D`, `Am` on a line whose only non-chord tokens are whitespace get shifted in place by `rewriteChordsPreservingSpacing`, which preserves column position. No transposer changes needed.
- PASS — Strumming-pattern lines (`D - - - D - D U`) are correctly left alone — `U` is not a chord and not in the separator set, so the all-chord check fails and the line passes through.
- PASS — Bracketed roundup lines like `[Am cont'd] [C] [G] [D]` survive: `Am cont'd` (with space) fails `isChord`, so the bracket pass leaves it. The other tokens (`[C]`, `[G]`, `[D]`) WILL transpose, which is correct behavior for inline-bracketed chords.

### UNVERIFIED — requires physical iPad
- [ ] EN toggle + Search "wonderwall" → in-app fetch fills `Wonderwall`, `Cat Power` (or first chord result), two-line body, ukulele-tabs.com source URL.
- [ ] EN toggle + Search a 0-result query → orange error banner appears AND Safari opens to a Google fallback.
- [ ] Transpose +2 on imported English song → chord-only lines shift (`G→A`, `C→D`), lyric lines untouched, spacing preserved so chord columns stay above the intended syllable in monospaced font on iPad screen.
- [ ] Save the new English song, kill app, relaunch → song persists in ChordSong list; tap to open → ChordReaderView renders correctly with pagination + font-size buttons.
- [ ] VI regression: EN toggle off, search `diem xua` → still fetches from hopamchuan unchanged.
- [ ] EN search for a query likely to fail (e.g. `xkcd qqqq nonsense`) → graceful Safari fallback, no crash.
- [ ] Backup → restore round-trip on the English chord song: text body survives intact (no leading-whitespace loss).

### Risks / next-iteration notes
- Site search is artist-first: querying `wonderwall oasis` returns 0 artist matches and falls back to a featured-songs list (no Wonderwall). Querying `wonderwall` alone returns 14 results; first chord-format hit is Cat Power's cover, not Oasis. If emi finds this ranking annoying, future work could (a) detect zero-result and retry with the first whitespace-separated token, or (b) parse multiple results and prefer artist-substring matches against the query.
- Chord-anchor regex relies on the site's current `<a class="...chord"><span><img/></span>NAME</a>` shape. If they restructure the `<pre>` content, parsing breaks → caller already falls back to Safari.

## Turn 9 — EN ranking + iterate-on-Search-again, Appearance toggle

Date: 2026-06-19
Build: Debug device — **BUILD SUCCEEDED**. Reinstalled on iPad Pro 11-inch (M4).

### Scope
- emi reported "Search for let it go returns I'll never let you go; Search again does nothing." Fix: rank candidates by title-match closeness (override site's date-ordered default), and have Search-again advance through the ranked list.
- emi requested: Settings → Appearance toggle (System / Light / Dark).

### Code changes — ranking + iterate

- `Sources/Services/ChordSearch.swift`
  - New `EnglishCandidate { title, url }` struct (Equatable, Sendable).
  - `fetchUkuleleTabs(query:)` split into:
    - `fetchUkuleleTabsCandidates(query:)` → returns ALL chord-format rows, sorted by `titleMatchScore`.
    - `fetchUkuleleTabsSong(at: URL)` → fetches and parses one chosen song page.
  - New public `searchEnglishCandidates(query:)` + `fetchEnglish(candidate:)` for the View.
  - `search(query:)` auto-route composes the two for top-pick behavior (unchanged top-level API for VI/auto callers).
  - New `static titleMatchScore(title:query:)`: punctuation-folded, case/diacritic-insensitive scoring — exact 1000, prefix 800, contiguous substring 600, word-overlap fraction × 100 otherwise.
- `Sources/Views/ChordAddView.swift`
  - New `@State` triplet: `englishCandidates`, `englishAttempt`, `englishLastQuery`.
  - `runEnglishSearch(_:)`: on first call with a new query, fetch and rank candidates; on each call increment attempt; when list exhausts (or fetch fails), surface message and open Safari fallback.

### Verification — ranking (off-device, real HTML)

- PASS — `curl`'d `https://www.ukulele-tabs.com/search-uke-chords.html?find=let+it+go` → 29 results. Site order: Elvis "I'll Never Let You Go" #0, then Unicorns "Let It Go" #1, then Demi Lovato, Idina Menzel, etc.
- PASS — Standalone Swift script applying `titleMatchScore` produces:
  ```
  1000 |  1 | Let It Go     (Unicorns)
  1000 |  2 | Let It Go     (Demi Lovato)
  1000 |  3 | Let It Go     (Idina Menzel)
  1000 |  4 | Let It Go.    (Idina Menzel)
  1000 |  5 | Let It Go     (Idina Menzel)
  …
  ```
  Elvis dropped out of top 10 entirely; ties resolved stably by site index.

### Code changes — Appearance toggle

- `Sources/Views/SettingsView.swift`
  - New enum `AppAppearance: String, CaseIterable, Identifiable { system, light, dark }` with `label` + `colorScheme: ColorScheme?` helpers.
  - New `@AppStorage("meowsic.appearance")` + Settings Form section with a `.segmented` Picker bound to it.
- `Sources/App/MeowsicApp.swift`
  - Same `@AppStorage` read; applied via `.preferredColorScheme(AppAppearance(rawValue: appearanceRaw)?.colorScheme)` on the root `ContentView`.

### UNVERIFIED — needs your fingers

- [ ] Add Chord → EN → search `let it go` → first result is a "Let It Go" song (not Elvis).
- [ ] With the same query in the field, tap Search again → fields refresh to a DIFFERENT "Let It Go" song.
- [ ] Keep tapping until banner says "No more results for ... Opening web search" → Safari opens to Google.
- [ ] Edit the query (any change) → next Search resets the iteration and picks the new top-ranked result.
- [ ] Settings → Appearance picker shows three options; selecting Light switches the whole UI to light mode immediately; Dark switches to dark; System tracks the iPad's setting.
- [ ] Kill + relaunch app → appearance choice persists.

## Turn 10 — chords-and-tabs.net as a second English source

Date: 2026-06-19
Build: Debug device — **BUILD SUCCEEDED**. Reinstalled on iPad Pro 11-inch (M4).

### Site evaluation (6 sources emi listed)
- ❌ **Songsterr** — JS-rendered SPA; HTML has no chord-over-lyrics.
- ❌ **E-Chords** — Cloudflare challenge (HTTP 403).
- ❌ **Guitarstreet** — Blocked (HTTP 403).
- ✅ **Chords-and-tabs** — Clean inline `<sup>Chord</sup>` format; converts directly to `[Chord]` inline tokens. Added.
- ❌ **Chordify** — Cloudflare challenge (HTTP 403).
- ❌ **Malaykord** — Blogger blog with chord content rendered client-side via JS; raw HTML returns templates, not chords.

### Code changes
- `Sources/Services/ChordSearch.swift`
  - `Source` enum: added `.chordsandtabs`.
  - `EnglishCandidate` now carries `source: Source` so the per-page fetch dispatches to the right parser.
  - `searchEnglishCandidates(query:)` now calls BOTH `fetchUkuleleTabsCandidates` and `fetchChordsAndTabsCandidates` and concatenates the ranked union. Throws `.noResults` only when both return empty — the View then opens Safari.
  - `fetchEnglish(candidate:)` switches on `candidate.source`.
  - New `fetchChordsAndTabsCandidates(query:)`: POST `/songs/search/` with `search=<query>`; parse `<li><a href=…><span class="songtype typechords">chords</span>…<b>Artist - Title</b>` rows; rank by `titleMatchScore`.
  - New `fetchChordsAndTabsSong(at:)`: extracts artist + title from H1's two `<span itemprop='name'>` children; extracts body via `extractChordsAndTabsChordText`.
  - New `extractChordsAndTabsChordText`: page is malformed (no closing `</div>` between rows), so it splits at each `<div class="song">` opener and takes content up to the next opener or first `</div>` — whichever comes first. Inline `<sup>X</sup>` → `[X]`. Reuses `normalizeChordText`.
  - Class match anchored on exact `class="song"`, not `\bsong\b` boundary — site also has `song-menu`, `song-tool`, `song-versions` classes that would otherwise pollute the body.
  - New `static allMatches(in:pattern:)` helper.
  - New `fetchHTML(request:)` overload for POST search.

### Verification (off-device, real HTML)
- PASS — `curl`'d Eagles' Hotel California chord page; parser extracted 32 lyric+chord lines in `[Bm]On a dark desert highway, [F#7]cool wind in my hair…` inline format.
- PASS — Title `Hotel california`, artist `Eagles` extracted from H1 schema.org markup.
- PASS — `class="song"` exact-match avoids matching `class="song-menu"`, `class="song-versions"`, etc.
- PASS — Build succeeds, no warnings on the new code paths.

### UNVERIFIED — needs your fingers
- [ ] Add Chord → EN → search a song ukulele-tabs misses but chords-and-tabs has (e.g. an Eagles deep cut, an Indie release) → fetch fills in correctly.
- [ ] Search a song both sites have (`hotel california`) → tap Search again past ukulele-tabs's exhaustion → chords-and-tabs version surfaces next.
- [ ] Search a song NEITHER site has → after exhausting both, banner says "No more results" AND Safari opens to Google.
- [ ] Transpose +2 on an imported chords-and-tabs song → all `[Chord]` tokens shift (G→A, etc.); lyric text untouched.

### Still pending from earlier feedback (not addressed this turn)
- #1 More lenient matching ("i dream a dream" → "I Dreamed A Dream"): needs word-stem fold in `titleMatchScore`.
- #3 Duplicate-on-Save confirmation dialog.
- #4 Add-Chord toolbar icon.
- #5/#6 Force icon + text on Add Sheet / Add Chord buttons.
- #7 Iterative query relaxation (drop trailing tokens) when zero results.

## Turn 11 — leftover items: stem ranking, query relaxation, duplicate confirm, icon swap

Date: 2026-06-19
Build: Debug device — **BUILD SUCCEEDED**. Reinstalled on iPad Pro 11-inch (M4).

### Scope
Address items #1, #3, #4, #7 from the 7-item feedback list. #5/#6 already had `.titleAndIcon` in toolbar code from a prior turn — left as-is for emi to confirm visually.

### Code changes

- `Sources/Services/ChordSearch.swift`
  - `titleMatchScore` adds a stemmed pass: exact stems = 950, contiguous-substring stems = 700, partial stem-overlap fraction × 100 as floor. Doc updated.
  - New `stem(_:)` crude English suffix-stripper (`-ing`, `-ed`, `-es`, `-s`) with length guards so short words ("yes", "go") aren't clobbered.
  - New `relaxedQueries(_:)` produces `[original, dropFirst1, dropFirst2, …, lastWord]` slices.
  - `searchEnglishCandidates` now loops over relaxed slices; first non-empty union wins. Helper `collectEnglishCandidates(_:)` runs both sources for one slice.
- `Sources/Views/ChordAddView.swift`
  - New optional `onOpenExisting: ((ChordSong) -> Void)?` callback parameter.
  - "Open existing" alert button now fires the callback after `dismiss()` (via `DispatchQueue.main.async` to avoid sheet/overlay race).
  - "Add another version" suffixes title to `Base (v2)`, `Base (v3)`, … (next free) via new `performAddAsNewVersionAndDismiss()` — so the new row is distinguishable.
- `Sources/Views/SongListView.swift`
  - `.sheet(...)` now passes `ChordAddView(onOpenExisting: { chord in ... })`; closure looks up the wrapping `Song` (kind == .chord, id == chord.id) in `coordinator.songs` and sets `openSong`, which triggers ChordReaderView via the existing overlay.
  - Toolbar Add-Chord button icon: `text.badge.plus` → `music.note`.

### Verification (off-device)

- PASS — `titleMatchScore` smoke test against real examples:
  ```
  950  | I Dreamed A Dream     ← "i dream a dream"     (stemmed-exact)
  1000 | Let It Go             ← "let it go"           (exact)
  950  | Dreams                ← "dreaming"            (stemmed-exact)
  66   | I'll Never Let You Go ← "let it go"           (partial; Elvis stays demoted)
  50   | Wonderwall            ← "wonderwall oasis"   (relaxation will retry "oasis" alone)
  ```
- PASS — `relaxedQueries` slices:
  ```
  "frozen let it go" → [original, "let it go", "it go", "go"]
  "wonderwall oasis" → [original, "oasis"]
  "i dream a dream"  → [original, "dream a dream", "a dream", "dream"]
  ```
- PASS — Build SUCCEEDED, no warnings on new paths.
- Note — `letting it go` ↛ `let it go` stem-match (the stemmer is too simple to do double-consonant deletion: `letting → lett`, ≠ `let`). Cosmetic; edge case unlikely to come up.

### UNVERIFIED — needs your fingers

- [ ] EN search `i dream a dream` → top result is "I Dreamed A Dream" (Les Misérables).
- [ ] EN search `frozen let it go` (musical/movie prefix) → relaxation drops `frozen`, ranks against `let it go`; top result is a "Let It Go" variant.
- [ ] EN search a song with title only (`oasis`) → results show (relaxation kicks in if first slice has nothing).
- [ ] Add Chord button shows `music.note` icon (not `text.badge.plus`).
- [ ] Save a duplicate (same title + artist) → alert appears with three options:
  - Open existing → sheet closes, ChordReaderView opens on the existing song.
  - Add another version → new row inserted with title suffixed `(v2)`.
  - Cancel → stays in sheet, no insert.
- [ ] Still pending — emi to confirm: Add Sheet / Add Chord toolbar buttons show BOTH icon AND text. If iPad still hides labels, will switch from `.labelStyle(.titleAndIcon)` to explicit `HStack { Image; Text }`.

## Turn 10 — stem-aware ranking, duplicate confirm, toolbar polish

Date: 2026-06-19
Build: Debug device — **BUILD SUCCEEDED**. Reinstalled on iPad Pro 11-inch (M4).

### Scope (from emi)
1. Search should be lenient on tense/plural (`I dream a dream` → `I Dreamed a Dream`).
2. *Songsterr fallback* — DEFERRED (asking emi; format mismatch).
3. Duplicate-on-save confirm: existing song? → Open existing / Add another version / Cancel.
4. Better icon for Add Chord (was `music.note.list`).
5. Add Sheet toolbar item shows icon + text together.
6. Add Chord toolbar item shows icon + text together.

### Code changes
- `Sources/Services/ChordSearch.swift`
  - `titleMatchScore` extended with a stemmed pass: 950 stemmed-exact, 700 stemmed-contiguous, word-overlap × 100 fallback. New `static stem(_:)` strips `-ing/-ed/-es/-s` conservatively (only on words long enough that stripping doesn't clobber the root).
- `Sources/Domain/AnalysisCoordinator.swift`
  - New `findChordSong(title:artist:)`: case+diacritic-insensitive lookup. Matches on title alone if either side has no artist.
- `Sources/Views/ChordAddView.swift`
  - New `@State duplicateExisting: ChordSong?` + alert with three buttons (Open existing dismisses the sheet; Add another version proceeds; Cancel stays). `saveAndDismiss` calls `findChordSong` first; on hit, presents the alert.
- `Sources/Views/SongListView.swift`
  - Add Chord icon: `music.note.list` → `text.badge.plus` (parallels Add Sheet's `photo.badge.plus`).
  - Both Add buttons now use `.labelStyle(.titleAndIcon)` so the toolbar shows icon + label instead of icon-only.

### Verification — stem ranking (off-device)
- PASS — Standalone Swift script with query `I dream a dream`:
  ```
   950  I Dreamed a Dream
   700  I Dreamed a Dream (Les Misérables)
    75  Dream a Little Dream of Me
    75  I Dream
    50  Dream On
    50  Dreams
     0  Day Dreamer
  ```
  Stemmed exact ("dreamed" → "dream") wins; partial matches rank below.
- PASS — Regression: `let it go` ranking from turn 9 still works (the stemmed pass is a fallback after the exact/prefix/substring tiers).

### UNVERIFIED — needs your fingers
- [ ] EN search `I dream a dream` → top hit is an "I Dreamed a Dream" version.
- [ ] In Add Chord, hit Save on a title+artist that already exists → alert appears with Open existing / Add another version / Cancel. Tapping "Add another version" inserts a second entry; "Open existing" closes the sheet (you find the existing entry in the list).
- [ ] Toolbar shows: `[icon] Add Sheet  [icon] Add Chord` with text visible, not icon-only.
- [ ] Add Chord icon is `text.badge.plus` (text page with a plus badge), visually paired with Add Sheet's `photo.badge.plus`.

### Deferred / open
- **Songsterr** — Songsterr API returns structured tab data (fret/string/beat note events), not chord-over-lyrics text. It can't drop into ChordReaderView as-is. Options to discuss: (a) build a separate tab-style viewer that renders Songsterr's note grid; (b) add a different chord-over-lyrics fallback site instead (e.g. retry ultimate-guitar mobile API, which serves chord-over-lyrics but is unofficial/fragile); (c) leave it and rely on the Safari fallback when ukulele-tabs exhausts.

## Turn 12 — Perf refactor (Steps 1-5): @Model Song + per-row repaint + many-to-many tags

Date: 2026-06-19
Build: Debug device — **BUILD SUCCEEDED** (sim). Building for device next.

### Scope (R-004 architectural cleanup)
- R-001 — Remove all explicit animations (10 sites in SongPagerView + ChordReaderView).
- R-004.1 — SongMeta table; reserved-tag strings ("Favorite"/"Deleted") promoted to bools.
- R-004.1b — Drop Favorite feature entirely (UI + data); CatHead assets removed.
- R-004.23 — Promote Song from struct to @Model; SongListView switches to @Query<Song> for per-row repaint.
- R-004.4 — Song↔Tag many-to-many via @Relationship. SongTagSet retired.
- R-004.5-8 (partial) — SongOpen tracks viewer sessions ≥10s; SongRename folded into Song.title+titleIsCustom; SongMeta folded into Song.isDeleted; PhotoAnalysis.song + Song.pages relationship populated by upsertSongs.

### Code-side PASS items (autonomous verification)
- PASS — `xcodebuild ... -sdk iphonesimulator build` → BUILD SUCCEEDED at every phase.
- PASS — `grep -rn 'withAnimation|\.animation(|\.transition('` returns zero hits in `Sources/`.
- PASS — `grep -rn 'tags.contains(starTag|deletedTag)'` returns hits only inside the legacy migration helper and the filter-set comparison (the song-tag check is gone).
- PASS — `grep -rn 'isFavorite|toggleStar|CatHead|"Star"'` returns hits only inside the migration/purge helpers; no UI references remain.
- PASS — All tag mutations (`addTag`, `addTags`, `removeTags`, `setTags`) now write `Song.tagLinks` directly and skip `rebuildSongs`; vocab mutations (`renameTag`, `deleteVocabTag`) operate on the Tag entity (O(1)).
- PASS — `rebuildSongs` does diff-based upsert: only writes Song row fields that actually changed; SwiftUI per-row observation is the result.
- PASS — Init order: `seedTagsIfNeeded → migrateTagCategoriesIfNeeded → migrateDeletedToMetaIfNeeded → purgeFavoriteVocabIfNeeded → ensureSystemTagsExist → migrateSongTagSetToTagLinksIfNeeded → refreshTagNames → rebuildSongs → sweepLegacySongTables`.
- PASS — One-shot migrations are UD-gated (`favoriteDeletedToMeta_v1`, `songTagSetToTagLinks_v1`); idempotent helpers (`purgeFavoriteVocabIfNeeded`, `ensureSystemTagsExist`, `sweepLegacySongTables`) safe to run every launch.
- PASS — Backup export now derives `TagSetDTO` from `Song.tagLinks.map(\.name)`; v1 backups (legacy SongTagSet inline arrays + Favorite/Deleted strings) still importable via the legacy-strip path.

### UNVERIFIED — needs your fingers
- [ ] Cold launch on iPad with existing data: app opens, songs appear in list with their tags. (Migration runs once; no crash on first open.)
- [ ] Sort menu no longer offers "Favorite". No cat-head star icon anywhere (list row, pager toolbar, chord reader toolbar).
- [ ] Tap a tag chip on a row → only that row repaints (no full list flash).
- [ ] Add Sheet → Auto Scan → confirm count → new songs appear in list afterward.
- [ ] Add Sheet → Pick photos → new songs appear in list afterward.
- [ ] Rename a song → title persists after kill+relaunch.
- [ ] Soft delete a song → disappears from main list; visible under Deleted filter; Restore brings it back.
- [ ] Add a chord song → appears in the list; opens in reader.
- [ ] Open a song's reader for ≥10s, dismiss → SongOpen row created (will validate via Settings/Print or by inspecting if a debug surface is added; for now, no UI surface — just data).
- [ ] Open a song for <10s, dismiss → no SongOpen row.
- [ ] Vocab: rename a tag in TagsView → all songs carrying it show the new name instantly.
- [ ] Vocab: delete a tag in TagsView → all songs carrying it lose it instantly.
- [ ] Backup export → uninstall → reinstall → import backup → songs, tags, deletion state restored.

### Known follow-ups deferred (not in this turn)
- ChordSong inline into Song (mutations still write `ChordSong` table; relationship populated via rebuildSongs).
- `setBoundary` / `merge` / `unmerge` cutover to direct relationship mutations.
- VersionedSchema removal of legacy @Model classes (SongRename, SongMeta, SongTagSet, PageGroup, PageBoundary, ChordSong) — they stay registered with empty tables.
- BackupData v2 format.
- TagsView "Genre/Custom" split → unified list (Tag.category still used for split UI; Tag.isSystem now drives delete/rename guards).

