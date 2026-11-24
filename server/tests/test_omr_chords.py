"""omr/omr.py: chord names printed above the staff — grammar + snapping of OCR misreads, the bar / beat they go on,
the ink groups read as names, the page's own letters, and a chord over a held note getting a note to sit on."""
import importlib.util
from pathlib import Path

import music21 as m21
import numpy as np
import pytest

spec = importlib.util.spec_from_file_location('omr_chords', Path(__file__).resolve().parents[2] / 'omr' / 'omr.py')
omr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omr)


@pytest.mark.parametrize('read, name', [
    ('C', 'C'), ('Em', 'Em'), ('Bb', 'Bb'), ('B♭', 'Bb'), ('86', 'Bb'), ('B5', 'Bb'), ('Bh', 'Bb'),
    ('Am?', 'Am7'), ('G1', 'G7'), ('Om', 'Dm'), ('c', 'C'), ('Ic', 'C'), (',Dm', 'Dm'), ('2.G7', 'G7'), ('(C)', 'C'),
    ('C/E', 'C/E'), ('Bb/D', 'Bb/D'), ('Dm/C', 'Dm/C'), ('Csus4', 'Csus4'), ('C7sus4', 'C7sus4'), ('Gsus2', 'Gsus2'),
    ('Fmaj7', 'Fmaj7'), ('FΔ7', 'Fmaj7'), ('CM7', 'Cmaj7'), ('Cm(maj7)', 'Cmmaj7'), ('C°7', 'Cdim7'), ('Cø7', 'Cm7b5'),
    ('C+', 'Caug'), ('G7(b9)', 'G7b9'), ('C6/9', 'C69'), ('F#m7', 'F#m7'), ('Bbm', 'Bbm'), ('Ebmaj7', 'Ebmaj7'),
    ('N.C.', 'N.C.'), ('N.C', 'N.C.'),
    # not chord names: words around the staff, lyrics, triplet / fingering numbers
    ('Moderately', None), ('Coda', None), ('To', None), ('D.C.', None), ('al', None), ('em', None), ('a', None),
    ('3', None), ('CODA', None), ('', None),
])
def test_chord_symbol_snaps_to_the_grammar(read, name):
    assert omr.chord_symbol(read) == name


def test_snapped_readings_are_marked():
    assert omr.chord_snap('Em') == ('Em', True)
    assert omr.chord_snap('2.G7') == ('G7', True)
    assert omr.chord_snap('Om') == ('Dm', False)
    assert omr.chord_snap('0')[1] is False


@pytest.mark.parametrize('name, root, kind', [
    ('Bb', 'B-', 'major'), ('Cm7b5', 'C', 'half-diminished-seventh'), ('Cmmaj7', 'C', 'minor-major-seventh'),
    ('Fmaj9', 'F', 'major-ninth'), ('Bb/D', 'B-', 'major'), ('G7', 'G', 'dominant-seventh'), ('C9sus4', 'C', 'suspended-fourth-seventh'),
])
def test_every_name_becomes_a_music21_chord(name, root, kind):
    cs = omr.chord_m21(name)
    assert cs.root().name == root and cs.chordKind == kind and not cs.writeAsChord


def test_beat_of_a_chord_over_notes():
    gap = 15
    # Bb … G7 over one whole note (Beauty and the Beast, last bar of the line): G7 is on beat 3, not on the note
    whole = [(1242, 0.0)]
    assert omr.chord_beat(1240, whole, 1370, 4.0, 1.0, gap) == 0.0
    assert omr.chord_beat(1312, whole, 1370, 4.0, 1.0, gap, taken={0.0}) == 2.0
    # a chord printed a little left of its note goes on that note (Close To You: E over the eighth on beat 4)
    ons = [(1187, 0.0), (1320, 3.0), (1373, 3.5)]
    assert omr.chord_beat(1280, ons, 1410, 4.0, 1.0, 24.6) == 3.0
    # a note placed oddly far left by the note reader: the chord stays on the bar's first beat (half-bar grid)
    ons = [(1060, 0.0), (1221, 1.5), (1276, 2.0), (1340, 3.0)]
    assert omr.chord_beat(1145, ons, 1420, 4.0, 1.0, 14) == 0.0
    # 3/4: a beat grid
    assert omr.chord_beat(200, [(100, 0.0)], 250, 3.0, 1.0, 10) == 2.0


def _text(strip_words, h=40, w=900):
    """A white strip with black words at x (PIL default font scaled up)."""
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new('L', (w, h * 3), 255)
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=h)
    for x, y, t in strip_words: d.text((x, y), t, fill=0, font=font)
    return im


def test_chord_tokens_one_group_per_name_dots_kept_lines_and_edges_left_out():
    from PIL import ImageDraw
    im = _text([(20, 40, 'C'), (200, 40, 'Em'), (400, 40, 'N.C.'), (600, 40, 'G7')])
    d = ImageDraw.Draw(im)
    d.line((700, 110, 880, 110), fill=0, width=2)    # a long thin line (slur / bracket)
    d.line((850, 60, 850, im.height), fill=0, width=3)  # a stem cut by the strip's edge
    toks = omr.chord_tokens(im, gap=20)
    xs = [t['x0'] for t in toks]
    assert len(toks) == 4 and xs == sorted(xs)
    assert all(t['x0'] < 840 for t in toks)
    nc = next(t for t in toks if 390 <= t['x0'] <= 420)
    assert len(nc['comps']) >= 4  # N . C . in one group


def test_page_font_reads_a_lone_letter_from_names_read_before():
    im = _text([(20, 40, 'C'), (200, 40, 'G'), (400, 40, 'F'), (600, 40, 'G')])
    toks = omr.chord_tokens(im, gap=20)
    font = omr._PageFont()
    for t, n in zip(toks[:3], ['C', 'G', 'F']): font.learn(t, n)
    name, sure = font.read(toks[3])
    assert name == 'G' and sure > 0.6


def test_a_chord_over_a_held_note_splits_it_tied():
    p = m21.stream.Part()
    m = m21.stream.Measure(number=1)
    m.insert(0, m21.meter.TimeSignature('4/4'))
    n = m21.note.Note('D5', quarterLength=4); n.lyric = 'rise'
    m.insert(0, n)
    m.insert(0, omr.chord_m21('Bb')); m.insert(2, omr.chord_m21('G7'))
    p.append(m)
    s = m21.stream.Score(); s.insert(0, p)
    done = omr.chords_on_notes(s)
    assert done == [{'bar': 1, 'beat': 3.0, 'chord': 'G7'}]
    notes = list(m.notes.getElementsNotOfClass(m21.harmony.ChordSymbol))
    assert [float(x.offset) for x in notes] == [0.0, 2.0] and [x.quarterLength for x in notes] == [2.0, 2.0]
    assert notes[0].tie.type == 'start' and notes[1].tie.type == 'stop'
    assert notes[0].lyric == 'rise' and not notes[1].lyrics
    assert omr.chords_on_notes(s) == []  # nothing left to split
