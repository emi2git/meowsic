"""Cheap stages (always re-run): note clean-up, quantize, hand split, lyrics attach, MusicXML/MIDI/PDF."""
import re, shutil, subprocess
from pathlib import Path

import numpy as np
import pretty_midi

from . import lyricfit, rhythm
from .util import clean_title, pretty_key, read_json, write_json

MSCORE = "/Applications/MuseScore 4.app/Contents/MacOS/mscore"

# ---------- note lengths (all in quarter notes; options of the same name override them) ----------
REST_MIN = 1.0      # a silence inside one hand shorter than this is no rest: the note before is held (legato)
RING_MAX = 4.0      # up to this long, a silence where the audio still rings (pedal, decay) is held too
SHORT_VEL = 35      # a note shorter than min_dur is kept when struck at least this loud (a clear onset)
RING_DROP_DB = 12.0  # "still rings": its level falls less than this (dB) in the 0.25 s after the key release


# ---------- note clean-up ----------
def _pedal_ends(notes, ccs):
    """Sustain pedal (CC64): a note released while the pedal is down sounds until the pedal comes up
    (or the same key is struck again)."""
    ups, down = [], None
    for c in sorted(ccs, key=lambda c: c.time):
        if c.value >= 64 and down is None:
            down = c.time
        elif c.value < 64 and down is not None:
            ups.append((down, c.time))
            down = None
    if down is not None:
        ups.append((down, float("inf")))
    if not ups:
        return notes
    nxt = {}
    out = []
    for n in sorted(notes, key=lambda n: -n[0]):          # latest first: next strike of the same key
        e = n[1]
        for a, b in ups:
            if a <= e < b:
                e = max(e, min(b, nxt.get(n[2], b)))
                break
        nxt[n[2]] = n[0]
        out.append([n[0], e if e != float("inf") else n[1], n[2], n[3]])
    return out


def load_notes(mid: Path, pedal=True):
    """[start, end, pitch, velocity] in seconds; with pedal, ends held by the sustain pedal are extended."""
    pm = pretty_midi.PrettyMIDI(str(mid))
    out = []
    for i in pm.instruments:
        ns = [[n.start, n.end, n.pitch, n.velocity] for n in i.notes]
        ccs = [c for c in i.control_changes if c.number == 64]
        out += _pedal_ends(ns, ccs) if pedal and ccs else ns
    return sorted(out, key=lambda n: (n[0], n[2]))


def vocal_melody(notes, min_dur):
    """Monophonic melody. Each note: [start, end, pitch (octave-corrected), velocity, raw_pitch]."""
    ns = [n for n in notes if 40 <= n[2] <= 84 and n[1] - n[0] >= min_dur]
    mono = []
    for n in ns:  # keep strongest at overlaps
        if mono and n[0] < mono[-1][1] - 0.03:
            p = mono[-1]
            if (n[1] - n[0]) * n[3] > (p[1] - p[0]) * p[3]:
                mono[-1] = list(n) + [n[2]]
            continue
        mono.append(list(n) + [n[2]])
    if not mono:
        return []
    p = np.array([m[2] for m in mono], float)
    for _ in range(3):  # octave-jump correction against local median
        med = np.array([np.median(p[max(0, i - 8):i + 9]) for i in range(len(p))])
        p = np.where(p - med > 7, p - 12, np.where(p - med < -7, p + 12, p))
    for m, v in zip(mono, p):
        m[2] = int(v)
    return mono


def _double_hit(n, same, gap=0.12):
    """n is a second detection of a key already sounding (or struck just before / after)."""
    return any(m is not n and (abs(m[0] - n[0]) < gap and m[1] - m[0] > n[1] - n[0] or m[0] < n[0] < m[1])
               for m in same)


def clean_piano(notes, melody, min_dur, min_vel, bleed_tol, short_vel=SHORT_VEL):
    """Drop quiet notes, short ghost notes, and notes doubling the sung melody at its *detected* pitch
    (|Δ| <= bleed_tol semitones, >50% overlap). bleed_tol < 0 disables the vocal-bleed filter.
    A note shorter than min_dur seconds is kept when its onset is clear: struck at least short_vel
    loud and not a second detection of the same key (a staccato bass, a short grace note)."""
    starts = np.array([m[0] for m in melody]) if melody else np.array([])
    by_pitch = {}
    for n in notes:
        by_pitch.setdefault(n[2], []).append(n)
    out = []
    for n in notes:
        dur = n[1] - n[0]
        if n[3] < min_vel:
            continue
        if dur < min_dur and (n[3] < short_vel or _double_hit(n, by_pitch[n[2]])):
            continue
        bleed = False
        if bleed_tol >= 0 and len(starts):
            lo = np.searchsorted(starts, n[0] - 8)
            for m in melody[lo:]:
                if m[0] > n[1]:
                    break
                raw = m[4] if len(m) > 4 else m[2]
                if abs(raw - n[2]) <= bleed_tol and min(m[1], n[1]) - max(m[0], n[0]) > 0.5 * dur:
                    bleed = True
                    break
        if not bleed:
            out.append(n)
    return out


# ---------- time grid ----------
def make_grid(an, tempo_override=None, onsets=(), meter=None):
    """rhythm.Grid from tracked beats/downbeats; a fixed-tempo grid when the tempo is given by hand
    or nothing was tracked. meter: beats per bar (else found from the downbeats: 3 or 4)."""
    bt, db = an.get("beats") or [], an.get("downbeats") or []
    if tempo_override or len(bt) < 4:
        tempo = float(tempo_override or an.get("tempo") or 0)
        if tempo <= 0:  # no beats detected (steady tones, silence): assume 120
            tempo = 120.0
        t0 = db[0] if db else (bt[0] if bt else 0.0)
        return rhythm.constant_grid(min(300.0, max(20.0, tempo)), float(t0), meter or 4)
    pulse = rhythm.steady(rhythm.tactus(bt, db, onsets), onsets)
    bl, meter = rhythm.bars(pulse, db, meter)
    pulse, bl = rhythm.repair(pulse, bl, meter, onsets)
    return rhythm.Grid(pulse, bl, meter)


def best_phase(beats_pos, weights=None):
    """Sub-beat shift (0, .25, .5, .75) that puts the most onsets on beats / 8ths (fixes grids
    that lock onto the off-beat)."""
    b = np.asarray(beats_pos, float)
    w = np.ones_like(b) if weights is None else np.asarray(weights, float)
    best, score = 0.0, -1.0
    for s in (0.0, 0.25, 0.5, 0.75):
        fr = np.round(((b - s) % 1) * 4) % 4  # 0=beat, 2=8th, 1/3=16ths
        sc = float(np.sum(w * np.select([fr == 0, fr == 2], [1.0, 0.5], 0.0)))
        if sc > score + 1e-9:
            best, score = s, sc
    return best


def quantize(notes, qpos, short=0.25, rawpos=None):
    """[start_q, dur_q, pitch, vel(, raw_end_q)] using qpos(seconds) → quantised quarter position.
    rawpos(seconds) → unquantised quarter position: kept as the 5th item, where the key was really
    released, so _events can tell a held note from a real rest."""
    out = []
    for n in notes:
        s, e = qpos(n[0]), qpos(n[1])
        if e - s < short - 1e-6:
            third = abs(s * 3 - round(s * 3)) < 1e-6 and abs(s * 4 - round(s * 4)) > 1e-6
            e = s + (1 / 3 if third else short)
        out.append([s, e - s, n[2], n[3]] + ([float(rawpos(n[1]))] if rawpos else []))
    return out


def ring_probe(d: Path, to_sec, drop_db=RING_DROP_DB, floor_db=-50.0):
    """→ ringing(pitches, from_q, to_q): True when one of these pitches still sounds in the recording
    after its key was released (sustain pedal, a slowly decaying low note). A damped key loses
    drop_db or more within 0.25 s of its release (its peak in the 0.15 s before vs the median level
    0.05-0.25 s after); a ringing one loses less and stays above floor_db (from the song's loudest).
    to_sec(q) → seconds in the recording. None when there is no audio or librosa."""
    wav = next(iter(sorted(d.glob("stems/htdemucs/*/no_vocals.wav"))), None) or d / "source.wav"
    if not wav.exists():
        return None
    try:
        import librosa
    except ImportError:
        return None
    cache = {}

    def row(p):
        if "C" not in cache:
            y, sr = librosa.load(str(wav), sr=22050, mono=True)
            c = np.abs(librosa.cqt(y, sr=sr, hop_length=256, fmin=librosa.midi_to_hz(21), n_bins=88))
            cache["C"] = librosa.amplitude_to_db(c, ref=float(np.max(c)) or 1.0)
            cache["fps"] = sr / 256
        return cache["C"][int(np.clip(p - 21, 0, 87))], cache["fps"]

    def seg(r, fps, a, b):
        return r[max(0, int(a * fps)):max(0, int(a * fps) + 1, int(b * fps))]

    def ringing(pitches, a_q, b_q):
        ta, tb = float(to_sec(a_q)), float(to_sec(b_q))
        if tb - ta < 0.15:
            return True
        for p in pitches:
            r, fps = row(p)
            at, after = seg(r, fps, ta - 0.15, ta + 0.01), seg(r, fps, ta + 0.05, min(ta + 0.25, tb - 0.02))
            if not len(at) or not len(after):
                continue
            lv = float(np.median(after))
            if lv > floor_db and float(np.max(at)) - lv < drop_db:
                return True
        return False
    return ringing


# ---------- key + spelling ----------
def parse_key(k):
    m = re.match(r"\s*([A-Ga-g])([#b-]?)\s*((?i:major|maj|minor|min)|m)?(?![A-Za-z])", k or "")
    if not m:
        return None
    tonic = m.group(1).upper() + {"#": "#", "b": "-", "-": "-"}.get(m.group(2), "")
    q = (m.group(3) or "").lower()
    return tonic, "minor" if q and not q.startswith("maj") else "major"


def _scale(sharps):
    tonic = (7 * sharps) % 12
    return {(tonic + i) % 12 for i in (0, 2, 4, 5, 7, 9, 11)}


def key_plan(notes, bar_start, switch=0.8):
    """Key signature per stretch of bars → [(first_bar, sharps, minor)].
    Picks the signatures that leave the fewest accidentals on the page; a change must pay for itself
    over several bars (Viterbi over bars, 13 signatures)."""
    nb = len(bar_start) - 1
    W = np.zeros((nb, 12))
    for s_, d_, p_, *_ in notes:
        i = int(np.clip(np.searchsorted(bar_start, s_ + 1e-9, "right") - 1, 0, nb - 1))
        W[i, p_ % 12] += min(d_, 2.0)
    sigs = list(range(-6, 7))
    out_mask = np.array([[pc not in _scale(sh) for pc in range(12)] for sh in sigs], float)
    emit = W @ out_mask.T + 0.004 * np.abs(sigs) * W.sum(1, keepdims=True)
    busy = W.sum(1)
    switch = switch * float(np.mean(busy[busy > 0])) if busy.any() else 1.0   # ≈ one bar of wrong notes
    best = emit[0].copy()
    back = np.zeros((nb, len(sigs)), int)
    for i in range(1, nb):
        stay = best
        jump = best.min() + switch
        back[i] = np.where(stay <= jump, np.arange(len(sigs)), int(best.argmin()))
        best = np.minimum(stay, jump) + emit[i]
    k = int(best.argmin())
    path = [k]
    for i in range(nb - 1, 0, -1):
        k = int(back[i, k])
        path.append(k)
    path = path[::-1]
    plan = []
    for i, k in enumerate(path):
        if not plan or plan[-1][1] != sigs[k]:
            plan.append([i, sigs[k]])
    res = []
    for j, (i0, sh) in enumerate(plan):
        i1 = plan[j + 1][0] if j + 1 < len(plan) else nb
        pc = W[i0:i1].sum(0)
        maj, rel = (7 * sh) % 12, (7 * sh + 9) % 12
        km = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        kn = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        cm = np.nan_to_num(np.corrcoef(pc, np.roll(km, maj))[0, 1]) if pc.sum() else 1
        cn = np.nan_to_num(np.corrcoef(pc, np.roll(kn, rel))[0, 1]) if pc.sum() else 0
        res.append((i0, sh, bool(cn > cm + 0.02)))
    return res


_STEP_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_STEP_FIFTH = {"F": -1, "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5}


def spell(midi: int, sharps: int, minor: bool):
    """(step, alter, octave) closest to the key on the line of fifths."""
    pc = midi % 12
    centre = sharps + (2.5 if minor else 2.0)
    best = None
    for step, spc in _STEP_PC.items():
        for alter in (0, 1, -1):
            if (spc + alter) % 12 != pc:
                continue
            dist = abs(_STEP_FIFTH[step] + 7 * alter - centre)
            tie = -4.5 if alter == 0 else (0.1 if (alter < 0) == (sharps <= 0) else 0.2)
            cand = (dist + tie, step, alter)
            if best is None or cand < best:
                best = cand
    _, step, alter = best
    octave = (midi - (_STEP_PC[step] + alter)) // 12 - 1
    return step, alter, octave


# ---------- rhythm ----------
def _whole(p, L):
    """Whole-beat lengths allowed from integer beat p in a bar of L quarters."""
    if L == 4:
        return ([4] if p == 0 else []) + ([3] if p in (0, 1) else []) + ([2] if p in (0, 2) else [])
    if L == 3:
        return ([3] if p == 0 else []) + ([2] if p in (0, 1) else [])
    if L == 6:
        return ([6] if p == 0 else []) + ([4] if p in (0, 2) else []) + ([2] if p % 2 == 0 else [])
    return ([4] if p == 0 and L >= 4 else []) + ([2] if p % 2 == 0 and p + 2 <= L else [])


def _is16(x):
    return abs(x * 4 - round(x * 4)) < 1e-6


def _compound_piece(pos, rem, L, rest):
    """Next piece length in a compound bar (beat = dotted quarter = 1.5)."""
    b = int(np.floor(pos / 1.5 + 1e-9))
    r = pos - 1.5 * b
    if r < 1e-6:
        if b == 0 and rem >= L - 1e-6 and abs(L - 3) < 1e-6 or (b == 0 and rem >= L - 1e-6 and abs(L - 6) < 1e-6):
            return L
        if b % 2 == 0 and rem >= 3 - 1e-6 and pos + 3 <= L + 1e-6:
            return 3.0
        for x in (1.5, 1.0):
            if rem >= x - 1e-6:
                return x
        if not rest and abs(rem - 0.75) < 1e-6:
            return 0.75
        return 0.5 if rem >= 0.5 - 1e-6 else rem
    if abs(r - 0.5) < 1e-6:
        return 1.0 if rem >= 1.0 - 1e-6 else (0.5 if rem >= 0.5 - 1e-6 else rem)
    if abs(r - 1.0) < 1e-6:
        return 0.5 if rem >= 0.5 - 1e-6 else rem
    return min(rem, (np.floor(r / 0.5 + 1e-9) + 1) * 0.5 - r)      # 16th offsets: up to the next 8th


def chunks(off, dur, rest=False, bar_start=None, compound=False):
    """Split a span into engraver-friendly pieces that never cross a barline.
    Whole beats only from aligned positions (4@0, 3@0/1, 2@0/2); notes may also use a dotted quarter
    from a beat or 8th and a syncopated quarter from an 8th; off-beat rests split as 16th + 8th.
    Positions on thirds of a beat give triplet pieces. compound: bars of dotted-quarter beats.
    bar_start: sorted bar start positions (default: 4/4 bars from 0)."""
    out, t, e = [], off, off + dur
    while t < e - 1e-6:
        if bar_start is None:
            ms, L = np.floor(t / 4 + 1e-9) * 4, 4.0
        else:
            i = int(np.clip(np.searchsorted(bar_start, t + 1e-9, "right") - 1, 0, len(bar_start) - 2))
            ms, L = float(bar_start[i]), float(bar_start[i + 1] - bar_start[i])
        pos, rem = t - ms, min(e, ms + L) - t
        if compound:
            ln = _compound_piece(pos, rem, L, rest)
            out.append((float(t), float(ln)))
            t += ln
            continue
        frac = pos - np.floor(pos + 1e-9)
        if frac > 1 - 1e-6:
            frac = 0.0
        to_beat = 1 - frac
        if not _is16(frac):                                   # on a third: triplet 8th / quarter
            ln = min(rem, to_beat)
        elif not _is16(rem) and rem < to_beat - 1e-6:         # ends on a third inside this beat
            ln = rem
        elif not _is16(rem) and frac > 1e-6:                  # binary start, triplet end later: go to the beat
            ln = min(rem, to_beat)
        elif frac < 1e-6 and rem >= 1 - 1e-6:
            p, whole = int(round(pos)), int(rem + 1e-6)
            allowed = _whole(p, int(round(L)))
            if not rest and _is16(rem) and 1.5 <= rem < 2 - 1e-6 and p <= L - 2:
                allowed.append(1.5)
            ln = next((x for x in allowed if x <= rem + 1e-6 and (x == 1.5 or x <= whole)), 1)
        elif not rest and abs(frac - 0.5) < 1e-6 and rem >= 1 - 1e-6:
            ln = 1.5 if (rem >= 1.5 - 1e-6 and pos + 1.5 <= L + 1e-6 and int(pos) % 2 == 0) else 1.0
        else:
            ln = min(rem, to_beat)
            if rest and abs(frac - 0.25) < 1e-6 and ln > 0.25 + 1e-6:
                ln = 0.25
        out.append((float(t), float(ln)))
        t += ln
    return out


def _simple_end(s, e, beat):
    """Where to end a note that a real rest follows: on a beat when it sounded about a beat or more
    (a quarter or half, not an 8th + 16th rest), else on an 8th. Positions in quarters."""
    step = beat if e - s >= 0.75 * beat else 0.5
    x = round(e / step) * step
    if x <= s + 1e-6:
        x = (np.floor(s / step + 1e-9) + 1) * step
    return float(x)


def _events(notes, max_chord=4, beat=1.0, bar_start=None, rest_min=REST_MIN, ringing=None, ring_max=RING_MAX):
    """Group one hand's quantised notes into chords → [(onset, dur, [pitches], staccato)].
    Each chord lasts until the hand's next onset (legato) unless the hand is really silent before it:
    a rest is written only when the silence, measured from where the hand's LAST sounding note was
    released (an arpeggio's held bass counts), is at least rest_min quarters and the recording does not
    still ring there (ringing(pitches, from_q, to_q), up to ring_max). A note before a bar line whose
    silence to the bar line is shorter than rest_min is held to the bar line. A held note is never
    written as note + rest; a note before a real rest ends on a beat (or an 8th) and short isolated
    notes become a staccato 8th/quarter, so the page is not littered with 16th rests.
    notes: [start, dur, pitch, vel(, raw_end)] in quarters; bar_start: bar line positions."""
    ev = {}
    for n in notes:
        s, d, p, v = n[:4]
        e_raw = float(n[4]) if len(n) > 4 else s + d
        ev.setdefault(s, {})
        if p not in ev[s] or ev[s][p][0] < d:
            ev[s][p] = (d, v, max(e_raw, ev[s].get(p, (0, 0, -1e9))[2]))
    keys = sorted(ev)
    bars = np.asarray(bar_start, float) if bar_start is not None else None

    def barline_after(s):
        if bars is None or not len(bars) or s >= bars[-1] - 1e-6:
            return float(np.floor(s / 4 + 1e-9) * 4 + 4)
        return float(bars[int(np.searchsorted(bars, s + 1e-6, "right"))])

    def held(pitches, a, b):
        return b - a < rest_min - 1e-6 or (ringing is not None and b - a <= ring_max + 1e-6 and ringing(pitches, a, b))
    res = []
    heard, ring_p = -1e9, []          # where the hand's sound stops (raw quarters), and the notes ringing last
    for i, s in enumerate(keys):
        items = sorted(ev[s].items(), key=lambda x: -x[1][1])[:max_chord]
        d = max(x[1][0] for x in items)
        e_now = max(x[2] for x in ev[s].values())
        if e_now >= heard - 1e-6:
            heard, ring_p = e_now, [p for p, x in ev[s].items() if x[2] >= e_now - 0.25]
        sound = max(heard, s + 0.25)
        nxt = keys[i + 1] if i + 1 < len(keys) else None
        bl = barline_after(s)
        stacc = False
        if nxt is not None and held(ring_p, sound, nxt):
            d = nxt - s                                           # legato: no rest before the next onset
        elif (nxt is None or bl < nxt - 1e-6) and sound <= bl + 1e-6 and held(ring_p, sound, bl):
            d = bl - s                                            # held to the bar line, the rest is after it
        else:                                                     # a real rest follows
            room = (nxt if nxt is not None else s + 64) - s
            if sound - s < 0.5 - 1e-6:
                on_beat = abs(s / beat - round(s / beat)) < 1e-6
                if on_beat and room >= beat:
                    d, stacc = beat, True
                elif abs(s * 2 - round(s * 2)) < 1e-6 and room >= 0.5:
                    d, stacc = 0.5, True
                else:
                    d = min(max(d, 0.25), room)
            else:
                d = _simple_end(s, sound, beat) - s
            d = min(d, room)
        res.append((s, max(d, 0.25), sorted(p for p, _ in items), stacc))
    return res


def split_hands(notes, lh0=48.0, rh0=67.0, steal_cost=2.0, figure_reach=12, figure_gap=2.0):
    """Assign every note to a hand so both parts stay playable.
    Each chord is cut at some point (lower notes left, upper notes right); a search over all cuts
    (Viterbi) minimises stretches over an octave, jumps of a hand between consecutive notes,
    hands crossing and notes in the wrong register. A note under a chord the right hand still holds
    that carries on the left hand's running figure (an arpeggio, a bass pattern: the left hand's last
    attack was a single note or a dyad, no new bass note under it, within figure_reach semitones of
    the left hand's last notes and figure_gap quarters after them)
    costs steal_cost in the right hand: taken there it would cut the held chord short. The left hand
    may jump back to its bass line after a figure at no extra cost (voice leading from the bass).
    notes: [start, dur, pitch, vel(, raw_end)] in quarters (raw_end: where the key really went up)."""
    groups = {}
    for n in notes:
        groups.setdefault(n[0], []).append(n)
    ons = sorted(groups)
    if not ons:
        return [], []
    ev = [sorted(groups[o], key=lambda n: n[2]) for o in ons]

    def emit(g, k):
        c = 0.0
        for hand, part in (("L", g[:k]), ("R", g[k:])):
            if not part:
                continue
            ps = [n[2] for n in part]
            span = ps[-1] - ps[0]
            if span > 12:
                c += 3.0 + (span - 12)
            elif span > 9:
                c += 0.1 * (span - 9)
            if len(ps) > 5:
                c += 4.0 * (len(ps) - 5)
            c += sum(0.08 * (p - 64) for p in ps if p > 64) if hand == "L" else sum(0.08 * (55 - p) for p in ps if p < 55)
        if 0 < k < len(g) and len(g) >= 3 and g[-1][2] - g[0][2] <= 12:
            c += 0.6                                     # keep a close chord in one hand
        return c

    def move(prev, now, gap, crossing):
        if now is None:
            return 0.0
        return 0.25 * max(0.0, abs(now - prev) - 4) / (0.5 + gap) + (2.0 if crossing else 0.0)

    def reach(recent, part, t):
        """Cost of what one hand must cover within a beat (notes just played + these)."""
        if not part:
            return 0.0, recent
        lo, hi = part[0][2], part[-1][2]
        if recent and (lo > recent[-1][2] + 12 or hi < recent[-1][1] - 12):
            recent = ()                      # a deliberate jump (already paid for as a move): new position
        keep = tuple(r for r in recent if t - r[0] <= 1.0) + ((t, lo, hi),)
        span = max(r[2] for r in keep) - min(r[1] for r in keep)
        return (0.4 * (span - 14) if span > 14 else 0.0), keep

    def end_of(n):
        return float(n[4]) if len(n) > 4 else n[0] + n[1]

    def steal(lpart, part, t, rsound, lt, lps, bass):
        """Cost of taking these notes into the right hand while it holds a chord above them and they
        carry on the left hand's figure (the left hand, if it plays now, does not strike its bass anew)."""
        held = [p for p, e in rsound if e > t + 0.5]
        if not part or not held or not lps or len(lps) > 2 or t - lt > figure_gap + 1e-6:
            return 0.0                                   # (a block chord in the left hand is no running figure)
        if lpart and bass and lpart[0][2] <= bass[0] + 2:
            return 0.0                                   # a new bass: the left hand starts afresh here
        low, near = min(held), lps + tuple(n[2] for n in lpart)
        return steal_cost * sum(1 for n in part if n[2] < low and min(abs(n[2] - q) for q in near) <= figure_reach)

    def bass_after(bass, part, t):
        """The left hand's bass line (pitch, time): its lowest note, renewed by a note near or under it."""
        if not part:
            return bass
        lo = part[0][2]
        return (lo, t) if bass is None or lo <= bass[0] + 5 or t - bass[1] > 4.0 else bass

    # per cut: (cost, lh_pos, rh_pos, lh_recent, rh_recent, lh_time, rh_time, rh_sounding, lh_last_pitches, lh_bass)
    t0 = ons[0] - 4.0
    prev_states = {None: (0.0, lh0, rh0, (), (), t0, t0, (), (), None)}
    back = []
    for i, g in enumerate(ev):
        t = ons[i]
        cur = {}
        for k in range(len(g) + 1):
            lc = float(np.mean([n[2] for n in g[:k]])) if k else None
            rc = float(np.mean([n[2] for n in g[k:]])) if k < len(g) else None
            e = emit(g, k)
            best = None
            for pk, (pc, pl, pr, lrec, rrec, lt, rt, rs, lps, lb) in prev_states.items():
                # hands cross: one is placed above where the other one is now (struck now, or last)
                lx = lc is not None and lc > (pr if rc is None else rc) + 2
                rx = rc is not None and rc < (pl if lc is None else lc) - 2
                ml = move(pl, lc, min(4.0, t - lt), lx)
                # back down to the bass after an arpeggio: voice leading from the bass note, the hand
                # starts from a new position there
                mb = move(lb[0], g[0][2], min(4.0, t - lb[1]), lx) if k and lb else 1e9
                cl, lrec2 = reach(() if mb < ml else lrec, g[:k], t)
                cr, rrec2 = reach(rrec, g[k:], t)
                c = pc + e + cl + cr + steal(g[:k], g[k:], t, rs, lt, lps, lb) + min(ml, mb) \
                    + move(pr, rc, min(4.0, t - rt), rx)
                if best is None or c < best[0]:
                    rs2 = rs if rc is None else tuple((p, e_) for p, e_ in rs if e_ > t) + tuple((n[2], end_of(n)) for n in g[k:])
                    best = (c, pl if lc is None else lc, pr if rc is None else rc, lrec2, rrec2,
                            lt if lc is None else t, rt if rc is None else t, rs2,
                            lps if lc is None else tuple(n[2] for n in g[:k]), bass_after(lb, g[:k], t), pk)
            cur[k] = best
        back.append({k: v[10] for k, v in cur.items()})
        prev_states = {k: v[:10] for k, v in cur.items()}
    k = min(prev_states, key=lambda x: prev_states[x][0])
    cuts = []
    for i in range(len(ev) - 1, -1, -1):
        cuts.append(k)
        k = back[i][k]
    cuts.reverse()
    rh, lh = [], []
    for g, k in zip(ev, cuts):
        lh += g[:k]
        rh += g[k:]
    return rh, lh


def attach_lyrics(mel_events, words, grid, off):
    """mel_events: list of [onset, dur, pitch, lyric]. Nearest-onset, never reusing a note."""
    j = 0
    for w in words:
        b = float(grid(w["t"])) - off
        while j < len(mel_events) and mel_events[j][0] < b - 0.75:
            j += 1
        if j >= len(mel_events):
            break
        if j + 1 < len(mel_events) and abs(mel_events[j + 1][0] - b) < abs(mel_events[j][0] - b):
            j += 1
        mel_events[j][3] = w["w"]
        j += 1


def melody_events(qm):
    """Monophonic events [onset, dur, pitch, lyric]: drop isolated 16th blips, legato-fill gaps <= 1 beat."""
    mel = []
    for s, du, p, v, *_ in qm:
        if mel and s <= mel[-1][0]:
            continue
        mel.append([s, min(du, 4.0), p, None])
    keep = []
    for i, m in enumerate(mel):
        gap_before = m[0] - (mel[i - 1][0] + mel[i - 1][1]) if i else 9
        gap_after = mel[i + 1][0] - (m[0] + m[1]) if i + 1 < len(mel) else 9
        if m[1] <= 0.25 and gap_before >= 0.5 and gap_after >= 0.5:
            continue
        keep.append(m)
    for a, b in zip(keep, keep[1:]):
        g = b[0] - a[0]
        a[1] = g if g - a[1] <= 1.0 else min(a[1], g)
    return keep


# ---------- chords ----------
CHORDS = {"": (0, 4, 7), "m": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10),
          "dim": (0, 3, 6), "m7b5": (0, 3, 6, 10), "sus4": (0, 5, 7), "sus2": (0, 2, 7)}
CHORD_KIND = {"": "major", "m": "minor", "7": "dominant-seventh", "maj7": "major-seventh", "m7": "minor-seventh",
              "dim": "diminished", "m7b5": "half-diminished-seventh", "sus4": "suspended-fourth",
              "sus2": "suspended-second"}


_PEN = {"": 0.0, "m": 0.0, "7": 0.05, "maj7": 0.07, "m7": 0.05, "dim": 0.12, "m7b5": 0.14, "sus4": 0.15, "sus2": 0.15}


def name_chord(notes, a, b, scale=()):
    """Best chord for the quantised notes sounding in [a, b) → (score, root_pc, quality, bass_pc) or None.
    scale: pitch classes of the key; chords inside the key win ties."""
    w = np.zeros(12)
    low = None
    for s, d, p, *_ in notes:
        ov = min(b, s + d) - max(a, s)
        if ov <= 0:
            continue
        w[p % 12] += ov * (1.5 if p < 60 else 1.0) * (1.3 if a - 1e-6 <= s < b else 1.0)
        if low is None or p < low:
            low = p
    tot = w.sum()
    if tot <= 0 or np.count_nonzero(w > 0.08 * tot) < 2:   # a single pitch does not make a chord
        return None
    w = w / tot
    bass = low % 12
    best = None
    for q, iv in CHORDS.items():
        for r in range(12):
            tones = [(r + i) % 12 for i in iv]
            inside = sum(w[t] for t in tones)
            missing = sum(1 for t in tones if w[t] < 0.04)
            sc = inside - (1 - inside) - 0.25 * missing - _PEN[q]
            sc += 0.12 if bass == r else (0.03 if bass in tones else 0.0)
            if w[r] < 0.04:
                sc -= 0.25
            if q.startswith("sus") and missing:
                continue                                  # a sus chord needs all three notes
            if scale and all(t in scale for t in tones):
                sc += 0.06
            if best is None or sc > best[0]:
                best = (sc, r, q, tones)
    sc, r, q, tones = best
    if sc < 0.35:
        return None
    return sc, r, q, (bass if bass in tones else r)


def find_chords(notes, bar_start, scales=None):
    """[(position_q, root_pc, quality, bass_pc)] — one per bar (two when the harmony clearly moves
    mid-bar), only where the chord changes."""
    out, last = [], None
    for i in range(len(bar_start) - 1):
        a, b = float(bar_start[i]), float(bar_start[i + 1])
        L = b - a
        scale = scales[i] if scales else ()
        picks = [(a, name_chord(notes, a, b, scale))]
        if L >= 4 and L % 2 == 0:
            h1, h2 = name_chord(notes, a, a + L / 2, scale), name_chord(notes, a + L / 2, b, scale)
            whole = picks[0][1]
            if h1 and h2 and h1[1:] != h2[1:] and min(h1[0], h2[0]) >= max(0.55, (whole[0] if whole else 0) - 0.05):
                picks = [(a, h1), (a + L / 2, h2)]
        for x, c in picks:
            if c and c[1:] != last:
                out.append((x, *c[1:]))
                last = c[1:]
    return out


# ---------- arrangement / lead sheet ----------
def lift_melody(mel, lo=62):
    """Octave-shift a sung melody so it sits in the right hand's range."""
    if not mel:
        return mel
    med = float(np.median([m[2] for m in mel]))
    up = 12 * int(np.ceil((lo - med) / 12)) if med < lo else 0
    return [[m[0], m[1], m[2] + up, *m[3:]] for m in mel]


def arrange(qp, mel, split=57):
    """Whole song as a piano piece: melody on top of the right hand, a little harmony under it,
    the low accompaniment in the left hand. mel: [[onset, dur, pitch, ...]] monophonic."""
    lh = [n for n in qp if n[2] < split]
    rh = [[m[0], m[1], m[2], 100] for m in mel]
    onsets = {m[0] for m in mel}
    ms = np.array([m[0] for m in mel]) if mel else np.array([])
    per_onset = {}
    for n in sorted((n for n in qp if n[2] >= split), key=lambda n: -n[3]):
        i = int(np.searchsorted(ms, n[0] + 1e-9, "right")) - 1
        sounding = mel[i] if i >= 0 and mel[i][0] <= n[0] < mel[i][0] + mel[i][1] else None
        if sounding is None:
            ok = True                                    # between phrases: the accompaniment fills in
        else:
            ok = n[0] in onsets and sounding[2] - 14 <= n[2] < sounding[2] - 2
        if ok and per_onset.get(n[0], 0) < 2:
            per_onset[n[0]] = per_onset.get(n[0], 0) + 1
            rh.append(list(n))
    return sorted(rh), lh


def skyline(qp, lo=55):
    """The tune inside a piano texture: the top note of each attack, unless a higher tune note is
    still sounding (then it is accompaniment under a held melody note)."""
    top = {}
    for n in qp:
        if n[2] >= lo and (n[0] not in top or n[2] > top[n[0]][2]):
            top[n[0]] = n
    out = []
    for k in sorted(top):
        n = top[k]
        if out and out[-1][2] - n[2] >= 6 and out[-1][0] + out[-1][1] > n[0] + 1e-6:
            continue                          # well below a held tune note: accompaniment
        out.append(list(n))
    return out


def top_line(notes, low=False):
    """Only the highest note of everything struck together (drops the filler notes under a tune).
    low=True keeps the lowest instead: the bass note of a left-hand chord."""
    top = {}
    for n in notes:
        if n[0] not in top or (n[2] < top[n[0]][2] if low else n[2] > top[n[0]][2]):
            top[n[0]] = n
    return [top[k] for k in sorted(top)]


def ottava_runs(pitch_sets, kind="8va", min_notes=4):
    """Stretches to write an octave away from where they sound, so they sit on the staff instead of
    on a ladder of ledger lines. pitch_sets: per note event, its pitches. → [(first, last)] indexes.
    8va: everything in the stretch is F5 or higher and it mostly lives from C6 up (reaching E6);
    8vb: everything is G2 or lower and it mostly lives from C2 down (reaching A1)."""
    hi = kind == "8va"
    inside = (lambda ps: min(ps) >= 77) if hi else (lambda ps: max(ps) <= 43)
    runs, i, n = [], 0, len(pitch_sets)
    while i < n:
        if not inside(pitch_sets[i]):
            i += 1
            continue
        j = i
        while j + 1 < n and inside(pitch_sets[j + 1]):
            j += 1
        tops = [max(ps) if hi else min(ps) for ps in pitch_sets[i:j + 1]]
        far = (max(tops) >= 88 and float(np.median(tops)) >= 84) if hi else (min(tops) <= 33 and float(np.median(tops)) <= 36)
        if j - i + 1 >= min_notes and far:
            runs.append((i, j))
        i = j + 1
    return runs


def treble_runs(pitch_sets, min_notes=4):
    """Left-hand stretches that sit above the bass staff (everything A3 or higher, mostly from E4 up):
    written in treble clef there, instead of on ledger lines. → [(first, last)] indexes."""
    runs, i, n = [], 0, len(pitch_sets)
    while i < n:
        if min(pitch_sets[i]) < 57:
            i += 1
            continue
        j = i
        while j + 1 < n and min(pitch_sets[j + 1]) >= 57:
            j += 1
        if j - i + 1 >= min_notes and float(np.median([max(ps) for ps in pitch_sets[i:j + 1]])) >= 64:
            runs.append((i, j))
        i = j + 1
    return runs


# ---------- build ----------
# The sheet comes in named versions; each one is a fixed choice of layout and detail.
VERSIONS = {
    "original": {"layout": "piano", "detail": "normal"},          # everything the pianist plays
    "lead": {"layout": "lead", "detail": "simple"},               # tune and chord symbols on one staff
    "vocal": {"layout": "piano-vocal", "detail": "normal"},       # voice line with words above the piano
}


def with_version(opts: dict) -> dict:
    """Options with the chosen version's layout and detail filled in (no version: unchanged)."""
    v = VERSIONS.get(opts.get("version") or "")
    return {**opts, **v} if v else dict(opts)


def transpose_notes(notes, semis, lo=21, hi=108):
    """Move every note by `semis` semitones; a note pushed off the keyboard comes back by an octave."""
    for n in notes:
        p = int(n[2]) + semis
        while p > hi:
            p -= 12
        while p < lo:
            p += 12
        n[2] = p
    return notes


_MAJ = {"C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7, "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6, "Cb": -7}
_MIN = {"A": 0, "E": 1, "B": 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7, "D": -1, "G": -2, "C": -3, "F": -4, "Bb": -5, "Eb": -6, "Ab": -7}


def key_sharps(name):
    """'A major' -> 3, 'F minor' -> -4 (sharps, flats negative); None if the name is not a key."""
    tonic, _, mode = (name or "").strip().partition(" ")
    return (_MIN if mode.strip().lower().startswith("min") else _MAJ).get(tonic.replace("-", "b"))


def easy_shift(plan, n_bars):
    """How many semitones to move a piece so that it has the fewest sharps and flats to read.
    plan: [(first bar index, sharps)] in the piece's own key; ties go to the smaller move."""
    if not plan:
        return 0
    ends = [b for b, _ in plan[1:]] + [max(n_bars, plan[-1][0] + 1)]
    cost = lambda s: sum(max(1, e - b) * abs(shift_key(sh, s)) for (b, sh), e in zip(plan, ends))   # noqa: E731
    return min(range(-6, 7), key=lambda s: (cost(s), abs(s), s))


def shift_key(sharps, semis):
    """Key signature (sharps, flats negative) after moving the music by `semis` semitones."""
    return (sharps + 7 * semis + 6) % 12 - 6


def build(d: Path, opts: dict):
    from music21 import (stream, note, chord, clef, meter, key, pitch, tie, tempo as m21tempo, instrument, layout,
                         metadata, harmony, articulations, duration, expressions, spanner)
    from music21.stream import makeNotation as mn
    from .stages import key_from_profile

    opts = with_version(opts)
    meta = read_json(d / "meta.json")
    an = read_json(d / "analysis.json")
    min_dur, min_vel, tol = opts.get("min_dur", 0.05), opts.get("min_vel", 20), opts.get("bleed_tol", 0)

    use_vocals = not opts.get("no_vocals") and (d / "midi/vocals.mid").exists()
    melody = vocal_melody(load_notes(d / "midi/vocals.mid"), max(min_dur, 0.08)) if use_vocals else []
    pm_file = d / "midi" / (opts.get("piano_midi") or "piano-mix.mid")
    if not pm_file.exists():
        found = sorted((d / "midi").glob("piano-*.mid"))
        if not found:
            raise RuntimeError("no piano notes found; run the song again")
        pm_file = found[0]
    piano = clean_piano(load_notes(pm_file, pedal=opts.get("pedal", True)), melody, min_dur, min_vel, tol,
                        opts.get("short_vel", SHORT_VEL))
    tr = max(-12, min(12, int(opts.get("transpose") or 0)))      # semitones up (+) or down (-)
    if tr:
        transpose_notes(piano, tr)
        transpose_notes(melody, tr)

    def lead_in(g):                          # notes before the first tracked bar: add whole bars in front
        first = min([float(g(n[0])) for n in piano + melody] or [0.0])
        return -float(np.ceil((-first - 0.25) / g.meter) * g.meter) if first < -0.25 else 0.0
    grid = make_grid(an, opts.get("tempo"), [n[0] for n in piano])
    off = lead_in(grid)
    raw = lambda t: float(grid(t)) - off     # noqa: E731  position in tracked beats
    detail = opts.get("detail") or "simple"          # simple | normal | full
    onsets_b = [raw(n[0]) for n in piano + melody]
    kind, trip = rhythm.feel(onsets_b, triplets=detail == "full")
    if opts.get("feel") in ("straight", "swing", "compound"):
        kind, trip = opts["feel"], (trip if opts["feel"] == "straight" else set())
    unit = 1.5 if kind == "compound" else 1.0            # quarter notes per tracked beat
    if kind == "compound" and grid.meter == 4 and not opts.get("tempo") and \
            rhythm.beats_per_bar(grid.pulse, an.get("downbeats") or []) == 2:
        grid = make_grid(an, None, [n[0] for n in piano], meter=2)     # two dotted-quarter beats a bar: 6/8, not 12/8
        off = lead_in(grid)
    plain = None
    if detail == "simple" and kind == "straight":        # 16ths only where the music really runs in 16ths
        busy = rhythm.busy_beats([raw(n[0]) for n in piano])
        plain = lambda b: b not in busy                  # noqa: E731
    qpos = lambda t: rhythm.place(raw(t), kind, trip, plain)    # noqa: E731
    qp = quantize(piano, qpos, rawpos=lambda t: raw(t) * unit)    # raw key-release kept: held vs rest
    qm = quantize(melody, qpos)
    for q in (qp, qm):                       # snapping can push a note a hair before 0
        for n in q:
            n[0] = max(0.0, n[0])
    mode, lay = opts.get("mode") or "auto", opts.get("layout") or "auto"
    if lay == "auto":
        lay = "piano" if (opts.get("piano_only") or not qm or mode == "arrange") else "piano-vocal"
    if lay == "piano-vocal" and not qm:
        lay = "piano"
    if lay == "lead" and not qm:             # instrumental: the top line is the tune
        qm = skyline(qp)
    mel = melody_events(qm)
    lyr = "none" if opts.get("no_lyrics") else (opts.get("lyrics") or "auto")
    text_file = {"paste": d / "lyrics_user.txt", "find": d / "lyrics_found.txt"}.get(lyr)
    lyric_lines, lyric_pins, lyric_times = (lyricfit.parse_full(text_file.read_text())
                                            if text_file and text_file.exists() else ([], {}, {}))
    if lyr == "find" and len(lyric_times) < max(4, 0.5 * len(lyric_lines)):
        lyric_lines, lyric_pins, lyric_times = [], {}, {}     # looked-up lyrics without timings: leave them out
    words, fit_info = [], None
    if not (lyric_lines and mel) and lyr == "auto" and use_vocals and lay != "piano":
        words = (read_json(d / "lyrics.json", {}) or {}).get("words", [])
        attach_lyrics(mel, words, qpos, 0.0)

    end = max([e[0] + e[1] for e in qp] + [m[0] + m[1] for m in mel] + [grid.meter * unit])
    lead_bars = int(round(-off / grid.meter))
    beats = [grid.meter] * lead_bars + list(grid.bar_beats)
    bs = np.concatenate([[0], np.cumsum(beats)]).astype(float) * unit
    while bs[-1] < end - 1e-6:
        beats.append(grid.meter)
        bs = np.append(bs, bs[-1] + grid.meter * unit)
    last = int(np.searchsorted(bs, end - 1e-6, "left"))           # drop empty bars after the music
    beats, bs = beats[:last], bs[:last + 1]
    end = float(bs[-1])
    nm = len(beats)
    def fit_lyrics(tune):
        """Fit the text to a tune. Lines stamped with their time in the original recording are laid
        out by those timings; plain text is fitted by phrase shape alone."""
        secs = [float(grid.time(n[0] / unit + off)) for n in tune]
        timed = len(lyric_times) >= max(4, 0.5 * len(lyric_lines)) and len(tune) > 3
        if timed:
            placed_ = lyricfit.fit_timed(tune, lyric_lines, lyric_times, secs, lyric_pins, bs)
        else:
            placed_ = lyricfit.fit(tune, lyric_lines, lyric_pins, bs)
        info_ = lyricfit.coverage(tune, lyric_lines, placed_)
        info_.update(timed=timed, lines=len(lyric_lines), lines_placed=len(lyricfit.fit.line_note))
        return placed_, info_

    if lyric_lines and mel:                          # written lyrics on the melody staff
        placed, fit_info = fit_lyrics(mel)
        for i, txt in placed.items():
            mel[i][3] = txt

    if opts.get("key") and parse_key(opts["key"]):
        k0 = key.Key(*parse_key(opts["key"]))          # the key given is the song's own key
        plan = [(0, shift_key(k0.sharps, tr), k0.mode == "minor")]
    elif qp:
        # keys are found on the notes as played, then moved: every transposition has the same key changes
        plan = [(bi, shift_key(sh, tr), mi) for bi, sh, mi in
                key_plan([[n[0], n[1], n[2] - tr, 80] for n in qp + [list(m[:3]) for m in mel]], bs)]
    else:
        k0 = key.Key(*an["key"].split())
        plan = [(0, shift_key(k0.sharps, tr), k0.mode == "minor")]
    plan_bars = np.array([x[0] for x in plan])

    def key_at(pos):
        bi = int(np.clip(np.searchsorted(bs, pos + 1e-9, "right") - 1, 0, nm - 1))
        return plan[int(np.searchsorted(plan_bars, bi, "right") - 1)][1:]

    def key_name(sh, mi):
        k_ = key.KeySignature(sh).asKey("minor" if mi else "major")
        return pretty_key(f"{k_.tonic.name} {k_.mode}")
    if mode == "arrange" and melody and mel:
        rh, lh = arrange(qp, lift_melody(mel))
    else:
        rh, lh = split_hands(qp)
    # chords are named from everything that sounds, whatever the hands end up showing
    # (a tune taken from the piano itself is already among the piano notes: count only a sung one)
    chords_found = find_chords(qp + ([[m[0], m[1], m[2], 80] for m in mel] if melody else []), bs,
                               [_scale(key_at(x)[0]) for x in bs[:-1]])
    if opts.get("no_chords"):
        chords_found = []
    single = detail == "simple"              # simple: never two notes at once in a hand
    if single or opts.get("rh_melody"):
        rh = top_line(rh)                    # the tune: the top note
    if single:
        lh = top_line(lh, low=True)          # the bass: the bottom note
    rh_lyric = {}
    if lyric_lines and not (lay in ("piano-vocal", "lead") and mel):   # no melody staff: words go under the right hand
        tune = lyricfit.tune_only(skyline(rh + lh), below=9)
        placed, fit_info = fit_lyrics(tune)
        rh_lyric = {tune[i][0]: txt for i, txt in placed.items()}
        sung = {(tune[i][0], tune[i][2]) for i in placed}        # a sung note belongs in the right hand
        rh += [n for n in lh if (n[0], n[2]) in sung]
        lh = [n for n in lh if (n[0], n[2]) not in sung]
        rh.sort(key=lambda n: (n[0], n[2]))
        if single:                           # a sung note moved over must not make a chord again
            rh = top_line(rh)

    def bpm_at(i):
        j = i - lead_bars
        return grid.bpm(min(max(j, 0), len(grid.bar_beats) - 1))
    raw_bpm = [min(300.0, max(20.0, bpm_at(i))) for i in range(nm)]
    marks, cur = {}, None                    # bar index → bpm, only where the tempo really changes
    for i in range(nm):
        sm = float(np.median(raw_bpm[i:i + 3]))
        settled = abs(np.log(raw_bpm[i] / sm)) < np.log(1.07)
        # (the last two bars are too short a sample: endings slow down or the tracker loses the beat)
        tracked = i <= lead_bars + len(grid.bar_beats) - 3
        if cur is None or (settled and tracked and abs(np.log(sm / cur[1])) > np.log(1.12) and i - cur[0] >= 2):
            cur = (i, sm)
            marks[i] = int(round(sm))
    order = sorted(marks)                    # a short burst at a wildly different tempo is the tracker slipping
    for a, b in zip(order[1:], order[2:] + [nm]):
        prev = marks.get(order[order.index(a) - 1])
        if prev and b - a < 8 and abs(np.log(marks[a] / prev)) > np.log(1.6):
            marks.pop(a)

    def mkpitch(m, pos):
        step, alter, octave = spell(int(m), *key_at(pos))
        pp = pitch.Pitch(step)
        if alter:
            pp.accidental = pitch.Accidental(alter)
        pp.octave = octave
        return pp

    def part(cls, name, events, cl, inst, shift=None):
        """events: (offset, dur, [pitches], lyric|None) non-overlapping. Builds clean measures ourselves.
        shift: "8va" / "8vb" → far-out stretches get an ottava bracket."""
        made = []                                        # (pitches, [note objects]) per sounding event
        ms = [stream.Measure(number=i + 1) for i in range(nm)]
        ms[0].insert(0, cl)
        for bi, sh, _ in plan:
            ms[bi].insert(0, key.KeySignature(sh))
        for i in range(nm):
            if i == 0 or beats[i] != beats[i - 1]:
                ms[i].insert(0, meter.TimeSignature(f"{int(beats[i]) * 3}/8" if unit == 1.5 else f"{int(beats[i])}/4"))
        seq, t = [], 0.0
        for o, du, ps, ly, *rest in events:
            if o >= end - 1e-6:
                break
            du = min(du, end - o)
            if o > t + 1e-6:
                seq.append((t, o - t, None, None, False))
            seq.append((o, du, ps, ly, bool(rest and rest[0])))
            t = o + du
        if t < end - 1e-6:
            seq.append((t, end - t, None, None, False))
        for o, du, ps, ly, st in seq:
            pcs = chunks(o, du, rest=ps is None, bar_start=bs, compound=unit == 1.5)
            if ps is not None:
                made.append((ps, []))
            for i, (po, pl) in enumerate(pcs):
                if ps is None:
                    obj = note.Rest(quarterLength=pl)
                else:
                    obj = (note.Note(mkpitch(ps[0], po), quarterLength=pl) if len(ps) == 1
                           else chord.Chord([mkpitch(x, po) for x in ps], quarterLength=pl))
                    if len(pcs) > 1:
                        obj.tie = tie.Tie("start" if i == 0 else "stop" if i == len(pcs) - 1 else "continue")
                    if ly and i == 0:
                        obj.lyric = ly
                    if st and len(pcs) == 1:
                        obj.articulations.append(articulations.Staccato())
                if ps is not None:
                    made[-1][1].append(obj)
                mi = int(np.clip(np.searchsorted(bs, po + 1e-9, "right") - 1, 0, nm - 1))
                ms[mi].insert(po - bs[mi], obj)
        p = cls()
        p.partName = name
        p.insert(0, inst)
        if shift == "8vb":                               # left hand playing high: switch to treble clef there
            for a_, b_ in treble_runs([m_[0] for m_ in made]):
                first = made[a_][1][0]
                if a_ == 0:
                    ms[0].remove(cl)
                first.activeSite.insert(first.offset, clef.TrebleClef())
                if b_ + 1 < len(made):
                    nxt = made[b_ + 1][1][0]
                    nxt.activeSite.insert(nxt.offset, clef.BassClef())
        if shift and not opts.get("no_ottava"):
            for a_, b_ in ottava_runs([m_[0] for m_ in made], shift):
                ott = spanner.Ottava([o_ for m_ in made[a_:b_ + 1] for o_ in m_[1]], type=shift)
                ott.transposing = False                  # notes stay at sounding pitch; only the writing moves
                p.insert(0, ott)
        for m in ms:
            if trip:
                mn.makeTupletBrackets(m, inPlace=True)
            p.append(m)
        mn.makeAccidentalsInMeasureStream(p, useKeySignature=True)
        return p

    sc = stream.Score()
    sc.insert(0, metadata.Metadata(title=clean_title(meta["title"]), composer="transcribed by Emi Music Note"))
    parts = []
    if lay in ("piano-vocal", "lead") and mel:
        med = np.median([m[2] for m in mel])
        vc = clef.Treble8vbClef() if med < 60 else clef.TrebleClef()
        nm_part, inst = ("Voice", instrument.Vocalist()) if use_vocals and melody else ("Melody", instrument.Piano())
        parts.append(part(stream.Part, nm_part, [(m[0], m[1], [m[2]], m[3]) for m in mel], vc, inst,
                          None if (use_vocals and melody) else "8va"))      # a piano tune can sit very high
    if lay != "lead" or not parts:
        lengths = dict(beat=unit, bar_start=bs, rest_min=float(opts.get("rest_min", REST_MIN)),
                       ring_max=float(opts.get("ring_max", RING_MAX)),
                       ringing=ring_probe(d, lambda q: grid.time(q / unit + off), float(opts.get("ring_db", RING_DROP_DB)))
                       if opts.get("ring", True) else None)
        prh = part(stream.PartStaff, "Piano", [(e[0], e[1], e[2], rh_lyric.get(e[0]), e[3]) for e in _events(rh, **lengths)],
                   clef.TrebleClef(), instrument.Piano(), "8va")
        plh = part(stream.PartStaff, "Piano", [(e[0], e[1], e[2], None, e[3]) for e in _events(lh, **lengths)],
                   clef.BassClef(), instrument.Piano(), "8vb")
        parts += [prh, plh]
        sc.insert(0, layout.StaffGroup([prh, plh], name="Piano", abbreviation="Pno.", symbol="brace",
                                       barTogether=True))
    for p in parts:
        sc.insert(0, p)
    top = list(parts[0].getElementsByClass(stream.Measure))
    for i, b in marks.items():
        top[i].insert(0, m21tempo.MetronomeMark(number=b, referent=duration.Duration(unit)))
    if kind == "swing":
        top[0].insert(0, expressions.TextExpression("Swing"))

    slug = d.name
    sc.write("midi", fp=str(d / f"{slug}-score.mid"))   # before chord symbols, so they are not played
    # where every bar starts, in seconds: in the score playback and in the original recording
    # (lets the page move a cursor over the sheet while either one plays)
    sm = pretty_midi.PrettyMIDI(str(d / f"{slug}-score.mid"))
    bar_times = {"q": [round(float(x), 4) for x in bs],
                 "score": [round(float(sm.tick_to_time(int(round(x * sm.resolution)))), 3) for x in bs],
                 "audio": [round(float(grid.time(x / unit + off)), 3) for x in bs]}

    names = []
    for pos, r, q, bass in chords_found:
        rs, ra, _ = spell(60 + r, *key_at(pos))
        b_s, b_a, _ = spell(60 + bass, *key_at(pos))
        acc = {0: "", 1: "#", -1: "-"}
        cs = harmony.ChordSymbol(root=rs + acc[ra], bass=b_s + acc[b_a], kind=CHORD_KIND[q])
        mi = int(np.clip(np.searchsorted(bs, pos + 1e-9, "right") - 1, 0, nm - 1))
        top[mi].insert(pos - bs[mi], cs)
        nm_ = rs + {0: "", 1: "#", -1: "b"}[ra] + q + ("" if bass == r else "/" + b_s + {0: "", 1: "#", -1: "b"}[b_a])
        names.append([mi + 1, nm_])

    sc.write("musicxml", fp=str(d / f"{slug}.musicxml.tmp"))
    (d / f"{slug}.musicxml.tmp").replace(d / f"{slug}.musicxml")

    # raw (unquantized) cleaned piano MIDI
    bpm0 = marks.get(0, 120)
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm0)
    ins = pretty_midi.Instrument(0, name="Piano")
    ins.notes = [pretty_midi.Note(int(v), int(p), s, e) for s, e, p, v in piano]
    pm.instruments.append(ins)
    pm.write(str(d / f"{slug}-piano.mid"))
    info = {"bpm": bpm0, "tempos": [[i + 1, b] for i, b in marks.items()],
            "key": key_name(*plan[0][1:]), "transpose": tr, "key_orig": key_name(shift_key(plan[0][1], -tr), plan[0][2]), "keys": [[bi + 1, key_name(sh, mi)] for bi, sh, mi in plan], "meter": f"{grid.meter * 3}/8" if unit == 1.5 else f"{grid.meter}/4", "feel": kind, "detail": detail, "rh_melody": bool(opts.get("rh_melody")), "single_notes": single, "version": opts.get("version"),
            "big_print": bool(opts.get("big_print")), "triplet_beats": len(trip),
            "melody_notes": len(mel), "piano_notes": len(piano), "lyrics_attached": sum(1 for m in mel if m[3]) + len(rh_lyric),
            "lyrics": lyr, "lyrics_fit": fit_info,
            "words": len(words), "measures": nm, "chords": names,
            "layout": {1: "lead", 2: "piano", 3: "piano-vocal"}[len(parts)], "mode": mode, "bars": bar_times}
    write_json(d / "score.json", info)
    return info


def _plain_pdf(xml: Path, pdf: Path, big=False) -> bool:
    """PDF without the instrument label ("Piano") and the brace beside the staves: the sheet is always
    piano, at most with a voice line, so they only take room. Goes through MuseScore's own file format,
    where both can be taken out; False if any step fails (the caller then prints the plain way)."""
    import re, tempfile
    with tempfile.TemporaryDirectory() as t:
        ms = Path(t) / "score.mscx"
        try:
            subprocess.run([MSCORE, "-o", str(ms), str(xml)], capture_output=True, text=True, timeout=300)
            s = ms.read_text(encoding="utf-8")
            s = re.sub(r"[ \t]*<bracket [^>]*/>\n", "", s)
            s = re.sub(r"<(longName|shortName)>[^<]*</\1>", r"<\1></\1>", s)
            ms.write_text(s, encoding="utf-8")
            style = Path(t) / "score_style.mss"
            if style.exists():                       # no label, so the first line needs no indent
                st = re.sub(r"<enableIndentationOnFirstSystem>1<", "<enableIndentationOnFirstSystem>0<",
                            style.read_text(encoding="utf-8"))
                if big:                              # large print: staves about a third bigger
                    st = re.sub(r"\s*<Spatium>[^<]*</Spatium>", "", st).replace("</Style>", "  <Spatium>2.3</Spatium>\n  </Style>", 1)
                style.write_text(st, encoding="utf-8")
            subprocess.run([MSCORE, "-o", str(pdf), str(ms)], capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            pdf.unlink(missing_ok=True)
            return False
    return pdf.exists()


def render_pdf(d: Path) -> str:
    xml = d / f"{d.name}.musicxml"
    pdf = d / f"{d.name}.pdf"
    pdf.unlink(missing_ok=True)
    errs = []
    if Path(MSCORE).exists():
        try:
            if _plain_pdf(xml, pdf, bool((read_json(d / "score.json", {}) or {}).get("big_print"))):
                return "musescore"
            r = subprocess.run([MSCORE, "-o", str(pdf), str(xml)], capture_output=True, text=True, timeout=300)
            if pdf.exists():
                return "musescore"
            errs.append(f"MuseScore: {(r.stderr or r.stdout)[-500:]}")
        except subprocess.TimeoutExpired:
            errs.append("MuseScore timed out")
    if shutil.which("musicxml2ly") and shutil.which("lilypond"):
        ly = d / f"{d.name}.ly"
        try:
            subprocess.run(["musicxml2ly", "-o", str(ly), str(xml)], capture_output=True, timeout=120)
            r = subprocess.run(["lilypond", "-o", str(d / d.name), str(ly)], capture_output=True, text=True,
                               cwd=d, timeout=300)
            if pdf.exists():
                return "lilypond"
            errs.append(f"LilyPond: {r.stderr[-500:]}")
        except subprocess.TimeoutExpired:
            errs.append("LilyPond timed out")
    raise RuntimeError("PDF render failed. " + " | ".join(errs or ["no renderer installed"]))
