"""Edit notes (staffmove.py): notes moved between the upper and lower staff of the piano part — both staves keep
full bars, chords stay together, rests fill what is left, clefs untouched, moving back gives the same music;
preview, saving into the score (history + Activities undo) or as a new score."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest

from meowsic import easerests as er
from meowsic import staffmove as sm

TY = {Fr(1, 2): 'eighth', Fr(1): 'quarter', Fr(3, 2): ('quarter', 1), Fr(2): 'half', Fr(3): ('half', 1), Fr(4): 'whole'}


def ev(x, q, staff=1, voice=None):
    """x: 'C4' | 'R' | 'C4+E4' (a chord); q in quarters (divisions = 4)."""
    voice = voice or (1 if staff == 1 else 5)
    t = TY[Fr(q)]
    t, dots = (t, 0) if isinstance(t, str) else t
    tail = f'<duration>{int(Fr(q) * 4)}</duration><voice>{voice}</voice><type>{t}</type>' + '<dot/>' * dots + f'<staff>{staff}</staff>'
    if x == 'R': return f'<note><rest/>{tail}</note>'
    out = ''
    for k, p in enumerate(x.split('+')):
        alt = '<alter>1</alter>' if '#' in p else ''
        out += f'<note>{"<chord/>" if k else ""}<pitch><step>{p[0]}</step>{alt}<octave>{p[-1]}</octave></pitch>{tail}</note>'
    return out


def score(rh, lh, beats=4, harmony=''):
    ms = []
    for i, (a, b) in enumerate(zip(rh, lh)):
        x = f'<measure number="{i + 1}">'
        if i == 0:
            x += (f'<attributes><divisions>4</divisions><time><beats>{beats}</beats><beat-type>4</beat-type></time><staves>2</staves>'
                  '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>')
            x += harmony
        x += ''.join(a) + f'<backup><duration>{beats * 4}</duration></backup>' + ''.join(b)
        ms.append(x + '<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>' if i == len(rh) - 1 else x + '</measure>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


RH = [[ev('C5+E5', 1), ev('D5', 1), ev('E5', 2)], [ev('G5', 1), ev('F5', 1), ev('E5', 1), ev('D5', 1)]]
LH = [[ev('C3', 2, 2), ev('G3', 2, 2)], [ev('B2+D3', 4, 2)]]


def full(text):
    for num, vs, need in er.bar_lengths(text):
        assert vs, f'bar {num}: no voices'
        for k, q in vs.items(): assert q == need, f'bar {num} voice {k}: {q} quarters, needs {need}'
        assert {s for s, _ in vs} == {'1', '2'}, f'bar {num}: a staff has no voice {vs}'
    return True


def music(text):
    """{(bar, staff, onset, quarters, midi)} — what sounds where."""
    return {(n['bar'], n['staff'], n['on'], n['dur'], n['midi']) for n in sm.notes(ET.fromstring(text.encode())) if not n.get('rest')}


def refs(text, pred):
    return [n['ref'] for n in sm.notes(ET.fromstring(text.encode())) if not n.get('rest') and pred(n)]


def chords(text, bar, staff):
    """[(onset, (midis…))] of a staff's chords in a bar."""
    out = {}
    for n in sm.notes(ET.fromstring(text.encode())):
        if not n.get('rest') and n['bar'] == bar and n['staff'] == staff: out.setdefault((n['on'], n['voice']), []).append(n['midi'])
    return sorted((on, tuple(sorted(ms))) for (on, _), ms in out.items())


def clefs(text):
    return [(c.get('number'), c.findtext('sign'), c.findtext('line')) for c in ET.fromstring(text.encode()).iter('clef')]


def test_move_a_note_down_fills_a_rest_and_keeps_bars_full():
    x = score(RH, LH)
    d5 = refs(x, lambda n: n['midi'] == 74 and n['bar'] == 0)
    out, moved = sm.move(x, d5, 2)
    assert full(out)
    m = music(out)
    assert (0, 2, 1.0, 1.0, 74) in m and not any(k[1] == 1 and k[4] == 74 and k[0] == 0 for k in m)
    assert len(moved) == 1 and [n for n in sm.notes(ET.fromstring(out.encode())) if n['ref'] == moved[0]][0]['midi'] == 74
    # the right hand rests where the D was
    bar = ET.fromstring(out.encode()).find('part/measure')
    up = [n for n in bar.findall('note') if n.findtext('staff') == '1' and n.find('chord') is None]
    assert [n.find('rest') is not None for n in up] == [False, True, False]
    assert clefs(out) == clefs(x)


def test_a_chord_moved_stays_a_chord():
    x = score(RH, LH)
    ce = refs(x, lambda n: n['bar'] == 0 and n['on'] == 0 and n['staff'] == 1)
    assert len(ce) == 2
    out, moved = sm.move(x, ce, 2)
    assert full(out) and len(moved) == 2
    # C5+E5 lands on the left hand at beat 1 — over a half note there, so in a voice of its own, still one chord
    assert (0.0, (72, 76)) in chords(out, 0, 2)
    bar = ET.fromstring(out.encode()).find('part/measure')
    lo = [n for n in bar.findall('note') if n.findtext('staff') == '2']
    assert len({n.findtext('voice') for n in lo}) == 2
    e5 = next(n for n in lo if sm._midi(n) == 76)
    assert e5.find('chord') is not None


def test_same_time_same_length_joins_the_chord_there():
    x = score(RH, LH)
    g5 = refs(x, lambda n: n['bar'] == 1 and n['midi'] == 79)
    out, _ = sm.move(x, g5, 2)
    assert full(out)
    # G5 (a quarter) is not the length of the whole-note B2+D3: a voice of its own
    assert (0.0, (79,)) in chords(out, 1, 2)
    # a whole note up there instead: joins B2+D3 as one chord
    y = score([RH[0], [ev('G5', 4)]], LH)
    g = refs(y, lambda n: n['bar'] == 1 and n['midi'] == 79)
    out, _ = sm.move(y, g, 2)
    assert full(out) and chords(out, 1, 2) == [(0.0, (47, 50, 79))]
    # the right hand is left with a whole-bar rest
    bar = ET.fromstring(out.encode()).findall('part/measure')[1]
    up = [n for n in bar.findall('note') if n.findtext('staff') == '1']
    assert len(up) == 1 and up[0].find('rest').get('measure') == 'yes'


def test_part_of_a_chord_leaves_the_rest_of_it():
    x = score(RH, LH)
    c5 = refs(x, lambda n: n['bar'] == 0 and n['midi'] == 72)
    out, _ = sm.move(x, c5, 2)
    assert full(out)
    assert (0.0, (76,)) in chords(out, 0, 1) and (0.0, (72,)) in chords(out, 0, 2)
    bar = ET.fromstring(out.encode()).find('part/measure')
    e5 = next(n for n in bar.findall('note') if sm._midi(n) == 76)
    assert e5.find('chord') is None  # it heads what is left of the chord now


def test_whole_bar_up_and_back_round_trip():
    x = score(RH, LH)
    lh = refs(x, lambda n: n['staff'] == 2)
    out, moved = sm.move(x, lh, 1)
    assert full(out)
    assert not any(k[1] == 2 for k in music(out))
    for bar in ET.fromstring(out.encode()).findall('part/measure'):
        lo = [n for n in bar.findall('note') if n.findtext('staff') == '2']
        assert len(lo) == 1 and lo[0].find('rest').get('measure') == 'yes'  # the left hand rests the whole bar
    back, _ = sm.move(out, moved, 2)
    assert full(back)
    assert music(back) == music(x)
    assert clefs(back) == clefs(x)
    # the left hand is one voice again, with no rests
    for bar in ET.fromstring(back.encode()).findall('part/measure'):
        lo = [n for n in bar.findall('note') if n.findtext('staff') == '2']
        assert len({n.findtext('voice') for n in lo}) == 1 and all(n.find('rest') is None for n in lo)


def test_round_trip_of_single_notes_and_ops():
    x = score(RH, LH)
    pick = refs(x, lambda n: n['staff'] == 1 and n['on'] in (1.0, 3.0))
    out, moved = sm.apply_ops(x, [{'refs': pick, 'to': 2}])
    assert full(out) and len(moved) == len(pick)
    back, _ = sm.apply_ops(out, [{'refs': moved, 'to': '1'}])
    assert full(back) and music(back) == music(x)


def test_harmony_barline_and_untouched_bars():
    h = '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>'
    x = score(RH, LH, harmony=h)
    d5 = refs(x, lambda n: n['midi'] == 74 and n['bar'] == 0)
    out, _ = sm.move(x, d5, 2)
    m0, m1 = ET.fromstring(out.encode()).findall('part/measure')
    kids = [e.tag for e in m0]
    assert kids[:2] == ['attributes', 'harmony'] and kids.count('backup') >= 1
    x1 = ET.fromstring(x.encode()).findall('part/measure')[1]
    assert [e.tag for e in m1] == [e.tag for e in x1] and [e.tag for e in m1][-1] == 'barline'


def test_eighths_are_beamed_again_per_beat():
    rh = [[ev('C5', 0.5), ev('D5', 0.5), ev('E5', 0.5), ev('F5', 0.5), ev('G5', 2)]]
    x = score(rh, [[ev('C3', 4, 2)]])
    d = refs(x, lambda n: n['midi'] == 74)
    out, _ = sm.move(x, d, 2)
    assert full(out)
    bar = ET.fromstring(out.encode()).find('part/measure')
    e5 = next(n for n in bar.findall('note') if sm._midi(n) == 76)
    f5 = next(n for n in bar.findall('note') if sm._midi(n) == 77)
    assert e5.findtext('beam') == 'begin' and f5.findtext('beam') == 'end'


def test_bad_requests():
    x = score(RH, LH)
    with pytest.raises(Exception): sm.move(x, [0], 3)
    rest = [i for i, n in enumerate(ET.fromstring(x.encode()).find('part').iter('note')) if n.find('rest') is not None]
    assert not rest
    one = x.replace('<staves>2</staves>', '')
    with pytest.raises(Exception): sm.move(one, [0], 2)


# ---------- the endpoints ----------

@pytest.fixture
def piano(client):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'musicxmlText': score(RH, LH), 'tags': ['Kids']}).json()


def test_api_preview_save_this_and_undo(client, piano, data):
    i = piano['id']
    p0 = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    assert p0['part'] == 0 and not p0['changed'] and len([n for n in p0['notes'] if not n.get('rest')]) == 12 and p0['hands']
    d5 = [n['ref'] for n in p0['notes'] if n['midi'] == 74 and n['bar'] == 0]
    ops = [{'refs': d5, 'to': 2}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()
    assert p['changed'] and full(p['xml']) and len(p['moved']) == 1
    assert next(n for n in p['notes'] if n['ref'] == p['moved'][0])['staff'] == 2
    f = data / 'items' / piano['folder'] / piano['musicxml']
    was = f.read_text()
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': 'nope'}).status_code == 409
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': [], 'mode': 'this'}).status_code == 422
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p['sha']}).json()
    assert f.read_text() == p['xml'] and (f.parent / j['history']).read_text() == was
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert row['type'] == 'edit-notes' and row['action'] == 'undo' and 'left hand' in row['detail']
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was


def test_api_save_as_new(client, piano):
    p0 = client.post(f'/api/items/{piano["id"]}/editnotes/preview', json={}).json()
    lh = [n['ref'] for n in p0['notes'] if n['staff'] == 2]
    j = client.post(f'/api/items/{piano["id"]}/editnotes', json={'ops': [{'refs': lh, 'to': 1}], 'mode': 'new'}).json()
    new = j['item']
    assert new['id'] != piano['id'] and sm.TAG in new['tags'] and 'Kids' in new['tags'] and new['groupId']
    assert full(client.get(f'/api/items/{new["id"]}/musicxml').text)
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{new["id"]}').json().get('deleted')


def test_api_no_piano_part(client):
    x = score(RH, LH).replace('<staves>2</staves>', '')
    it = client.post('/api/items', json={'kind': 'score', 'title': 'One staff', 'musicxmlText': x}).json()
    p = client.post(f'/api/items/{it["id"]}/editnotes/preview', json={}).json()
    assert p['hands'] is False and p['notes']
    assert client.post(f'/api/items/{it["id"]}/editnotes/preview', json={'ops': [{'op': 'move', 'refs': [0], 'to': 2}]}).status_code == 400


# ---------- the other edits (Edit notes, Check bars) ----------

def test_pitch_up_and_down():
    x = score(RH, LH)
    d5 = refs(x, lambda n: n['midi'] == 74 and n['bar'] == 0)
    out, t = sm.edit(x, {'op': 'pitch', 'refs': d5, 'by': 1})
    assert (0, 1, 1.0, 1.0, 75) in music(out) and full(out)
    n = sm.notes(ET.fromstring(out.encode()))
    assert next(x for x in n if x['ref'] == t[0])['midi'] == 75
    out, _ = sm.edit(out, {'op': 'pitch', 'refs': t, 'by': -13})
    assert (0, 1, 1.0, 1.0, 62) in music(out)
    m = ET.fromstring(out.encode()).find('part/measure')
    d = next(e for e in m.iter('note') if sm._midi(e) == 62)
    assert d.findtext('pitch/step') == 'D' and d.find('pitch/alter') is None


def test_flat_spelling_going_down():
    x = score(RH, LH)
    e5 = refs(x, lambda n: n['midi'] == 76 and n['bar'] == 0 and n['on'] == 2.0)
    out, _ = sm.edit(x, {'op': 'pitch', 'refs': e5, 'by': -1})
    m = ET.fromstring(out.encode()).find('part/measure')
    e = next(e for e in m.iter('note') if sm._midi(e) == 75)
    assert e.findtext('pitch/step') == 'E' and e.findtext('pitch/alter') == '-1'


def test_length_shorter_and_longer_keep_bars_full():
    x = score(RH, LH)
    e5 = refs(x, lambda n: n['bar'] == 0 and n['on'] == 2.0 and n['staff'] == 1)  # the half note E5
    out, t = sm.edit(x, {'op': 'len', 'refs': e5, 'q': 1})
    assert full(out) and (0, 1, 2.0, 1.0, 76) in music(out)
    # D5 (beat 2) longer: a half note over the E5 → the E5 is written over, the bar still adds up
    d5 = refs(out, lambda n: n['midi'] == 74 and n['bar'] == 0)
    out2, _ = sm.edit(out, {'op': 'len', 'refs': d5, 'q': 2})
    assert full(out2) and (0, 1, 1.0, 2.0, 74) in music(out2) and not any(k[0] == 0 and k[2] == 2.0 and k[1] == 1 for k in music(out2))
    with pytest.raises(Exception): sm.edit(x, {'op': 'len', 'refs': e5, 'q': 4})       # does not fit the bar
    with pytest.raises(Exception): sm.edit(x, {'op': 'len', 'refs': e5, 'q': 1.25})    # not one written value


def test_delete_leaves_a_rest_and_chords_lose_one_note():
    x = score(RH, LH)
    out, _ = sm.edit(x, {'op': 'delete', 'refs': refs(x, lambda n: n['midi'] == 74 and n['bar'] == 0)})
    assert full(out) and not any(k[4] == 74 and k[0] == 0 for k in music(out))
    out, _ = sm.edit(x, {'op': 'delete', 'refs': refs(x, lambda n: n['midi'] == 72 and n['bar'] == 0)})
    assert full(out) and chords(out, 0, 1)[0] == (0.0, (76,))


def test_add_a_note_to_a_chord_and_on_a_rest():
    x = score(RH, LH)
    g5 = refs(x, lambda n: n['midi'] == 79)
    out, t = sm.edit(x, {'op': 'add', 'refs': g5})
    assert full(out) and chords(out, 1, 1)[0] == (0.0, (79, 83))
    # the left hand rests a whole bar after moving it up; a note there
    out, _ = sm.move(x, refs(x, lambda n: n['staff'] == 2 and n['bar'] == 1), 1)
    rest = [n['ref'] for n in sm.notes(ET.fromstring(out.encode())) if n.get('rest') and n['bar'] == 1 and n['staff'] == 2]
    out2, t = sm.edit(out, {'op': 'add', 'refs': rest, 'midi': 48})
    assert full(out2) and (1, 2, 0.0, 4.0, 48) in music(out2)
    n = next(e for e in ET.fromstring(out2.encode()).findall('part/measure')[1].iter('note') if sm._midi(e) == 48)
    assert n.findtext('type') == 'whole' and n.find('rest') is None


CHECK = '<identification><miscellaneous><miscellaneous-field name="meowsic-check-bars">{}</miscellaneous-field></miscellaneous></identification><part-list>'


def test_unmark_and_check_bars():
    x = score(RH, LH).replace('<part-list>', CHECK.format('1 2'))
    x = x.replace('<measure number="2">', '<measure number="2"><direction><direction-type><words color="#D00">⚠ check</words></direction-type></direction>')
    assert sm.check_bars(x) == [1, 2]
    out, _ = sm.edit(x, {'op': 'unmark', 'bars': [2]})
    assert sm.check_bars(out) == [1] and '⚠ check' not in out and full(out)
    out, _ = sm.edit(out, {'op': 'unmark', 'bars': [1]})
    assert sm.check_bars(out) == [] and 'meowsic-check-bars' not in out


def test_use_the_other_reading_of_a_bar():
    x = score(RH, LH)
    alt = '<measure number="9">' + ev('A5', 4) + '<backup><duration>16</duration></backup>' + ev('A3', 4, 2) + '</measure>'
    out, _ = sm.edit(x, {'op': 'alt', 'bar': 2, 'measure': alt})
    assert full(out) and music(out) >= {(1, 1, 0.0, 4.0, 81), (1, 2, 0.0, 4.0, 57)}
    assert ET.fromstring(out.encode()).findall('part/measure')[1].get('number') == '2'
    with pytest.raises(Exception): sm.edit(x, {'op': 'alt', 'bar': 9, 'measure': alt})


def test_api_save_check_edits_with_undo(client, data):
    x = score(RH, LH).replace('<part-list>', CHECK.format('2'))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Check me', 'musicxmlText': x}).json()
    p0 = client.post(f'/api/items/{it["id"]}/editnotes/preview', json={}).json()
    assert p0['check'] == [2]
    f = data / 'items' / it['folder'] / it['musicxml']
    was = f.read_text()
    j = client.post(f'/api/items/{it["id"]}/editnotes', json={'ops': [{'op': 'unmark', 'bars': [2]}], 'mode': 'this', 'sha': p0['sha']}).json()
    assert j['check'] == [] and sm.check_bars(f.read_text()) == []
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert row['type'] == 'edit-notes' and '1 bar checked' in row['detail']
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was
