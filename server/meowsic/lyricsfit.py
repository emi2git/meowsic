"""Add lyrics from a sheet to a score (score ⋯ → "Add lyrics from a sheet…", job kind 'lyrics').

1. The sheet's photos → omr/omr.py --first-verse (homr + Audiveris + Apple Vision): the sheet's tune with its
   words under it, one syllable per note. Kept in work/lyricsfit/<sheet id>-<updatedAt>/ for the next time.
2. Both tunes are read as a skyline: the highest note at each onset of the top staff (a part named Voice /
   Melody wins), ties joined.
3. Dynamic programming lines the sheet's notes up with the score's (semi-global: the score's intro / outro are
   free): pitch class after the best transposition, the step from the note before (contour), and the length
   after the best tempo ratio. Either side may skip notes (ornaments and fills in the score; bars the
   recording leaves out).
4. Each syllable goes on its partner note; a syllable whose note has no partner goes on the free score note
   nearest to where it should be between its neighbours' partners. Both kinds of doubt are "low confidence":
   the syllable is red and its bar gets "⚠ check lyrics".
5. The result is a new score item (same group and version, tag "Lyrics added"); the score itself is untouched.
"""
import json
import math
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
MELODY_NAMES = ('voice', 'melody', 'vocal', 'vocals', 'lead', 'soprano')
OMR_DIR = Path(__file__).resolve().parents[2] / 'omr'
TAG = 'Lyrics added'
CHECK = '⚠ check lyrics'
RED = '#D22'
EPS = 1e-4

# alignment weights (tuned on synthetic tunes; see tests/test_lyricsfit.py)
GAP_SCORE = -0.35  # a score note with no sheet note (ornament, fill, accompaniment on top)
GAP_SHEET = -1.0   # a sheet note with no score note
JUMP_OPEN, JUMP_EXT = -6.0, -0.05  # a long stretch on either side with nothing on the other
SHIFTS = range(12)
RATES = (0.5, 1.0, 2.0)  # score quarters per sheet quarter
SWITCH = -10.0      # a change of key or tempo ratio between sheet and score
WINDOW = 4          # a syllable is judged by the sheet notes up to WINDOW before and after it:
SURE, KEEP = 0.7, 0.4  # sure when this share of them pair up with the same pitch (and the tempo fits); left out below KEEP
TEMPO = (0.5, 2.2)  # …and the score takes about as long for them as the sheet (rubato, held notes)
FILL_MAX = 4        # syllables with no partner note are placed only inside short gaps
RESPREAD_MAX = 24   # …or a stretch of up to this many syllables between sure ones is spread over its notes again


@dataclass
class Note:
    onset: float       # quarters from the start
    dur: float
    midi: int
    bar: str           # the measure's number
    els: list = field(default_factory=list)  # the <note> elements sounding at this onset on the staff, top first
    meas: object = None  # the <measure> element
    text: str = ''
    syllabic: str = ''


# ---------- reading ----------

def _midi(n):
    p = n.find('pitch')
    if p is None: return None
    try:
        return 12 * (int(p.findtext('octave')) + 1) + STEP[p.findtext('step').strip()] + round(float(p.findtext('alter') or 0))
    except (TypeError, ValueError, KeyError, AttributeError):
        return None


def _melody_part(root):
    """(part element, staff or None): a part named Voice / Melody…, else the first part's top staff."""
    names = {sp.get('id'): (sp.findtext('part-name') or '').strip().lower() for sp in root.iter('score-part')}
    parts = root.findall('part')
    if not parts: return None, None
    for p in parts:
        if names.get(p.get('id')) in MELODY_NAMES: return p, None
    return parts[0], '1'


def read_tune(root, lyrics=False) -> list[Note]:
    """The tune of a score-partwise tree: highest note at each onset of the melody staff, in time order."""
    part, staff = _melody_part(root)
    if part is None: return []
    raw, start, div = [], 0.0, 1  # (onset, end, midi, el, bar, meas)
    for meas in part.findall('measure'):
        t = last = longest = 0.0
        for e in meas:
            if e.tag == 'attributes' and e.find('divisions') is not None:
                div = int(float(e.findtext('divisions')))
            elif e.tag == 'backup':
                t -= float(e.findtext('duration') or 0) / div
            elif e.tag == 'forward':
                t += float(e.findtext('duration') or 0) / div
                longest = max(longest, t)
            elif e.tag == 'note':
                if e.find('grace') is not None or e.find('cue') is not None: continue
                d = float(e.findtext('duration') or 0) / div
                chord = e.find('chord') is not None
                at = last if chord else t
                if not chord:
                    last, t = t, t + d
                    longest = max(longest, t)
                if staff and (e.findtext('staff') or '1').strip() != staff: continue
                m = _midi(e)
                if m is None or d <= 0: continue
                raw.append([start + at, start + at + d, m, e, meas.get('number', ''), meas,
                            any(x.get('type') == 'stop' for x in e.findall('tie'))])
        start += longest
    # a tied-on note only makes its note longer
    raw.sort(key=lambda r: (r[0], -r[2]))
    notes, open_ = [], {}
    for on, end, m, e, bar, meas, tied in raw:
        prev = open_.get(m)
        if tied and prev is not None and abs(prev[1] - on) < 0.05:
            prev[1] = end
            continue
        r = [on, end, m, e, bar, meas]
        open_[m] = r
        notes.append(r)
    # skyline: highest note per onset, unless a higher note from before is still sounding
    by = {}
    for r in notes: by.setdefault(round(r[0], 4), []).append(r)
    out, sounding = [], []
    for on in sorted(by):
        grp = sorted(by[on], key=lambda r: -r[2])
        top = grp[0]
        sounding = [r for r in sounding if r[1] > on + EPS]
        if any(r[2] > top[2] for r in sounding):
            sounding += grp
            continue
        sounding += grp
        n = Note(on, top[1] - on, top[2], top[4], [r[3] for r in grp], top[5])
        if lyrics: n.text, n.syllabic = _lyric_of(n.els)
        out.append(n)
    # a melody note lasts until the next melody onset at most
    for a, b in zip(out, out[1:]): a.dur = min(a.dur, b.onset - a.onset)
    return out


def _lyric_of(els):
    """(text, syllabic) of the first verse on any of these notes."""
    best = None
    for e in els:
        for ly in e.findall('lyric'):
            num = ly.get('number') or '1'
            try: k = int(num)
            except ValueError: k = 99
            text = ''.join(x.text or '' for x in ly.findall('text')).strip()
            if text and (best is None or k < best[0]): best = (k, text, (ly.findtext('syllabic') or 'single').strip())
    return (best[1], best[2]) if best else ('', '')


# ---------- aligning ----------

def _sub_matrix(S, T, shift, rate):
    """Score for pairing sheet note i with score note j (n × m)."""
    sp = (np.array([s.midi for s in S]) + shift) % 12
    tp = np.array([t.midi for t in T]) % 12
    d = np.abs(sp[:, None] - tp[None, :])
    d = np.minimum(d, 12 - d)
    sub = np.where(d == 0, 2.0, np.where(d <= 1, -0.6, -1.5))
    si = np.diff([s.midi for s in S], prepend=S[0].midi)
    ti = np.diff([t.midi for t in T], prepend=T[0].midi)
    di = np.abs(si[:, None] - ti[None, :])
    same = (di == 0) | (di == 12)
    sign = np.sign(si)[:, None] == np.sign(ti)[None, :]
    sub += np.where(same, 0.6, np.where(sign, 0.2, -0.3))
    sd = np.log2(np.maximum([s.dur * rate for s in S], 1 / 16))
    td = np.log2(np.maximum([t.dur for t in T], 1 / 16))
    sub -= 0.35 * np.minimum(np.abs(sd[:, None] - td[None, :]), 2.0)
    return sub


def _dp(sub):
    """Semi-global alignment over layers (one per transposition × tempo ratio; sub is L × n × m). The score's ends
    are free; moving to another layer costs SWITCH (a key or tempo change in one of the two). Skipping notes costs
    either per note (GAP_*) or, for a long stretch (a section the recording leaves out, an interlude), once
    (JUMP_OPEN + JUMP_EXT per note). Returns (best score, [(i, j, layer)])."""
    L, n, m = sub.shape
    ninf = -1e18
    H = np.zeros((L, m + 1))
    P = np.zeros((n + 1, L, m + 1), dtype=np.int8)  # 0 diagonal, 1 up (skip a sheet note), 2 left (skip a score note), 3 sheet jump, 4 score jump
    D = np.zeros((n + 1, L, m + 1), dtype=np.int8)  # the layer a diagonal step comes from
    PE = np.zeros((n + 1, L, m + 1), dtype=bool)  # a sheet jump goes on from the row above
    PF = np.zeros((n + 1, L, m + 1), dtype=bool)  # a score jump goes on from the column before
    E = np.full((L, m + 1), ninf)
    P[0, :, 1:] = 2
    ks = np.arange(m + 1)
    lay = np.arange(L)[:, None]
    for i in range(1, n + 1):
        prev = H
        opened, kept = prev + JUMP_OPEN, E + JUMP_EXT
        E = np.maximum(opened, kept)
        PE[i] = kept > opened
        best_l = prev.argmax(axis=0)  # per column, the best layer to switch from
        other = prev.max(axis=0) + SWITCH
        stay = prev >= other[None, :]
        src = np.where(stay, lay, best_l[None, :])
        diag = np.full((L, m + 1), ninf)
        diag[:, 1:] = np.maximum(prev, other[None, :])[:, :-1] + sub[:, i - 1]
        D[i, :, 1:] = src[:, :-1]
        up = prev + GAP_SHEET
        a = np.maximum(np.maximum(diag, up), E)
        pa = np.where(a == diag, 0, np.where(a == up, 1, 3))
        # skipping score notes one by one: H[j] = max_k (a[k] + (j-k)·GAP) — a running max
        h1 = np.maximum.accumulate(a - ks * GAP_SCORE, axis=1) + ks * GAP_SCORE
        p1 = np.where(h1 > a + 1e-9, 2, pa)
        # …or in one jump: F[j] = max_k<j (h1[k] + JUMP_OPEN + (j-1-k)·JUMP_EXT)
        F = np.full((L, m + 1), ninf)
        F[:, 1:] = np.maximum.accumulate(h1[:, :-1] - ks[:-1] * JUMP_EXT, axis=1) + JUMP_OPEN + ks[:-1] * JUMP_EXT
        PF[i, :, 1:] = F[:, 1:] > h1[:, :-1] + JUMP_OPEN + 1e-9
        H = np.maximum(h1, F)
        P[i] = np.where(F > h1 + 1e-9, 4, p1)
    l, j = np.unravel_index(int(np.argmax(H)), H.shape)
    best, i, pairs, state = float(H[l, j]), n, [], 'H'
    while i > 0 and j > 0:
        if state == 'E':
            state = 'E' if PE[i, l, j] else 'H'
            i -= 1
            continue
        if state == 'F':
            state = 'F' if PF[i, l, j] else 'H'
            j -= 1
            continue
        p = P[i, l, j]
        if p == 0:
            pairs.append((i - 1, j - 1, int(l)))
            l = D[i, l, j]; i -= 1; j -= 1
        elif p == 1: i -= 1
        elif p == 2: j -= 1
        elif p == 3: state = 'E'
        else: state = 'F'
    return best, pairs[::-1]


def align(S: list[Note], T: list[Note]):
    """[(i, j, shift, rate)]: sheet note i ↔ score note j, the sheet transposed up `shift` semitones and
    `rate` times as long there."""
    if not S or not T: return []
    layers = [(k, r) for k in SHIFTS for r in RATES]
    sub = np.stack([_sub_matrix(S, T, k, r) for k, r in layers])
    _, pairs = _dp(sub)
    return [(i, j, *layers[l]) for i, j, l in pairs]


def _quality(S, T, trip, n):
    """How well the stretch around pair n lines up: (share of the sheet notes nearby paired with the same pitch,
    the nearby score time ÷ sheet time against the pair's tempo ratio, 1 = as expected)."""
    i, _, _, r = trip[n]
    lo, hi = max(0, i - WINDOW), min(len(S) - 1, i + WINDOW)
    near = [t for t in trip[max(0, n - 2 * WINDOW):n + 2 * WINDOW + 1] if lo <= t[0] <= hi]
    good = sum(1 for a, b, k, _ in near if (S[a].midi + k - T[b].midi) % 12 == 0)
    dens = good / (hi - lo + 1)
    if len(near) < 3: return dens, 0.0
    ds = S[near[-1][0]].onset - S[near[0][0]].onset
    dt = T[near[-1][1]].onset - T[near[0][1]].onset
    if ds <= 0 or dt <= 0: return dens, 0.0
    return dens, (dt / ds) / r


def place(S: list[Note], T: list[Note]):
    """[(sheet index, score index, confident)] for every sheet syllable that found a place, plus the alignment info."""
    if not S or not T: return [], {'shift': 0, 'blocks': 0}
    trip = align(S, T)
    q = [_quality(S, T, trip, n) for n in range(len(trip))]
    trip = [t for t, (dens, _) in zip(trip, q) if dens >= KEEP]  # stray pairs in a stretch that doesn't line up
    q = [x for x in q if x[0] >= KEEP]
    pairs = [(i, j) for i, j, *_ in trip]
    of = dict(pairs)
    used, out = set(), []
    for (i, j, k, _), (dens, tempo) in zip(trip, q):
        if not S[i].text: continue
        sure = (S[i].midi + k - T[j].midi) % 12 == 0 and dens >= SURE and TEMPO[0] <= tempo <= TEMPO[1]
        out.append((i, j, sure)); used.add(j)
    # syllables whose note found no partner (a note or two missing): the free score note nearest to where it should be
    for i, s in enumerate(S):
        if not s.text or i in of: continue
        lo = max((p for p in pairs if p[0] < i), default=None)
        hi = min((p for p in pairs if p[0] > i), default=None)
        if lo is None or hi is None or hi[0] - lo[0] - 1 > FILL_MAX: continue
        free = [j for j in range(lo[1] + 1, hi[1]) if j not in used]
        if not free: continue
        f = (s.onset - S[lo[0]].onset) / max(S[hi[0]].onset - S[lo[0]].onset, EPS)
        want = T[lo[1]].onset + f * (T[hi[1]].onset - T[lo[1]].onset)
        j = min(free, key=lambda j: abs(T[j].onset - want))
        out.append((i, j, False)); used.add(j)
    out = _respread(S, T, out)
    out.sort(key=lambda x: x[1])
    return out, {'shift': trip[0][2] if trip else 0, 'blocks': len({t[2] for t in trip})}


def _respread(S, T, out):
    """Between two sure syllables, when some syllables found no note but the score has at least as many notes there
    as the sheet has syllables (the pairing went astray, e.g. a misread bar), the stretch's syllables are spread
    over its score notes again, in order, each as near as possible to where its time says (all unsure)."""
    by_i = {i: (j, sure) for i, j, sure in out}
    anchors = sorted((i, j) for i, j, sure in out if sure)
    anchors = [a for k, a in enumerate(anchors) if all(a[1] > b[1] for b in anchors[:k])]  # strictly in order
    for (ai, aj), (bi, bj) in zip(anchors, anchors[1:]):
        syl = [i for i in range(ai + 1, bi) if S[i].text]
        if not syl or len(syl) > RESPREAD_MAX or all(i in by_i for i in syl): continue
        notes = list(range(aj + 1, bj))
        if len(notes) < len(syl): continue
        span_s = max(S[bi].onset - S[ai].onset, EPS)
        want = [T[aj].onset + (S[i].onset - S[ai].onset) / span_s * (T[bj].onset - T[aj].onset) for i in syl]
        # monotone assignment of syllables to notes, least total time error (k syllables × m notes)
        k, m = len(syl), len(notes)
        INF = float('inf')
        C = [[INF] * (m + 1) for _ in range(k + 1)]
        C[0] = [0.0] * (m + 1)
        for a in range(1, k + 1):
            for b in range(a, m + 1):
                C[a][b] = min(C[a][b - 1], C[a - 1][b - 1] + abs(T[notes[b - 1]].onset - want[a - 1]))
        a, b, pick = k, m, []
        while a > 0:
            if b > a and C[a][b] == C[a][b - 1]: b -= 1
            else: pick.append((syl[a - 1], notes[b - 1])); a -= 1; b -= 1
        for i in syl: by_i.pop(i, None)
        for i, j in pick: by_i[i] = (j, False)
    return [(i, j, sure) for i, (j, sure) in by_i.items()]


# ---------- writing ----------

def _insert_lyric(note_el, text, syllabic, sure):
    ly = ET.Element('lyric', {'number': '1', **({} if sure else {'color': RED})})
    ET.SubElement(ly, 'syllabic').text = syllabic or 'single'
    ET.SubElement(ly, 'text').text = text
    kids = list(note_el)
    at = next((k for k, c in enumerate(kids) if c.tag in ('play', 'listen')), len(kids))
    note_el.insert(at, ly)


def _mark_bar(meas, staff):
    d = ET.Element('direction', {'placement': 'above'})
    w = ET.SubElement(ET.SubElement(d, 'direction-type'), 'words', {'color': RED})
    w.text = CHECK
    if staff: ET.SubElement(d, 'staff').text = staff
    kids = list(meas)
    at = next((k for k, c in enumerate(kids) if c.tag in ('note', 'backup', 'forward', 'direction', 'harmony')), len(kids))
    meas.insert(at, d)


def _fix_syllabic(placed, S):
    """A word cut short (its next syllable found no place) still reads right: begin→single, middle→end."""
    k = {i for i, _, _ in placed}
    for i, _, _ in placed:
        s = S[i]
        nxt = next((x for x in range(i + 1, len(S)) if S[x].text), None)
        if s.syllabic in ('begin', 'middle') and (nxt is None or nxt not in k):
            s.syllabic = 'single' if s.syllabic == 'begin' else 'end'


def fit(score_xml: str, sheet_xml: str):
    """(new score MusicXML text, report). The report has numbers only."""
    root = ET.fromstring(score_xml.encode('utf-8') if isinstance(score_xml, str) else score_xml)
    sroot = ET.fromstring(sheet_xml.encode('utf-8') if isinstance(sheet_xml, str) else sheet_xml)
    S, T = read_tune(sroot, lyrics=True), read_tune(root)
    syl = sum(1 for s in S if s.text)
    if not syl: raise ValueError('No words were found on the sheet')
    if not T: raise ValueError('The score has no tune to put words under')
    placed, info = place(S, T)
    _fix_syllabic(placed, S)
    part, staff = _melody_part(root)
    for e in part.iter('note'):
        for ly in e.findall('lyric'): e.remove(ly)
    for d in [d for m in part.findall('measure') for d in m.findall('direction')
              if any((w.text or '') == CHECK for w in d.iter('words'))]:
        for m in part.findall('measure'):
            if d in list(m): m.remove(d)
    check = []
    for i, j, sure in placed:
        _insert_lyric(T[j].els[0], S[i].text, S[i].syllabic, sure)
        if not sure and T[j].bar not in check: check.append(T[j].bar)
    for m in part.findall('measure'):
        if m.get('number', '') in check: _mark_bar(m, staff)
    head = score_xml[:score_xml.find('<score-partwise')] if isinstance(score_xml, str) and '<score-partwise' in score_xml else '<?xml version="1.0" encoding="UTF-8"?>\n'
    out = head + ET.tostring(root, encoding='unicode')
    sure = sum(1 for p in placed if p[2])
    report = {'syllables': syl, 'placed': len(placed), 'sure': sure, 'unsure': len(placed) - sure,
              'coverage': round(100 * len(placed) / syl, 1), 'checkBars': len(check), 'bars': len(part.findall('measure')),
              'sheetNotes': len(S), 'scoreNotes': len(T), **info}
    return out, report


# ---------- the sheet's words (OMR) ----------

def omr_python() -> Path | None:
    for p in (os.environ.get('MEOWSIC_OMR_PY'), OMR_DIR / '.venv' / 'bin' / 'python',
              Path.home() / 'git' / 'apps' / 'meowsic' / 'omr' / '.venv' / 'bin' / 'python'):
        if p and Path(p).exists(): return Path(p)
    return None


def read_sheet(cfg, sheet: dict, on_event=None, cancelled=lambda: False) -> Path:
    """The sheet's pages read as a score with words (cached per sheet version). Returns its MusicXML path."""
    from . import inkclean, trim
    from .db import folder_path
    cache = cfg.work_dir / 'lyricsfit' / f"{sheet['id']}-{sheet.get('updatedAt') or 0}"
    if (cache / 'out' / 'score.musicxml').is_file(): return cache / 'out' / 'score.musicxml'
    py = omr_python()
    if not py: raise RuntimeError('Reading sheets is not set up on this Mac (omr/.venv missing)')
    if not sheet.get('pageFiles'): raise RuntimeError('That sheet has no pages')
    shutil.rmtree(cache, ignore_errors=True)
    cache.mkdir(parents=True)
    d = folder_path(cfg, sheet['folder'])
    pages = []
    for k, f in enumerate(sheet['pageFiles'], 1):
        dst, _ = inkclean.prepare_page(d / f, cache, k, trim.analyze(d / f)['trim'])
        pages.append(str(dst))
    proc = subprocess.Popen([str(py), str(OMR_DIR / 'omr.py'), '--first-verse', '--out', str(cache / 'out'), '--title', 'sheet', *pages],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(OMR_DIR))
    tail = []
    for line in proc.stdout:
        if cancelled(): proc.kill(); raise RuntimeError('cancelled')
        try: ev = json.loads(line)
        except ValueError: tail = (tail + [line.strip()])[-3:]; continue
        if on_event: on_event(ev)
    if proc.wait() != 0 or not (cache / 'out' / 'score.musicxml').is_file():
        shutil.rmtree(cache, ignore_errors=True)
        raise RuntimeError('Could not read the sheet: ' + (tail[-1] if tail else 'unknown error'))
    return cache / 'out' / 'score.musicxml'


# ---------- the job ----------
OMR_STEP = {'notes': 0.1, 'lyrics': 0.6, 'check': 0.7, 'chords': 0.75, 'words': 0.85, 'done': 1.0}


def lyrics_runner(ctx):
    """Job 'lyrics': fromItemId = the score, sheetId = the sheet with the words. Stages (LYRICS_STAGES in the UI):
    0 read the score, 1 read the words on the sheet, 2 fit them to the tune, 3 write the new score (and its PDF)."""
    from . import arrange
    from .db import connect, folder_path, get_item
    from .jobs import Cancelled
    from .runners import pdf_on, save_outputs
    p = ctx.params
    c = connect(ctx.cfg)
    try: src, sheet = get_item(c, p.get('fromItemId', '')), get_item(c, p.get('sheetId', ''))
    finally: c.close()
    if not src or src['kind'] != 'score' or not src.get('musicxml'): raise RuntimeError('The score is gone')
    if not sheet or sheet['kind'] != 'sheet': raise RuntimeError('The sheet is gone')
    ctx.update(stage=0, progress=0)
    xml = folder_path(ctx.cfg, src['folder']) / src['musicxml']
    score_xml = xml.read_text(encoding='utf-8')
    ctx.update(stage=1, progress=0, msg=f'Reading the words on “{sheet["title"]}” ({sheet.get("pages") or "?"} pages)')

    def ev(e):
        ctx.update(progress=round(0.9 * OMR_STEP.get(e.get('step'), 0) + 0.05 * (e.get('progress') or 0), 3))
    sheet_xml = read_sheet(ctx.cfg, sheet, ev, ctx.cancelled)
    if ctx.cancelled(): raise Cancelled()
    ctx.update(stage=2, progress=0)
    out, rep = fit(score_xml, sheet_xml.read_text(encoding='utf-8'))
    ctx.update(stage=3, progress=0, msg=f"Placed {rep['placed']} of {rep['syllables']} syllables ({rep['coverage']:g}%)"
               + (f"; {rep['checkBars']} bars to check" if rep['checkBars'] else ''))
    work = ctx.work
    new = work / 'lyrics.musicxml'
    new.write_text(out, encoding='utf-8')
    mid = folder_path(ctx.cfg, src['folder']) / src['midi'] if src.get('midi') else None
    pdf = None
    if pdf_on():
        if arrange.render_pdf(new, work / 'lyrics.pdf'): pdf = work / 'lyrics.pdf'
    v = src.get('version') or 'original'
    ids = save_outputs(ctx, [(v, new, mid, pdf, {})], title=src['title'],
                       source=f'From the score “{src["title"]}” + lyrics from the sheet', artist=src.get('artist', ''),
                       tags=[*[t for t in src.get('tags', []) if t != TAG], TAG], group_id=src.get('groupId'),
                       key=src.get('key', ''), bpm=src.get('bpm'), ai=src.get('ai'), source_url=src.get('sourceUrl') or '')
    ctx.update(stage=3, progress=1, status='done', result=ids,
               msg=f"Done — {rep['coverage']:g}% of the words placed" + (f", {rep['checkBars']} bars to check" if rep['checkBars'] else ''))
    return rep
