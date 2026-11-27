#!/usr/bin/env python3
"""A sung melody (one note at a time) from a vocal pitch track -> a MusicXML lead line with lyrics.

usage: sung-melody-to-musicxml.py --beats bt.json --words aligned.json --syl syl.json --out out.musicxml
           (--pyin pitch.npz | --bp notes.json) [--grid 2|4] [--triplets] [--word-splits]
           [--skip 0:11.3 --skip 112.5:134.5] [--title T] [--key 2] [--report rep.json]
           [--meter auto|2/4|3/4|4/4|6/8|9/8|12/8] [--rest-min 1.0]
       sung-melody-to-musicxml.py --selftest     (rhythm fixtures: exact durations, no note + rest on held notes)

Inputs (all local, made by the caller):
  pitch.npz   librosa pyin of the vocal stem: t, f0, vp (voiced prob.)
  notes.json  basic-pitch notes [[start, end, midi, amp], ...] (polyphonic: the loudest is kept at each time)
  bt.json     beat_this beats/downbeats of the mix: {beats, downbeats}
  aligned.json  {subs: [{start, end, text}], words: [{line, k, w, s, e}]} on-screen lyric lines + word times
  syl.json    {line index: "syl-la-bles of the line"} for the lines to place (others get no words)
Steps: beat grid (half-time beats split), notes (pyin segments or basic-pitch top line), octave folded per line to
a singable range, meter from the downbeats (compound = 6/8-like when the beat splits in 3), only ONSETS quantized
(1/grid of a beat; --triplets may split a beat in 3; compound beats in 3 or 6), each note held to the next onset
(legato) unless the silence is >= --rest-min quarters and pyin hears no voice there (then a rest; the note ends on a
beat or beat division), a short silence before a bar line is held to it, bars always full, syllables placed at the
note nearest each word's sung start, extra notes = melisma.
Run with a python that has music21 + numpy (e.g. ~/git/apps/meowsic/omr/.venv/bin/python)."""
import argparse, json, math, sys
import numpy as np


def beats_per_bar(bt, P):
    """The tracker's count: median number of beats between its downbeats (2, 3 or 4; 4 if unknown)."""
    db = np.array(bt.get('downbeats') or [])
    if len(db) < 4: return 4
    n = np.round(np.diff(db) / P).astype(int)
    n = n[(n >= 2) & (n <= 4)]
    return int(np.median(n)) if len(n) else 4


def beat_grid(bt, t_end, period=None, per_bar=4):
    b = np.array(bt['beats'])
    iv = np.diff(b); P = period or float(np.median(iv))
    g = [b[0]]
    for a, c in zip(b[:-1], b[1:]):
        n = max(1, int(round((c - a) / P)))
        g += [a + (c - a) * k / n for k in range(1, n + 1)]
    while g[0] - P > 0: g.insert(0, g[0] - P)
    while g[-1] + P < t_end + 2 * P: g.append(g[-1] + P)
    g = np.array(g)
    # bar phase: the phase that puts the most steady-section downbeats on bar starts
    db = np.array(bt['downbeats'])
    idx = [int(np.argmin(abs(g - x))) for x in db if abs(g - x).min() < 0.12]
    phase = max(range(per_bar), key=lambda p: sum((i - p) % per_bar == 0 for i in idx))
    return g, phase


def to_beats(g, x):
    """time -> fractional beat index on grid g."""
    i = int(np.clip(np.searchsorted(g, x) - 1, 0, len(g) - 2))
    return i + (x - g[i]) / (g[i + 1] - g[i])


def pyin_notes(path, splits=(), vthr=0.25, min_len=0.07):
    z = np.load(path); t, f0, vp = z['t'], z['f0'], z['vp']
    m = 69 + 12 * np.log2(np.where(np.isnan(f0), 1, f0) / 440)
    ok = (~np.isnan(f0)) & (vp > vthr)
    # median smoothing over voiced runs
    sm = m.copy()
    for i in np.where(ok)[0]:
        w = [m[j] for j in range(max(0, i - 3), min(len(m), i + 4)) if ok[j]]
        sm[i] = np.median(w)
    dt = t[1] - t[0]
    cut = np.zeros(len(t), bool)
    for x in splits:
        k = int(np.searchsorted(t, x))
        if 0 < k < len(t): cut[k] = True  # a new note may start at frame k
    out, i, n = [], 0, len(t)
    while i < n:
        if not ok[i]: i += 1; continue
        j = i; vals = [sm[i]]
        while j + 1 < n and ok[j + 1]:
            ref = np.median(vals[-6:])
            if abs(sm[j + 1] - ref) > 0.75:
                # a real change only if it lasts 50 ms
                k = j + 1; cnt = 0
                while k < n and ok[k] and abs(sm[k] - ref) > 0.75 and cnt < 5: k += 1; cnt += 1
                if cnt >= 5: break
            if cut[j + 1] and t[j + 1] - t[i] > 0.06: break
            j += 1; vals.append(sm[j])
        a, b = t[i], t[j] + dt
        if b - a >= min_len:  # the steadiest pitch: the most common semitone in the middle of the note (no glides)
            mid = vals[len(vals) // 4: len(vals) - len(vals) // 4] or vals
            r = np.round(mid).astype(int); u, c = np.unique(r, return_counts=True)
            out.append([a, b, float(u[c.argmax()])])
        i = j + 1
    return out


def bp_notes(path, min_len=0.09):
    raw = sorted(json.load(open(path)))
    # the loudest note at each 10 ms step -> a monophonic line
    if not raw: return []
    T = max(x[1] for x in raw); step = 0.01
    best = [None] * (int(T / step) + 2)
    for a, b, p, amp in raw:
        for k in range(int(a / step), int(b / step)):
            if best[k] is None or amp > best[k][1] or (abs(amp - best[k][1]) < 0.05 and p > best[k][0]): best[k] = (p, amp)
    out = []
    for k, x in enumerate(best):
        if x is None: continue
        if out and out[-1][2] == x[0] and abs(out[-1][1] - k * step) < 1e-6: out[-1][1] = (k + 1) * step
        else: out.append([k * step, (k + 1) * step, float(x[0])])
    # onsets inside the same pitch (re-attacks) from basic-pitch itself
    return [n for n in out if n[1] - n[0] >= min_len]


def fold_octaves(notes, lines, lo=62, hi=73):
    """per lyric line (or 6 s window): shift by octaves so the median sits in [lo, hi); single octave jumps fixed."""
    def group(n):
        for L in lines:
            if L['start'] - 0.6 <= n[0] < L['end'] + 0.3: return ('L', L['start'])
        return ('W', int(n[0] // 6))
    groups = {}
    for n in notes: groups.setdefault(group(n), []).append(n)
    for g in groups.values():
        med = np.median([n[2] for n in g])
        sh = 0
        while med + sh < lo: sh += 12
        while med + sh >= hi: sh -= 12
        for n in g:
            n[2] += sh
            while n[2] - (med + sh) > 8: n[2] -= 12
            while (med + sh) - n[2] > 9: n[2] += 12
    return notes


METERS = {'2/4': (2, 1.0), '3/4': (3, 1.0), '4/4': (4, 1.0), '6/8': (2, 1.5), '9/8': (3, 1.5), '12/8': (4, 1.5)}
REST_MIN = 1.0   # quarters: a shorter silence is no rest (the note before is held: legato)


def compound_feel(notes, g):
    """True when the onsets mostly divide the beat in three (6/8-like), from where they fall in the beat."""
    f = np.array([to_beats(g, a) % 1 for a, _, _ in notes])
    if len(f) < 16: return False
    near = lambda x: np.abs(f - x) < 0.06     # noqa: E731
    tern = (near(1 / 3) | near(2 / 3)).sum(); bina = (near(0.25) | near(0.5) | near(0.75)).sum()
    return bool(tern >= max(8, 1.5 * bina))


def pick_meter(arg, bt, g, notes):
    """'4/4' etc. as given, or auto: beats per bar from the downbeats, compound when the beat splits in 3."""
    if arg != 'auto': return arg
    per = beats_per_bar(bt, float(np.median(np.diff(g))))
    if compound_feel(notes, g): return {2: '6/8', 3: '9/8', 4: '12/8'}[per]
    return {2: '2/4', 3: '3/4', 4: '4/4'}[per]


def quantize(notes, g, grid, triplets, qpb=1.0, rest_min=REST_MIN, voiced=None, bar=None):
    """-> [(onset beats, dur beats, midi)]. Only ONSETS are snapped: to 1/grid of a beat (simple meter;
    with triplets a beat may be split in 3 instead) or to thirds (and sixths with grid 4) of a compound beat.
    Each note then lasts until the next onset (legato), unless the singer is really silent before it:
    the gap from the note's raw end is at least rest_min quarters and the voice is not heard there
    (voiced(t0, t1) → True when it still sounds; optional). A note before a real rest ends on a beat
    when it lasted about a beat or more, else on a beat division; a silence before the bar line shorter than
    rest_min is held to the bar line. qpb: quarters per beat (1.5 compound); bar: (phase, beats per bar)."""
    subs = ([3, 6] if grid >= 4 else [3]) if qpb == 1.5 else ([grid, 3] if triplets else [grid])
    cands = sorted({k / n for n in subs for k in range(n + 1)})

    def snap(x):
        b = math.floor(x)
        return b + min(cands, key=lambda c: abs(c - (x - b)))
    q = sorted([snap(to_beats(g, a)), to_beats(g, b), int(round(m)), b - a, a, b] for a, b, m in notes)
    out = []
    for x in q:
        if out and abs(out[-1][0] - x[0]) < 1e-6:   # same onset: keep the longer
            if x[3] > out[-1][3]: out[-1] = x
            continue
        out.append(x)
    div = 1 / subs[0]                                # one regular division of the beat
    res = []
    for i, (a, e, m, _, ta, te) in enumerate(out):
        nxt = out[i + 1][0] if i + 1 < len(out) else None
        if nxt is not None:
            silent = (nxt - max(e, a)) * qpb         # in quarters
            if silent < rest_min - 1e-6 or (voiced is not None and voiced(te, out[i + 1][4])):
                res.append((a, nxt - a, m)); continue
        if bar is not None:                          # held to the bar line when the silence before it is short
            bl = bar[0] + bar[1] * (math.floor((a - bar[0]) / bar[1] + 1e-9) + 1)
            if (nxt is None or bl < nxt - 1e-9) and (bl - max(e, a)) * qpb < rest_min - 1e-6:
                res.append((a, bl - a, m)); continue
        u = 1.0 if e - a >= 0.75 else div            # a held note ends on a beat, a short one on a division
        end = round(e / u) * u
        if end <= a + 1e-9: end = a + div
        if nxt is not None: end = min(end, nxt)
        res.append((a, end - a, m))
    return [(a, d, m) for a, d, m in res if d > 1e-6]


def place_lyrics(qn, g, al, syl, skip):
    """-> {note index: (text, syllabic, extend)}, placed count, unplaced count."""
    W = al['words']; subs = al['subs']; lyr = {}; placed = unplaced = 0; perline = place_lyrics.perline = {}; where = place_lyrics.where = {}
    onsets = [x[0] for x in qn]
    used = set()
    for k, line in syl.items():
        li = int(k); L = subs[li]
        if any(a <= L['start'] < b for a, b in skip): continue
        items = []
        for wi, w in enumerate(line.split()):
            parts = w.split('-')
            ww = [x for x in W if x['line'] == li]
            ts = ww[wi]['s'] if wi < len(ww) else None
            for i, p in enumerate(parts):
                s = 'single' if len(parts) == 1 else 'begin' if i == 0 else 'end' if i == len(parts) - 1 else 'middle'
                items.append((p, s, ts if i == 0 else None))
        b0, b1 = to_beats(g, L['start'] - 0.8), to_beats(g, L['end'] + 0.6)
        cand = [i for i, x in enumerate(qn) if b0 <= x[0] < b1 and i not in used]
        perline[k] = (len(items), len(cand))
        if not cand: unplaced += len(items); continue
        pos = 0; last = None
        for si_, (n_left, (txt, s, ts)) in enumerate(zip(range(len(items), 0, -1), items)):
            free = cand[pos:]
            if len(free) < n_left:  # not enough notes left: each syllable takes the next note
                if not free: unplaced += 1; continue
                j = 0
            elif ts is not None:
                tb = to_beats(g, ts)
                # nearest onset, but leave room for the syllables still to come
                lim = len(free) - n_left + 1
                j = min(range(lim), key=lambda jj: abs(onsets[free[jj]] - tb))
            else: j = 0
            ni = free[j]; pos = cand.index(ni) + 1
            if last is not None and ni != last: pass
            lyr[ni] = [txt, s, False]; used.add(ni); placed += 1; where[ni] = [li, si_]
            last = ni
        # melisma marks: a syllable followed by unworded notes in the line gets an extend line
        worded = sorted(i for i in cand if i in lyr)
        for a, b in zip(worded, worded[1:] + [None]):
            nxt = b if b is not None else (cand[-1] + 1)
            if nxt - a > 1 and any(qn[i][2] != qn[a][2] for i in range(a + 1, min(nxt, a + 4))): lyr[a][2] = True
    return lyr, placed, unplaced


def build_xml(qn, lyr, title, key_sharps, bpm, phase, first_beat, meter='4/4'):
    import music21 as m21
    from fractions import Fraction as Fr
    per, qpb = METERS[meter]
    bar_q = Fr(per) * Fr(qpb).limit_denominator(2)
    s = m21.stream.Part()
    s.append(m21.clef.TrebleClef()); s.append(m21.key.KeySignature(key_sharps)); s.append(m21.meter.TimeSignature(meter))
    s.append(m21.tempo.MetronomeMark(number=round(bpm), referent=m21.duration.Duration(qpb)))
    # beat index -> offset: bar 1 starts on the first downbeat-phase beat at/before the first note
    start = first_beat - ((first_beat - phase) % per)
    q = lambda beats: Fr(beats).limit_denominator(12) * Fr(qpb).limit_denominator(2)   # noqa: E731  beats -> quarters
    cur = Fr(0)
    for i, (a, d, m) in enumerate(qn):
        off = q(a - start)
        if off > cur:
            s.append(m21.note.Rest(quarterLength=off - cur)); cur = off
        n = m21.note.Note(m, quarterLength=q(a - start + d) - off)
        if i in lyr:
            t, sy, ext = lyr[i]
            n.lyrics.append(m21.note.Lyric(text=t, syllabic=sy))
        s.append(n); cur = off + n.quarterLength
    tail = (bar_q - cur % bar_q) % bar_q
    if tail: s.append(m21.note.Rest(quarterLength=tail))
    # spell in the key (D major: sharps)
    ks = m21.key.Key('D') if key_sharps == 2 else None
    for n in s.recurse().notes:
        if ks and n.pitch.accidental and n.pitch.accidental.name == 'flat': n.pitch = n.pitch.getEnharmonic()
    sc = m21.stream.Score(); sc.insert(0, m21.metadata.Metadata(title=title)); sc.insert(0, s)
    s.partName = 'Voice'
    sc = sc.makeNotation()
    return sc


def voiced_probe(path, vthr=0.25, share=0.5):
    """pyin voiced probability → voiced(t0, t1): the voice still sounds in more than `share` of the gap."""
    z = np.load(path); t, vp = z['t'], z['vp']

    def voiced(a, b):
        w = vp[(t >= a) & (t < b)]
        return bool(len(w) and np.mean(w > vthr) > share)
    return voiced


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pyin'); ap.add_argument('--bp'); ap.add_argument('--beats', required=True)
    ap.add_argument('--words', required=True); ap.add_argument('--syl', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--grid', type=int, default=2); ap.add_argument('--triplets', action='store_true')
    ap.add_argument('--word-splits', action='store_true'); ap.add_argument('--onsets'); ap.add_argument('--skip', action='append', default=[])
    ap.add_argument('--title', default='Sung melody'); ap.add_argument('--key', type=int, default=2)
    ap.add_argument('--report')
    ap.add_argument('--meter', default='auto', choices=['auto'] + list(METERS),
                    help='time signature; auto = beats per bar from the downbeats, compound when the beat splits in 3')
    ap.add_argument('--rest-min', type=float, default=REST_MIN,
                    help='shortest silence (in quarters) written as a rest; shorter gaps are legato (default 1)')
    ap.add_argument('--selftest', action='store_true', help='run the built-in rhythm fixtures and exit')
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    a = ap.parse_args()
    bt = json.load(open(a.beats)); al = json.load(open(a.words)); syl = json.load(open(a.syl))
    skip = [tuple(map(float, x.split(':'))) for x in a.skip]
    splits = [w['s'] for w in al['words'] if w['s'] is not None] if a.word_splits else []
    if a.onsets: splits += json.load(open(a.onsets))
    notes = pyin_notes(a.pyin, splits) if a.pyin else bp_notes(a.bp)
    notes = [n for n in notes if not any(x <= n[0] < y for x, y in skip)]
    lines = [al['subs'][int(k)] for k in syl]
    notes = [n for n in notes if any(L['start'] - 1.0 <= n[0] < L['end'] + 0.8 for L in lines)]  # sung lines only
    notes = fold_octaves(notes, lines)
    g, _ = beat_grid(bt, max(n[1] for n in notes))
    meter = pick_meter(a.meter, bt, g, notes)
    g, phase = beat_grid(bt, max(n[1] for n in notes), per_bar=METERS[meter][0])
    qn = quantize(notes, g, a.grid, a.triplets, METERS[meter][1], a.rest_min, voiced_probe(a.pyin) if a.pyin else None,
                  bar=(phase, METERS[meter][0]))
    lyr, placed, unplaced = place_lyrics(qn, g, al, syl, skip)
    bpm = 60 / float(np.median(np.diff(bt['beats'])))
    sc = build_xml(qn, lyr, a.title, a.key, bpm, phase, int(qn[0][0]), meter)
    sc.write('musicxml', fp=a.out)
    bars = len(sc.parts[0].getElementsByClass('Measure'))
    rep = {'notes': len(qn), 'syllables': placed, 'unplaced': unplaced, 'bars': bars, 'bpm': round(bpm, 1), 'meter': meter,
           'perline': place_lyrics.perline, 'where': place_lyrics.where, 'qnotes': [[float(x), float(d), int(m)] for x, d, m in qn], 'grid': [float(x) for x in g], 'phase': phase}
    if a.report: json.dump(rep, open(a.report, 'w'))
    print(json.dumps({k: v for k, v in rep.items() if k not in ('qnotes', 'grid')}))


def selftest():
    """Rhythm fixtures (beats every 0.5 s): exact MusicXML durations, no note + rest where a note is held."""
    import tempfile, xml.etree.ElementTree as ET
    from fractions import Fraction as Fr

    def run(notes, meter, per, qpb=1.0, grid=2, triplets=False, rest_min=REST_MIN):
        B = 0.5
        bt = {'beats': [i * B for i in range(41)], 'downbeats': [i * B for i in range(0, 41, per)]}
        g, phase = beat_grid(bt, 20, per_bar=per)
        sec = [[s_ * B, e_ * B, m] for s_, e_, m in notes]
        qn = quantize(sec, g, grid, triplets, qpb, rest_min, bar=(phase, per))
        sc = build_xml(qn, {}, 'test', 0, 120, phase, int(qn[0][0]), meter)
        with tempfile.TemporaryDirectory() as td:
            sc.write('musicxml', fp=td + '/t.musicxml')
            root = ET.parse(td + '/t.musicxml').getroot()
        div, bars = 1, []
        for m in root.iter('measure'):
            if m.find('attributes/divisions') is not None: div = int(m.find('attributes/divisions').text)
            bars.append([('r' if n.find('rest') is not None else n.find('pitch/step').text,
                          Fr(int(n.find('duration').text), div)) for n in m.findall('note')])
        return bars
    Q, H, E = Fr(1), Fr(2), Fr(1, 2)
    checks = []
    # 4 quarters with early releases (60 %), then nothing: 4 quarters, not 3 quarters + 8th + 8th rest
    b = run([(i, i + 0.6, 60 + 2 * i) for i in range(4)], '4/4', 4)
    checks.append(('4 quarters', [d for _, d in b[0]] == [Q] * 4, b[0]))
    # a held half note with a breath gap (released at 1.6 of 2 beats), then a half
    b = run([(0, 1.6, 60), (2, 3.7, 64)], '4/4', 4)
    checks.append(('breath gap', [d for _, d in b[0]] == [H, H] and all(p != 'r' for p, _ in b[0]), b[0]))
    # a real silence of 2 beats stays a rest
    b = run([(0, 0.9, 60), (3, 3.9, 62)], '4/4', 4)
    checks.append(('real rest', [p for p, _ in b[0]].count('r') >= 1 and sum(d for _, d in b[0]) == 4, b[0]))
    # 3/4: half + quarter released early
    b = run([(3 * k + x, 3 * k + x + 0.6 * ln, 60) for k in range(2) for x, ln in ((0, 2), (2, 1))], '3/4', 3)
    checks.append(('3/4', [d for _, d in b[0]] == [H, Q] and [d for _, d in b[1]] == [H, Q], b[:2]))
    # 6/8 (beat = dotted quarter): quarter + 8th | 8th 8th 8th, keys lifted at 60 %
    pat = ((0, 2 / 3), (2 / 3, 1 / 3), (1, 1 / 3), (4 / 3, 1 / 3), (5 / 3, 1 / 3))
    b = run([(2 * k + x, 2 * k + x + 0.6 * ln, 60 + i) for k in range(2) for i, (x, ln) in enumerate(pat)], '6/8', 2, 1.5)
    checks.append(('6/8', [d for _, d in b[0]] == [Q, E, E, E, E], b[0]))
    # anticipation: struck an 8th before the bar line (a bit early), held to beat 2 of the next bar
    b = run([(0, 0.9, 60), (1, 1.9, 62), (2, 2.9, 64), (3.45, 5.6, 65), (6, 7.8, 67)], '4/4', 4)
    checks.append(('anticipation', b[0][-1] == ('F', E) and b[1][0] == ('F', H) and all(p != 'r' for p, _ in b[0] + b[1]), b[:2]))
    bad = [c for c in checks if not c[1]]
    for name, ok, got in checks: print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got}'))
    return 1 if bad else 0


if __name__ == '__main__':
    main()
