"""Fit lyric text onto melody notes (no audio needed): syllables ↔ notes, lines ↔ phrases."""
import re

import numpy as np

VOWELS = "aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿ"


def split_word(word: str):
    """English-style syllable split → list of pieces ("tomorrow" → ["to", "mor", "row"])."""
    m = re.match(r"^(\W*)(.*?)(\W*)$", word, re.S)
    pre, core, post = m.group(1), m.group(2), m.group(3)
    low = core.lower()
    groups = [(g.start(), g.end()) for g in re.finditer(f"[{VOWELS}]+", low)]
    if len(groups) > 1:
        last = groups[-1]
        tail = low[last[0]:]
        silent_e = tail == "e" and not (low.endswith("le") and len(low) > 2 and low[-3] not in VOWELS)
        silent_es = tail == "es" and low[last[0] - 1] not in "sxzh"
        silent_ed = tail == "ed" and low[last[0] - 1] not in "td"
        if silent_e or silent_es or silent_ed:
            groups = groups[:-1]
    if len(groups) <= 1:
        return [word]
    cuts = []
    for gi, ((a0, a1), (b0, b1)) in enumerate(zip(groups, groups[1:])):
        between = low[a1:b0]
        last_le = gi == len(groups) - 2 and low.endswith("le") and b0 == len(low) - 1
        if len(between) <= 1 or between in ("ch", "sh", "th", "ph", "wh", "ck"):
            cut = a1 if len(between) != 2 or between != "ck" else b0
        elif last_le:
            cut = b0 - 2                              # lit-tle, peo-ple
        else:
            cut = a1 + 1
        cuts.append(max(a1, cut))
    pieces = [core[i:j] for i, j in zip([0] + cuts, cuts + [len(core)])]
    pieces = [p for p in pieces if p]
    pieces[0] = pre + pieces[0]
    pieces[-1] = pieces[-1] + post
    return pieces


def parse_full(text: str):
    """Lyric text → (lines, pins, times).
    lines: rows of (piece, word_position), word_position in "single" | "begin" | "middle" | "end".
    pins: {line_index: bar_number} for lines written as "@12 words ..." (must start in bar 12).
    times: {line_index: seconds} for lines carrying an LRC stamp "[01:23.45] words ..." (when that
    line is sung in the original recording).
    Words of languages written one syllable per word (Vietnamese, Chinese ...) are never split."""
    mono = bool(re.search(r"[\u0102\u0103\u0110\u0111\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9\u3040-\u30ff\u4e00-\u9fff]", text))
    out, pins, times = [], {}, {}
    for raw in text.splitlines():
        pin = re.match(r"\s*@(\d+)\s*", raw)
        if pin:
            raw = raw[pin.end():]
        stamp = re.match(r"\s*\[(\d+):(\d+(?:[.:]\d+)?)\]", raw)
        line = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", raw).strip()     # [Chorus], (x2), [00:12.3] ...
        if not line or re.fullmatch(r"[\W_]+", line):
            continue
        row = []
        for w in line.split():
            if not re.search(r"\w", w):
                continue
            parts = [w] if mono else split_word(w)
            if len(parts) == 1:
                row.append((parts[0], "single"))
            else:
                row += [(p, "begin" if i == 0 else "end" if i == len(parts) - 1 else "middle")
                        for i, p in enumerate(parts)]
        if row:
            if pin:
                pins[len(out)] = int(pin.group(1))
            if stamp:
                times[len(out)] = int(stamp.group(1)) * 60 + float(stamp.group(2).replace(":", "."))
            out.append(row)
    return out, pins, times


def parse(text: str):
    return parse_full(text)[:2]


def syllables(text: str):
    return parse_full(text)[0]


def note_features(mel):
    """mel: [[onset_q, dur_q, ...]] → (phrase_start[], figuration[])."""
    on = np.array([m[0] for m in mel], float)
    n = len(on)
    gap = np.diff(on) if n > 1 else np.array([])
    ps = np.zeros(n, bool)
    ps[0:1] = True
    if n > 1:                                 # a note clearly longer than its neighbours ends a phrase
        long_ = max(1.0, 1.8 * float(np.median(gap)))
        ps[1:] = gap >= long_ - 1e-6
    fig = np.zeros(n, bool)                   # bars of unbroken 16ths are accompaniment figures, not words
    i = 0
    while i < n - 1:
        j = i
        while j < n - 1 and gap[j] <= 0.26:
            j += 1
        if j - i >= 15:                       # a bar or more of unbroken 16ths
            fig[i:j] = True                   # the note the run lands on may carry a word
        i = max(j, i + 1)
    ps[1:] |= fig[:-1] & ~fig[1:]             # the tune entering after an accompaniment figure
    if all(len(m) > 2 and isinstance(m[2], (int, float, np.integer, np.floating)) for m in mel):
        p = np.array([m[2] for m in mel], float)
        ps[1:] |= (np.abs(np.diff(p)) >= 12) & ~fig[1:]      # a leap of an octave or more starts afresh
    return ps, fig


def tune_only(notes, below=7, win=8):
    """Drop notes well under the line around them: accompaniment that shares the staff with the tune.
    notes: [[onset, dur, pitch, ...]] in order → kept notes (same objects)."""
    if len(notes) < 4:
        return list(notes)
    p = np.array([n[2] for n in notes], float)
    med = np.array([np.median(p[max(0, i - win):i + win + 1]) for i in range(len(p))])
    return [n for n, m in zip(notes, med) if n[2] > m - below]


def fit(mel, lines, pins=None, bar_start=None, when=None, note_time=None):
    """Assign syllables to notes. mel: [[onset_q, dur_q, ...]] monophonic, in order.
    lines: rows from parse(). pins {line_index: bar_number} + bar_start (quarter positions) force a
    line to begin on the first tune note of that bar. when {line_index: seconds} + note_time[seconds
    per note] pull each line towards the moment it is expected. → {note_index: lyric_text}."""
    fit.line_starts, fit.line_note = [], {}
    if not mel or not lines:
        return {}
    ps, fig = note_features(mel)
    syl = [(p, pos, i == 0, i == len(row) - 1) for row in lines for i, (p, pos) in enumerate(row)]
    N, K = len(mel), len(syl)
    starts = [k for k in range(K) if syl[k][2]] + [K]
    next_line = {k: starts[i + 1] for i, k in enumerate(starts[:-1])}
    due = {}                                   # line-start syllable → expected seconds
    if when and note_time is not None:
        due = {starts[li]: tm for li, tm in when.items() if li < len(starts) - 1}
    pin_note, pin_at = {}, {}                  # line-start syllable → note, note → syllable
    if pins and bar_start is not None:
        on = np.array([m[0] for m in mel], float)
        for li, bar in sorted(pins.items()):
            if 1 <= bar < len(bar_start) and li < len(starts) - 1:
                t = int(np.searchsorted(on, bar_start[bar - 1] - 1e-6))
                if t < N and t not in pin_at and (not pin_note or t > max(pin_note.values())):
                    pin_note[starts[li]], pin_at[t] = t, starts[li]
    INF = 1e9
    D = np.full((N + 1, K + 1), INF)
    B = np.zeros((N + 1, K + 1), np.int8)      # 1 match, 2 skip note, 3 stack syllable, 4 skip line
    D[0, 0] = 0.0
    for t in range(N + 1):
        for k in range(K + 1):
            c = D[t, k]
            if c >= INF:
                continue
            held = t in pin_at and pin_at[t] >= k       # this note is reserved for a pinned line start
            if t < N and k < K and (pin_note.get(k, t) == t) and (not held or pin_at[t] == k):
                ls = syl[k][2]                  # sing syllable k on note t
                m = 0.0
                if fig[t]:
                    m = 1.2                     # running figures are accompaniment, not words
                elif ls and ps[t]:
                    m -= 1.5                    # a line begins where a phrase begins
                elif ls:
                    m += 1.0                    # a line starting mid-phrase is unlikely
                elif ps[t]:
                    m += 0.4                    # a long note inside a line happens, but not often
                if k in due:                    # stay close to when this line is sung
                    m += 0.8 * min(abs(note_time[t] - due[k]), 6.0)
                if c + m < D[t + 1, k + 1]:
                    D[t + 1, k + 1], B[t + 1, k + 1] = c + m, 1
            if t < N and not held:              # note without a word
                between = k == 0 or k == K or syl[k][2]
                s = 0.2 if fig[t] else (0.3 if between else 0.55)
                if c + s < D[t + 1, k]:
                    D[t + 1, k], B[t + 1, k] = c + s, 2
            if k < K and t > 0 and not syl[k][2]:   # extra syllable shares the previous note
                if c + 0.7 < D[t, k + 1]:
                    D[t, k + 1], B[t, k + 1] = c + 0.7, 3
            if k in next_line and k not in pin_note:      # leave a whole line out
                k2 = next_line[k]
                s = 0.5 + 0.25 * (k2 - k)
                if c + s < D[t, k2]:
                    D[t, k2], B[t, k2] = c + s, 4
    # stop at a line boundary: a line that was begun is finished, unused lines are simply left out
    ends = [k for k in starts if D[N, k] < INF]
    t, k = N, min(ends, key=lambda k: D[N, k] + 0.25 * (K - k)) if ends else 0
    on_note = {}
    prev_line_start = {v: s for s, v in next_line.items()}
    while t > 0 or k > 0:
        b = B[t, k]
        if b == 1:
            t, k = t - 1, k - 1
            on_note.setdefault(t, []).insert(0, k)
        elif b == 2:
            t -= 1
        elif b == 3:
            k -= 1
            on_note.setdefault(t - 1, []).append(k)
        elif b == 4:
            k = prev_line_start[k]
        else:
            break
    out = {}
    fit.line_starts = sorted(t for t, ks in on_note.items() if any(syl[k][2] for k in ks))
    line_of = {k: i for i, k in enumerate(starts[:-1])}
    fit.line_note = {line_of[k]: t for t, ks in on_note.items() for k in ks if k in line_of}
    for t, ks in on_note.items():
        ks = sorted(ks)
        txt = ""
        for i, k in enumerate(ks):
            p, pos = syl[k][0], syl[k][1]
            if i and pos in ("single", "begin"):
                txt += " "
            txt += p
        first, last = syl[ks[0]][1], syl[ks[-1]][1]
        out[t] = ("-" if first in ("middle", "end") else "") + txt + ("-" if last in ("begin", "middle") else "")
    return out


def coverage(mel, lines, placed):
    """Numbers to judge a fit: syllables placed, lines starting on a phrase start."""
    total = sum(len(r) for r in lines)
    ps, _ = note_features(mel) if mel else (np.array([]), None)
    return {"syllables": total, "placed_notes": len(placed), "notes": len(mel),
            "phrase_starts_used": int(sum(1 for t in placed if ps[t])), "phrases": int(ps.sum())}


def fit_timed(mel, lines, times, note_time, pins=None, bar_start=None):
    """Fit lyrics whose lines carry time stamps from the original recording.
    A cover keeps the order and (roughly) the pacing of the original, so the lines are laid out one
    after another: the time from one line start to the next should match the original gap, the notes
    in between should match the syllables of the line, and lines like to begin on phrase starts.
    Lines the cover does not play are left out. → {note_index: lyric_text}; sets fit.line_note."""
    fit.line_starts, fit.line_note = [], {}
    J, N = len(lines), len(mel)
    if not J or N < 2:
        return {}
    ps, fig = note_features(mel)
    tau = np.asarray(note_time, float)
    C = np.concatenate([[0], np.cumsum(~fig)])           # sung-able notes before index t
    need = np.array([len(r) for r in lines], float)
    known = sorted(times)
    T = np.interp(np.arange(J), known, [times[i] for i in known])    # unstamped lines: between neighbours
    start_cost = np.where(fig, 9.0, np.where(ps, -1.0, 0.3))
    pin_note = {}
    if pins and bar_start is not None:
        on = np.array([m[0] for m in mel], float)
        for li, bar in pins.items():
            if 1 <= bar < len(bar_start) and li < J:
                pin_note[li] = int(np.searchsorted(on, bar_start[bar - 1] - 1e-6))

    def mismatch(m, n):
        """m notes available for a line of n syllables."""
        return np.where(m >= n, 0.45 * np.minimum(m - n, 10), 1.0 * (n - m))

    def run(Tq):
        INF = 1e9
        F = np.full((J, N), INF)
        Bj = np.full((J, N), -1)
        Bt = np.full((J, N), -1)
        for j in range(J):                               # the song may start with lines the cover skips
            F[j] = 1.5 * j + 0.15 * C[:N] + start_cost
            if j in pin_note:
                keep = np.zeros(N, bool)
                keep[min(pin_note[j], N - 1)] = True
                F[j][~keep] = INF
        for j in range(1, J):
            for s_ in (1, 2, 3):
                i = j - s_
                if i < 0:
                    break
                if any(x in pin_note for x in range(i + 1, j)):
                    continue                             # a pinned line cannot be skipped
                gap = max(0.3, Tq[j] - Tq[i])
                lo = np.searchsorted(tau, tau - (1.8 * gap + 4.0))
                for t in range(1, N):
                    if fig[t] or (j in pin_note and pin_note[j] != t):
                        continue
                    a_ = int(lo[t])
                    if a_ >= t:
                        continue
                    prev = F[i, a_:t]
                    dt = tau[t] - tau[a_:t]
                    ratio = np.clip(dt / gap, 0.2, 5.0)
                    c = prev + mismatch(C[t] - C[a_:t], need[i]) + 1.5 * (s_ - 1) + 1.5 * np.abs(np.log(ratio))
                    k = int(np.argmin(c))
                    v = c[k] + start_cost[t]
                    if v < F[j, t]:
                        F[j, t], Bj[j, t], Bt[j, t] = v, i, a_ + k
        tail = 1.5 * (J - 1 - np.arange(J))[:, None]
        j, t = np.unravel_index(int(np.argmin(F + tail)), F.shape)
        path = []
        while j >= 0 and t >= 0:
            path.append((int(j), int(t)))
            j, t = Bj[j, t], Bt[j, t]
        return path[::-1]

    path = run(T)
    if len(path) >= 6:                                   # the cover's overall speed, then once more
        r = [(tau[t2] - tau[t1]) / (T[j2] - T[j1]) for (j1, t1), (j2, t2) in zip(path, path[1:]) if T[j2] - T[j1] > 0.5]
        if r and abs(np.log(float(np.median(r)))) > 0.03:
            path = run(T * float(np.median(r)))
    out = {}
    for n_, (j, t) in enumerate(path):
        end = path[n_ + 1][1] if n_ + 1 < len(path) else N
        notes = [x for x in range(t, end) if not fig[x]]
        if n_ + 1 == len(path):                          # last line: stay inside its own phrase
            cut = next((i for i, x in enumerate(notes[1:], 1) if ps[x] and i >= len(lines[j])), len(notes))
            notes = notes[:cut]
        row = lines[j]
        groups = [[k] for k in range(min(len(row), len(notes)))]
        for k in range(len(notes), len(row)):            # more syllables than notes: share the last note
            groups[-1].append(k)
        for x, ks in zip(notes, groups):
            txt = ""
            for i, k in enumerate(ks):
                if i and row[k][1] in ("single", "begin"):
                    txt += " "
                txt += row[k][0]
            first, last = row[ks[0]][1], row[ks[-1]][1]
            out[x] = ("-" if first in ("middle", "end") else "") + txt + ("-" if last in ("begin", "middle") else "")
        fit.line_note[j] = t
    fit.line_starts = sorted(fit.line_note.values())
    return out
