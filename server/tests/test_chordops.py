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


def test_sus_spellings_play_no_third_and_keep_their_text():
    """A bare "sus" is sus4 (Csus = C F G, not a C major triad); the kind says suspended-*, the other tones are
    degrees (MuseScore's spelling), and the printed text stays as typed."""
    def deg(h): return [(int(d.findtext('degree-value')), int(d.findtext('degree-alter')), d.findtext('degree-type')) for d in h.findall('degree')]
    for typed, text, kind, iv, degrees in [
            ('Csus', 'sus', 'suspended-fourth', [0, 5, 7], []),
            ('Csus4', 'sus4', 'suspended-fourth', [0, 5, 7], []),
            ('Csus2', 'sus2', 'suspended-second', [0, 2, 7], []),
            ('C7sus', '7sus', 'suspended-fourth', [0, 5, 7, 10], [(7, 0, 'add')]),
            ('C7sus4', '7sus4', 'suspended-fourth', [0, 5, 7, 10], [(7, 0, 'add')]),
            ('C7sus2', '7sus2', 'suspended-second', [0, 2, 7, 10], [(7, 0, 'add')]),
            ('Csus9', '9sus4', 'suspended-fourth', [0, 5, 7, 10, 14], [(7, 0, 'add'), (9, 0, 'add')]),  # = C9sus4
            ('C9sus', '9sus', 'suspended-fourth', [0, 5, 7, 10, 14], [(7, 0, 'add'), (9, 0, 'add')]),
            ('Csus/G', 'sus', 'suspended-fourth', [0, 5, 7], [])]:
        name = chordname.parse(typed)
        h = chordname.harmony(name)
        k = h.find('kind')
        assert (k.get('text'), k.text, deg(h)) == (text, kind, degrees), typed
        assert chordname.tones(name)[1] == iv, typed
        assert chordname.name_of(h) == name, typed
    assert chordname.tones('Csus/G') == (0, [0, 5, 7], 7)
    assert chordname.harmony('C').find('kind').text == 'major' and chordname.harmony('G7').find('kind').text == 'dominant'


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


def duo(melody_chords=''):
    """A voice part (P1: no <staff>, divisions 2, chords `melody_chords` in bar 1) over the piano tune (P2)."""
    piano = tune()
    body = piano[piano.index('<part id="P1">') + len('<part id="P1">'):piano.index('</part>')]
    voice = ''.join(f'<measure number="{i + 1}">' + ('<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time>'
                    '<clef><sign>G</sign><line>2</line></clef></attributes>' + melody_chords if i == 0 else '')
                    + f'<note><pitch><step>{s}</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>whole</type></note></measure>'
                    for i, s in enumerate('EFE'))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part>'
            '<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{voice}</part><part id="P2">{body}</part></score-partwise>')


def part_chords(text):
    return [[(float(t), n) for t, n in chordops.chords_in(p)] for p in root(text).findall('part')]


C_HARMONY = '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>'


def test_two_parts_chords_go_where_the_chords_are():
    """Voice + piano, chords already on the voice: a new one goes above the voice, not the piano (it was the piano)."""
    out, _, _ = op(duo(C_HARMONY), op='chord', bar=1, on=2, text='G7')
    assert part_chords(out) == [[(0.0, 'C'), (6.0, 'G7')], []]
    assert all(h.find('staff') is None for h in root(out).iter('harmony'))  # the voice part has no staves
    out, _, _ = op(out, op='chord', bar=0, on=0, text='')  # takes away the voice's chord
    assert part_chords(out) == [[(6.0, 'G7')], []]
    out, _, _ = op(out, op='chord', bar=0, on=0, text='Am', part=2)  # an explicit part still wins
    assert part_chords(out) == [[(6.0, 'G7')], [(0.0, 'Am')]]
    out, _, _ = op(out, op='chord', bar=0, on=1, text='D', part='P1')
    assert part_chords(out)[0] == [(1.0, 'D'), (6.0, 'G7')]
    with pytest.raises(HTTPException): op(out, op='chord', bar=0, on=0, text='C', part=3)


def test_two_parts_no_chords_go_on_the_top_part():
    out, _, _ = op(duo(), op='chord', bar=0, on=1, text='F')
    assert part_chords(out) == [[(1.0, 'F')], []]
    out, _, _ = op(out, op='chord', bar=2, on=0, text='C')
    assert part_chords(out) == [[(1.0, 'F'), (8.0, 'C')], []]
    # Realize still writes the piano's left hand, from the voice's chord names
    out, _, _ = op(out, op='realize', pattern='block')
    assert part_chords(out) == [[(1.0, 'F'), (8.0, 'C')], []] and lh(out, 2)


def test_single_part_unchanged():
    out, _, _ = op(tune(), op='chord', bar=0, on=0, text='C')
    h = root(out).find('part/measure/harmony')
    assert part_chords(out) == [[(0.0, 'C')]] and h.findtext('staff') == '1' and bars(out)


def test_movechords_repairs_chords_on_the_piano():
    x = duo(C_HARMONY)
    for bar, on, t in [(0, 0, 'F'), (0, 1, 'Am'), (1, 2, 'G7')]: x, _, _ = op(x, op='chord', bar=bar, on=on, text=t, part=2)
    assert part_chords(x) == [[(0.0, 'C')], [(0.0, 'F'), (1.0, 'Am'), (6.0, 'G7')]]
    info = {}
    out, _, _ = sm.edit_ex(x, {'op': 'movechords', 'from': 2, 'to': 1}, info)
    assert part_chords(out) == [[(0.0, 'F'), (1.0, 'Am'), (6.0, 'G7')], []]  # the newer F replaced the C at that beat
    assert info['moved'] == 3 and info['replaced'] == 1
    assert all(h.find('staff') is None for h in root(out).iter('harmony'))
    assert [n['midi'] for n in notes(out)] == [n['midi'] for n in notes(x)]  # no note changed
    with pytest.raises(HTTPException): op(out, op='movechords', **{'from': 2, 'to': 1})  # nothing left to move
    with pytest.raises(HTTPException): op(out, op='movechords', **{'from': 1, 'to': 1})


def test_movechords_through_the_api_is_logged(client):
    x, _, _ = op(duo(), op='chord', bar=0, on=0, text='C', part=2)
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Duo', 'musicxmlText': x}).json()
    r = client.post(f'/api/items/{it["id"]}/editnotes', json={'ops': [{'op': 'movechords', 'from': 2, 'to': 1}], 'mode': 'this'}).json()
    assert r['ok'] and r['activity']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == r['activity'])
    assert 'chord names moved' in str(row)
    assert client.get(f'/api/items/{it["id"]}/score-chords').json()['chords'] == ['C']
