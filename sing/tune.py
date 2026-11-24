"""Gentle pitch correction for the sung vocal: snap each note's pitch centre to the score, keep the vibrato.

target_curve(notes, bpm, shift, times)   -> score pitch per frame (midi, 0 = rest)
retune_f0(f0, times, target, strength)  -> f0 with each note's slow drift pulled to the score; vibrato, scoops
                                          between notes and unvoiced frames left alone (numpy only, testable)
retune(y, sr, notes, bpm, shift)         -> WORLD (pyworld) analysis -> retune_f0 -> resynthesis; returns (y, report)

The slow part of the pitch error is a ~0.2 s moving median of (sung - score) in cents; what is left over (vibrato,
jitter) rides on top unchanged. The correction itself is smoothed over ~40 ms so note changes stay legato, and a
frame more than 3 semitones off (a tracking slip, or a deliberate ornament) is not touched.
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


def retune_f0(f0, times, target, strength=0.85, slow_s=0.2, smooth_s=0.04, max_cents=300.0):
    f0 = np.asarray(f0, dtype=float)
    fp = float(times[1] - times[0]) if len(times) > 1 else FRAME_S
    ok = (f0 > 0) & (target > 0)
    dev = np.zeros_like(f0)
    dev[ok] = 1200 * np.log2(f0[ok] / (440.0 * 2 ** ((target[ok] - 69) / 12)))
    oct_ = np.round(dev / 1200) * 1200  # sung an octave away from the score: tune to that octave
    dev = dev - oct_
    ok &= np.abs(dev) <= max_cents
    corr = np.zeros_like(f0)
    w = max(3, int(round(slow_s / fp)) | 1)
    # per note (a run of frames with the same target), the slow drift = moving median inside that note only
    edges = np.flatnonzero(np.diff(np.r_[-1, target, -1]) != 0)
    for a, b in zip(edges[:-1], edges[1:]):
        if target[a] <= 0: continue
        m = ok[a:b]
        if m.sum() < 3: continue
        d = dev[a:b].copy()
        idx = np.flatnonzero(m)
        d[~m] = np.interp(np.flatnonzero(~m), idx, d[idx]) if (~m).any() else d[~m]
        slow = _moving(d, min(w, (len(d) // 2) * 2 + 1 if len(d) > 2 else 1), np.median)
        corr[a:b] = -strength * slow
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
    c = np.abs(np.array(c)) if c else np.array([np.inf])
    c = np.minimum(c, np.abs(c - 1200))
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
