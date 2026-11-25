"""Edit notes → Bar ▾ → Clef (structops 'clef'): a clef from a bar on, or over bars with the old clef back after,
replacing one already there, on either staff; through preview, Save (Activities) and Undo."""
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from meowsic.barnorm import tidy_score
from test_structops import six, melody, notes


def op(text, **o): return sm.edit_ex(text, o)[0]


def clefs(text, staff):
    """[(bar, sign)] where the staff's clef is written (a change), in order."""
    out = []
    for bi, m in enumerate(ET.fromstring(text.encode()).find('part').findall('measure')):
        for a in m.findall('attributes'):
            for c in a.findall('clef'):
                if (c.get('number') or '1') == str(staff): out.append((bi, c.findtext('sign')))
    return out


def in_force(text, staff):
    """The staff's clef sign in each bar."""
    ch, cur, out = dict(clefs(text, staff)), None, []
    for bi in range(len(ET.fromstring(text.encode()).find('part').findall('measure'))):
        cur = ch.get(bi, cur); out.append(cur)
    return out


def test_clef_from_a_bar_on_carries_forward():
    x = six()
    out = op(x, op='clef', bar=2, staff=2, clef='treble')
    assert clefs(out, 2) == [(0, 'F'), (2, 'G')]
    assert in_force(out, 2) == ['F', 'F', 'G', 'G', 'G', 'G'] and in_force(out, 1) == ['G'] * 6
    assert melody(out) == melody(x) and [n['midi'] for n in notes(out)] == [n['midi'] for n in notes(x)]
    m = ET.fromstring(out.encode()).find('part').findall('measure')[2]
    assert m.find('attributes/clef').get('number') == '2' and m[0].tag == 'attributes'


def test_range_restores_the_clef_after_it():
    x = six()
    out = op(x, op='clef', bar=0, until=3, staff=2, clef='treble')  # bars 1–4 treble, bass again at bar 5
    assert clefs(out, 2) == [(0, 'G'), (4, 'F')]
    assert in_force(out, 2) == ['G'] * 4 + ['F'] * 2
    assert clefs(out, 1) == [(0, 'G')]
    # the same range again: nothing new, no doubled clefs
    again = op(out, op='clef', bar=0, until=3, staff=2, clef='treble')
    assert clefs(again, 2) == clefs(out, 2)
    # a range to the last bar: nothing to restore
    assert clefs(op(x, op='clef', bar=3, until=5, staff=2, clef='treble'), 2) == [(0, 'F'), (3, 'G')]


def test_range_takes_the_changes_inside_it_and_restores_what_was_in_force():
    x = op(six(), op='clef', bar=2, staff=2, clef='treble')  # bass, treble from bar 3
    out = op(x, op='clef', bar=1, until=3, staff=2, clef='bass')  # bars 2–4 bass: the bar-3 change goes, treble at bar 5
    assert clefs(out, 2) == [(0, 'F'), (4, 'G')]
    # restoring onto a bar that already has its own clef: that one stays
    y = op(six(), op='clef', bar=4, staff=2, clef='treble')
    out2 = op(y, op='clef', bar=1, until=3, staff=2, clef='treble')
    assert clefs(out2, 2) == [(0, 'F'), (1, 'G')]


def test_replaces_the_clef_already_there_and_tidy_keeps_real_changes():
    x = op(six(), op='clef', bar=2, staff=2, clef='treble')
    out = op(x, op='clef', bar=2, staff=2, clef='bass')  # back: the change is gone, not doubled
    assert clefs(out, 2) == [(0, 'F')]
    out = op(x, op='clef', bar=0, staff=2, clef='treble')  # the change at bar 3 is now a repeat: tidied away
    assert clefs(out, 2) == [(0, 'G')]
    y = op(op(six(), op='clef', bar=0, until=1, staff=2, clef='treble'), op='clef', bar=4, until=4, staff=2, clef='treble')
    root = ET.fromstring(y.encode())
    st = tidy_score(root)
    assert st['clef'] == 0 and clefs(y, 2) == [(0, 'G'), (2, 'F'), (4, 'G'), (5, 'F')]
    assert sum(len(m.findall('attributes/clef')) for m in root.iter('measure')) == 5


def test_top_staff_and_one_staff_scores():
    out = op(six(), op='clef', bar=1, until=2, staff=1, clef='bass')
    assert clefs(out, 1) == [(0, 'G'), (1, 'F'), (3, 'G')] and clefs(out, 2) == [(0, 'F')]
    one = ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">'
           '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure>'
           '<measure number="2"><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>')
    out = op(one, op='clef', bar=1, staff=1, clef='bass')
    m2 = ET.fromstring(out.encode()).find('part').findall('measure')[1]
    assert clefs(out, 1) == [(0, 'G'), (1, 'F')] and m2.find('attributes/clef').get('number') is None


def test_bad_clef_ops_are_refused():
    x = six()
    for o in ({'bar': 0, 'staff': 3, 'clef': 'treble'}, {'bar': 0, 'staff': 1, 'clef': 'alto'}, {'bar': 9, 'staff': 1, 'clef': 'bass'},
              {'bar': 3, 'until': 1, 'staff': 1, 'clef': 'bass'}):
        with pytest.raises(HTTPException): op(x, op='clef', **o)


def test_clef_through_preview_save_and_undo(client):
    x = six()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Clefs', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'clef', 'bar': 0, 'until': 3, 'staff': 2, 'clef': 'treble'}]
    pv = client.post(f'{url}/preview', json={'ops': ops}).json()
    assert clefs(pv['xml'], 2) == [(0, 'G'), (4, 'F')] and not pv['incomplete']
    sv = client.post(url, json={'ops': ops, 'mode': 'this', 'sha': pv['sha']}).json()
    assert sv['ok']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == sv['activity'])
    assert '1 clef change' in row['detail']
    assert clefs(client.post(f'{url}/preview', json={'ops': []}).json()['xml'], 2) == [(0, 'G'), (4, 'F')]
    assert client.post(f'/api/activity/{sv["activity"]}/undo', json={}).status_code == 200
    assert clefs(client.post(f'{url}/preview', json={'ops': []}).json()['xml'], 2) == [(0, 'F')]
