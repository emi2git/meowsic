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


def test_too_long_bar_keeps_the_words_of_a_dropped_note():
    s = score([('C4', 2, 'one'), ('D4', 2, None), ('E4', 2, 'two')])  # 6 beats in 4/4: last note goes
    omr.fill_bars(s)
    assert omr.bars_full(s) == []
    assert lyrics(s) == ['one', 'two']


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
