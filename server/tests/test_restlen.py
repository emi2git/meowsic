"""Edit notes: the length of a rest (op 'len' on a rest, either hand) and "Fill next rest" (op 'fill').
Shorter rest: the time freed is a rest after it (pull: the next notes come earlier); longer: it takes the time of the
rests / notes after it in the bar (notes shortened or gone are reported, `took`); too long for the bar: refused. The
bar tidying keeps the rest the user set (never joined back) unless it is notationally wrong — then it is split by
the beat and said. Fill next rest: the picked note takes in the one rest right after it, never a note."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from test_barnorm import DIV, n, piano

LYR = '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>'


def ns(t): return sm.notes(ET.fromstring(t.encode()))


def voice(t, staff):
    """[(midi or 'R', onset, quarters)] of the staff, in time order."""
    return [('R' if x.get('rest') else x['midi'], Fr(x['on']).limit_denominator(64), Fr(x['dur']).limit_denominator(64))
            for x in sorted(ns(t), key=lambda x: (x['on'], x['midi'] or 0)) if x['staff'] == staff]


def rest_at(t, staff, on):
    return next(x['ref'] for x in ns(t) if x['staff'] == staff and x.get('rest') and abs(x['on'] - on) < 1e-6)


def note(t, staff, midi):
    return next(x['ref'] for x in ns(t) if x['staff'] == staff and x['midi'] == midi)


def run(t, op):
    info = {}
    out, touched, gone = sm.edit_ex(t, op, info)
    return out, touched, info


def full(t):
    for staff in (1, 2):
        assert sum(d for _, _, d in voice(t, staff)) == 4, voice(t, staff)
    return True


RH = [n('C5', 1), n('D5', 1), n('E5', 2)]
X = piano(RH, [n('R', 4, 2, 5)])  # the left hand rests the whole bar


def test_left_hand_whole_bar_rest_made_a_quarter_keeps_the_users_rest():
    r = rest_at(X, 2, 0)
    out, touched, info = run(X, {'op': 'len', 'refs': [r], 'q': 1})
    # the quarter rest the user set stays; the rest of the bar: quarter (beat 2) + half (never joined back into it)
    assert voice(out, 2) == [('R', 0, 1), ('R', 1, 1), ('R', 2, 2)] and full(out)
    assert [x['ref'] for x in ns(out) if x['ref'] in touched] == [rest_at(out, 2, 0)]
    assert voice(out, 1) == voice(X, 1) and not info.get('took')


def test_right_hand_rest_longer_takes_rests_then_shortens_or_removes_notes():
    x = piano([n('C5', 1), n('R', 1), n('D5', 0.5), n('E5', 0.5, extra=LYR), n('F5', 1)], [n('C3', 4, 2, 5)])
    r = rest_at(x, 1, 1)
    out, touched, info = run(x, {'op': 'len', 'refs': [r], 'q': 2})  # beat 2 → a half rest: over D5, E5
    # (a half rest on beat 2 is split by the beat: quarter + quarter, and said)
    assert voice(out, 1) == [(72, 0, 1), ('R', 1, 1), ('R', 2, 1), (77, 3, 1)] and full(out)
    assert [t['what'] for t in info['took']] == ['D5', 'E5'] and all(t['now'] == 0 for t in info['took'])
    assert info['took'][1]['lyrics'] == 1
    assert info['said'] and 'half rest on beat 2' in info['said'][0]
    # a dotted quarter from beat 1 of the second half: takes half of the F5 (shortened, still there)
    y = piano([n('C5', 1), n('D5', 1), n('R', 1), n('F5', 1)], [n('C3', 4, 2, 5)])
    out, _, info = run(y, {'op': 'len', 'refs': [rest_at(y, 1, 2)], 'q': 1.5})
    assert voice(out, 1) == [(72, 0, 1), (74, 1, 1), ('R', 2, Fr(3, 2)), (77, Fr(7, 2), Fr(1, 2))] and full(out)
    assert info['took'] == [{'bar': 1, 'beat': '4', 'what': 'F5', 'was': 1.0, 'now': 0.5, 'lyrics': 0}]
    assert info['tookRefs'] == [note(out, 1, 77)]


def test_rest_shorter_leaves_a_rest_or_pulls_the_next_notes_earlier():
    x = piano([n('R', 2), n('D5', 1), n('E5', 1)], [n('C3', 4, 2, 5)])
    r = rest_at(x, 1, 0)
    out, _, _ = run(x, {'op': 'len', 'refs': [r], 'q': 1})
    assert voice(out, 1) == [('R', 0, 1), ('R', 1, 1), (74, 2, 1), (76, 3, 1)] and full(out)
    out, _, _ = run(x, {'op': 'len', 'refs': [r], 'q': 1, 'pull': True})
    assert voice(out, 1) == [('R', 0, 1), (74, 1, 1), (76, 2, 1), ('R', 3, 1)] and full(out)


def test_rest_too_long_for_the_bar_is_refused():
    x = piano([n('C5', 1), n('D5', 1), n('R', 1), n('F5', 1)], [n('C3', 4, 2, 5)])
    with pytest.raises(HTTPException) as e:
        run(x, {'op': 'len', 'refs': [rest_at(x, 1, 2)], 'q': 4})
    assert e.value.status_code == 400 and 'Too long for the bar' in e.value.detail and 'beat 3' in e.value.detail
    assert 'half rest' in e.value.detail  # the room there


def test_dotted_rest_on_beat_one_stays():
    out, _, info = run(X, {'op': 'len', 'refs': [rest_at(X, 2, 0)], 'q': 1.5})
    assert voice(out, 2)[0] == ('R', 0, Fr(3, 2)) and full(out) and not info.get('said')


def test_ties_slurs_lyrics_chords_stay_when_a_rest_changes():
    sl = lambda k: f'<notations><slur type="{k}" number="1"/></notations>'
    rh = [n('C5', 1, extra=LYR).replace('</note>', sl('start') + '</note>'), n('D5', 1).replace('</note>', sl('stop') + '</note>'),
          n('E5+G5', 1), n('R', 1)]
    x = piano(rh, [n('R', 4, 2, 5)])
    harmony = '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>'
    x = x.replace('<note>', harmony + '<note>', 1)
    out, _, _ = run(x, {'op': 'len', 'refs': [rest_at(x, 2, 0)], 'q': 2})
    root = ET.fromstring(out.encode())
    assert root.find('.//harmony/root/root-step').text == 'C'
    assert root.find('.//lyric/text').text == 'la'
    assert [s.get('type') for s in root.iter('slur')] == ['start', 'stop']
    assert sum(1 for e in root.iter('chord')) == 1 and voice(out, 1) == voice(x, 1)


def test_undo_is_replaying_fewer_ops():
    r = rest_at(X, 2, 0)
    a, _ = sm.apply_ops(X, [{'op': 'len', 'refs': [r], 'q': 1}])
    b, _ = sm.apply_ops(X, [])
    assert voice(b, 2) == [('R', 0, 4)] and voice(a, 2) != voice(b, 2)


# ---------- Fill next rest ----------

def test_fill_next_rest_one_rest_per_press_then_no_more():
    x = piano([n('C5', 1, extra=LYR), n('R', 1), n('R', 1), n('F5', 1)], [n('C3', 4, 2, 5)])
    assert next(y for y in ns(x) if y['midi'] == 72).get('fill')
    out, touched, _ = run(x, {'op': 'fill', 'refs': [note(x, 1, 72)]})
    assert voice(out, 1) == [(72, 0, 2), ('R', 2, 1), (77, 3, 1)] and full(out)
    assert touched == [note(out, 1, 72)]  # the picked note stays picked
    c = ET.fromstring(out.encode()).find('.//note')
    assert c.find('lyric/text').text == 'la'
    out2, _, _ = run(out, {'op': 'fill', 'refs': [note(out, 1, 72)]})
    assert voice(out2, 1) == [(72, 0, 3), (77, 3, 1)] and full(out2)  # a dotted half on beat 1
    assert not next(y for y in ns(out2) if y['midi'] == 72).get('fill')
    with pytest.raises(HTTPException) as e:
        run(out2, {'op': 'fill', 'refs': [note(out2, 1, 72)]})
    assert e.value.detail == 'No rest after this note to fill'
    with pytest.raises(HTTPException) as e:
        run(out2, {'op': 'fill', 'refs': [note(out2, 1, 77)]})
    assert 'end of the bar' in e.value.detail


def test_fill_spells_by_the_meter_and_never_takes_a_note():
    # D5 on beat 2 + the rest on 3: quarter~quarter tied (a half on beat 2 is not written), the F5 stays
    x = piano([n('C5', 1), n('D5', 1), n('R', 1), n('F5', 1)], [n('C3', 4, 2, 5)])
    out, touched, _ = run(x, {'op': 'fill', 'refs': [note(x, 1, 74)]})
    v = voice(out, 1)
    assert v == [(72, 0, 1), (74, 1, 1), (74, 2, 1), (77, 3, 1)] and full(out)
    d5 = [e for e in ET.fromstring(out.encode()).iter('note') if sm._midi(e) == 74]
    assert [sorted(t.get('type') for t in e.findall('tie')) for e in d5] == [['start'], ['stop']]
    assert touched == [note(out, 1, 74)]
    # pressed again on the tied D5: the next thing after its chain is a note
    with pytest.raises(HTTPException):
        run(out, {'op': 'fill', 'refs': [touched[0]]})


def test_fill_in_the_left_hand_8ths():
    x = piano([n('C5', 4)], [n('C3', 0.5, 2, 5), n('R', 0.5, 2, 5), n('R', 1, 2, 5), n('G3', 2, 2, 5)])
    out, _, _ = run(x, {'op': 'fill', 'refs': [note(x, 2, 48)]})
    assert voice(out, 2) == [(48, 0, 1), ('R', 1, 1), (55, 2, 2)] and full(out)


def test_api_preview_tells_what_was_taken(client):
    x = piano([n('C5', 1), n('R', 1), n('D5', 1), n('E5', 1)], [n('C3', 4, 2, 5)])
    iid = client.post('/api/items', json={'kind': 'score', 'title': 'Rests', 'musicxmlText': x}).json()['id']
    p = client.post(f'/api/items/{iid}/editnotes/preview', json={'ops': [{'op': 'len', 'refs': [rest_at(x, 1, 1)], 'q': 2}]})
    assert p.status_code == 200
    j = p.json()
    assert [t['what'] for t in j['took']] == ['D5'] and 'half rest on beat 2' in j['said'][0]
    bad = client.post(f'/api/items/{iid}/editnotes/preview', json={'ops': [{'op': 'len', 'refs': [rest_at(x, 1, 1)], 'q': 4}]})
    assert bad.status_code == 400 and 'Too long' in bad.json()['detail']
