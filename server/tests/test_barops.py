"""Edit notes → Bar ▾ (barops.py): clear / add a hand in a bar, insert / delete bars, add / remove staves (a left
hand for a melody, a voice line over a piano score) — bars stay full, ties / slurs / lyrics / chord names kept or
adjusted, later bars renumbered; through the editor's preview and Save like any edit."""
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException

from meowsic import easerests as er
from meowsic import staffmove as sm
from test_staffmove import CHECK, LH, RH, ev, music, score

HARM = '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>'


def bars(text, staves=('1', '2')):
    """Every bar: each voice exactly the time signature, every staff there. Returns the bar numbers."""
    out = []
    for num, vs, need in er.bar_lengths(text):
        for k, q in vs.items(): assert q == need, f'bar {num} voice {k}: {q} quarters, needs {need}'
        assert {s for s, _ in vs} == set(staves), f'bar {num}: staves {vs}'
        out.append(num)
    return out


def root(text): return ET.fromstring(text.encode())
def nstaves(text): return {int(s.text) for s in root(text).iter('staves')} or {1}
def op(text, **o): return sm.edit_ex(text, o)


def one_staff():
    x = score(RH, [[ev('R', 4, 2)], [ev('R', 4, 2)]])
    r = root(x)
    for m in r.iter('measure'):
        for k in [e for e in list(m) if e.tag == 'backup' or (e.tag == 'note' and e.findtext('staff') == '2')]: m.remove(k)
    for a in r.iter('attributes'):
        a.remove(a.find('staves')); a.remove(a.findall('clef')[1]); del a.find('clef').attrib['number']
    for n in r.iter('note'): n.remove(n.find('staff'))
    return sm._head(x) + ET.tostring(r, encoding='unicode')


def test_clear_left_hand_keeps_right_hand_and_chord_names():
    x = score(RH, LH, harmony=HARM)
    out, rests, gone = op(x, op='clearbar', bar=0, staff=2)
    assert bars(out) and gone == 0
    m = music(out)
    assert not [n for n in m if n[0] == 0 and n[1] == 2]
    assert {n for n in m if n[1] == 1} == {n for n in music(x) if n[1] == 1}
    assert {n for n in m if n[0] == 1} == {n for n in music(x) if n[0] == 1}
    assert '<harmony>' in out and len(rests) == 1
    r = next(n for n in sm.notes(root(out)) if n['ref'] == rests[0])
    assert r['rest'] and r['staff'] == 2 and r['dur'] == 4


def test_clear_right_hand_moves_its_chord_name_to_the_left_hand_and_drops_lyrics_there():
    x = score(RH, LH, harmony=HARM.replace('</harmony>', '<staff>1</staff></harmony>'))
    x = x.replace('<staff>1</staff></note>', '<staff>1</staff><lyric><text>la</text></lyric></note>', 1)
    out, _, _ = op(x, op='clearbar', bar=0, staff=1)
    assert bars(out) and '<lyric>' not in out
    h = next(root(out).iter('harmony'))
    assert h.findtext('staff') == '2'  # stays where a note starts
    assert {n for n in music(out) if n[1] == 2} == {n for n in music(x) if n[1] == 2}


def test_add_left_hand_to_a_bar_that_has_none():
    x = score(RH, LH)
    r = root(x)
    m2 = r.findall('.//measure')[1]
    for k in [e for e in list(m2) if e.tag == 'backup' or (e.tag == 'note' and e.findtext('staff') == '2')]: m2.remove(k)
    x = sm._head(x) + ET.tostring(r, encoding='unicode')
    out, rests, _ = op(x, op='fillbar', bar=1, staff=2)
    assert bars(out) and len(rests) == 1
    n = next(n for n in sm.notes(root(out)) if n['ref'] == rests[0])
    assert n['rest'] and n['bar'] == 1 and n['staff'] == 2 and n['voice'] == '5'
    # a bar that has the hand already: nothing changes, its rests / notes come back to pick
    same, got, _ = op(out, op='fillbar', bar=1, staff=2)
    assert music(same) == music(out) and got
    with pytest.raises(HTTPException): op(x, op='fillbar', bar=1, staff=3)


def test_single_staff_gets_a_left_hand_staff():
    x = one_staff()
    out, rests, _ = op(x, op='addstaff', at=2, clef='bass')
    assert nstaves(out) == {2} and bars(out) == ['1', '2'] and len(rests) == 2
    assert [(c.get('number'), c.findtext('sign')) for c in root(out).iter('clef')] == [('1', 'G'), ('2', 'F')]
    assert {n for n in music(out)} == {n for n in music(x)}
    p = sm.notes(root(out))
    assert all(n['rest'] for n in p if n['staff'] == 2)
    # it is a piano part now: notes move to the new left hand
    d = next(n['ref'] for n in p if n['midi'] == 74)
    moved, _ = sm.edit(out, {'op': 'move', 'refs': [d], 'to': 2})
    assert bars(moved) and (0, 2, 1.0, 1.0, 74) in music(moved)


def test_voice_staff_on_top_of_piano_with_lyrics_and_edits():
    x = score(RH, LH, harmony=HARM)
    out, rests, _ = op(x, op='addstaff', at=1, clef='treble')
    assert nstaves(out) == {3} and bars(out, ('1', '2', '3'))
    assert [c.findtext('sign') for c in root(out).iter('clef')] == ['G', 'G', 'F']
    # the piano went down a staff, voices with it; the chord name stays with the piano
    assert {(b, s - 1, on, q, m) for b, s, on, q, m in music(out)} == music(x)
    assert next(root(out).iter('harmony')).findtext('staff') == '2'
    assert {n['voice'] for n in sm.notes(root(out)) if n['staff'] == 1} == {'1'}
    # a melody on the voice staff, with a lyric
    out, got, _ = op(out, op='add', refs=[rests[0]], midi=72)
    t = root(out)
    mel = [n for n in t.iter('note') if n.findtext('staff') == '1' and n.find('pitch') is not None][0]
    ET.SubElement(mel, 'lyric').append(ET.fromstring('<text>Hel</text>'))
    out = sm._head(out) + ET.tostring(t, encoding='unicode')
    # edits on the piano (pitch, move to the left hand = staff 3) keep the voice line and its lyric
    e5 = [n['ref'] for n in sm.notes(root(out)) if n['midi'] == 76 and n['bar'] == 0 and n['staff'] == 2]
    out2, _ = sm.edit(out, {'op': 'move', 'refs': e5[-1:], 'to': 3})
    assert bars(out2, ('1', '2', '3')) and (0, 3, 2.0, 2.0, 76) in music(out2)
    out2, _ = sm.edit(out2, {'op': 'pitch', 'refs': [n['ref'] for n in sm.notes(root(out2)) if n['midi'] == 79], 'by': 1})
    v = [n for n in root(out2).iter('note') if n.findtext('staff') == '1' and n.find('pitch') is not None]
    assert len(v) == 1 and v[0].findtext('lyric/text') == 'Hel' and (0, 1, 0.0, 4.0, 72) in music(out2)
    with pytest.raises(HTTPException): sm.edit(out2, {'op': 'move', 'refs': e5[:1], 'to': 4})


def test_insert_empty_bar_before_the_first_and_after():
    x = score(RH, LH, harmony=HARM).replace('<part-list>', CHECK.format('2'))
    x = x.replace('<staff>1</staff></note>', '<staff>1</staff><lyric><text>la</text></lyric></note>', 1)
    out, rests, gone = op(x, op='insbar', bar=0, after=False)
    assert bars(out) == ['1', '2', '3'] and len(rests) == 2 and gone == 0
    ms = root(out).findall('.//measure')
    assert ms[0].find('attributes/divisions') is not None and ms[0].find('attributes/time') is not None
    assert ms[1].find('attributes') is None and ms[1].find('harmony') is not None and ms[1].find('.//lyric') is not None
    assert {(b - 1, s, on, q, m) for b, s, on, q, m in music(out)} == music(x)
    assert sm.check_bars(out) == [3]  # the bar to check moved with its bar
    out2, _, _ = op(out, op='insbar', bar=1, after=True)
    assert bars(out2) == ['1', '2', '3', '4'] and sm.check_bars(out2) == [4]
    assert not [n for n in music(out2) if n[0] == 2]


def test_insert_inside_a_tie_takes_the_tie_away():
    rh = [[ev('C5', 1), ev('D5', 1), ev('E5', 2)], [ev('E5', 2), ev('D5', 2)]]
    x = score(rh, LH)
    t = root(x)
    a, b = [n for n in t.iter('note') if n.findtext('pitch/step') == 'E']
    sm._add_tie(a, 'start'); sm._add_tie(b, 'stop')
    x = sm._head(x) + ET.tostring(t, encoding='unicode')
    out, _, gone = op(x, op='insbar', bar=0, after=True)
    assert gone == 1 and 'tied' not in out and '<tie ' not in out and bars(out)


def test_delete_a_bar_carries_its_set_up_and_drops_a_tie_into_it():
    rh = [[ev('C5', 1), ev('D5', 1), ev('E5', 2)], [ev('E5', 2), ev('D5', 2)], [ev('C5', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('G2', 4, 2)], [ev('C3', 4, 2)]]
    x = score(rh, lh).replace('<part-list>', CHECK.format('1 3'))
    t = root(x)
    a, b = [n for n in t.iter('note') if n.findtext('pitch/step') == 'E']
    sm._add_tie(a, 'start'); sm._add_tie(b, 'stop')
    m1 = t.findall('.//measure')[0]
    m1.insert(1, ET.fromstring('<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>'))
    x = sm._head(x) + ET.tostring(t, encoding='unicode')
    out, _, gone = op(x, op='delbar', bar=1)
    assert gone == 1 and 'tied' not in out and bars(out) == ['1', '2'] and sm.check_bars(out) == [1, 2]
    assert not [n for n in music(out) if n[4] == 74 and n[0] == 1]
    out, _, gone = op(out, op='delbar', bar=0)  # the first bar: divisions, time, clefs and the tempo go on
    ms = root(out).findall('.//measure')
    assert len(ms) == 1 and ms[0].get('number') == '1' and gone == 0
    assert ms[0].findtext('attributes/divisions') == '4' and len(ms[0].findall('attributes/clef')) == 2
    assert ms[0].find('direction/sound').get('tempo') == '90' and ms[0].find('barline') is not None and bars(out)
    with pytest.raises(HTTPException): op(out, op='delbar', bar=0)


def test_delete_the_last_bar_keeps_the_final_barline_and_a_slur_into_it():
    x = score(RH, LH)
    t = root(x)
    ns = [n for n in t.iter('note') if n.findtext('staff') == '1']
    sm._notations(ns[2]).append(ET.Element('slur', type='start', number='1'))
    sm._notations(ns[-1]).append(ET.Element('slur', type='stop', number='1'))
    x = sm._head(x) + ET.tostring(t, encoding='unicode')
    out, _, _ = op(x, op='delbar', bar=1)
    ms = root(out).findall('.//measure')
    assert len(ms) == 1 and ms[0].findtext('barline/bar-style') == 'light-heavy' and bars(out)
    # the slur's stop went with its bar: the slur now ends on the last note left (or goes when it would span nothing)
    assert out.count('type="stop" number="1"') == out.count('type="start" number="1"')


def test_remove_a_staff_and_bad_requests():
    x = score(RH, LH, harmony=HARM)
    out, _, _ = op(x, op='addstaff', at=1, clef='treble')
    back, _, _ = op(out, op='delstaff', staff=1)
    assert nstaves(back) == {2} and music(back) == music(x) and bars(back)
    assert [c.get('number') for c in root(back).iter('clef')] == ['1', '2']
    assert {n['voice'] for n in sm.notes(root(back))} == {'1', '5'}
    one, _, _ = op(x, op='delstaff', staff=2)
    assert nstaves(one) == {1} and bars(one, ('1',)) and not [n for n in music(one) if n[1] != 1]
    assert sm.edit_part(root(one))[2] is False
    for bad in ({'op': 'delstaff', 'staff': 1}, {'op': 'clearbar', 'bar': 9, 'staff': 1}, {'op': 'addstaff', 'at': 5, 'clef': 'bass'},
                {'op': 'addstaff', 'at': 1, 'clef': 'alto'}, {'op': 'insbar', 'bar': 'x'}):
        with pytest.raises(HTTPException): sm.edit_ex(one, bad)


@pytest.fixture
def melody(client):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Tune', 'musicxmlText': one_staff()}).json()


def test_api_add_staff_edit_and_save_keeps_everything(client, melody, data):
    i = melody['id']
    p0 = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    assert not p0['hands']
    ops = [{'op': 'addstaff', 'at': 2, 'clef': 'bass'}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()
    assert p['hands'] is False and len(p['moved']) == 2  # hands = what the score had when the editor opened
    rest = next(n['ref'] for n in p['notes'] if n['staff'] == 2 and n['bar'] == 0)
    ops += [{'op': 'add', 'refs': [rest], 'midi': 48}, {'op': 'insbar', 'bar': 1, 'after': True}, {'op': 'addstaff', 'at': 1, 'clef': 'treble'}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()
    assert bars(p['xml'], ('1', '2', '3')) == ['1', '2', '3'] and (0, 3, 0.0, 4.0, 48) in music(p['xml'])
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p['sha']}).json()
    saved = (data / 'items' / melody['folder'] / melody['musicxml']).read_text()
    assert saved == p['xml'] and client.get(f'/api/items/{i}').json()['staves'] == 3
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert 'staves added' in row['detail'] and 'empty bar added' in row['detail']
    again = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    assert again['hands'] and music(again['xml']) == music(p['xml'])
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{i}').json()['staves'] == 1
