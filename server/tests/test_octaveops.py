"""Edit notes → Bar ▾ → 8va / 8vb (octaveops.py): an <octave-shift> start / stop over bars of one staff. Only the
drawing changes: every reader of pitches (notes / play, singing, chords, music21, the OMR bar check) gets the same
notes; a line can be taken off part of its bars, lines of one shift join; preview, Save, Activities and Undo."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest
from fastapi import HTTPException

from meowsic import octaveops as oo
from meowsic import singscore
from meowsic import staffmove as sm
from test_staffmove import ev, score


def op(text, **o): return sm.edit_ex(text, o)[0]
def part(text): return ET.fromstring(text.encode()).find('part')
def lines(text): return [(s['staff'], s['a'], s['z'], s['shift']) for s in oo.spans(part(text))]
def sounds(text): return [(n['bar'], n['staff'], n['on'], n['dur'], n['midi']) for n in sm.notes(ET.fromstring(text.encode()))]


def five():  # a high intro (C6 …) and a low last bass note
    rh = [[ev('C6', 1), ev('D6', 1), ev('E6', 2)], [ev('G6', 4)], [ev('A5', 4)], [ev('G5', 4)], [ev('C5', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('G2', 4, 2)], [ev('F2', 4, 2)], [ev('G2', 4, 2)], [ev('C1', 4, 2)]]
    return score(rh, lh)


def test_8va_writes_a_start_and_stop_and_keeps_every_pitch():
    x = five()
    out = op(x, op='ottava', staff=1, from_bar=0, to_bar=1, shift=8)
    assert lines(out) == [(1, 0, 1, 8)]
    ms = part(out).findall('measure')
    st = ms[0].find('direction/direction-type/octave-shift')
    assert st.attrib == {'type': 'down', 'size': '8', 'number': '1'} and ms[0].find('direction').get('placement') == 'above'
    assert ms[0].find('direction/staff').text == '1'
    kids = list(ms[1])
    stop = next(k for k, e in enumerate(kids) if e.tag == 'direction')
    assert kids[stop].find('direction-type/octave-shift').get('type') == 'stop'
    assert kids[stop - 1].tag == 'note' and kids[stop - 1].findtext('staff') == '1'  # right after the bar's last RH note
    assert sounds(out) == sounds(x)
    assert sm.incomplete_bars(ET.fromstring(out.encode())) == []


def test_8vb_on_the_low_bass_note():
    out = op(five(), op='ottava', staff=2, from_bar=4, to_bar=4, shift=-8)
    assert lines(out) == [(2, 4, 4, -8)]
    d = part(out).findall('measure')[4].find('direction')
    assert d.get('placement') == 'below' and d.find('direction-type/octave-shift').get('type') == 'up' and d.findtext('staff') == '2'
    assert oo.shift_at(part(out), 4, 2) == -12 and oo.shift_at(part(out), 4, 1) == 0 and oo.shift_at(part(out), 3, 2) == 0


def test_every_pitch_reader_is_unchanged():
    x = five()
    out = op(op(x, op='ottava', staff=1, from_bar=0, to_bar=3, shift=8), op='ottava', staff=2, from_bar=4, to_bar=4, shift=-8)
    # the sung voice
    a, b = singscore.read(x), singscore.read(out)
    assert [(n['midi'], n['q']) for n in a['notes']] == [(n['midi'], n['q']) for n in b['notes']]
    # music21 (Simple piano, arrange) reads the line as non-transposing: the same sounding pitches
    from music21 import converter
    p = lambda t: [p.midi for p in converter.parseData(t, format='musicxml').flatten().pitches]
    assert p(out) == p(x)
    # chord detection
    from meowsic import chordfind
    nx, bx, fx, _ = chordfind.read_xml(x.encode())
    no, bo, fo, _ = chordfind.read_xml(out.encode())
    assert no == nx
    assert chordfind.names(chordfind.find_chords(no, bo, fo)) == chordfind.names(chordfind.find_chords(nx, bx, fx))
    # the OMR vote (omr/omr.py, music21): the same melody bar by bar
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location('omr_tool', pathlib.Path(__file__).resolve().parents[2] / 'omr' / 'omr.py')
    omr = importlib.util.module_from_spec(spec); spec.loader.exec_module(omr)
    mel = lambda t: [omr.melody(m) for m in omr.top_part(converter.parseData(t, format='musicxml')).getElementsByClass('Measure')]
    assert mel(out) == mel(x) and mel(x)[0][0] == (0.0, 84)


def test_take_off_part_of_a_line_join_and_toggle():
    x = op(five(), op='ottava', staff=1, from_bar=0, to_bar=1, shift=8)
    x2 = op(x, op='ottava', staff=1, from_bar=2, to_bar=3, shift=8)
    assert lines(x2) == [(1, 0, 3, 8)]  # joined: one line
    x3 = op(x2, op='ottava', staff=1, from_bar=1, to_bar=2, shift=0)
    assert lines(x3) == [(1, 0, 0, 8), (1, 3, 3, 8)]
    x4 = op(x3, op='ottava', staff=1, from_bar=0, to_bar=3, shift=-8)  # another shift over them: replaces
    assert lines(x4) == [(1, 0, 3, -8)]
    back = op(x4, op='ottava', staff=1, from_bar=0, to_bar=3, shift=0)
    assert lines(back) == [] and 'octave-shift' not in back and sounds(back) == sounds(five())
    with pytest.raises(HTTPException): op(back, op='ottava', staff=1, from_bar=0, to_bar=0, shift=0)
    with pytest.raises(HTTPException): op(back, op='ottava', staff=3, from_bar=0, to_bar=0, shift=8)
    with pytest.raises(HTTPException): op(back, op='ottava', staff=1, from_bar=0, to_bar=9, shift=8)
    with pytest.raises(HTTPException): op(back, op='ottava', staff=1, from_bar=0, to_bar=0, shift=7)


def test_reads_lines_from_other_writers():
    # a stop at the start of the next bar (some exporters) ends the line on the bar before; no stop: to the end
    x = five().replace('<measure number="3">', '<measure number="3"><direction><direction-type><octave-shift type="stop" size="8"/></direction-type></direction>', 1)
    x = x.replace('<measure number="1"><attributes>', '<measure number="1"><direction placement="above"><direction-type><octave-shift type="down" size="8"/></direction-type></direction><attributes>', 1)
    assert lines(x) == [(1, 0, 1, 8)]
    y = five().replace('<measure number="4">', '<measure number="4"><direction><direction-type><octave-shift type="down" size="15" number="2"/></direction-type><staff>1</staff></direction>', 1)
    assert lines(y) == [(1, 3, 4, 15)]


def test_notes_edited_under_a_line_keep_it():
    x = op(five(), op='ottava', staff=1, from_bar=0, to_bar=0, shift=8)
    e6 = next(n['ref'] for n in sm.notes(ET.fromstring(x.encode())) if n['midi'] == 88)
    y = op(x, op='len', refs=[e6], q=1)  # the bar is written again (_write_bar): the line stays on it
    assert lines(y) == [(1, 0, 0, 8)]
    # a rest given a note (+ Note) under 8va: the middle of the staff as drawn, an octave up
    r = next(n['ref'] for n in sm.notes(ET.fromstring(y.encode())) if n.get('rest') and n['bar'] == 0 and n['staff'] == 1)
    z = op(y, op='add', refs=[r])
    assert any(n['midi'] == 83 and n['bar'] == 0 for n in sm.notes(ET.fromstring(z.encode())))


def test_through_preview_save_and_undo(client, data):
    x = five()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Octaves', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'ottava', 'staff': 1, 'from_bar': 0, 'to_bar': 3, 'shift': 8}, {'op': 'ottava', 'staff': 2, 'from_bar': 4, 'to_bar': 4, 'shift': -8}]
    p0 = client.post(f'{url}/preview', json={'ops': []}).json()
    pv = client.post(f'{url}/preview', json={'ops': ops, 'sha': p0['sha']}).json()
    assert pv['changed'] and lines(pv['xml']) == [(1, 0, 3, 8), (2, 4, 4, -8)] and not pv['incomplete']
    assert [(n['bar'], n['staff'], n['on'], n['midi']) for n in pv['notes']] == [(n['bar'], n['staff'], n['on'], n['midi']) for n in p0['notes']]
    assert pv['said'] == ['8vb over bar 5']  # the last edit's words
    f = data / 'items' / it['folder'] / it['musicxml']
    was = f.read_text()
    sv = client.post(url, json={'ops': ops, 'mode': 'this', 'sha': pv['sha']}).json()
    assert f.read_text() == pv['xml']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == sv['activity'])
    assert row['type'] == 'edit-notes' and '2 octave lines (8va / 8vb) changed' in row['detail']
    assert client.post(f'/api/activity/{sv["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was


# ---- part of a bar (from_beat / to_beat): One Day More, bar 4 = high intro notes, then two sung pickup 8ths on beat 4
def intro():
    rh = [[ev('C6', 4)], [ev('E6', 4)], [ev('G6', 4)], [ev('C6', 2), ev('D6', 1), ev('G4', 0.5), ev('A4', 0.5)], [ev('B4', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('C3', 4, 2)], [ev('C3', 4, 2)], [ev('G2', 4, 2)], [ev('C3', 4, 2)]]
    return score(rh, lh)


def places(text):
    return [(s['staff'], s['start'], s['end'], s['shift']) for s in oo.spans(part(text))]


def test_a_line_stops_before_the_pickups_and_joins_the_line_before():
    x = op(intro(), op='ottava', staff=1, from_bar=0, to_bar=2, shift=8)
    info = {}
    out = sm.edit_ex(x, {'op': 'ottava', 'staff': 1, 'from_bar': 3, 'to_bar': 3, 'from_beat': 1, 'to_beat': 4, 'shift': 8}, info)[0]
    assert lines(out) == [(1, 0, 3, 8)]  # one line, joined
    assert places(out) == [(1, (0, Fr(0)), (3, Fr(3)), 8)]
    assert out.count('<octave-shift') == 2 and info['said'] == ['8va over bar 4, before beat 4']
    kids = list(part(out).findall('measure')[3])
    k = next(i for i, e in enumerate(kids) if e.tag == 'direction')
    assert kids[k].find('direction-type/octave-shift').get('type') == 'stop'
    assert kids[k - 1].findtext('pitch/step') == 'D' and kids[k + 1].findtext('pitch/step') == 'G'  # after D6, before the pickups
    assert sounds(out) == sounds(intro()) and sm.incomplete_bars(ET.fromstring(out.encode())) == []
    p = part(out)
    m4 = p.findall('measure')[3].findall('note')
    assert [oo.shift_at(p, 3, 1, n) for n in m4[:4]] == [12, 12, 0, 0] and oo.shift_at(p, 3, 2, m4[4]) == 0  # C6, D6 under it; G4 A4 and the bass not


def test_a_line_starts_mid_bar_before_its_note():
    out = op(intro(), op='ottava', staff=1, from_bar=3, to_bar=4, from_beat=2, to_beat=1, shift=8)
    assert places(out) == [(1, (3, Fr(2)), (4, Fr(0)), 8)]  # beat 2 is inside the C6: from the D6 on
    out = op(intro(), op='ottava', staff=1, from_bar=3, to_bar=3, from_beat=3, to_beat=4, shift=8)
    assert places(out) == [(1, (3, Fr(2)), (3, Fr(3)), 8)]
    kids = list(part(out).findall('measure')[3])
    i = [k for k, e in enumerate(kids) if e.tag == 'direction']
    assert [kids[k].find('direction-type/octave-shift').get('type') for k in i] == ['down', 'stop']
    assert kids[i[0] - 1].findtext('pitch/step') == 'C' and kids[i[0] + 1].findtext('pitch/step') == 'D' and kids[i[1] + 1].findtext('pitch/step') == 'G'
    y = op(intro(), op='ottava', staff=1, from_bar=3, to_bar=3, from_beat=2.5, to_beat=4, shift=-8)
    assert places(y) == [(1, (3, Fr(2)), (3, Fr(3)), -8)]
    assert sounds(out) == sounds(y) == sounds(intro())
    with pytest.raises(HTTPException): op(intro(), op='ottava', staff=1, from_bar=3, to_bar=3, from_beat=3, to_beat=3, shift=8)


def test_take_a_line_off_part_of_a_bar():
    x = op(intro(), op='ottava', staff=1, from_bar=0, to_bar=3, shift=8)
    y = op(x, op='ottava', staff=1, from_bar=3, to_bar=3, from_beat=4, shift=0)  # the pickups out from under it
    assert places(y) == [(1, (0, Fr(0)), (3, Fr(3)), 8)]
    assert y == op(op(intro(), op='ottava', staff=1, from_bar=0, to_bar=2, shift=8), op='ottava', staff=1, from_bar=3, to_bar=3, to_beat=4, shift=8)
    z = op(x, op='ottava', staff=1, from_bar=1, to_bar=3, from_beat=3, to_beat=3, shift=0)  # a hole in the middle (beat 3 of bar 2 is inside its whole note: the line keeps that note)
    assert places(z) == [(1, (0, Fr(0)), (2, Fr(0)), 8), (1, (3, Fr(2)), (4, Fr(0)), 8)]
    back = op(z, op='ottava', staff=1, from_bar=1, to_bar=3, from_beat=3, to_beat=3, shift=8)  # filled: one line again
    assert places(back) == [(1, (0, Fr(0)), (4, Fr(0)), 8)] and back.count('<octave-shift') == 2
    assert sounds(z) == sounds(back) == sounds(intro())
    with pytest.raises(HTTPException): op(y, op='ottava', staff=1, from_bar=3, to_bar=3, from_beat=4, shift=0)  # nothing there


def test_edits_under_a_partial_line_keep_it_and_a_rest_after_it_is_plain():
    x = op(intro(), op='ottava', staff=1, from_bar=3, to_bar=3, to_beat=4, shift=8)
    c6 = next(n['ref'] for n in sm.notes(ET.fromstring(x.encode())) if n['midi'] == 84 and n['bar'] == 3)
    y = op(x, op='len', refs=[c6], q=1)  # C6 a quarter: a rest after it, the bar written again
    assert places(y) == [(1, (3, Fr(0)), (3, Fr(3)), 8)]
    r = next(n['ref'] for n in sm.notes(ET.fromstring(y.encode())) if n.get('rest') and n['bar'] == 3 and n['staff'] == 1)
    z = op(y, op='add', refs=[r])  # + Note on the rest under 8va: the staff's middle as drawn (B5)
    assert any(n['midi'] == 83 and n['bar'] == 3 for n in sm.notes(ET.fromstring(z.encode())))
    w = op(intro(), op='ottava', staff=1, from_bar=3, to_bar=3, to_beat=3, shift=8)  # the line ends before D6
    d6 = next(n['ref'] for n in sm.notes(ET.fromstring(w.encode())) if n['midi'] == 86)
    w = op(w, op='delete', refs=[d6])
    assert places(w) == [(1, (3, Fr(0)), (3, Fr(2)), 8)]
    r = next(n['ref'] for n in sm.notes(ET.fromstring(w.encode())) if n.get('rest') and n['bar'] == 3 and n['staff'] == 1)
    w2 = op(w, op='add', refs=[r])  # a rest after the line: B4 as usual
    assert any(n['midi'] == 71 and n['bar'] == 3 for n in sm.notes(ET.fromstring(w2.encode())))


def test_partial_line_pitch_readers_unchanged():
    x = intro()
    out = op(op(x, op='ottava', staff=1, from_bar=0, to_bar=2, shift=8), op='ottava', staff=1, from_bar=3, to_bar=3, to_beat=4, shift=8)
    a, b = singscore.read(x), singscore.read(out)
    assert [(n['midi'], n['q']) for n in a['notes']] == [(n['midi'], n['q']) for n in b['notes']]
    from music21 import converter
    p = lambda t: [p.midi for p in converter.parseData(t, format='musicxml').flatten().pitches]
    assert p(out) == p(x)
