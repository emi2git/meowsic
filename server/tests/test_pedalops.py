"""Edit notes op 'unpedal' (pedalops.py): every pedal mark off, nothing else changes; preview, Save, Activities, Undo."""
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from test_staffmove import ev, score

PED = ('<direction placement="below"><direction-type><pedal type="{t}" line="no" sign="{s}"/></direction-type>'
       '<staff>{st}</staff><sound damper-pedal="{d}"/></direction>')
WORDS = '<direction placement="above"><direction-type><words>cresc.</words></direction-type><staff>1</staff></direction>'
DYN = '<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff><sound dynamics="50"/></direction>'


def op(text, **o): return sm.edit_ex(text, o)[0]
def tags(text): return [e.tag for e in ET.fromstring(text.encode()).iter()]
def pitches(text): return [(n['bar'], n['staff'], n['on'], n['dur'], n['midi']) for n in sm.notes(ET.fromstring(text.encode()))]


def pedalled():
    rh = [[WORDS, DYN, ev('C5', 4)], [ev('D5', 4)], [ev('E5', 4)]]
    lh = [[PED.format(t='start', s='yes', st=2, d='yes'), ev('C3', 4, 2)],
          [PED.format(t='change', s='yes', st=2, d='yes'), ev('G2', 4, 2)],
          [ev('C3', 4, 2), PED.format(t='stop', s='yes', st=2, d='no')]]
    return score(rh, lh)


def test_removes_every_pedal_and_keeps_the_rest():
    x = pedalled()
    assert tags(x).count('pedal') == 3
    y = op(x, op='unpedal')
    t = tags(y)
    assert 'pedal' not in t and 'damper-pedal' not in y
    assert t.count('direction') == 2 and 'words' in t and 'dynamics' in t and 'dynamics="50"' in y
    assert pitches(y) == pitches(x)


def test_mixed_direction_keeps_its_other_marks():
    mixed = ('<direction placement="below"><direction-type><pedal type="start" sign="yes"/></direction-type>'
             '<direction-type><words>legato</words></direction-type><staff>2</staff></direction>')
    x = score([[ev('C5', 4)]], [[mixed, ev('C3', 4, 2)]])
    y = op(x, op='unpedal')
    assert 'pedal' not in tags(y) and 'words' in tags(y) and tags(y).count('direction') == 1


def test_only_one_staff_and_none_left_is_refused():
    x = pedalled()
    with pytest.raises(HTTPException): op(x, op='unpedal', staff=1)
    y = op(x, op='unpedal', staff=2)
    assert 'pedal' not in tags(y)
    with pytest.raises(HTTPException): op(y, op='unpedal')


def test_through_preview_save_and_undo(client, data):
    x = pedalled()
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Pedals', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'unpedal'}]
    p0 = client.post(f'{url}/preview', json={'ops': []}).json()
    pv = client.post(f'{url}/preview', json={'ops': ops, 'sha': p0['sha']}).json()
    assert pv['changed'] and 'pedal' not in tags(pv['xml']) and pv['said'] == ['3 pedal marks removed']
    f = data / 'items' / it['folder'] / it['musicxml']
    was = f.read_text()
    sv = client.post(url, json={'ops': ops, 'mode': 'this', 'sha': pv['sha']}).json()
    assert f.read_text() == pv['xml']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == sv['activity'])
    assert row['type'] == 'edit-notes' and 'pedal marks removed' in row['detail']
    assert client.post(f'/api/activity/{sv["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was
