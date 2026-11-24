"""Edit notes chord names (chordops.py, chordname.py): write / change / take away a chord name at a beat (the chord
grammar of omr.py), and Realize to left hand — block chords, root–fifth, broken chords — over a window, written over
the left hand only, chord names kept; through the preview and the ukulele panel's chord list."""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi import HTTPException

from meowsic import chordname, chordops, scorechords
from meowsic import staffmove as sm
from test_barops import bars
from test_staffmove import ev, score


def root(text): return ET.fromstring(text.encode())
def op(x, **o): return sm.edit_ex(x, o)
def notes(text): return sm.notes(root(text))
def lh(text, bar): return [(n['on'], n['dur'], n['midi']) for n in notes(text) if n['bar'] == bar and n['staff'] == 2 and not n.get('rest')]


def tune():
    rh = [[ev('E5', 2), ev('G5', 2)], [ev('F5', 4)], [ev('E5', 4)]]
    return score(rh, [[ev('C3', 4, 2)], [ev('C3', 4, 2)], [ev('C3', 4, 2)]])


def test_the_grammar_is_omrs():
    src = (Path(__file__).resolve().parents[2] / 'omr' / 'omr.py').read_text()
    grab = lambda s: re.search(r'_CHORD_RE = .*?compile\(r"""(.*?)"""', s, re.S).group(1)
    assert grab(src) == grab((Path(chordname.__file__)).read_text())
    for t, want in [('Bbm7', 'Bbm7'), ('C/E', 'C/E'), ('Cmaj7', 'Cmaj7'), ('CM', 'C'), ('Csus4', 'Csus4'), ('NC', 'N.C.'),
                    ('C♯m', 'C#m'), ('Hm', None), ('C5', None), ('hello', None), ('G7(b9)', 'G7b9')]:
        assert chordname.parse(t) == want, t


def test_harmony_round_trip_and_tones():
    for name in ['C', 'Am7', 'F/A', 'Bb7sus4', 'Ebmaj7', 'F#m7b5', 'G7b9', 'Cdim7', 'D6', 'N.C.']:
        h = chordname.harmony(name)
        assert chordname.name_of(h) == name, name
    assert chordname.tones('Am7') == (9, [0, 3, 7, 10], 9)
    assert chordname.tones('C/E') == (0, [0, 4, 7], 4)
    assert chordname.tones('N.C.') is None


def test_write_change_and_take_away_a_chord_name():
    x = tune()
    out, _, _ = op(x, op='chord', bar=0, on=0, text='C')
    assert [n for _, n in chordops.chords_in(root(out).find('part'))] == ['C'] and bars(out)
    out, _, _ = op(out, op='chord', bar=0, on=1, text='Am7')  # in the middle of the E5 half note
    cs = chordops.chords_in(root(out).find('part'))
    assert [(float(t), n) for t, n in cs] == [(0.0, 'C'), (1.0, 'Am7')] and bars(out)
    assert scorechords.chords_of(out.encode())[0] == ['C', 'Am7']  # the ukulele panel's chord list reads them
    out, _, _ = op(out, op='chord', bar=0, on=0, text='F')
    assert [n for _, n in chordops.chords_in(root(out).find('part'))] == ['F', 'Am7']
    out, _, _ = op(out, op='chord', bar=0, on=1, text='')
    assert [n for _, n in chordops.chords_in(root(out).find('part'))] == ['F']
    with pytest.raises(HTTPException) as e: op(out, op='chord', bar=0, on=0, text='Hmm7')
    assert 'not a chord name' in e.value.detail
    with pytest.raises(HTTPException): op(out, op='chord', bar=1, on=0, text='')


def with_chords(x, cs):
    for bar, on, t in cs: x, _, _ = op(x, op='chord', bar=bar, on=on, text=t)
    return x


def test_realize_block_chords():
    x = with_chords(tune(), [(0, 0, 'C'), (0, 2, 'G7'), (1, 0, 'F/A')])
    out, refs, _ = op(x, op='realize', pattern='block')
    assert bars(out) and refs
    assert lh(out, 0) == [(0.0, 2.0, 48), (0.0, 2.0, 52), (0.0, 2.0, 55), (2.0, 2.0, 43), (2.0, 2.0, 47), (2.0, 2.0, 50), (2.0, 2.0, 53)]
    assert {m for _, _, m in lh(out, 1)} == {45, 48, 53}  # F/A: A in the bass
    assert {m for _, _, m in lh(out, 2)} == {45, 48, 53}  # the chord goes on into bar 3
    rh = lambda t: [(n['bar'], n['on'], n['midi']) for n in notes(t) if n['staff'] == 1 and not n.get('rest')]
    assert rh(out) == rh(x)
    assert [n for _, n in chordops.chords_in(root(out).find('part'))] == ['C', 'G7', 'F/A']


def test_realize_root_fifth_and_broken_over_a_window():
    x = with_chords(tune(), [(0, 0, 'C'), (1, 0, 'Am')])
    out, _, _ = op(x, op='realize', pattern='root5', start=[0, 0], end=[1, 0])
    assert lh(out, 0) == [(0.0, 1.0, 48), (1.0, 1.0, 55), (2.0, 1.0, 48), (3.0, 1.0, 55)] and bars(out)
    assert lh(out, 1) == lh(x, 1)  # outside the window: as it was
    out, _, _ = op(x, op='realize', pattern='broken', start=[1, 0], end=[2, 0])
    assert [m for _, _, m in lh(out, 1)] == [45, 52, 60, 52] * 2 and all(d == 0.5 for _, d, _ in lh(out, 1)) and bars(out)


def test_realize_on_a_one_staff_melody_adds_the_left_hand():
    from test_barops import one_staff
    x = with_chords(one_staff(), [(0, 0, 'C')])
    info = {}
    out, _, _ = sm.edit_ex(x, {'op': 'realize', 'pattern': 'block'}, info)
    assert '<staves>2</staves>' in out and lh(out, 0) and any('left-hand staff' in s for s in info['said'])


def test_realize_needs_chords():
    with pytest.raises(HTTPException): op(tune(), op='realize', pattern='block')
    with pytest.raises(HTTPException): op(with_chords(tune(), [(0, 0, 'C')]), op='realize', pattern='waltz')


def test_through_the_preview(client):
    x = tune()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Chords', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'chord', 'bar': 0, 'on': 0, 'text': 'C'}, {'op': 'chord', 'bar': 1, 'on': 0, 'text': 'Dm7'}, {'op': 'realize', 'pattern': 'broken'}]
    pv = client.post(f'{url}/preview', json={'ops': ops}).json()
    assert not pv['incomplete'] and pv['moved']
    assert client.post(url, json={'ops': ops, 'mode': 'this'}).json()['ok']
    assert client.get(f'/api/items/{it["id"]}/score-chords').json()['chords'] == ['C', 'Dm7']
