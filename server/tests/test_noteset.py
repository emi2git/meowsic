"""Edit notes, played on a MIDI keyboard (noteset.py, {op:'set'}): a note / chord / rest takes exactly the keys
played, spelled for the key, bars stay full, ties go along."""
import xml.etree.ElementTree as ET

from meowsic import staffmove as sm
from test_staffmove import LH, RH, chords, ev, full, music, refs, score


def _note(out, ref): return list(ET.fromstring(out.encode()).find('part').iter('note'))[ref]


def test_set_a_note_spelled_for_the_key():
    x = score(RH, LH)
    d5 = refs(x, lambda n: n['midi'] == 74 and n['bar'] == 0)
    out, t = sm.edit(x, {'op': 'set', 'refs': d5, 'midis': [70]})
    assert full(out) and (0, 1, 1.0, 1.0, 70) in music(out) and len(t) == 1
    n = _note(out, t[0])
    assert n.findtext('pitch/step') == 'B' and n.findtext('pitch/alter') == '-1'  # C major: B flat
    out, t = sm.edit(x, {'op': 'set', 'refs': d5, 'midis': [66]})
    n = _note(out, t[0])
    assert n.findtext('pitch/step') == 'F' and n.findtext('pitch/alter') == '1'
    flat = x.replace('<divisions>4</divisions>', '<divisions>4</divisions><key><fifths>-2</fifths></key>')
    out, t = sm.edit(flat, {'op': 'set', 'refs': d5, 'midis': [66]})
    n = _note(out, t[0])
    assert n.findtext('pitch/step') == 'G' and n.findtext('pitch/alter') == '-1'


def test_set_left_hand_and_chords():
    x = score(RH, LH)
    c3 = refs(x, lambda n: n['midi'] == 48)
    out, _ = sm.edit(x, {'op': 'set', 'refs': c3, 'midis': [45]})
    assert full(out) and (0, 2, 0.0, 2.0, 45) in music(out)
    # one note → a chord
    out, t = sm.edit(x, {'op': 'set', 'refs': c3, 'midis': [43, 47, 50]})
    assert full(out) and chords(out, 0, 2)[0] == (0.0, (43, 47, 50)) and len(t) == 3
    # a chord → one note (the chord's first note stays)
    ce = refs(x, lambda n: n['bar'] == 0 and n['staff'] == 1 and n['on'] == 0)
    out, t = sm.edit(x, {'op': 'set', 'refs': ce, 'midis': [79]})
    assert full(out) and chords(out, 0, 1)[0] == (0.0, (79,))


def test_set_a_rest_becomes_a_note_of_its_length():
    x = score([[ev('C5', 1), ev('R', 1), ev('E5', 2)]], [[ev('C3', 4, 2)]])
    r = [n['ref'] for n in sm.notes(ET.fromstring(x.encode())) if n.get('rest')]
    out, t = sm.edit(x, {'op': 'set', 'refs': r, 'midis': [74]})
    assert full(out) and (0, 1, 1.0, 1.0, 74) in music(out)
    out, t = sm.edit(x, {'op': 'set', 'refs': r, 'midis': [74, 77]})
    assert full(out) and (1.0, (74, 77)) in chords(out, 0, 1)


def test_set_keeps_ties_and_lyrics():
    rh = [[ev('C5', 2), ev('E5', 2)], [ev('E5', 4)]]
    x = score(rh, [[ev('C3', 4, 2)], [ev('C3', 4, 2)]])
    x = x.replace('<step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff>',
                  '<step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type><staff>1</staff><lyric><text>la</text></lyric>', 1)
    x, _ = sm.edit(x, {'op': 'tie', 'refs': refs(x, lambda n: n['midi'] == 76 and n['bar'] == 0)})
    assert '<tie type="start"' in x
    e5 = refs(x, lambda n: n['midi'] == 76 and n['bar'] == 0)
    out, _ = sm.edit(x, {'op': 'set', 'refs': e5, 'midis': [77]})
    assert (0, 1, 2.0, 2.0, 77) in music(out) and (1, 1, 0.0, 4.0, 77) in music(out)  # the tied note went along
    assert '<tie type="start"' in out
    c5 = refs(x, lambda n: n['midi'] == 72)
    out, _ = sm.edit(x, {'op': 'set', 'refs': c5, 'midis': [71]})
    assert '<text>la</text>' in out and (0, 1, 0.0, 2.0, 71) in music(out)
