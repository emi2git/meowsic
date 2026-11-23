"""'Piano clear': both hands stay, chords become their main note (RH top, LH bottom), bars stay full."""
import pytest
music21 = pytest.importorskip('music21')
from music21 import chord, clef, converter, layout, meter, note, stream, harmony
from meowsic import arrange


def piano(tmp_path):
    rh, lh = stream.PartStaff(), stream.PartStaff()
    m1 = stream.Measure(number=1); m1.append([clef.TrebleClef(), meter.TimeSignature('4/4')])
    m1.insert(0, harmony.ChordSymbol('C'))
    c = chord.Chord(['E4', 'G4', 'C5'], quarterLength=2); c.addLyric('la')
    m1.append([c, note.Note('D5', quarterLength=1), chord.Chord(['F4', 'A4'], quarterLength=1)])
    m2 = stream.Measure(number=2)  # two voices in the right hand
    v1, v2 = stream.Voice(id='1'), stream.Voice(id='2')
    v1.append(note.Note('E5', quarterLength=4)); v2.append([note.Note('C4', quarterLength=2), note.Note('B3', quarterLength=2)])
    m2.insert(0, v1); m2.insert(0, v2)
    rh.append([m1, m2])
    l1 = stream.Measure(number=1); l1.append([clef.BassClef(), meter.TimeSignature('4/4'), chord.Chord(['C3', 'G3', 'E4'], quarterLength=4)])
    l2 = stream.Measure(number=2); l2.append(chord.Chord(['G2', 'D3'], quarterLength=4))
    lh.append([l1, l2])
    sc = stream.Score(); sc.insert(0, rh); sc.insert(0, lh)
    sc.insert(0, layout.StaffGroup([rh, lh], name='Piano', symbol='brace'))
    p = tmp_path / 'in.musicxml'; sc.write('musicxml', fp=str(p)); return p


def notes(part):
    return [[n.nameWithOctave for n in m.recurse().notes if not isinstance(n, harmony.ChordSymbol)] for m in part.getElementsByClass(stream.Measure)]


def test_clear(tmp_path):
    sc = arrange.clear(piano(tmp_path), title='Song', artist='Me')
    out = tmp_path / 'clear.musicxml'; arrange.write_files(sc, out, tmp_path / 'clear.mid')
    back = converter.parse(str(out))
    rh, lh = back.parts
    assert notes(rh) == [['C5', 'D5', 'A4'], ['E5']]       # top notes; the second voice is gone
    assert notes(lh) == [['C3'], ['G2']]                   # bottom notes
    assert not any(isinstance(x, chord.Chord) and not isinstance(x, harmony.ChordSymbol) for x in back.recurse().notes)
    for p in back.parts:                                    # every bar still adds up to 4 beats
        for m in p.getElementsByClass(stream.Measure):
            assert m.duration.quarterLength == 4
    assert [h.figure for h in back.recurse().getElementsByClass(harmony.ChordSymbol)] == ['C']
    assert rh.recurse().getElementsByClass(note.Note)[0].lyric == 'la'
    assert back.metadata.title == 'Song'
    assert (tmp_path / 'clear.mid').stat().st_size > 0
