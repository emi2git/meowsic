"""Edit notes → Bar ▾ structure (structops.py): pickup, key / time from here (barred again), repeat signs and
1st / 2nd endings, and the order they play in (play_order; web/js/musicxml.js playOrder follows the same rules;
singscore sings verse 1 then verse 2 through a repeat)."""
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException

from meowsic import singscore
from meowsic import staffmove as sm
from meowsic import structops as so
from test_barops import bars
from test_staffmove import ev, score


def root(text): return ET.fromstring(text.encode())
def op(text, **o): return sm.edit_ex(text, o)
def part(text): return root(text).find('part')
def notes(text): return sm.notes(root(text))
def melody(text): return [(n['bar'], n['on'], n['dur'], n['midi']) for n in notes(text) if n['staff'] == 1 and not n.get('rest')]


def six(beats=4):
    rh = [[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('F5', 1)][:beats] if beats <= 4 else [], [ev('G5', 4)]] + [[ev('A5', 4)] for _ in range(4)]
    lh = [[ev('C3', 4, 2)] for _ in range(6)]
    return score(rh, lh)


def test_pickup_keeps_the_last_beats_and_is_not_incomplete():
    x = score([[ev('R', 3), ev('G4', 1)], [ev('C5', 4)]], [[ev('R', 4, 2)], [ev('C3', 4, 2)]])
    out, _, _ = op(x, op='pickup', beats=1)
    m = part(out).find('measure')
    assert m.get('implicit') == 'yes' and m.get('number') == '0'
    assert melody(out) == [(0, 0.0, 1.0, 67), (1, 0.0, 4.0, 72)]
    assert sm.incomplete_bars(root(out)) == []
    assert [x.get('number') for x in part(out).findall('measure')] == ['0', '1']
    # back to a full bar: rests in front
    out2, _, _ = op(out, op='pickup', beats=0)
    assert melody(out2) == [(0, 3.0, 1.0, 67), (1, 0.0, 4.0, 72)] and part(out2).find('measure').get('implicit') is None
    assert bars(out2)


def test_pickup_that_cuts_notes_says_so():
    x = six()
    info = {}
    out, _, _ = sm.edit_ex(x, {'op': 'pickup', 'beats': 2}, info)
    assert melody(out)[:2] == [(0, 0.0, 1.0, 76), (0, 1.0, 1.0, 77)]
    assert any('3 notes before the pickup went' in s for s in info['said'])  # C5, D5 and the left hand's C3
    with pytest.raises(HTTPException): op(x, op='pickup', beats=7)


def test_key_from_here_writes_accidentals_for_the_new_key():
    x = six()
    out, _, _ = op(x, op='keysig', bar=2, fifths=-1)  # F major from bar 3: no B in the music, A stays plain
    ks = [(k, m.findtext('attributes/key/fifths')) for k, m in enumerate(part(out).findall('measure'))]
    assert ks[2] == (2, '-1') and melody(out) == melody(x)
    out2, _, _ = op(x, op='keysig', bar=2, fifths=-4)  # four flats: the A needs a natural
    m3 = part(out2).findall('measure')[2]
    assert [n.findtext('accidental') for n in m3.findall('note') if n.findtext('staff') == '1'] == ['natural']
    out3, _, _ = op(x, op='keysig', bar=0, fifths=2)
    assert part(out3).find('measure/attributes/key/fifths').text == '2'


def test_time_from_here_bars_the_music_again_with_ties():
    x = six()  # 6 bars of 4/4 = 24 beats
    info = {}
    out, _, _ = sm.edit_ex(x, {'op': 'timesig', 'bar': 0, 'beats': 3, 'beatType': 4}, info)
    ms = part(out).findall('measure')
    assert len(ms) == 8 and bars(out)
    assert ms[0].find('attributes/time/beats').text == '3'
    # the sound is the same: C5 D5 E5 | F5 G5~G5 …
    mel = melody(out)
    assert mel[:4] == [(0, 0.0, 1.0, 72), (0, 1.0, 1.0, 74), (0, 2.0, 1.0, 76), (1, 0.0, 1.0, 77)]
    g = [n for n in notes(out) if n['midi'] == 79]
    assert sum(n['dur'] for n in g if n['bar'] == 1) == 2 and sum(n['dur'] for n in g if n['bar'] == 2) == 2
    assert min(n['on'] for n in g if n['bar'] == 1) == 1 and all(n.get('tie') for n in g[:-1])
    assert any('3/4' in s for s in info['said'])
    assert [m.get('number') for m in ms] == [str(k) for k in range(1, 9)]
    assert ms[-1].find('barline/bar-style').text == 'light-heavy'


def test_time_from_the_middle_keeps_the_bars_before():
    x = six()
    out, _, _ = op(x, op='timesig', bar=2, beats=2, beatType=4)
    ms = part(out).findall('measure')
    assert len(ms) == 2 + 8 and bars(out) and ms[2].find('attributes/time/beats').text == '2'
    assert melody(out)[:5] == melody(x)[:5]


def test_time_with_a_pickup_bars_from_after_it():
    x = score([[ev('R', 3), ev('G4', 1)], [ev('C5', 4)], [ev('D5', 4)]], [[ev('R', 4, 2)], [ev('C3', 4, 2)], [ev('C3', 4, 2)]])
    x, _, _ = op(x, op='pickup', beats=1)
    out, _, _ = op(x, op='timesig', bar=0, beats=2, beatType=4)
    ms = part(out).findall('measure')
    assert ms[0].get('implicit') == 'yes' and len(ms) == 5 and sm.incomplete_bars(root(out)) == []


def test_repeat_signs_on_and_off():
    x = six()
    out, _, _ = op(x, op='repeat', bar=1, kind='start')
    out, _, _ = op(out, op='repeat', bar=3, kind='end')
    p = part(out)
    assert p.findall('measure')[1].find("barline[@location='left']/repeat").get('direction') == 'forward'
    assert p.findall('measure')[3].find("barline[@location='right']/bar-style").text == 'light-heavy'
    assert [b for b, _ in so.play_order(p)] == [0, 1, 2, 3, 1, 2, 3, 4, 5]
    off, _, _ = op(out, op='repeat', bar=3, kind='end')
    assert part(off).findall('measure')[3].find('barline') is None
    off, _, _ = op(off, op='repeat', bar=1, kind='start')
    assert '<repeat' not in off and '<barline location="left"' not in off


def test_endings_play_in_order():
    x = six()
    x, _, _ = op(x, op='repeat', bar=1, kind='start')
    info = {}
    x, _, _ = sm.edit_ex(x, {'op': 'ending', 'bars': [2, 3], 'number': '1'}, info)
    assert any('end repeat' in s for s in info['said'])  # ending 1 goes back: a repeat sign was put
    x, _, _ = op(x, op='ending', bars=[4, 4], number='2')
    p = part(x)
    assert so.endings(p) == [(2, 3, (1,)), (4, 4, (2,))]
    assert so.play_order(p) == [(0, 1), (1, 1), (2, 1), (3, 1), (1, 2), (4, 2), (5, 1)]
    ms = p.findall('measure')
    assert ms[2].find("barline[@location='left']/ending").text == '1.'
    assert ms[4].find("barline[@location='right']/ending").get('type') == 'discontinue'
    # off again
    y, _, _ = op(x, op='ending', bars=[4, 4], number='2')
    assert so.endings(part(y)) == [(2, 3, (1,))]


def test_repeat_without_a_start_goes_back_to_the_beginning_three_times():
    x = six()
    x, _, _ = op(x, op='repeat', bar=1, kind='end', times=3)
    assert [b for b, _ in so.play_order(part(x))] == [0, 1, 0, 1, 0, 1, 2, 3, 4, 5]


def test_sung_verses_follow_the_passes():
    rh = [[ev('C5', 4)], [ev('D5', 4)], [ev('E5', 4)]]
    x = score(rh, [[ev('C3', 4, 2)] for _ in range(3)])
    r = root(x)
    for m, (a, b) in zip(r.find('part').findall('measure')[:2], [('one', 'three'), ('two', 'four')]):
        n = m.find('note')
        for num, w in (('1', a), ('2', b)):
            l = ET.SubElement(n, 'lyric', number=num); ET.SubElement(l, 'syllabic').text = 'single'; ET.SubElement(l, 'text').text = w
    x = sm._head(x) + ET.tostring(r, encoding='unicode')
    x, _, _ = op(x, op='repeat', bar=1, kind='end')
    s = singscore.read(x)
    assert [(n['midi'], n['text']) for n in s['notes'] if n['midi']] == [(72, 'one'), (74, 'two'), (72, 'three'), (74, 'four'), (76, '')]
    assert s['notes'][2]['q'] == 8.0  # the second time through starts after bar 2


def test_through_the_preview(client):
    x = six()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Structure', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'repeat', 'bar': 0, 'kind': 'start'}, {'op': 'repeat', 'bar': 1, 'kind': 'end'}, {'op': 'timesig', 'bar': 2, 'beats': 3, 'beatType': 4},
           {'op': 'keysig', 'bar': 2, 'fifths': 1}, {'op': 'pickup', 'beats': 2}]
    pv = client.post(f'{url}/preview', json={'ops': ops}).json()
    assert not pv['incomplete'], pv['incomplete']
    sv = client.post(url, json={'ops': ops, 'mode': 'this'}).json()
    assert sv['ok']
