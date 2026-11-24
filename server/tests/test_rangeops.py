"""Edit notes range tools (rangeops.py): copy / cut / paste, Repeat, octave on a range, enharmonic respelling,
accidentals (♯ ♭ ♮, courtesy) and the accidental tidy — bars stay full, ties / slurs / lyrics / chord names come
along, one op each through the editor's preview and Save."""
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException

from meowsic import rangeops as ro
from meowsic import staffmove as sm
from test_barops import HARM, bars
from test_staffmove import LH, RH, ev, music, score


def root(text): return ET.fromstring(text.encode())
def op(text, **o): return sm.edit_ex(text, o)
def notes(text): return sm.notes(root(text))


def four():
    """4 bars: bar 1 RH C5 D5 E5 F5 (lyrics la-li-lo-lu, a slur D5→F5), LH C3 whole; bar 2 RH G5 half tied to G5 half
    over…, no: RH G5 A5 B5 C6; bars 3-4 rests in the RH, LH whole notes."""
    rh = [[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('F5', 1)], [ev('G5', 1), ev('A5', 1), ev('B5', 1), ev('C6', 1)],
          [ev('R', 4)], [ev('R', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('G2', 4, 2)], [ev('A2', 4, 2)], [ev('F2', 4, 2)]]
    x = score(rh, lh, harmony=HARM)
    for k, w in enumerate(['la', 'li', 'lo', 'lu']):
        x = x.replace('<staff>1</staff></note>', f'<staff>1</staff><lyric number="1"><text>{w}</text></lyric></note>!', 1)
    x = x.replace('!', '')
    r = root(x)
    m1 = r.find('part/measure')
    ns = [n for n in m1.findall('note') if n.findtext('staff') == '1']
    ET.SubElement(ET.SubElement(ns[1], 'notations'), 'slur', type='start', number='1')
    ET.SubElement(ET.SubElement(ns[3], 'notations'), 'slur', type='stop', number='1')
    return sm._head(x) + ET.tostring(r, encoding='unicode')


def staff_music(text, bar, staff):
    return sorted((n['on'], n['dur'], n['midi']) for n in notes(text) if n['bar'] == bar and n['staff'] == staff and not n.get('rest'))


def test_copy_bar_and_paste_over_a_later_bar_keeps_lyrics_slur_and_chord_name():
    x = four()
    clip = ro.clip_of(x, [0, 0], [1, 0], [1, 2])
    assert clip['notes'] == 5 and clip['staves'] == 2 and clip['bars'] == 1 and clip['whole']
    assert len(clip['harmony']) == 1
    out, refs, gone = op(x, op='paste', at=[2, 0], staff=1, clip=clip)
    assert bars(out) and gone == 0
    assert staff_music(out, 2, 1) == staff_music(x, 0, 1) and staff_music(out, 2, 2) == staff_music(x, 0, 2)
    assert staff_music(out, 3, 1) == [] and staff_music(out, 1, 1) == staff_music(x, 1, 1)
    m3 = root(out).findall('part/measure')[2]
    assert [l.findtext('text') for l in m3.iter('lyric')] == ['la', 'li', 'lo', 'lu']
    assert len(m3.findall('.//slur')) == 2 and m3.find('harmony') is not None
    assert len(refs) == 5


def test_paste_mid_bar_runs_over_the_bar_line_tied_and_adds_bars_at_the_end():
    x = four()
    clip = ro.clip_of(x, [1, 0], [2, 0], [1, 1])  # bar 2's right hand: G5 A5 B5 C6
    out, refs, _ = op(x, op='paste', at=[3, 2], staff=1, clip=clip)  # beat 3 of the last bar: runs a bar over
    assert len(root(out).findall('part/measure')) == 5 and bars(out)
    assert staff_music(out, 3, 1) == [(2.0, 1.0, 79), (3.0, 1.0, 81)]
    assert staff_music(out, 4, 1) == [(0.0, 1.0, 83), (1.0, 1.0, 84)]
    assert staff_music(out, 3, 2) == staff_music(x, 3, 2)  # the left hand stays (not in the clip)


def test_paste_splits_a_long_note_over_the_bar_line_with_a_tie():
    rh = [[ev('C5', 2), ev('E5', 2)], [ev('R', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('C3', 4, 2)]]
    x = score(rh, lh)
    clip = ro.clip_of(x, [0, 2], [1, 0], [1, 1])  # the E5 half note
    out, _, gone = op(x, op='paste', at=[0, 3], staff=1, clip=clip)
    assert bars(out) and gone == 0
    ns = [n for n in notes(out) if n['staff'] == 1 and n['midi'] == 76]
    assert [(n['bar'], n['on'], n['dur']) for n in ns] == [(0, 2.0, 1.0), (0, 3.0, 1.0), (1, 0.0, 1.0)]
    assert not ns[0].get('tie') and ns[1].get('tie')
    # the E5 it was written over is cut: its first beat stays, no tie out of it
    assert [(n['bar'], n['on'], n['dur'], n['midi']) for n in notes(out) if n['staff'] == 1 and n['bar'] == 0 and not n.get('rest')] == \
        [(0, 0.0, 2.0, 72), (0, 2.0, 1.0, 76), (0, 3.0, 1.0, 76)]


def test_cut_leaves_rests_and_takes_chord_names():
    x = four()
    out, _, _ = op(x, op='clear', start=[0, 0], end=[1, 0], staves=[1, 2])
    assert bars(out) and staff_music(out, 0, 1) == [] and staff_music(out, 0, 2) == []
    assert '<harmony>' not in out and '<lyric' not in out and '<slur' not in out
    assert staff_music(out, 1, 1) == staff_music(x, 1, 1)


def test_cut_part_of_a_bar_on_one_staff():
    x = four()
    out, _, _ = op(x, op='clear', start=[0, 1], end=[0, 3], staves=[1, 1])
    assert bars(out) and staff_music(out, 0, 1) == [(0.0, 1.0, 72), (3.0, 1.0, 77)]
    assert '<slur' not in out  # its start (D5) went: the slur goes, not moved
    assert staff_music(out, 0, 2) == staff_music(x, 0, 2)


def test_repeat_a_single_note_and_a_range():
    x = four()
    # one note: the D5 repeated right after itself (over the E5)
    clip = ro.clip_of(x, [0, 1], [0, 2], [1, 1])
    out, refs, _ = op(x, op='paste', at=[0, 2], staff=1, clip=clip)
    assert staff_music(out, 0, 1) == [(0.0, 1.0, 72), (1.0, 1.0, 74), (2.0, 1.0, 74), (3.0, 1.0, 77)] and bars(out)
    # bars 1–2, both staves, repeated after bar 2: written over bars 3–4
    clip = ro.clip_of(x, [0, 0], [2, 0], [1, 2])
    out, refs, _ = op(x, op='paste', at=[2, 0], staff=1, clip=clip)
    assert staff_music(out, 2, 1) == staff_music(x, 0, 1) and staff_music(out, 3, 1) == staff_music(x, 1, 1)
    assert staff_music(out, 3, 2) == staff_music(x, 1, 2) and len(root(out).findall('part/measure')) == 4 and bars(out)


def test_paste_onto_the_lower_staff_leaves_out_what_has_no_staff():
    x = four()
    clip = ro.clip_of(x, [0, 0], [1, 0], [1, 2])
    info = {}
    out, _, _ = sm.edit_ex(x, {'op': 'paste', 'at': [2, 0], 'staff': 2, 'clip': clip}, info)
    assert staff_music(out, 2, 2) == staff_music(x, 0, 1) and bars(out)
    assert any('left out' in s for s in info['said'])


def test_ties_leaving_the_clip_go():
    rh = [[ev('C5', 2), ev('E5', 2)], [ev('E5', 4)]]
    x = score(rh, [[ev('C3', 4, 2)], [ev('C3', 4, 2)]])
    r = root(x)
    e1 = [n for n in r.iter('note') if n.findtext('pitch/step') == 'E']
    sm._add_tie(e1[0], 'start'); sm._add_tie(e1[1], 'stop')
    x = sm._head(x) + ET.tostring(r, encoding='unicode')
    clip = ro.clip_of(x, [0, 0], [1, 0], [1, 1])
    assert 'tie' not in str(clip['voices'])
    clip2 = ro.clip_of(x, [0, 0], [2, 0], [1, 1])
    assert 'type="start"' in str(clip2['voices'])


def test_octave_on_a_range_and_a_chord():
    x = four()
    rs = [n['ref'] for n in notes(x) if n['bar'] in (0, 1) and n['staff'] == 1 and not n.get('rest')]
    out, _, _ = op(x, op='pitch', refs=rs, by=12)
    assert [m for _, _, m in staff_music(out, 0, 1)] == [84, 86, 88, 89] and bars(out)
    assert '<lyric' in out and '<slur' in out


def test_respell_cycles_the_spellings_of_one_pitch():
    rh = [[ev('C#5', 1), ev('C5', 1), ev('R', 2)]]
    x = score(rh, [[ev('C3', 4, 2)]])
    ref = notes(x)[0]['ref']
    seen = []
    for k in range(4):
        x, _, _ = op(x, op='respell', refs=[ref])
        p = root(x).find('part/measure/note/pitch')
        seen.append((p.findtext('step'), p.findtext('alter') or '0'))
    assert seen == [('D', '-1'), ('B', '2'), ('C', '1'), ('D', '-1')]
    assert music(x) == music(score(rh, [[ev('C3', 4, 2)]]))  # the sound never changes
    assert ro.spellings(60)[:2] == [('C', 0, 4), ('B', 1, 3)]


def test_accidental_sharp_flat_natural_and_courtesy():
    x = score([[ev('F5', 1), ev('F5', 1), ev('R', 2)]], [[ev('C3', 4, 2)]])
    r0 = notes(x)[0]['ref']
    out, _, _ = op(x, op='accidental', refs=[r0], alter=1)
    ns = root(out).find('part/measure').findall('note')
    assert ns[0].findtext('pitch/alter') == '1' and ns[0].findtext('accidental') == 'sharp'
    assert ns[1].findtext('accidental') == 'natural'  # the next F5 needs its natural now
    out2, _, _ = op(out, op='accidental', refs=[r0], alter=0)
    assert '<accidental' not in out2  # all naturals again: nothing to show
    out3, _, _ = op(x, op='courtesy', refs=[notes(x)[1]['ref']])
    a = root(out3).find('part/measure').findall('note')[1].find('accidental')
    assert a is not None and a.get('parentheses') == 'yes' and a.text == 'natural'
    out4, _, _ = op(out3, op='courtesy', refs=[notes(x)[1]['ref']])
    assert '<accidental' not in out4


def test_redundant_accidentals_go_after_an_edit():
    x = score([[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('R', 1)]], [[ev('C3', 4, 2)]])
    x = x.replace('<step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type>',
                  '<step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><accidental>natural</accidental>')
    assert '<accidental>natural' in x
    out, _, _ = op(x, op='pitch', refs=[notes(x)[0]['ref']], by=1)  # C5 → C♯5 in the same bar
    m = root(out).find('part/measure')
    acc = [(n.findtext('pitch/step'), n.findtext('accidental')) for n in m.findall('note') if n.find('pitch') is not None and n.findtext('staff') == '1']
    assert acc == [('C', 'sharp'), ('D', None), ('E', None)]


def test_through_the_preview_endpoint(client):
    x = four()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Range', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    cl = client.post(f'{url}/clip', json={'ops': [], 'start': [0, 0], 'end': [1, 0], 'staves': [1, 2]})
    assert cl.status_code == 200
    clip = cl.json()['clip']
    ops = [{'op': 'paste', 'at': [2, 0], 'staff': 1, 'clip': clip}]
    pv = client.post(f'{url}/preview', json={'ops': ops}).json()
    assert len(pv['moved']) == 5 and not pv['incomplete']
    # copy after an edit: the clip is the edited score's
    cl2 = client.post(f'{url}/clip', json={'ops': [{'op': 'pitch', 'refs': [notes(x)[0]['ref']], 'by': 12}], 'start': [0, 0], 'end': [0, 1], 'staves': [1, 1]}).json()['clip']
    assert '<octave>6</octave>' in cl2['voices'][0]['evs'][0]['notes'][0]
    sv = client.post(url, json={'ops': ops + [{'op': 'clear', 'start': [0, 0], 'end': [1, 0], 'staves': [1, 1]}], 'mode': 'this'}).json()
    assert sv['ok']
    acts = client.get('/api/activities').json() if client.get('/api/activities').status_code == 200 else None
    saved = client.get(f'/api/items/{it["id"]}/musicxml').text
    assert staff_music(saved, 0, 1) == [] and staff_music(saved, 2, 1) == staff_music(x, 0, 1)


def test_paste_needs_a_clip():
    with pytest.raises(HTTPException):
        op(four(), op='paste', at=[0, 0], staff=1, clip={})
