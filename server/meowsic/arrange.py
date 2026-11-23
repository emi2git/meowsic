"""Rule-based piano versions of a score (no AI): read the tune and the chords, then write them out again.

lead    melody + chord symbols
vocal   melody staff above a piano accompaniment
accomp  piano accompaniment only
easy    melody + left hand on chord roots, long values (old; no longer offered)
clear   the original's two hands as written, but one note at a time: right hand keeps the top
        (melody) note of each chord, left hand the bottom (bass) note; extra voices in a staff go
pro     melody with chord tones under it + broken-chord left hand
duet    primo (melody an octave up) + secondo (the accompaniment)
"""
import copy
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

VERSION_TAGS = {'original': 'Original', 'vocal': 'Piano + vocals', 'lead': 'Lead sheet', 'duet': 'Piano duet',
                'accomp': 'Piano accompaniment', 'clear': 'Piano clear', 'easy': 'Piano easy', 'pro': 'Piano pro'}
ARRANGED = ('lead', 'vocal', 'accomp', 'clear', 'pro', 'duet')
MSCORE = '/Applications/MuseScore 4.app/Contents/MacOS/mscore'
MELODY_NAMES = ('voice', 'melody', 'vocal', 'vocals', 'lead', 'soprano')


def _q(x) -> Fraction:
    """Snap to the nearest 16th or 8th-triplet position."""
    x = Fraction(x).limit_denominator(96)
    return min((Fraction(round(x * d), d) for d in (4, 3)), key=lambda v: abs(v - x))


def place(pc: int, lo: int) -> int:
    """MIDI pitch of pitch class `pc` at or just above `lo`."""
    return lo + (pc - lo) % 12


# ---------- reading ----------

class Tune:
    """What a score boils down to: melody events, chord spans and the bar grid."""

    def __init__(self, sc):
        from music21 import harmony, meter, key, tempo, stream
        self.title = (sc.metadata.title if sc.metadata and sc.metadata.title else '') or ''
        parts = list(sc.parts)
        if not parts: raise ValueError('The score has no parts')
        first = parts[0]
        self.bars = [(Fraction(m.offset).limit_denominator(96), Fraction(m.duration.quarterLength).limit_denominator(96))
                     for m in first.getElementsByClass(stream.Measure)]
        if not self.bars: raise ValueError('The score has no measures')
        flat0 = first.flatten()
        self.times = [(Fraction(t.offset).limit_denominator(96), t.ratioString) for t in flat0.getElementsByClass(meter.TimeSignature)] or [(Fraction(0), '4/4')]
        self.keys = [(Fraction(k.offset).limit_denominator(96), k.sharps) for k in flat0.getElementsByClass(key.KeySignature)] or [(Fraction(0), 0)]
        self.tempos = [(Fraction(t.offset).limit_denominator(96), t.number, t.referent.quarterLength)
                       for t in sc.flatten().getElementsByClass(tempo.MetronomeMark) if t.number]
        # a pickup bar: shift everything so it fills a whole bar (bars stay full)
        full = Fraction(meter.TimeSignature(self.times[0][1]).barDuration.quarterLength).limit_denominator(96)
        self.shift = full - self.bars[0][1] if len(self.bars) > 1 and self.bars[0][1] < full else Fraction(0)
        self.total = self.bars[-1][0] + self.bars[-1][1] + self.shift

        mp = self._melody_part(parts)
        self.melody_name = mp.partName or ''
        self.melody = self._melody(mp)
        self.chords = self._chords(sc, harmony)

    @staticmethod
    def _melody_part(parts):
        for p in parts:
            if (p.partName or '').strip().lower() in MELODY_NAMES: return p
        for p in parts:
            if any(n.lyrics for n in p.flatten().notes): return p
        return parts[0]

    def _melody(self, part):
        """Top line, monophonic: (offset, length, midi, lyric), ties merged, overlaps cut, on a 16th/triplet grid."""
        raw = []
        for n in part.flatten().notes:
            if n.duration.isGrace or not n.quarterLength: continue
            top = max(n.pitches, key=lambda p: p.midi)
            raw.append([Fraction(n.offset).limit_denominator(96) + self.shift, Fraction(n.quarterLength).limit_denominator(96),
                        top.midi, n.lyric, n.tie.type if n.tie else None])
        raw.sort(key=lambda e: (e[0], -e[2]))
        ev = []
        for o, d, p, ly, tie in raw:
            if ev and ev[-1][0] == o: continue  # same onset: the highest note is the tune
            if ev and tie in ('stop', 'continue') and ev[-1][2] == p and ev[-1][0] + ev[-1][1] == o:
                ev[-1][1] += d
                continue
            ev.append([o, d, p, ly])
        out = []
        for o, d, p, ly in ev:
            o, end = _q(o), _q(o + d)
            if out and out[-1][0] + out[-1][1] > o: out[-1][1] = o - out[-1][0]
            if out and out[-1][1] <= 0: out.pop()
            if end <= o: end = o + Fraction(1, 4)
            out.append([o, end - o, p, ly])
        return [tuple(e) for e in out if e[1] > 0]

    def _chords(self, sc, harmony):
        """Chord spans (start, end, root pc, [pcs from the root up], figure, bass pc). From the chord symbols, else guessed per half bar."""
        syms = []
        for cs in sc.flatten().getElementsByClass(harmony.ChordSymbol):
            if isinstance(cs, harmony.NoChord) or not cs.pitches: continue
            o = _q(Fraction(cs.offset).limit_denominator(96) + self.shift)
            r, b = cs.root().pitchClass, cs.bass().pitchClass
            pcs = [pc for pc in dict.fromkeys(p.pitchClass for p in cs.pitches) if pc != b or b == r]
            pcs = sorted(pcs, key=lambda pc: (pc - r) % 12)  # root, third, fifth, seventh...
            if syms and syms[-1][0] == o: syms.pop()
            syms.append((o, r, pcs, cs.figure, b))
        if not syms: syms = self._guess_chords(sc)
        spans = []
        for i, (o, r, pcs, fig, b) in enumerate(syms):
            end = syms[i + 1][0] if i + 1 < len(syms) else self.total
            if end > o: spans.append((o, end, r, pcs, fig, b))
        return spans

    def _guess_chords(self, sc):
        """Best major/minor triad for each half bar, by note length (bass notes count double)."""
        notes = [(Fraction(n.offset).limit_denominator(96) + self.shift, Fraction(n.quarterLength).limit_denominator(96), p.midi)
                 for n in sc.flatten().notes for p in n.pitches if n.quarterLength]
        names = ['C', 'C#', 'D', 'E-', 'E', 'F', 'F#', 'G', 'A-', 'A', 'B-', 'B']
        out, last = [], None
        for bo, bl in self.bars:
            bo += self.shift
            halves = [(bo, bl / 2), (bo + bl / 2, bl / 2)] if bl >= 4 else [(bo, bl)]
            for so, sl in halves:
                w = [0.0] * 12
                inside = [(max(o, so), min(o + d, so + sl), p) for o, d, p in notes if o < so + sl and o + d > so]
                if not inside: continue
                low = min(p for _, _, p in inside)
                for a, b, p in inside: w[p % 12] += float(b - a) * (2 if p == low else 1)
                best = max(((sum(w[(r + i) % 12] for i in (0, iv, 7)) - 0.3 * sum(w) + 0.2 * w[r], r, iv)
                            for r in range(12) for iv in (4, 3)))
                _, r, iv = best
                key_ = (r, iv)
                if key_ == last: continue
                last = key_
                out.append((so, r, [r, (r + iv) % 12, (r + 7) % 12], names[r].replace('-', 'b') + ('m' if iv == 3 else ''), r))
        return out

    def chord_at(self, t):
        for s in self.chords:
            if s[0] <= t < s[1]: return s
        return None

    def beat(self, t) -> Fraction:
        from music21 import meter
        ts = [r for o, r in self.times if o <= t - self.shift] or [self.times[0][1]]
        return Fraction(meter.TimeSignature(ts[-1]).beatDuration.quarterLength).limit_denominator(96)

    def bar_starts(self):
        return [Fraction(0)] + [o + self.shift for o, _ in self.bars[1:]] + [self.total]


# ---------- writing patterns: lists of (offset, length, [midi], lyric) ----------

def segments(t: Tune, span_lo, span_hi, step=None):
    """Cut [lo, hi) at bar lines (and every `step` beats when given)."""
    cuts = sorted({span_lo, span_hi, *[b for b in t.bar_starts() if span_lo < b < span_hi]})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if step:
            x = a
            while x < b:
                n = min(b, x + t.beat(x) * step if step else b)
                out.append((x, n - x))
                x = n
        else:
            out.append((a, b - a))
    return out


def melody_events(t: Tune, up=0, lyrics=True):
    return [(o, d, [min(p + up, 103)], ly if lyrics else None) for o, d, p, ly in t.melody]


def bass_events(t: Tune, lo=40):
    """Chord bass (the root, or the slash note) per chord span, cut at bar lines."""
    return [(a, d, [place(b, lo)], None) for s, e, r, pcs, _, b in t.chords for a, d in segments(t, s, e)]


def block_chords(t: Tune, lo=55):
    """Right hand: the chord on every beat, closed position from `lo` up."""
    ev = []
    for s, e, r, pcs, _, b in t.chords:
        voicing = sorted({place(pc, lo) for pc in pcs[:3]})
        ev += [(a, d, voicing, None) for a, d in segments(t, s, e, step=1)]
    return ev


def broken_chords(t: Tune, lo=36):
    """Left hand: root, fifth, octave, third (tenth) in eighths."""
    ev = []
    for s, e, r, pcs, _, b in t.chords:
        root = place(b, lo)
        third = next((pc for pc in pcs if (pc - r) % 12 in (3, 4, 5, 2)), (r + 4) % 12)
        fifth = next((pc for pc in pcs if (pc - r) % 12 in (6, 7, 8)), (r + 7) % 12)
        cyc = [root, place(fifth, root + 1), place(r, root + 12), place(third, root + 12)]
        k = 0
        for a, d in segments(t, s, e):
            x = a
            while x < a + d:
                n = min(a + d, x + Fraction(1, 2))
                ev.append((x, n - x, [cyc[k % 4]], None))
                k += 1
                x = n
    return ev


def fuller_melody(t: Tune):
    """Melody with up to two chord tones under each note (within the octave below)."""
    ev = []
    for o, d, p, ly in t.melody:
        c = t.chord_at(o)
        ps = [p]
        if c and d >= Fraction(1, 2):
            under = sorted({p - ((p - pc) % 12) for pc in c[3] if (p - pc) % 12 not in (0, 1, 2)}, reverse=True)
            ps = sorted([x for x in under if x >= 52][:2] + [p])
        ev.append((o, d, ps, ly))
    return ev


# ---------- building music21 parts ----------

def spell(midi: int, sharps: int):
    """Pitch with flats in flat keys and sharps in sharp keys."""
    from music21 import pitch
    p = pitch.Pitch(midi)
    alter = p.accidental.alter if p.accidental else 0
    if (sharps < 0 and alter > 0) or (sharps > 0 and alter < 0):
        p = p.getEnharmonic()
    if p.accidental is not None and p.accidental.alter == 0:
        p.accidental = None
    return p


def build_part(t: Tune, events, name, clef_name, cls='Part', chords=False, marks=False, voice=False):
    from music21 import stream, note, chord, clef, meter, key, tempo, instrument, harmony
    from music21.stream.makeNotation import makeAccidentalsInMeasureStream
    p = getattr(stream, cls)()
    p.partName = name
    p.insert(0, instrument.Vocalist() if voice else instrument.Piano())
    p.insert(0, {'treble': clef.TrebleClef, 'bass': clef.BassClef, 'treble8vb': clef.Treble8vbClef}[clef_name]())
    for o, r in t.times: p.insert(float(o + (t.shift if o else 0)), meter.TimeSignature(r))
    for o, s in t.keys: p.insert(float(o + (t.shift if o else 0)), key.KeySignature(s))
    if marks:
        for o, n, ref in t.tempos:
            p.insert(float(o + (t.shift if o else 0)), tempo.MetronomeMark(number=n, referent=ref))
    end = Fraction(0)
    for o, d, ps, ly in sorted(events, key=lambda e: e[0]):
        if o < end: continue  # never overlap within one staff
        if o > end:
            p.insert(float(end), note.Rest(quarterLength=float(o - end)))
        sharps = ([s_ for k_, s_ in t.keys if k_ + (t.shift if k_ else 0) <= o] or [0])[-1]
        sp = [spell(x, sharps) for x in ps]
        n = note.Note(sp[0]) if len(sp) == 1 else chord.Chord(sp)
        n.quarterLength = float(d)
        if ly: n.lyric = ly
        p.insert(float(o), n)
        end = o + d
    if end < t.total:
        p.insert(float(end), note.Rest(quarterLength=float(t.total - end)))
    if chords:
        for s, _, _, _, fig, _ in t.chords:
            try: cs = harmony.ChordSymbol(fig)
            except Exception: continue
            cs.quarterLength = 0
            p.insert(float(s), cs)
    p.makeMeasures(inPlace=True)
    p.makeTies(inPlace=True)
    makeAccidentalsInMeasureStream(p, useKeySignature=True)
    for m in p.getElementsByClass(stream.Measure):
        m.makeBeams(inPlace=True) if m.notes else None
    return p


def read(src_xml) -> Tune:
    from music21 import converter
    return Tune(converter.parse(str(src_xml)))


def arrange(src, version: str, title=None, artist=''):
    """music21 Score for one version of `src` (a MusicXML path or a Tune from read())."""
    from music21 import stream, metadata, layout
    if version not in ARRANGED: raise ValueError(f'Cannot arrange version {version!r}')
    t = src if isinstance(src, Tune) else read(src)
    if not t.melody: raise ValueError('No melody found in the score')
    if not t.chords and version != 'lead': raise ValueError('No chords found in the score')
    sc = stream.Score()
    sc.insert(0, metadata.Metadata(title=title or t.title, composer=artist or ''))
    low_voice = sum(p for _, _, p, _ in t.melody) / len(t.melody) < 60
    mel_clef = 'treble8vb' if low_voice else 'treble'
    parts, piano = [], []

    def piano_pair(rh, lh, name='Piano'):
        a = build_part(t, rh, name, 'treble', 'PartStaff', chords=not parts, marks=not parts)
        b = build_part(t, lh, name, 'bass', 'PartStaff')
        sc.insert(0, layout.StaffGroup([a, b], name=name, symbol='brace', barTogether=True))
        return [a, b]

    if version == 'lead':
        parts = [build_part(t, melody_events(t), 'Melody', mel_clef, chords=True, marks=True)]
    elif version == 'vocal':
        parts = [build_part(t, melody_events(t), 'Voice', mel_clef, chords=True, marks=True, voice=True)]
        parts += piano_pair(block_chords(t), bass_events(t))
    elif version == 'accomp':
        parts = piano_pair(block_chords(t), bass_events(t))
    elif version == 'easy':
        parts = piano_pair(melody_events(t, up=12 if low_voice else 0), bass_events(t, lo=48))
    elif version == 'pro':
        parts = piano_pair(fuller_melody(t) if not low_voice else
                           [(o, d, [x + 12 for x in ps], ly) for o, d, ps, ly in fuller_melody(t)], broken_chords(t))
    elif version == 'duet':
        parts = [build_part(t, melody_events(t, up=12), 'Primo', 'treble', chords=True, marks=True)]
        parts += piano_pair(block_chords(t, lo=52), bass_events(t, lo=36), name='Secondo')
    for p in parts: sc.insert(0, p)
    return sc


def clear(src_xml, title=None, artist=''):
    """'Piano clear': the score as written, one note at a time per hand. Right hand (and any single
    staff) keeps the top note of each chord, left hand (a bass-clef staff, or the lower staff of a
    pair) the bottom one; a staff with several voices keeps its first voice. Rhythm, ties, lyrics,
    chord symbols, dynamics and bars stay as they are."""
    from music21 import converter, chord, note, stream, clef, metadata
    sc = converter.parse(str(src_xml))
    sc.metadata = sc.metadata or metadata.Metadata()
    if title: sc.metadata.title = title
    if artist is not None: sc.metadata.composer = artist
    parts = list(sc.parts)
    if not parts: raise ValueError('The score has no parts')
    for i, part in enumerate(parts):
        first = part.recurse().getElementsByClass(clef.Clef).first()
        lower = isinstance(first, clef.BassClef) or (
            type(part).__name__ == 'PartStaff' and i > 0 and type(parts[i - 1]).__name__ == 'PartStaff' and _same_group(sc, parts[i - 1], part))
        for m in part.getElementsByClass(stream.Measure):
            vs = list(m.voices)
            if len(vs) > 1:  # keep the first voice: the main line of that hand
                keep = vs[0]
                for v in vs[1:]: m.remove(v)
                for el in list(keep): m.insert(keep.elementOffset(el) + keep.offset, el)
                m.remove(keep)
            for c in list(m.recurse().getElementsByClass(chord.Chord)):
                if type(c).__name__ != 'Chord' or len(c.pitches) < 2: continue  # ChordSymbol subclasses Chord
                ps = sorted(c.notes, key=lambda n: n.pitch.ps)
                main = ps[0] if lower else ps[-1]
                n = note.Note(main.pitch, quarterLength=c.quarterLength)
                n.duration = c.duration
                if c.tie is not None or main.tie is not None: n.tie = main.tie or c.tie
                for attr in ('lyrics', 'articulations', 'expressions'):
                    setattr(n, attr, list(getattr(c, attr)))
                n.stemDirection = 'unspecified'
                if c.beams: n.beams = c.beams
                n.volume.velocity = c.volume.velocity
                c.activeSite.replace(c, n)
    return sc


def _same_group(sc, a, b) -> bool:
    """Both staves belong to one brace (a piano's two hands)."""
    from music21 import layout
    for g in sc.recurse().getElementsByClass(layout.StaffGroup):
        sp = g.getSpannedElements()
        if a in sp and b in sp: return True
    return not list(sc.recurse().getElementsByClass(layout.StaffGroup))  # no groups written: treat a PartStaff pair as one piano


def write_files(sc, xml: Path, mid: Path):
    """MusicXML as is; MIDI without chord symbols (they would sound)."""
    from music21 import harmony
    sc.write('musicxml', fp=str(xml))
    m = copy.deepcopy(sc)
    for cs in list(m.recurse().getElementsByClass(harmony.ChordSymbol)):
        cs.activeSite.remove(cs)
    m.write('midi', fp=str(mid))


def render_pdf(xml: Path, pdf: Path, timeout=300) -> bool:
    """PDF with MuseScore when it is installed; False when it is not or it fails."""
    exe = MSCORE if Path(MSCORE).exists() else shutil.which('mscore')
    if not exe: return False
    try:
        subprocess.run([exe, '-o', str(pdf), str(xml)], capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return pdf.is_file()


def key_name(xml) -> str:
    """'Bb major' from the score's first key signature (mode guessed by music21)."""
    from music21 import converter
    try:
        k = converter.parse(str(xml)).analyze('key')
        return f'{k.tonic.name.replace("-", "b")} {k.mode}'
    except Exception:
        return ''
