"""Edit notes: Remove rest (close the gap — the bar is left short and shown; the note before fills it; pull notes from
the next bars), Delete this bar (a whole-bar rest), and short / over-full bars: shown (staffmove.incomplete_bars, also
on load), fixed with Fill with rest or Change time for this bar (its own time signature, the time back on the next)."""
import re
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from test_barnorm import DIV, n, piano
from test_restlen import LYR, full, note, ns, rest_at, run, voice


def rh_len(rh):
    return sum(int(d) for x in rh for d in re.findall(r'<note>(?:(?!<chord/>).)*?<duration>(\d+)</duration>', x))


def score(*bars):
    """bars = [(right hand, left hand)]; the backup is the right hand's own length (a bar may be short or long)."""
    x = piano(bars[0][0], bars[0][1]).replace(f'<backup><duration>{4 * DIV}</duration></backup>', f'<backup><duration>{rh_len(bars[0][0])}</duration></backup>', 1)
    ms = ''.join(f'<measure number="{k + 2}">{"".join(rh)}<backup><duration>{rh_len(rh)}</duration></backup>{"".join(lh)}</measure>'
                 for k, (rh, lh) in enumerate(bars[1:]))
    return x.replace('</measure></part>', '</measure>' + ms + '</part>')


def two_bars(rh1, rh2, lh1=None, lh2=None):
    return score((rh1, lh1 or [n('C3', 4, 2, 5)]), (rh2, lh2 or [n('G3', 4, 2, 5)]))


def bar_voice(t, bar, staff=1):
    return [('R' if x.get('rest') else x['midi'], Fr(x['on']).limit_denominator(64), Fr(x['dur']).limit_denominator(64))
            for x in sorted(ns(t), key=lambda x: (x['on'], x['midi'] or 0)) if x['staff'] == staff and x['bar'] == bar]


def inc(t): return sm.incomplete_bars(ET.fromstring(t.encode()))


def times(t):
    return [[(x.findtext('beats'), x.findtext('beat-type')) for x in m.iter('time')] for m in ET.fromstring(t.encode()).findall('part/measure')]


LH = [n('C3', 4, 2, 5)]


def test_remove_rest_close_the_gap_leaves_the_bar_short_and_shown():
    x = two_bars([n('B4', 4)], [n('C5', 1, extra=LYR), n('R', 1), n('D5', 1), n('E5', 1)], LH, [n('C3', 3, 2, 5), n('R', 1, 2, 5)])
    r = next(y['ref'] for y in ns(x) if y['bar'] == 1 and y['staff'] == 1 and y.get('rest'))
    out, _, _ = run(x, {'op': 'restdel', 'refs': [r]})
    assert bar_voice(out, 1) == [(72, 0, 1), (74, 1, 1), (76, 2, 1)]  # no rest added: 3 of 4 beats
    assert inc(out) == [{'bar': 2, 'have': 3.0, 'need': 4.0, 'over': False, 'words': '3 of 4 beats'}]
    assert ET.fromstring(out.encode()).find('.//lyric/text').text == 'la'
    # Fill with rest: the old way
    out2, _, _ = run(out, {'op': 'fillbar', 'bar': 1})
    assert bar_voice(out2, 1) == [(72, 0, 1), (74, 1, 1), (76, 2, 1), ('R', 3, 1)] and inc(out2) == []
    with pytest.raises(HTTPException): run(out2, {'op': 'fillbar', 'bar': 1})
    # nothing after the rest: refused (the editor offers the other ways)
    y = piano([n('C5', 1), n('D5', 1), n('E5', 1), n('R', 1)], LH)
    with pytest.raises(HTTPException) as e: run(y, {'op': 'restdel', 'refs': [rest_at(y, 1, 3)]})
    assert 'Nothing after this rest' in e.value.detail


def test_change_time_for_this_bar_and_back_on_the_next():
    x = score(([n('B4', 4)], LH), ([n('C5', 1), n('D5', 1), n('E5', 1)], [n('C3', 2, 2, 5), n('E3', 1, 2, 5)]), ([n('F5', 4)], LH))
    assert [b['bar'] for b in inc(x)] == [2]
    out, _, info = run(x, {'op': 'bartime', 'bar': 1})
    assert times(out) == [[('4', '4')], [('3', '4')], [('4', '4')]] and inc(out) == []
    assert 'bar 3 goes back to 4/4' in info['said'][0]
    # the tidy step keeps both (real changes), also after other edits
    out2, _, _ = run(out, {'op': 'pitch', 'refs': [note(out, 1, 77)], 'by': 1})
    out2, _, _ = run(out2, {'op': 'pitch', 'refs': [note(out2, 1, 72)], 'by': 1})  # in the 3/4 bar
    assert times(out2) == times(out)
    # one hand full, the other short: Change time is refused (fill it instead)
    y = score(([n('B4', 4)], LH), ([n('C5', 1), n('D5', 1), n('E5', 1)], LH), ([n('F5', 4)], LH))
    with pytest.raises(HTTPException) as e: run(y, {'op': 'bartime', 'bar': 1})
    assert 'fill it with rests' in e.value.detail


def test_change_time_odd_lengths_and_over_full():
    assert sm._time_for(Fr(3)) == (3, 4) and sm._time_for(Fr(5, 2)) == (5, 8) and sm._time_for(Fr(9, 4)) == (9, 16)
    x = two_bars([n('C5', 4), n('D5', 1)], [n('F5', 4)], [n('C3', 4, 2, 5), n('E3', 1, 2, 5)])  # 5 beats in 4/4
    assert inc(x)[0]['over'] and inc(x)[0]['words'] == '5 of 4 beats'
    out, _, _ = run(x, {'op': 'bartime', 'bar': 0})
    assert times(out) == [[('5', '4')], [('4', '4')]] and inc(out) == []
    # 2.5 and 2 quarters → 5/8; the shorter voice gets rests to its end
    y = score(([n('B4', 4)], LH), ([n('C5', 2), n('D5', 0.5)], [n('C3', 2, 2, 5)]), ([n('F5', 4)], LH))
    out, _, _ = run(y, {'op': 'bartime', 'bar': 1})
    assert times(out)[1] == [('5', '8')] and inc(out) == [] and bar_voice(out, 1, 2) == [(48, 0, 2), ('R', 2, Fr(1, 2))]


def test_pickup_is_exempt():
    assert inc(two_bars([n('C5', 1)], [n('F5', 4)], [n('C3', 1, 2, 5)])) == []


def test_remove_rest_previous_note_fills_it():
    x = piano([n('C5', 1, extra=LYR), n('R', 1), n('D5', 2)], LH)
    out, touched, _ = run(x, {'op': 'restdel', 'refs': [rest_at(x, 1, 1)], 'how': 'fill'})
    assert voice(out, 1) == [(72, 0, 2), (74, 2, 2)] and full(out) and touched == [note(out, 1, 72)]
    y = piano([n('R', 1), n('C5', 1), n('D5', 2)], LH)
    with pytest.raises(HTTPException) as e: run(y, {'op': 'restdel', 'refs': [rest_at(y, 1, 0)], 'how': 'fill'})
    assert 'No note right before' in e.value.detail


def test_remove_rest_ripple_pulls_notes_over_the_bar_line():
    x = two_bars([n('C5', 1), n('D5', 1), n('E5', 1), n('R', 1)], [n('F5', 2, extra=LYR), n('G5', 2)])
    out, _, _ = run(x, {'op': 'restdel', 'refs': [rest_at(x, 1, 3)], 'how': 'ripple'})
    # F5 (half) now starts on beat 4 of bar 1: a quarter there tied to a quarter in bar 2; G5; a rest at the end
    assert bar_voice(out, 0) == [(72, 0, 1), (74, 1, 1), (76, 2, 1), (77, 3, 1)]
    assert bar_voice(out, 1) == [(77, 0, 1), (79, 1, 1), (79, 2, 1), ('R', 3, 1)]  # a half on beat 2: quarter~quarter
    f5 = [e for e in ET.fromstring(out.encode()).iter('note') if sm._midi(e) == 77]
    assert [sorted(t.get('type') for t in e.findall('tie')) for e in f5] == [['start'], ['stop']]
    assert f5[0].find('lyric/text').text == 'la' and f5[1].find('lyric') is None
    assert inc(out) == [] and bar_voice(out, 1, 2) == bar_voice(x, 1, 2)  # the left hand stays


def test_whole_bar_rest_delete_this_bar():
    x = two_bars([n('R', 4)], [n('F5', 4)], [n('R', 4, 2, 5)])
    out, _, _ = run(x, {'op': 'delbar', 'bar': 0})
    ms = ET.fromstring(out.encode()).findall('part/measure')
    assert len(ms) == 1 and ms[0].get('number') == '1'
    a = ms[0].find('attributes')
    assert a is not None and a.findtext('divisions') and a.find('time') is not None and len(a.findall('clef')) == 2
    assert voice(out, 1) == [(77, 0, 4)]
    with pytest.raises(HTTPException): run(out, {'op': 'delbar', 'bar': 0})  # the only bar stays


def test_api_save_with_a_short_bar_says_so(client):
    x = two_bars([n('B4', 4)], [n('C5', 1), n('R', 1), n('D5', 1), n('E5', 1)], LH, [n('C3', 3, 2, 5), n('R', 1, 2, 5)])
    iid = client.post('/api/items', json={'kind': 'score', 'title': 'Short', 'musicxmlText': x}).json()['id']
    r = next(y['ref'] for y in ns(x) if y['bar'] == 1 and y['staff'] == 1 and y.get('rest'))
    ops = [{'op': 'restdel', 'refs': [r]}]
    p = client.post(f'/api/items/{iid}/editnotes/preview', json={'ops': ops}).json()
    assert p['incomplete'][0]['words'] == '3 of 4 beats'
    j = client.post(f'/api/items/{iid}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p['sha']}).json()
    assert j['ok'] and len(j['incomplete']) == 1
    # on load (a preview with no edits) the bar is still shown
    assert client.post(f'/api/items/{iid}/editnotes/preview', json={'ops': []}).json()['incomplete'][0]['bar'] == 2
