// Workflow script: sheet → verified Meowsic score, for one song or many (run with the Workflow tool).
// Copy into the session's workflows folder, or pass this file, with args:
//   { root: '<scratchpad>/transcribe',            // temp work folder (NOT inside ~/git/apps/meowsic); deleted per song
//     tags: ['Musical', 'English', 'From a sheet'], // optional default tags
//     songs: [{ key: 'song-01',               // folder-safe id
//               title: '<title as printed>', composer: '<composer>', album: '<musical / album>',
//               sources: 's-xxxx (piano, 6 pages), s-yyyy (lead, 2 pages)',   // candidate library sheets
//               plan: '',                          // optional extra instructions for this song
//               fixItem: '' }] }                    // optional: an EXISTING score id to verify + fix instead of a new one
// Phases: Transcribe (draft, not saved) → Verify (5 independent read-only methods) → Fix & save (one fixer).
// Skill docs: .claude/skills/transcribe-sheet/ (SKILL.md, drafting.md, saving.md, verify.md, lessons.md).
export const meta = {
  name: 'transcribe-sheet',
  description: 'Transcribe library sheets into Meowsic scores (piano if a piano sheet exists, else lead), verify each 5 independent ways, fix and save',
  phases: [
    { title: 'Transcribe', detail: 'one agent per song writes a draft (not saved)' },
    { title: 'Verify', detail: '5 independent read-only verifiers per song' },
    { title: 'Fix & save', detail: 'one agent per song checks every finding, fixes, re-verifies, saves' },
  ],
}

const A = Array.isArray(args) ? { songs: args } : args
if (!A.root) throw new Error('args.root (a scratchpad folder) is required')
const ROOT = A.root.replace(/\/$/, '')
const TAGS = JSON.stringify(A.tags || ['Musical', 'English', 'From a sheet'])
const SKILL = '~/git/apps/meowsic/.claude/skills/transcribe-sheet'

const COMMON = `Meowsic. Live server https://localhost:5180, data ~/Documents/Meowsic, repo ~/git/apps/meowsic (live checkout, read-only for you).
Read first: ${SKILL}/SKILL.md and the reference file named for your step (drafting.md / verify.md / saving.md), plus ${SKILL}/lessons.md.
Hard rules: private use; never upload/share anything; never print lyric text (counts only, at most one word to point at a spot); publisher content stays on this Mac;
never restart/kill/signal/attach the live server; no sudo; no code changes; no temp files in ~/git/apps/meowsic; NO pedal marks; never add accompaniment to a lead sheet.
Rhythm: compare (onset, duration, pitch) per note with ~/git/scripts/score-onsets.py — a matching pitch sequence is NOT a match.
Get sheet pages via GET /api/items/{id} and /api/items/{id}/pages/{n}. Other agents work on other songs in parallel: only touch your own folder and item.`

const DRAFT = { type: 'object', properties: {
  draftPath: { type: 'string' }, sourceUsed: { type: 'string' }, version: { type: 'string', enum: ['original', 'lead'] },
  summary: { type: 'string' }, sheetProblems: { type: 'string' }, uncertain: { type: 'array', items: { type: 'string' } } },
  required: ['draftPath', 'sourceUsed', 'version', 'summary', 'sheetProblems', 'uncertain'] }

const FINDINGS = { type: 'object', properties: {
  method: { type: 'string' }, barsChecked: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: {
    bar: { type: 'string' }, staff: { type: 'string' }, beat: { type: 'string' },
    sheet: { type: 'string' }, score: { type: 'string' }, confidence: { type: 'string', enum: ['sure', 'likely', 'unsure'] } },
    required: ['bar', 'sheet', 'score', 'confidence'] } } },
  required: ['method', 'barsChecked', 'findings'] }

const RESULT = { type: 'object', properties: {
  song: { type: 'string' }, itemId: { type: 'string' }, version: { type: 'string' }, sourceUsed: { type: 'string' },
  activityIds: { type: 'array', items: { type: 'string' } }, structure: { type: 'string' },
  fixesApplied: { type: 'array', items: { type: 'string' } }, findingsRejected: { type: 'number' },
  keptAsPrinted: { type: 'array', items: { type: 'string' } }, uncertain: { type: 'array', items: { type: 'string' } },
  notSaved: { type: 'string' }, cleanedUp: { type: 'boolean' } },
  required: ['song', 'itemId', 'version', 'sourceUsed', 'structure', 'fixesApplied', 'findingsRejected', 'keptAsPrinted', 'uncertain', 'cleanedUp'] }

const ONSETS = 'For every bar you check, write the (onset, duration, pitch+octave) list from the sheet FIRST, then compare with `python3 ~/git/scripts/score-onsets.py <draft> --staff N`.'
const METHODS = [
  { key: 'visual', text: `VISUAL side-by-side: render the draft (MuseScore CLI), crop every sheet system at ~3x, compare every bar of every staff: pitches, accidentals, rhythms, rests, ties, beams/tuplets, clefs, dynamics, text. ${ONSETS}` },
  { key: 'omr', text: `MACHINE OMR DIFF: run local OMR on the pages (Audiveris + omr-fix-bars.py, homr; no downloads), align bar by bar, diff onset+duration+pitch per staff (score-onsets.py --diff); check each mismatch on the image; report only confirmed draft errors.` },
  { key: 'text', text: `TEXT LAYER: every lyric syllable on every verse (spelling, punctuation, hyphen, extender, which note and that note's onset), every chord symbol (name + exact beat), every tempo/expression/text mark, in order against the sheet. Report positions, never the words.` },
  { key: 'markings', text: `STRUCTURE & NOTATION from the MusicXML directly (no render): bar count, key/time sigs and changes, clefs, repeats/voltas/segno/To Coda/D.S./coda placement, barlines, every accidental incl. carried/courtesy, ties vs slurs (ties kept across D.S.), tuplets, dynamics, articulations, ottavas, voices; no <pedal>; no added staff on a lead sheet; score-onsets.py !SUM/!TYPE on every voice.` },
  { key: 'blind', text: `BLIND RE-READ: WITHOUT opening the draft first, write your own per-bar (onset, duration, pitch+octave) list for every staff from the sheet (extra care on chords, bass staff, ledger lines, octaves). Only then diff with the draft via score-onsets.py; re-look at the sheet at each difference; report only confirmed draft errors.` },
]

const SONGS = A.songs || []
const results = await pipeline(SONGS,
  (s) => s.fixItem
    ? Promise.resolve({ draftPath: `library item ${s.fixItem} (GET /api/items/${s.fixItem}/musicxml)`, sourceUsed: s.sources, version: '', summary: 'existing score', sheetProblems: '', uncertain: [] })
    : agent(`${COMMON}
TASK: transcribe "${s.title}" (${s.album}) into a draft score. Candidate sheets in the library: ${s.sources}.
Source rule: piano version if a piano sheet exists (version "original"); if only lead sheets exist, a lead score (version "lead": melody + chords + lyrics only, NO added accompaniment). ${s.plan || ''}
Several candidates of the chosen kind: use the clearest, cross-check unclear spots with the others; say which and why. Use all pages in order.
Copy exactly as printed (drafting.md): all staves, clefs, key/time sigs and changes, every note/rest/rhythm/tuplet, ties, slurs, articulations, dynamics, text, ottavas, repeats/voltas/segno/D.S./coda as printed (don't unroll), chord symbols at printed beats, ALL lyric verses with syllabic/extend. No pedal, no tempo marks. Hand-write the MusicXML from ~3x crops; OMR only as a first guess.
Self-check: score-onsets.py shows no !SUM / !TYPE; render and compare each system. If the sheet itself looks wrong, say so in sheetProblems.
DO NOT SAVE. Write ${ROOT}/${s.key}/draft.musicxml. Return draftPath, sourceUsed (sheet id + why), version, summary (bars, staves, keys, meters, repeats, credits), sheetProblems ('' if none), uncertain bars.`,
      { label: `transcribe:${s.key}`, phase: 'Transcribe', schema: DRAFT }),
  (d, s) => parallel(METHODS.map(m => () => agent(`${COMMON}
READ-ONLY verification (verify.md): don't write to the library or the draft. Draft for "${s.title}" (${s.album}): ${d.draftPath}. Source sheet: ${d.sourceUsed}. Version: ${d.version || 'as saved'}. Transcriber's summary: ${d.summary}
YOUR METHOD (one of 5 independent verifiers; you don't see the others): ${m.text}
Work only in ${ROOT}/${s.key}/verify-${m.key}/ and delete it when done. Return every discrepancy (bar 1-based, staff, beat, sheet vs score, confidence) and which bars you checked.`,
    { label: `verify:${s.key}:${m.key}`, phase: 'Verify', schema: FINDINGS }))).then(v => ({ d, v: v.filter(Boolean) })),
  ({ d, v }, s) => agent(`${COMMON}
FIX & SAVE "${s.title}" (${s.album}) — verify.md "The fixer" + saving.md. Draft ${d.draftPath}; source ${d.sourceUsed}; version ${d.version || 'as saved'}. Sheet problems noted: ${d.sheetProblems || 'none'}. Transcriber's uncertain spots: ${JSON.stringify(d.uncertain)}.
Verifier reports (${v.length}/5):
${JSON.stringify(v, null, 1)}
1. Check EVERY finding against the sheet crop yourself; real or not (one-line reason). Count rejected.
2. Apply the real ones. ${s.fixItem
    ? `Existing item ${s.fixItem}: ONLY logged routes (POST /api/items/${s.fixItem}/editnotes with sha, preview first; lyrics route). Never PUT /musicxml. A fix the ops can't express: list it in notSaved, don't work around it.`
    : `In the draft file.`}
3. Re-verify: score-onsets.py (no !SUM/!TYPE), score-onsets.py <before> --diff <after> shows only the intended bars, render the changed bars beside the crops.
4. Before ANY write: GET /api/items/{id}/editsession inactive AND no editnotes/preview/draft/lyrics on that id in ~/Documents/Meowsic/work/server.log in the last 10 min — else stop and report in notSaved.
${s.fixItem ? '' : `5. Save as a NEW score via POST /api/items: kind score, title "${s.title}", artist "${s.composer}", album "${s.album}", version "${d.version || 'original'}" (piano = "original", never "piano"), key set, tags ${TAGS}, source 'From the sheet “<sheet title>”', musicxmlText (lyrics embedded). Read it back to confirm it loads.`}
6. Delete ${ROOT}/${s.key}/ entirely (it holds lyric-bearing files).
Return item id, version, sourceUsed, activity ids, structure, fixes applied (bar + what), findings rejected, keptAsPrinted (oddities left as on the sheet), uncertain bars, notSaved ('' if all done), cleanedUp. Never lyric text.`,
    { label: `fix-save:${s.key}`, phase: 'Fix & save', schema: RESULT }),
)

return results.map((r, i) => r || { song: SONGS[i].title, failed: true })
