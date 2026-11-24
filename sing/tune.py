"""Gentle pitch correction for the sung vocal: snap each note's pitch centre to the score, keep the vibrato.

target_curve(notes, bpm, shift, times)   -> score pitch per frame (midi, 0 = rest)
retune_f0(f0, times, target, strength)  -> f0 with each note's slow drift pulled to the score; wrong-octave, short
                                          and clearly wrong notes moved whole onto the score; vibrato, scoops
                                          between notes and unvoiced frames left alone (numpy only, testable)
retune(y, sr, notes, bpm, shift)         -> WORLD (pyworld) analysis -> retune_f0 -> resynthesis; returns (y, report)

The slow part of the pitch error is a ~0.2 s (0.1 s on notes under 0.6 s) moving median of (sung - score) in cents; what is left over (vibrato,
jitter) rides on top unchanged. The correction itself is smoothed over ~25 ms so note changes stay legato, and a
frame more than 3 semitones from its note's own centre (a tracking slip, or an ornament) is not touched. A note the
model sang in the wrong octave, or a note more than 100 cents off, is moved whole onto the score.
"""
import numpy as np

FRAME_S = 0.005  # WORLD frame period (5 ms)


def target_curve(notes, bpm, shift, times):
    """notes: [{'q', 'd', 'midi'}] (quarter notes); times: seconds per frame -> midi target per frame (0 = rest)."""
    spq = 60.0 / bpm
    tgt = np.zeros(len(times))
    for n in notes:
        if not n['midi']: continue
        a, b = n['q'] * spq, (n['q'] + n['d']) * spq
        tgt[(times >= a) & (times < b)] = n['midi'] + shift
    return tgt


def _moving(x, w, fn):
    h = w // 2
    p = np.pad(x, (h, h), mode='edge')
    win = np.lib.stride_tricks.sliding_window_view(p, w)
    return fn(win, axis=1)


def retune_f0(f0, times, target, strength=0.85, slow_s=0.2, fast_s=0.1, smooth_s=0.025, max_cents=300.0, short_s=0.0, wrong_c=100.0):
    """Per note (a run of frames with one target):
    - a note sung in the wrong octave is moved to the score's octave (an octave jump is a wrong note, not a style);
    - frames more than max_cents from the note's own median are tracking slips / ornaments and stay untouched;
    - the slow drift (moving median, slow_s) is pulled to the score by `strength`; vibrato / jitter ride on top;
    - a note whose centre is more than wrong_c off (a wrong note), or shorter than short_s (off by default: on the
      model's fast notes WORLD's f0 is too rough to snap them whole), is moved as a whole, fully, onto the score pitch.
    The drift window is slow_s (keeps a 5-6 Hz vibrato) on notes of 0.6 s and longer, fast_s on shorter ones (0.2 s
    scored worse on One Day More's 16ths).
    The correction is smoothed over smooth_s so note changes stay legato without lagging at note starts."""
    f0 = np.asarray(f0, dtype=float)
    fp = float(times[1] - times[0]) if len(times) > 1 else FRAME_S
    v = (f0 > 0) & (target > 0)
    dev = np.zeros_like(f0)
    dev[v] = 1200 * np.log2(f0[v] / (440.0 * 2 ** ((target[v] - 69) / 12)))
    ok = np.zeros_like(v)
    corr = np.zeros_like(f0)
    w = max(3, int(round(slow_s / fp)) | 1)
    edges = np.flatnonzero(np.diff(np.r_[-1, target, -1]) != 0)
    for a, b in zip(edges[:-1], edges[1:]):
        if target[a] <= 0: continue
        m = v[a:b].copy()
        if m.sum() < 3: continue
        d = dev[a:b].copy()
        med = float(np.median(d[m]))
        octv = 1200.0 * round(med / 1200)  # sung an octave (or two) off: back to the score's octave
        d -= octv
        m &= np.abs(d - (med - octv)) <= max_cents
        if m.sum() < 3: continue
        ok[a:b] = m
        centre = float(np.median(d[m]))
        if (b - a) * fp < short_s or abs(centre) > wrong_c:
            corr[a:b] = -octv - centre  # whole note onto the score
            continue
        idx = np.flatnonzero(m)
        if (~m).any(): d[~m] = np.interp(np.flatnonzero(~m), idx, d[idx])
        wn = w if (b - a) * fp >= 0.6 else max(3, int(round(fast_s / fp)) | 1)
        slow = _moving(d, min(wn, (len(d) // 2) * 2 + 1 if len(d) > 2 else 1), np.median)
        corr[a:b] = -octv - strength * slow
    sw = max(1, int(round(smooth_s / fp)))
    if sw > 1:
        k = np.hanning(sw + 2)[1:-1]; k /= k.sum()
        corr = np.convolve(corr, k, mode='same')
    out = f0.copy()
    out[ok] = f0[ok] * 2 ** (corr[ok] / 1200)
    return out


def note_stats(f0, times, target):
    """% of notes whose median pitch (middle half of the note) is within 25 / 50 cents of the score."""
    edges = np.flatnonzero(np.diff(np.r_[-1, target, -1]) != 0)
    c = []
    for a, b in zip(edges[:-1], edges[1:]):
        if target[a] <= 0: continue
        q = (b - a) // 4
        seg, tg = f0[a + q:b - q], target[a + q:b - q]
        v = seg > 0
        if v.sum() < 3: continue
        c.append(1200 * np.log2(np.median(seg[v]) / (440.0 * 2 ** ((tg[0] - 69) / 12))))
    c = np.abs(np.array(c)) if c else np.array([np.inf])  # an octave off counts as wrong
    return {'notes': int(len(c)), 'in25': round(100 * float(np.mean(c <= 25)), 1), 'in50': round(100 * float(np.mean(c <= 50)), 1)}


def retune(y, sr, notes, bpm, shift, strength=0.85):
    """The whole dry vocal through WORLD: harvest f0, retune, resynthesize. Returns (y_tuned float32, report)."""
    import pyworld as pw
    x = np.asarray(y, dtype=np.float64)
    f0, t = pw.harvest(x, sr, f0_floor=70.0, f0_ceil=1100.0, frame_period=FRAME_S * 1000)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    tgt = target_curve(notes, bpm, shift, t)
    f1 = retune_f0(f0, t, tgt, strength)
    z = pw.synthesize(f1, sp, ap, sr, frame_period=FRAME_S * 1000)[:len(x)]
    z = np.pad(z, (0, len(x) - len(z)))
    # WORLD leaves faint noise in silences: keep the original's silences silent
    env = np.abs(x)
    k = int(0.02 * sr)
    env = np.convolve(env, np.ones(k) / k, mode='same')
    gate = np.clip(env / (1e-4 + 0.02 * env.max()), 0, 1)
    z = z * gate
    return z.astype(np.float32), {'before': note_stats(f0, t, tgt), 'after': note_stats(f1, t, tgt)}
