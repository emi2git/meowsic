"""omr/omr.py: every bar of a read sheet adds up to its time signature; words on the notes are kept."""
import importlib.util
from pathlib import Path

import music21 as m21

spec = importlib.util.spec_from_file_location('omr_main', Path(__file__).resolve().parents[2] / 'omr' / 'omr.py')
omr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omr)


def score(*bars, ts='4/4'):
    """bars: lists of (pitch or 'r', quarters, lyric or None)."""
    p = m21.stream.Part()
    for k, notes in enumerate(bars):
        m = m21.stream.Measure(number=k + 1)
        if k == 0: m.insert(0, m21.meter.TimeSignature(ts))
        for name, ql, word in notes:
            n = m21.note.Rest(quarterLength=ql) if name == 'r' else m21.note.Note(name, quarterLength=ql)
            if word: n.lyric = word
            m.append(n)
        p.append(m)
    s = m21.stream.Score(); s.insert(0, p)
    return s


def lyrics(s):
    return [n.lyric for n in s.recurse().notes if n.lyric]


def test_short_long_empty_and_pickup_bars_are_filled():
    s = score([('G4', 1, 'a')],                                       # pickup: 1 beat
              [('C4', 1, 'b'), ('D4', 1, 'c'), ('E4', 1, None)],       # 3 beats: rest added
              [('C4', 2, 'd'), ('E4', 1, None)],                       # last note missing its dot
              [('C4', 2, 'e'), ('D4', 2, None), ('E4', 1, None)],      # 5 beats: too long
              [])                                                      # empty
    assert len(omr.bars_full(s)) == 5
    fixes = omr.fill_bars(s)
    assert omr.bars_full(s) == []
    assert [f['bar'] for f in fixes] == [1, 2, 3, 4, 5]
    first = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    assert [type(n).__name__ for n in first.notesAndRests] == ['Rest', 'Note']  # tune still ends on the bar line
    assert lyrics(s) == ['a', 'b', 'c', 'd', 'e']


def test_too_long_bar_is_split_into_voices_no_note_dropped():
    # 3/4: a tune (3 beats) and an under-part (3 beats) read one after the other
    s = score([('F#5', 1.5, 'one'), ('G5', 0.5, None), ('A5', 1, None), ('C#5', 0.5, 'two'), ('A4', 0.5, None), ('F#4', 2, None)], ts='3/4')
    omr.fill_bars(s)
    assert omr.bars_full(s) == []
    assert len([n for n in s.recurse().notes]) == 6
    assert len(list(s.parts[0].getElementsByClass(m21.stream.Measure)[0].voices)) == 2
    assert sorted(lyrics(s)) == ['one', 'two']
    out = m21.converter.parseData(m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode(), format='musicxml')
    assert omr.bars_full(out) == [] and len(list(out.recurse().notes)) == 6  # survives writing MusicXML


def test_unsure_bars_are_kept_in_the_musicxml():
    rep = {'check': [{'page': 2, 'bar': 3, 'why': []}], 'filled': [{'part': 1, 'bar': 1, 'fix': 'pickup: 1-beat rest in front'},
           {'part': 1, 'bar': 5, 'fix': 'x'}], 'taken': [{'page': 1, 'bar': 2}]}
    bars = omr.unsure_bars(rep, [10, 8])
    assert bars == [2, 5, 13]
    x = omr.mark_unsure('<score-partwise><identification><encoding/></identification><part-list/></score-partwise>', bars)
    assert '<miscellaneous-field name="meowsic-check-bars">2 5 13</miscellaneous-field></miscellaneous></identification>' in x


def test_full_bars_untouched():
    s = score([('C4', 1, 'x'), ('D4', 1, None), ('E4', 2, None)], [('r', 4, None)])
    assert omr.fill_bars(s) == []


def test_three_four():
    s = score([('C4', 2, None)], [('C4', 2, None), ('D4', 2, None)], ts='3/4')
    omr.fill_bars(s)
    assert omr.bars_full(s) == []


def test_audiveris_reads_english_and_vietnamese_when_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(omr, 'TESSDATA', tmp_path)
    assert omr.audiveris_languages() == []
    (tmp_path / 'eng.traineddata').write_bytes(b'x')
    (tmp_path / 'vie.traineddata').write_bytes(b'x')
    assert omr.audiveris_languages()[-1].endswith('=eng+vie')


def test_notes_beside_voices_add_up_too():
    s = score([('C4', 4, None)])
    m = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    v = m21.stream.Voice(); v.append(m21.note.Note('E4', quarterLength=2)); m.insert(0, v)
    m.append(m21.note.Note('D4', quarterLength=1))  # bar itself: 5 beats; voice: 2
    omr.fill_bars(s)
    assert omr.bars_full(s) == []


def test_empty_bar_after_a_first_ending_is_dropped_printed_rest_kept():
    s = score([('C4', 4, None)], [('D4', 4, None)], [], [('r', 4, None)])  # bar 3: nothing printed; bar 4: a whole rest
    s.parts[0].getElementsByClass(m21.stream.Measure)[2].insert(0, m21.harmony.ChordSymbol('G7'))  # a chord name read there
    rep = {'check': [{'page': 1, 'bar': 4, 'why': []}], 'notes': []}
    omr.drop_empty_bars(s, 1, rep, {2})  # what empty_bars() finds in homr's file
    ms = list(s.parts[0].getElementsByClass(m21.stream.Measure))
    assert len(ms) == 3 and [n for n in ms[2].notesAndRests if n.isRest]
    assert ms[2].getElementsByClass(m21.harmony.ChordSymbol)[0].figure == 'G7'
    assert rep['check'][0]['bar'] == 3 and rep['dropped'] == [{'page': 1, 'bars': [3]}]


def test_missed_triplet_bracket_is_put_back():
    # Baby Mine bar 2: A half tied, then a quarter triplet A G F that was read as A quarter, G quarter, F eighth
    s = score([('A4', 2, 'mine'), ('A4', 1, None), ('G4', 1, 'don'), ('F4', 0.5, 'you')])
    fixes = omr.fill_bars(s)
    assert 'triplet' in fixes[0]['fix']
    ns = list(s.recurse().notes)
    assert [round(float(n.quarterLength), 4) for n in ns] == [2, 0.6667, 0.6667, 0.6667]
    assert lyrics(s) == ['mine', 'don', 'you']
    assert all(n.duration.tuplets for n in ns[1:]) and omr.bars_full(s) == []
    x = m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode()
    assert x.count('<time-modification>') == 3 and 'tuplet' in x


def test_empty_bars_found_in_homr_file(tmp_path):
    f = tmp_path / 'p.musicxml'
    f.write_text('<score-partwise><part id="P1"><measure number="1"><note><rest/><duration>4</duration></note></measure>'
                 '<measure number="2"><barline location="right"><ending type="stop" number="1"/></barline></measure>'
                 '<measure number="3"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>')
    assert omr.empty_bars(f) == {1}
