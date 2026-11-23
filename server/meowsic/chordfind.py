"""Music-aware chord finder: plain chord names (A, F#m, D, Bm, E7) from the notes of a score.

How it listens:
- One window per beat pair: half a bar in 4/4 (and 12/8), a whole bar in 3/4, 2/4 and 6/8.
- Every note counts by how long it sounds in the window, then by register: the bass (the lowest
  note sounding, and anything low on the keyboard) counts most, the top line (the tune) least,
  short melody notes off the beat least of all.
- A bass note that only walks by step between its neighbours (A-G#-F#) is a passing note: it
  counts like any inner note, it does not turn the chord into a slash chord.
- Candidates are major and minor triads, diminished (rare: all three notes and a penalty) and the
  dominant 7th only when the 7th sounds in the accompaniment, not just in the tune.
- The key is estimated (Krumhansl profiles, the key signature as a tie-breaker); chords in the
  key win close calls.
- Viterbi over the windows with a change penalty, larger in the middle of a bar: the chord only
  changes when the evidence clearly changes, so a bar is one chord unless the harmony really moves.

No slash chords: the bass under a held chord in this music is almost always a walking or passing
line, and naming each step (A/G#, F#m/E) is what made the old symbols unreadable. The bass line is
already in the score for anyone who wants it.

The MusicXML side (`rechord_xml`) swaps only the <harmony> elements, as text edits on the file:
every other byte, every note, stays exactly as it was.
"""
import re
import xml.parsers.expat
from dataclasses import dataclass

NAMES_SHARP = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']
NAMES_MANY_SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
QUALITIES = {'': (0, 4, 7), 'm': (0, 3, 7), 'dim': (0, 3, 6)}
KIND = {'': 'major', 'm': 'minor', '7': 'dominant', 'dim': 'diminished'}
STEP_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
# Krumhansl-Kessler key profiles
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


@dataclass
class Note:
    onset: float          # quarters from the start of the piece
    dur: float            # quarters
    midi: int
    attack: bool = True   # False: the tied-over rest of a longer note


@dataclass
class Bar:
    start: float          # quarters
    length: float         # quarters (actual length; a pickup is short)
    beats: int = 4        # time signature numerator
    beat_type: int = 4


@dataclass
class Chord:
    at: float             # quarters: window start where this chord begins
    root: int             # pitch class
    quality: str          # '', 'm', '7', 'dim'
    name: str = ''


# ---------- windows ----------

def beat_len(bar: Bar) -> float:
    q = 4 / bar.beat_type
    return q * 3 if bar.beat_type >= 8 and bar.beats % 3 == 0 and bar.beats > 3 else q  # 6/8, 12/8: dotted-quarter beats


def windows(bars):
    """[(start, end, bar index, is bar start)] — beat pairs: half bar in 4/4, whole bar in 3/4 / 2/4 / 6/8."""
    out = []
    for i, b in enumerate(bars):
        if b.length <= 0: continue
        bl = beat_len(b)
        nbeats = round(b.length / bl)
        full = abs(b.length - b.beats * 4 / b.beat_type) < 1e-6
        if full and nbeats >= 4 and nbeats % 2 == 0:
            step = b.length / (nbeats // 2)
            for k in range(nbeats // 2):
                out.append((b.start + k * step, b.start + (k + 1) * step, i, k == 0))
        else:
            out.append((b.start, b.start + b.length, i, True))
    return out


# ---------- weighting ----------

@dataclass
class Window:
    w: list               # 12 weights, every note
    acc: list             # 12 weights, without the top line (the accompaniment)
    bass: int = None      # pitch class of the bass, None when nothing sounds under the tune
    strength: float = 0.0  # share of the window the bass sounds


def _slices(notes, a, b):
    pts = sorted({a, b, *[n.onset for n in notes if a < n.onset < b], *[n.onset + n.dur for n in notes if a < n.onset + n.dur < b]})
    for x, y in zip(pts, pts[1:]):
        m = (x + y) / 2
        yield x, y, [n for n in notes if n.onset <= m < n.onset + n.dur]


def analyse(notes, a, b, beat, passing_bass=False):
    """Weights of [a, b). Each note counts by how long it sounds here, then by its role: the bass
    (lowest note under something else) most, inner notes normally, the top line (the tune) less and
    its short off-beat notes least. A passing bass counts like a passing tone."""
    inside = [n for n in notes if n.onset < b and n.onset + n.dur > a]
    win = Window([0.0] * 12, [0.0] * 12)
    if not inside: return win
    up, low = [0.0] * 12, [0.0] * 12
    role = {id(n): {'bass': 0.0, 'top': 0.0, 'all': 0.0} for n in inside}
    bass_time = {}
    for x, y, snd in _slices(inside, a, b):
        if not snd: continue
        lo, hi = min(snd, key=lambda n: n.midi), max(snd, key=lambda n: n.midi)
        for n in snd: role[id(n)]['all'] += y - x
        if (len(snd) >= 2 and hi.midi - lo.midi >= 5) or lo.midi < 55:  # under something else, or low anyway
            role[id(lo)]['bass'] += y - x
            bass_time[lo.midi % 12] = bass_time.get(lo.midi % 12, 0.0) + (y - x)
        if len(snd) >= 2 and hi.midi - lo.midi >= 5:
            role[id(hi)]['top'] += y - x
    if bass_time:
        # the bass of the window: longest in the bass, but the lowest note and the one on the
        # downbeat count extra (a broken left hand A2-E3-A3-E3 is an A bass)
        lowest = min(n.midi for n in inside if role[id(n)]['bass'] > 0) if any(role[id(n)]['bass'] for n in inside) else None
        on_one = [n.midi % 12 for n in inside if role[id(n)]['bass'] > 0 and n.onset <= a + 1e-6 < n.onset + n.dur]
        score = {pc: t + (0.25 * (b - a) if lowest is not None and pc == lowest % 12 else 0)
                 + (0.5 * (b - a) if pc in on_one else 0) for pc, t in bass_time.items()}
        win.bass = max(score, key=score.get)
        win.strength = min(1.0, bass_time[win.bass] / (b - a) + 0.5 * (win.bass in on_one))
    for n in inside:
        ov = min(b, n.onset + n.dur) - max(a, n.onset)
        if ov <= 0: continue
        r = role[id(n)]
        is_bass = r['all'] > 0 and r['bass'] >= 0.5 * r['all']
        is_top = r['all'] > 0 and r['top'] >= 0.5 * r['all'] and not is_bass
        f = 1.0
        if is_bass:
            f = 1.0
        elif is_top:
            f = 0.7
            on_beat = abs((n.onset - a) / beat - round((n.onset - a) / beat)) < 1e-3
            if n.onset >= a - 1e-9 and not on_beat and n.dur < beat * 0.75:
                f *= 0.5                                             # short melody notes off the beat
        if not n.attack or n.onset < a - 1e-9: f *= 0.85             # held over from before
        (low if is_bass else up)[n.midi % 12] += ov * f
        if not is_top: win.acc[n.midi % 12] += ov * f
    # the bass line and the rest each get a fixed share, so one long bass note cannot drown a
    # broken chord above it (and a passing bass hardly counts)
    if win.bass is not None: low[win.bass] *= 2                     # the bass note itself over its own broken octaves/fifths
    su, sl = sum(up), sum(low)
    share = (0.1 if passing_bass else 0.35) if su and sl else (0.0 if su else 1.0)
    win.w = [(1 - share) * (u / su if su else 0) + share * (l / sl if sl else 0) for u, l in zip(up, low)]
    return win


# ---------- key ----------

def _corr(x, y):
    mx, my = sum(x) / 12, sum(y) / 12
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    den = (sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y)) ** 0.5
    return num / den if den else 0.0


def find_key(notes, fifths=None):
    """(tonic pc, 'major'|'minor') from duration-weighted pitch classes (bass counts double)."""
    h = [0.0] * 12
    for n in notes:
        h[n.midi % 12] += n.dur * (2.0 if n.midi < 55 else 1.0)
    if not any(h): return ((7 * (fifths or 0)) % 12, 'major')
    best = None
    for t in range(12):
        for mode, prof in (('major', MAJOR_PROFILE), ('minor', MINOR_PROFILE)):
            r = _corr(h, [prof[(i - t) % 12] for i in range(12)])
            if fifths is not None:
                sig = (7 * fifths) % 12 if mode == 'major' else (7 * fifths + 9) % 12
                if sig == t: r += 0.05                            # the key signature breaks ties
            if best is None or r > best[0]: best = (r, t, mode)
    return best[1], best[2]


def diatonic(tonic, mode):
    """{(root pc, quality)} of the key (minor: natural + harmonic: V and vii° too)."""
    if mode == 'major':
        steps, quals = (0, 2, 4, 5, 7, 9, 11), ('', 'm', 'm', '', '', 'm', 'dim')
        out = {((tonic + s) % 12, q) for s, q in zip(steps, quals)}
    else:
        steps, quals = (0, 2, 3, 5, 7, 8, 10), ('m', 'dim', '', 'm', 'm', '', '')
        out = {((tonic + s) % 12, q) for s, q in zip(steps, quals)}
        out |= {((tonic + 7) % 12, ''), ((tonic + 11) % 12, 'dim')}
    return out


# ---------- scoring + smoothing ----------

def emission(win, root, quality, in_key, passing=False):
    w = win.w
    tot = sum(w)
    if tot <= 0: return 0.0
    tones = [(root + i) % 12 for i in QUALITIES[quality]]
    inside = sum(w[t] for t in tones) / tot
    s = inside - 0.6 * (1 - inside)
    if w[root] / tot < 0.05: s -= 0.35                              # no root, no chord
    if w[tones[1]] / tot < 0.03: s -= 0.08                          # no third: ambiguous
    if win.bass is not None and not passing:
        if win.bass == root: s += 0.35 * win.strength
        elif win.bass not in tones: s -= 0.2 * win.strength
    if in_key: s += 0.10
    if quality == 'dim':
        s -= 0.25
        if min(w[t] / tot for t in tones) < 0.08: s -= 1.0
    return s


def candidates():
    return [(r, q) for q in QUALITIES for r in range(12)]


CHANGE_BAR, CHANGE_MID, CHANGE_PASSING = 0.15, 0.2, 0.5


def viterbi(ems, pens):
    """ems: [ [score per candidate] or None (silence) ]; pens: the cost of changing chord at each window
    (small on a bar line, bigger mid-bar, biggest over a walking bass note).
    Returns the candidate index per window (silence keeps the chord before it)."""
    n = len(candidates())
    prev, back = None, []
    for e, pen in zip(ems, pens):
        if e is None:
            back.append(None)
            continue
        if prev is None:
            cur, bk = list(e), [-1] * n
        else:
            bi = max(range(n), key=lambda j: prev[j])
            cur, bk = [], []
            for k in range(n):
                stay, move = prev[k], prev[bi] - pen
                cur.append(e[k] + max(stay, move))
                bk.append(k if stay >= move else bi)
        back.append(bk)
        prev = cur
    if prev is None: return [None] * len(ems)
    path = [None] * len(ems)
    k = max(range(n), key=lambda j: prev[j])
    for i in range(len(ems) - 1, -1, -1):
        if back[i] is None: continue
        path[i] = k
        if back[i][k] >= 0: k = back[i][k]
    return path


def spell(pc, fifths):
    names = NAMES_FLAT if fifths < 0 else NAMES_MANY_SHARPS if fifths >= 4 else NAMES_SHARP
    return names[pc % 12]


def _walking(prev, bass, nxt):
    """A bass note one step between its neighbours, going the same way (A-G#-F#)."""
    if None in (prev, bass, nxt): return False
    down = 1 <= (prev - bass) % 12 <= 2 and 1 <= (bass - nxt) % 12 <= 2
    up = 1 <= (bass - prev) % 12 <= 2 and 1 <= (nxt - bass) % 12 <= 2
    return down or up


def has_seventh(acc, r):
    """A dominant 7th only when the accompaniment (not just the tune) really plays the flat 7th."""
    tot = sum(acc)
    if tot <= 0: return False
    sev = acc[(r + 10) % 12]
    return sev / tot >= 0.10 and sev >= 0.4 * max(acc[(r + 7) % 12], acc[(r + 4) % 12]) and acc[(r + 11) % 12] < 0.5 * sev


def find_chords(notes, bars, fifths=None, key=None):
    """[Chord] where the chord changes, at window starts. notes: [Note]; bars: [Bar]."""
    notes = [n for n in notes if n.dur > 0]
    if not notes or not bars: return []
    tonic, mode = key or find_key(notes, fifths)
    if fifths is None: fifths = _fifths_of(tonic, mode)
    dia = diatonic(tonic, mode)
    cands = candidates()
    wins = windows(bars)
    first = [analyse(notes, a, b, beat_len(bars[i])) for a, b, i, _ in wins]
    whole = {}  # the whole bar, heard at once: a bar is one chord unless its halves clearly differ
    for a, b, i, st in wins:
        if not st or i in whole or bars[i].length <= b - a + 1e-9: continue
        wb = analyse(notes, bars[i].start, bars[i].start + bars[i].length, beat_len(bars[i]))
        whole[i] = [emission(wb, r, q, (r, q) in dia) for r, q in cands] if sum(wb.w) > 0 else None
    ems, accs, pens = [], [], []
    for k, (a, b, i, st) in enumerate(wins):
        win = first[k]
        passing = not st and _walking(first[k - 1].bass if k else None, win.bass,
                                      first[k + 1].bass if k + 1 < len(wins) else None)
        if passing: win = analyse(notes, a, b, beat_len(bars[i]), passing_bass=True)
        accs.append(win.acc)
        pens.append(CHANGE_BAR if st else CHANGE_PASSING if passing else CHANGE_MID)
        tot = sum(win.w)
        if tot <= 0 or sum(1 for x in win.w if x > 0.1 * tot) < 2:  # one pitch alone is not a chord: keep the one before
            ems.append(None)
            continue
        own = [emission(win, r, q, (r, q) in dia, passing) for r, q in cands]
        bar = whole.get(i)
        if bar:  # a walking-bass step says less about the chord than the bar it is in
            mix = 0.25 if passing else 0.5
            own = [mix * x + (1 - mix) * y for x, y in zip(own, bar)]
        ems.append(own)
    path = viterbi(ems, pens)
    out, k = [], 0
    while k < len(wins):
        if path[k] is None:
            k += 1
            continue
        j = k
        while j + 1 < len(wins) and (path[j + 1] is None or path[j + 1] == path[k]): j += 1
        r, q = cands[path[k]]
        if q == '' and has_seventh([sum(accs[x][pc] for x in range(k, j + 1)) for pc in range(12)], r): q = '7'
        if not out or (out[-1].root, out[-1].quality) != (r, q):
            out.append(Chord(wins[k][0], r, q, spell(r, fifths) + q))
        k = j + 1
    return out


def _fifths_of(tonic, mode):
    t = tonic if mode == 'major' else (tonic + 3) % 12
    f = (t * 7) % 12  # pc -> position on the circle of fifths
    return f - 12 if f > 6 else f


def names(chords): return [c.name for c in chords]


# ---------- MusicXML ----------

@dataclass
class _Measure:
    part: int
    index: int
    start_byte: int
    end_byte: int = 0
    pos: float = 0.0          # quarters from the piece start (filled from part 0)
    length: float = 0.0
    beats: int = 4
    beat_type: int = 4
    points: list = None       # [(quarters into the measure, byte offset, is a chord-continuation note)]


class _Reader:
    """One pass of expat over the file: notes, measures, harmony byte ranges and insertion points."""

    def __init__(self, data: bytes):
        self.data = data
        self.notes = []        # (part, measure index, quarters into measure, dur q, midi, attack)
        self.measures = []
        self.harmonies = []    # (start byte, end byte, part, measure index, figure)
        self.fifths = None
        self.part = -1
        self.stack = []
        self.text = ''
        p = xml.parsers.expat.ParserCreate()
        p.StartElementHandler, p.EndElementHandler, p.CharacterDataHandler = self.start, self.end, self.chars
        self.p = p
        p.Parse(data, True)

    def byte(self): return self.p.CurrentByteIndex

    def start(self, name, attrs):
        self.stack.append(name)
        self.text = ''
        if name == 'part':
            self.part += 1
            self.divisions, self.mi, self.beats, self.beat_type, self.transpose = 1, -1, 4, 4, 0
        elif name == 'measure' and len(self.stack) >= 2 and self.stack[-2] == 'part':
            self.mi += 1
            self.cur, self.maxpos, self.last_onset = 0, 0, 0
            self.m = _Measure(self.part, self.mi, self.byte(), beats=self.beats, beat_type=self.beat_type, points=[])
            self.measures.append(self.m)
        elif name == 'note':
            self.n = {'start': self.byte(), 'chord': False, 'rest': False, 'grace': False, 'dur': 0, 'step': None,
                      'alter': 0.0, 'octave': None, 'tie_stop': False, 'cue': False}
        elif name == 'harmony':
            self.h = {'start': self.byte(), 'root': '', 'alter': 0.0, 'kind': '', 'text': None, 'bass': '', 'balter': 0.0, 'offset': 0.0}
            self.h['text'] = attrs.get('text')
        elif name == 'kind' and self.stack[-2] == 'harmony':
            self.h['ktext'] = attrs.get('text')
        elif name == 'tie' and self.stack[-2] == 'note' and attrs.get('type') == 'stop':
            self.n['tie_stop'] = True
        elif name in ('backup', 'forward'):
            self.bf = {'start': self.byte(), 'dur': 0}
        elif name == 'chord' and self.stack[-2] == 'note': self.n['chord'] = True
        elif name == 'rest' and self.stack[-2] == 'note': self.n['rest'] = True
        elif name == 'grace' and self.stack[-2] == 'note': self.n['grace'] = True
        elif name == 'cue' and self.stack[-2] == 'note': self.n['cue'] = True

    def chars(self, s): self.text += s

    def _end_byte(self, name):
        """Byte just after the end tag that is being closed (expat points at its '<')."""
        i = self.byte()
        if self.data[i:i + 2] == b'</':
            return self.data.index(b'>', i) + 1
        return self.data.index(b'>', i) + 1  # self-closing: expat reports the start tag

    def end(self, name):
        t = self.text.strip()
        par = self.stack[-2] if len(self.stack) >= 2 else ''
        if name == 'divisions': self.divisions = float(t) or 1
        elif name == 'fifths' and self.fifths is None: self.fifths = int(float(t))
        elif name == 'beats' and par == 'time':
            try: self.beats = int(t.split('+')[0])
            except ValueError: pass
            self.m.beats = self.beats
        elif name == 'beat-type' and par == 'time':
            try: self.beat_type = int(t)
            except ValueError: pass
            self.m.beat_type = self.beat_type
        elif name == 'chromatic' and par == 'transpose': self.transpose = int(float(t))
        elif par == 'note' and name == 'duration': self.n['dur'] = float(t)
        elif par == 'pitch' and name == 'step': self.n['step'] = t
        elif par == 'pitch' and name == 'alter': self.n['alter'] = float(t)
        elif par == 'pitch' and name == 'octave': self.n['octave'] = int(t)
        elif par in ('backup', 'forward') and name == 'duration': self.bf['dur'] = float(t)
        elif par == 'root' and name == 'root-step': self.h['root'] = t
        elif par == 'root' and name == 'root-alter': self.h['alter'] = float(t)
        elif par == 'bass' and name == 'bass-step': self.h['bass'] = t
        elif par == 'bass' and name == 'bass-alter': self.h['balter'] = float(t)
        elif par == 'harmony' and name == 'kind': self.h['kind'] = t
        elif par == 'harmony' and name == 'offset': self.h['offset'] = float(t or 0)
        elif name == 'note':
            n, q = self.n, 1 / self.divisions
            if not n['chord'] and not n['grace']:
                self.m.points.append((self.cur * q, n['start'], False))
            elif n['chord']:
                self.m.points.append((self.last_onset * q, n['start'], True))
            if not n['grace']:
                onset = self.last_onset if n['chord'] else self.cur
                if not n['rest'] and not n['cue'] and n['step'] and n['octave'] is not None:
                    midi = 12 * (n['octave'] + 1) + STEP_PC[n['step']] + round(n['alter']) + self.transpose
                    self.notes.append((self.part, self.mi, onset * q, n['dur'] * q, midi, not n['tie_stop']))
                if not n['chord']:
                    self.last_onset = self.cur
                    self.cur += n['dur']
                    self.maxpos = max(self.maxpos, self.cur)
        elif name == 'backup':
            self.m.points.append((self.cur / self.divisions, self.bf['start'], False))
            self.cur = max(0, self.cur - self.bf['dur'])
        elif name == 'forward':
            self.m.points.append((self.cur / self.divisions, self.bf['start'], False))
            self.cur += self.bf['dur']
            self.maxpos = max(self.maxpos, self.cur)
        elif name == 'harmony':
            h = self.h
            fig = figure_of(h)
            pcs, bass = tones_of(h)
            self.harmonies.append((h['start'], self._end_byte(name), self.part, self.mi, fig,
                                   (self.cur + h['offset']) / self.divisions, pcs, bass))
        elif name == 'measure' and par == 'part':
            self.m.length = self.maxpos / self.divisions
            self.m.end_byte = self.byte()  # at '</measure>'
        self.stack.pop()
        self.text = ''


KIND_SUFFIX = {'major': '', 'minor': 'm', 'dominant': '7', 'dominant-seventh': '7', 'major-seventh': 'maj7',
               'minor-seventh': 'm7', 'diminished': 'dim', 'diminished-seventh': 'dim7', 'half-diminished': 'm7b5',
               'augmented': 'aug', 'suspended-fourth': 'sus4', 'suspended-second': 'sus2', 'major-sixth': '6',
               'minor-sixth': 'm6', 'dominant-ninth': '9', 'power': '5', 'none': 'N.C.'}


KIND_TONES = {'major': (0, 4, 7), 'minor': (0, 3, 7), 'dominant': (0, 4, 7, 10), 'dominant-seventh': (0, 4, 7, 10),
              'major-seventh': (0, 4, 7, 11), 'minor-seventh': (0, 3, 7, 10), 'diminished': (0, 3, 6),
              'diminished-seventh': (0, 3, 6, 9), 'half-diminished': (0, 3, 6, 10), 'augmented': (0, 4, 8),
              'suspended-fourth': (0, 5, 7), 'suspended-second': (0, 2, 7), 'major-sixth': (0, 4, 7, 9),
              'minor-sixth': (0, 3, 7, 9), 'dominant-ninth': (0, 4, 7, 10, 2), 'major-ninth': (0, 4, 7, 11, 2),
              'minor-ninth': (0, 3, 7, 10, 2), 'power': (0, 7)}


def tones_of(h):
    """(pitch classes, bass pc) of a parsed <harmony>; ((), None) for N.C."""
    if not h['root'] or h['root'] not in STEP_PC: return (), None
    r = (STEP_PC[h['root']] + round(h['alter'])) % 12
    pcs = tuple((r + i) % 12 for i in KIND_TONES.get(h['kind'], (0, 4, 7)))
    b = (STEP_PC[h['bass']] + round(h['balter'])) % 12 if h['bass'] in STEP_PC else r
    return pcs, b


def figure_of(h):
    acc = lambda a: {1: '#', -1: 'b', 2: '##', -2: 'bb'}.get(round(a), '')
    if not h['root']: return 'N.C.'
    s = h['root'] + acc(h['alter']) + KIND_SUFFIX.get(h['kind'], h.get('ktext') or '')
    if h['bass']: s += '/' + h['bass'] + acc(h['balter'])
    return s


def read_xml(data: bytes):
    """(notes [Note], bars [Bar], fifths, reader) of a partwise MusicXML file."""
    r = _Reader(data)
    p0 = [m for m in r.measures if m.part == 0]
    bars, pos = [], 0.0
    full = lambda m: m.beats * 4 / m.beat_type
    for m in p0:
        others = [x.length for x in r.measures if x.index == m.index]
        length = max(others) if others else m.length
        if length <= 0: length = full(m)
        m.pos, m.length = pos, length
        bars.append(Bar(pos, length, m.beats, m.beat_type))
        pos += length
    starts = {m.index: m.pos for m in p0}
    notes = [Note(starts.get(mi, 0.0) + o, d, midi, att) for part, mi, o, d, midi, att in r.notes if mi in starts]
    r.chord_spans = []  # (start q, end q, pcs, bass pc) of the symbols already in the file
    hs = sorted((starts[h[3]] + h[5], h[6], h[7]) for h in r.harmonies if h[3] in starts)
    for k, (at, pcs, bass) in enumerate(hs):
        end = hs[k + 1][0] if k + 1 < len(hs) else pos
        if end > at and pcs: r.chord_spans.append((at, end, pcs, bass))
    return notes, bars, r.fifths, r


def melody_only(notes) -> bool:
    """True when hardly anything sounds together (a lead sheet / a sung line): under 15% of the
    sounding time has two different pitches at once."""
    ev = sorted([(n.onset, 1, n.midi) for n in notes] + [(n.onset + n.dur, -1, n.midi) for n in notes])
    on, last, alone, together = {}, None, 0.0, 0.0
    for t, d, m in ev:
        if last is not None and t > last:
            k = len([p for p, c in on.items() if c > 0])
            if k == 1: alone += t - last
            elif k >= 2: together += t - last
        on[m] = on.get(m, 0) + d
        last = t
    tot = alone + together
    return tot <= 0 or together / tot < 0.15


def hint_notes(spans):
    """Stand-in accompaniment from chord symbols already in a melody-only file (they were heard from
    the full recording): the root low, the chord tones held in the middle. A slash bass is left out:
    it is the noisy part of the old symbols (walking bass notes)."""
    out = []
    for a, b, pcs, bass in spans:
        out.append(Note(a, b - a, 36 + pcs[0]))
        out += [Note(a, b - a, 48 + pc) for pc in pcs]
    return out


def old_chords(data: bytes, reader=None):
    """[(bar number, chord name)] already in the file, in order."""
    r = reader or _Reader(data)
    return [(h[3] + 1, h[4]) for h in sorted(r.harmonies, key=lambda h: (h[3], h[0]))]


def bar_of(bars, at):
    return max((k for k, b in enumerate(bars) if b.start <= at + 1e-9), default=0)


def harmony_xml(c: Chord, fifths, staff=None, offset_div=None, indent=''):
    name = spell(c.root, fifths if fifths is not None else 0)
    step, alt = name[0], {'#': 1, 'b': -1}.get(name[1:2], 0)
    x = f'<harmony><root><root-step>{step}</root-step>' + (f'<root-alter>{alt}</root-alter>' if alt else '') + \
        f'</root><kind>{KIND[c.quality]}</kind>'
    if offset_div: x += f'<offset>{offset_div}</offset>'
    if staff: x += f'<staff>{staff}</staff>'
    return x + '</harmony>' + ('\n' + indent if indent else '')


@dataclass
class Rechorded:
    xml: bytes
    old: list             # [(bar number, name)]
    new: list             # [(bar number, name)]
    chords: list          # [Chord]

    @property
    def changed(self): return self.old != self.new


def rechord_xml(data: bytes) -> Rechorded:
    """New chord symbols for a MusicXML file. Only <harmony> elements change (every other byte stays);
    the new ones go on the part that had them (else the first part), at the window starts."""
    notes, bars, fifths, r = read_xml(data)
    hear = notes
    if melody_only(notes) and r.chord_spans:  # the tune alone says too little: let the old symbols speak for the piano
        hear = notes + hint_notes(r.chord_spans)
    found = find_chords(hear, bars, fifths)
    if hear is not notes:  # nothing before the first old symbol (an intro / pickup the old finder left bare)
        found = [c for c in found if c.at >= r.chord_spans[0][0] - 1e-6]
    if fifths is None: fifths = 0
    target = r.harmonies[0][2] if r.harmonies else 0
    ms = [m for m in r.measures if m.part == target]
    multi_staff = b'<staves>' in data
    divs = _divisions_by_measure(data, ms)
    edits = [(s, e, b'') for s, e, *_ in r.harmonies]  # drop every old symbol (and its line's indent)
    edits = [(_line_start(data, s), _eat_newline(data, e), b'') for s, e, _ in edits]
    for c in found:
        mi = bar_of(bars, c.at)
        if mi >= len(ms): continue
        m = ms[mi]
        into = c.at - bars[mi].start
        pts = sorted(m.points, key=lambda p: p[1])
        exact = [p for p in pts if abs(p[0] - into) < 1e-6 and not p[2]]
        if exact:
            at, off = exact[0][1], None
        else:
            before = [p for p in pts if p[0] < into and not p[2]]
            if before:
                p = max(before, key=lambda p: (p[0], -p[1]))
                at, off = p[1], round((into - p[0]) * divs[mi])
            else:
                at, off = m.end_byte, None
        at = _line_start(data, at)
        indent = data[at:_skip_ws(data, at)].decode()
        x = indent + harmony_xml(c, fifths, staff=1 if multi_staff else None, offset_div=off) + '\n'
        edits.append((at, at, x.encode()))
    return Rechorded(_apply(data, edits), old_chords(data, r), [(bar_of(bars, c.at) + 1, c.name) for c in found], found)


def _divisions_by_measure(data, ms):
    out, cur = [], 1.0
    for m in ms:
        seg = data[m.start_byte:m.end_byte]
        d = re.search(rb'<divisions>\s*([\d.]+)\s*</divisions>', seg)
        if d: cur = float(d[1])
        out.append(cur)
    return out


def _line_start(data, i):
    """Back up over the indentation before a tag, so a removed/inserted element keeps the layout."""
    j = i
    while j > 0 and data[j - 1:j] in (b' ', b'\t'): j -= 1
    return j if j == 0 or data[j - 1:j] == b'\n' else i


def _skip_ws(data, i):
    while i < len(data) and data[i:i + 1] in (b' ', b'\t'): i += 1
    return i


def _eat_newline(data, e):
    return e + 1 if data[e:e + 1] == b'\n' else e


def _apply(data, edits):
    edits.sort(key=lambda e: (e[0], e[1]))
    out, last = [], 0
    for s, e, x in edits:
        if s < last: s = last  # overlaps (never expected) keep the earlier edit
        out.append(data[last:s])
        out.append(x)
        last = max(last, e)
    out.append(data[last:])
    return b''.join(out)
