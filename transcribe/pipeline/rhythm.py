"""Turn tracked beats + downbeats into a consistent bar grid (pure functions, no audio).

Beat trackers switch between counting quarters and halves, drop beats in quiet spots and
mark some half-bars as downbeats. Here we rebuild one steady pulse (the tactus), then pick
bar lines over it with a small dynamic programme that prefers the tracker's downbeats.
"""
import numpy as np

TACTUS_PREF = 0.6        # preferred beat length in seconds (100 bpm); only breaks ties
LEVELS = (0, 1, 2, 3)    # a tracked interval may really be 1, 2, 4 or 8 beats


COMPOUND_COST = 0.2      # per interval: cutting a beat whose notes fall on its thirds into two halves


def _thirds(fr):
    """True when these onset phases (0..1 inside one beat) sit on thirds of the beat, not on halves."""
    t = int(np.sum((np.abs(fr - 1 / 3) < 0.07) | (np.abs(fr - 2 / 3) < 0.07)))
    h = int(np.sum((np.abs(fr - 0.5) < 0.06) | (np.abs(fr - 0.25) < 0.05) | (np.abs(fr - 0.75) < 0.05)))
    return t >= 2 and t >= 3 * h


def _compound(starts, ibi, onsets):
    """→ (intervals, levels) bool: at that level the beat holds three notes to the beat (6/8, 12/8, swing),
    so splitting it further would cut a dotted-quarter beat in two."""
    out = np.zeros((len(ibi), len(LEVELS)), bool)
    if onsets is None or not len(onsets):
        return out
    on = np.sort(np.asarray(onsets, float))
    for i, (a, L) in enumerate(zip(starts, ibi)):
        f = (on[np.searchsorted(on, a):np.searchsorted(on, a + L)] - a) / L
        if not len(f):
            continue
        for k in LEVELS:
            ph = (f * 2 ** k) % 1
            out[i, k] = _thirds(ph[(ph > 0.04) & (ph < 0.96)])
    # a compound beat is a property of a passage, not of one beat (a stray triplet, rubato)
    return np.array([out[max(0, i - 4):i + 5].mean(0) >= 0.5 for i in range(len(out))]).reshape(out.shape)


def _levels(ibi, bar_gap, starts=None, onsets=None):
    """For every tracked beat interval pick how many beats it really spans (as a power of two), so the
    beat length stays continuous through the song. Viterbi over intervals: jumps in beat length cost,
    a mild pull towards ~100 bpm and towards 2, 3 or 4 beats per tracked bar break ties, and a beat
    whose notes fall on its thirds (a compound beat) is not cut into halves."""
    n = len(ibi)
    cost = np.zeros((n, len(LEVELS)))
    comp = _compound(starts, ibi, onsets) if starts is not None else np.zeros((n, len(LEVELS)), bool)
    for k in LEVELS:
        tau = ibi / 2 ** k
        cost[:, k] = 0.1 * np.abs(np.log2(tau / TACTUS_PREF))
        if bar_gap is not None:
            r = bar_gap / tau
            cost[:, k] -= 0.05 * ((np.abs(r - 4) < 0.5) | (np.abs(r - 3) < 0.36) | (np.abs(r - 2) < 0.3))
        cost[tau < 0.2, k] += 5.0
        if k:
            cost[comp[:, :k].any(1), k] += COMPOUND_COST
    best = cost[0].copy()
    back = np.zeros((n, len(LEVELS)), int)
    for i in range(1, n):
        new = np.empty(len(LEVELS))
        for k in LEVELS:
            tr = [best[j] + min(2.0, 2.0 * abs(np.log2((ibi[i] / 2 ** k) / (ibi[i - 1] / 2 ** j))))
                  + (0.3 if j != k else 0.0) for j in LEVELS]
            back[i, k] = int(np.argmin(tr))
            new[k] = min(tr) + cost[i, k]
        best = new
    ks = [int(np.argmin(best))]
    for i in range(n - 1, 0, -1):
        ks.append(int(back[i, ks[-1]]))
    return np.array(ks[::-1])


def tactus(beats, downbeats=(), onsets=None):
    """Steady pulse from raw tracked beats: fills dropped beats, splits half-tempo stretches,
    removes doubled detections. onsets (s): note starts, so a compound beat is not split in two."""
    b = np.unique(np.round(np.asarray(beats, float), 4))
    if len(b) < 4:
        return b
    keep = [b[0]]
    for x in b[1:]:                      # doubled detections
        if x - keep[-1] >= 0.2:
            keep.append(x)
    b = np.array(keep)
    if len(b) < 4:
        return b
    db = np.asarray(downbeats, float)
    ibi = np.diff(b)
    bar_gap = None
    if len(db) > 3:
        dgap = np.diff(db)
        j = np.clip(np.searchsorted(db, b[:-1]) - 1, 0, len(dgap) - 1)
        bar_gap = np.array([np.median(dgap[max(0, x - 2):x + 3]) for x in j])
    folded = ibi / 2.0 ** _levels(ibi, bar_gap, b[:-1], onsets)
    tau = np.array([np.median(folded[max(0, i - 4):i + 5]) for i in range(len(folded))])
    out = [b[0]]
    for i in range(len(ibi)):
        gap = b[i + 1] - out[-1]
        k = int(round(gap / tau[i]))
        if k == 0:
            continue
        out.extend(out[-1] + gap * np.arange(1, k + 1) / k)
    return np.array(out)


def steady(pulse, onsets, double=(0.38, 0.65), half=(1.6, 2.6), support=1.45, history=12):
    """Keep the tactus at the established tempo when the tracker jumps to about double or half of it.
    A stretch whose beat is about half (double tempo) or twice (half tempo) the median of the last
    `history` beats is a real tempo change only when the notes agree: their rate (attacks a second,
    a chord counted once) against the music so far changes by at least `support` the same way.
    Otherwise the stretch is counted again at the established beat (every other beat kept, or each
    beat split)."""
    p = np.asarray(pulse, float)
    if len(p) < 8:
        return p
    on = np.sort(np.asarray(onsets if onsets is not None else [], float))
    if len(on):                                          # a chord (or a rolled one) is one attack
        on = on[np.concatenate([[True], np.diff(on) > 0.05])]
    ibi = np.diff(p)
    sm = np.array([np.median(ibi[max(0, i - 3):i + 4]) for i in range(len(ibi))])

    def rate(a, b):
        return (np.searchsorted(on, b) - np.searchsorted(on, a)) / max(1e-6, b - a)

    out, acc, i, n = [p[0]], [], 0, len(ibi)
    while i < n:
        E = float(np.median(acc[-history:])) if len(acc) >= 6 else None
        band = None
        if E:
            r = sm[i] / E
            band = double if double[0] < r < double[1] else half if half[0] < r < half[1] else None
        if band is None:
            out.append(p[i + 1])
            acc.append(p[i + 1] - p[i])
            i += 1
            continue
        j = i
        while j < n and band[0] < sm[j] / E < band[1]:
            j += 1
        a, b = p[i], p[j]
        before, during = rate(p[0], a), rate(a, b)
        faster = band is double
        real = len(on) >= 8 and before > 0 and (during >= support * before if faster else during <= before / support)
        if real or j - i < 2:
            seg = list(p[i + 1:j + 1])
        elif faster:                                     # tracker counts twice per beat: every other one
            keep = list(p[i:j + 1:2])
            if j < n and keep[-1] < p[j] - 1e-9:         # an odd count: spread the last 1.5 beats evenly
                keep.pop()                               # so the stretch still ends on p[j]
                start = keep[-1]
                k = max(1, int(round((p[j] - start) / E)))
                keep += list(start + (p[j] - start) * np.arange(1, k + 1) / k)
            seg = keep[1:]
        else:                                            # tracker counts every other beat: split each
            seg = []
            for x, y in zip(p[i:j], p[i + 1:j + 1]):
                k = max(1, int(round((y - x) / E)))
                seg += list(x + (y - x) * np.arange(1, k + 1) / k)
        for x in seg:
            acc.append(x - out[-1])
            out.append(x)
        i = j
    return np.array(out)


def _meter(pulse, downbeats):
    """3 if the tracker mostly counts three beats between its downbeats, else 4."""
    db = np.asarray(downbeats, float)
    if len(db) < 4:
        return 4
    n = np.diff(np.searchsorted(pulse, db - 0.08))
    n = n[n > 0]
    if not len(n):
        return 4
    three = np.mean((n == 3) | (n == 6))
    four = np.mean((n == 4) | (n == 2) | (n == 8))
    return 3 if three > 0.5 and three > four else 4


def beats_per_bar(pulse, downbeats):
    """The tracker's own count: median number of pulse beats between its downbeats (0 if unknown)."""
    db = np.asarray(downbeats, float)
    if len(db) < 4 or len(pulse) < 4:
        return 0
    n = np.diff(np.searchsorted(pulse, db - 0.08))
    n = n[n > 0]
    return int(np.median(n)) if len(n) else 0


def bars(pulse, downbeats, meter=None):
    """Bar lines over the pulse → (list of (first_beat_index, n_beats), meter).
    The first bar may be a pickup (fewer beats)."""
    n = len(pulse)
    meter = meter or _meter(pulse, downbeats)
    pen = ({4: 0.0, 2: 1.3, 6: 1.2, 3: 1.7, 5: 1.7} if meter == 4 else
           {2: 0.0, 4: 1.0, 3: 1.7, 1: 1.7} if meter == 2 else {3: 0.0, 6: 1.0, 2: 1.7, 4: 1.7})
    db = np.asarray(downbeats, float)
    isdown = np.zeros(n + 1, bool)
    if len(db):
        j = np.clip(np.searchsorted(db, pulse), 1, len(db) - 1) if len(db) > 1 else np.zeros(n, int)
        near = np.minimum(np.abs(db[j] - pulse), np.abs(db[j - 1] - pulse)) if len(db) > 1 else np.abs(db[0] - pulse)
        isdown[:n] = near < 0.09
    INF = 1e9
    best = np.full(n + 1, INF)
    prev = np.full(n + 1, -1)
    for i in range(min(meter, n) + 1):          # first bar line anywhere in the first bar
        best[i] = -1.0 * isdown[i] + (0.0 if i == 0 else 0.2)
    for i in range(1, n + 1):
        for m, p in pen.items():
            j = i - m
            if j >= 0 and best[j] < INF:
                c = best[j] + p - (1.0 if i < n and isdown[i] else 0.0)
                if c < best[i] - 1e-9:
                    best[i], prev[i] = c, j
    end = int(np.argmin(best[max(0, n - meter):]) + max(0, n - meter))
    lines = [end]
    while prev[lines[-1]] >= 0:
        lines.append(int(prev[lines[-1]]))
    lines = lines[::-1]
    out = []
    if lines[0] > 0:
        out.append((0, lines[0]))                # pickup
    out += [(a, b - a) for a, b in zip(lines[:-1], lines[1:])]
    if lines[-1] < n:
        out.append((lines[-1], n - lines[-1]))
    # a half-length bar next to a full one reads better as a single long bar (4+2 or 2+4 → 6),
    # as long as the long bar still starts and ends on a tracked downbeat
    merged, i = [], 0
    half = meter // 2

    def ok(a, k):
        return isdown[a] and (a + k >= n or isdown[a + k])
    while i < len(out):
        a, k = out[i]
        inner = 0 < i < len(out) - 1
        if inner and k <= half and merged and merged[-1][1] == meter and ok(merged[-1][0], meter + k) and len(merged) > 1:
            merged[-1] = (merged[-1][0], meter + k)
        elif inner and k <= half and out[i + 1][1] == meter and i + 1 < len(out) - 1 and ok(a, meter + k):
            merged.append((a, meter + k))
            i += 1
        else:
            merged.append((a, k))
        i += 1
    return merged, meter


def _fit(points, onsets):
    """Mean distance (s) from note onsets to the nearest half-beat of `points` (lower = better)."""
    pts = np.asarray(points, float)
    half = np.sort(np.concatenate([pts, (pts[:-1] + pts[1:]) / 2]))
    on = onsets[(onsets >= pts[0]) & (onsets <= pts[-1])]
    if len(on) < 3:
        return None
    j = np.clip(np.searchsorted(half, on), 1, len(half) - 1)
    return float(np.mean(np.minimum(np.abs(half[j] - on), np.abs(half[j - 1] - on))))


def _bars_for(n, meter):
    """Bar lengths for n beats: whole bars, a short remainder folded into the last bar (4+2 → 6)."""
    q, r = divmod(n, meter)
    out = [meter] * q
    if r:
        if q and r <= meter // 2:
            out[-1] += r
        else:
            out.append(r)
    return out


def repair(pulse, bar_list, meter, onsets):
    """Odd-length bars usually mean the tracker lagged behind a tempo change. Re-fit the stretch
    (odd bars plus a neighbour on each side) as n1 beats at the tempo before + n2 beats at the tempo
    after, and keep that when the played notes fit it at least as well."""
    pulse = np.asarray(pulse, float)
    onsets = np.sort(np.asarray(onsets, float))
    if len(onsets) < 8 or len(bar_list) < 6:
        return pulse, bar_list
    P, B = list(pulse), list(bar_list)

    def beat_len(bars_):
        d = [P[a + k] - P[a] for a, k in bars_ if a + k < len(P) and k == meter]
        return float(np.median(d)) / meter if d else None

    i = 1
    while i < len(B) - 1:
        if B[i][1] == meter:
            i += 1
            continue
        j = i
        while j + 1 < len(B) - 1 and B[j + 1][1] != meter:
            j += 1
        lo, hi = max(i - 1, 0), min(j + 1, len(B) - 1)
        a, b = B[lo][0], B[hi][0] + B[hi][1]
        tb, ta = beat_len(B[max(0, lo - 2):lo]), beat_len(B[hi + 1:hi + 3])
        done = False
        if b < len(P) and tb and ta:
            t0, t1 = P[a], P[b]
            cur = _fit(P[a:b + 1], onsets)
            odd_now = sum(1 for _, k in B[lo:hi + 1] if k != meter)
            best = None
            nmax = int((t1 - t0) / min(tb, ta)) + 2
            for n1 in range(0, nmax):
                n2 = int(round((t1 - t0 - n1 * tb) / ta))
                if n2 < 0 or n1 + n2 == 0:
                    continue
                total = n1 * tb + n2 * ta
                err = abs(total - (t1 - t0)) / (t1 - t0)
                if err > 0.04:
                    continue
                sc = (t1 - t0) / total
                pts = np.concatenate([t0 + sc * tb * np.arange(n1 + 1), t0 + sc * (n1 * tb + ta * np.arange(1, n2 + 1))])
                f = _fit(pts, onsets)
                if f is None:
                    continue
                bars_new = _bars_for(n1, meter) + _bars_for(n2, meter)
                odd = sum(1 for k in bars_new if k != meter)
                cost = f + 0.004 * odd + 0.2 * err
                if best is None or cost < best[0]:
                    best = (cost, f, pts, bars_new, odd)
            if best and cur is not None and best[1] <= cur * 1.05 + 0.002 and (best[4] < odd_now or best[1] < 0.75 * cur):
                _, _, pts, bars_new, _ = best
                shift = (len(pts) - 1) - (b - a)
                P = P[:a] + list(pts) + P[b + 1:]
                nb, x = [], a
                for k in bars_new:
                    nb.append((x, k))
                    x += k
                B = B[:lo] + nb + [(x0 + shift, k) for x0, k in B[hi + 1:]]
                i = lo + len(nb)
                done = True
        if not done:
            i = j + 1
    return np.array(P), B


class Grid:
    """Maps seconds → position in quarter notes; knows where bars start and how long they are."""

    def __init__(self, pulse, bar_list, meter=4):
        self.pulse = np.asarray(pulse, float)
        self.meter = meter
        full = [b for b in bar_list]
        if full and full[0][1] < meter and len(full) > 1:   # pickup: pad backwards to a whole bar
            a, k = full[0]
            self.lead = meter - k
            full[0] = (a - self.lead, meter)
        else:
            self.lead = 0
        if len(full) > 1 and full[-1][1] < meter:           # last bar: let it ring out as a whole bar
            full[-1] = (full[-1][0], meter)
        self.bar_beats = [k for _, k in full]
        self.bar_start = np.concatenate([[0], np.cumsum(self.bar_beats)]).astype(float)   # in quarters
        tau0 = float(np.median(np.diff(self.pulse[:8]))) if len(self.pulse) > 1 else 0.5
        tau1 = float(np.median(np.diff(self.pulse[-8:]))) if len(self.pulse) > 1 else 0.5
        pre = self.pulse[0] - tau0 * np.arange(64, 0, -1)
        post = self.pulse[-1] + tau1 * np.arange(1, 65)
        self._t = np.concatenate([pre, self.pulse, post])
        self._q = np.arange(len(self._t)) - 64.0 + self.lead

    def __call__(self, t):
        return np.interp(t, self._t, self._q)

    def time(self, q):
        return np.interp(q, self._q, self._t)

    def extend(self, end_q):
        """Make sure bars cover up to end_q quarters."""
        while self.bar_start[-1] < end_q - 1e-6:
            self.bar_beats.append(self.meter)
            self.bar_start = np.append(self.bar_start, self.bar_start[-1] + self.meter)

    def bpm(self, i):
        a, b = self.bar_start[i], self.bar_start[i + 1]
        return 60.0 * (b - a) / max(1e-6, float(self.time(b) - self.time(a)))


def constant_grid(bpm, t0, meter=4):
    """Fixed-tempo grid (used when the tempo is given by hand or no beats were found)."""
    tau = 60.0 / bpm
    pulse = t0 + tau * np.arange(0, 8)
    g = Grid(pulse, [(0, meter), (meter, meter)], meter)
    g._t = t0 + tau * np.arange(-4096, 4096 * 4)
    g._q = np.arange(-4096, 4096 * 4).astype(float)
    return g


def snap(q, prefer=0.5, fine=0.25, pull=0.35):
    """Quantise a position: to the 8th when within `pull` of an 8th (keeps the rhythm simple),
    else to the 16th."""
    c = round(q / prefer) * prefer
    return c if abs(q - c) <= pull * prefer else round(q / fine) * fine


# ---------- feel: straight / swing / compound, and stray triplets ----------
SLOTS = np.array([0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1.0])
LEAD = 0.12                      # an onset this far before a beat still belongs to that beat


def _split(pos):
    x = np.asarray(pos, float)
    b = np.floor(x + LEAD)
    return b, x - b


def feel(pos, triplets=False):
    """How the beat is divided, from raw onset positions (in beats).
    → ("straight" | "swing" | "compound", set of beats to write as triplets).
    Single triplet beats are only looked for when asked: expressive playing easily looks like one."""
    b, f = _split(pos)
    if len(f) < 16:
        return "straight", set()
    d = np.abs(f[:, None] - SLOTS[None, :])
    slot = d.argmin(1)
    ok = d.min(1) < 0.05
    c = np.array([(ok & (slot == i)).sum() for i in range(len(SLOTS))], float)
    tern, bina = c[2] + c[4], c[1] + c[3] + c[5]
    if tern >= max(12.0, 1.5 * bina) and tern >= 0.1 * len(f):
        return ("swing" if c[2] < 0.35 * c[4] else "compound"), set()
    trip = set()
    if not triplets:
        return "straight", trip
    for beat in np.unique(b):
        inner = np.sort(f[(b == beat) & (f > 0.12) & (f < 0.88)])
        if not len(inner):
            continue
        cl = [[inner[0]]]
        for v in inner[1:]:
            (cl[-1].append(v) if v - cl[-1][-1] < 0.05 else cl.append([v]))
        g = [float(np.mean(x)) for x in cl]
        if len(g) != 2:
            continue
        terr = abs(g[0] - 1 / 3) + abs(g[1] - 2 / 3)
        berr = min(abs(g[0] - a_) + abs(g[1] - b_) for a_, b_ in ((0.25, 0.5), (0.5, 0.75), (0.25, 0.75)))
        if terr < 0.1 and terr < 0.6 * berr:
            trip.add(int(beat))
    return "straight", trip


def busy_beats(pos, need=3):
    """Beats that really contain running 16ths: at least `need` separate onsets."""
    b, f = _split(pos)
    out = set()
    for beat in np.unique(b):
        v = np.sort(f[b == beat])
        if 1 + int(np.sum(np.diff(v) > 0.1)) >= need:
            out.add(int(beat))
    return out


def place(x, kind="straight", trip=(), eighths_only=None):
    """Quantised position in quarter notes for a raw position x in beats.
    eighths_only: callable(beat) → True where 16ths are not allowed (simple notation)."""
    b, f = _split(x)
    b, f = float(b), float(f)
    if kind == "compound":       # beat = dotted quarter; thirds of a beat are 8ths
        return snap(x * 1.5)
    if kind == "swing":          # long-short pairs are written as even 8ths
        f = f * 0.75 if f < 2 / 3 else 0.5 + (f - 2 / 3) * 1.5
        return snap(b + f, pull=0.5)
    if int(b) in trip:
        return b + round(f * 3) / 3
    if eighths_only is not None and eighths_only(int(b)):
        return snap(x, pull=0.5)
    return snap(x)
