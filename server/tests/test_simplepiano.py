"""Simple piano menu (simplepiano.py): main note only, hands on / off, remove staccato, grace notes & trills (also
the transcription's own), dynamics & pedal; the slider (test_smooth.py); defaults by source; the API (preview,
save into this score with history + undo, save as a new "Simple piano" version) and the make-version job."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest

from meowsic import simplepiano as sp
from test_easerests import full, ties_ok
from test_smooth import merged, n, score, tune

HEARD = {'source': 'YouTube · youtu.be/x', 'sourceUrl': 'https://youtu.be/x'}


def opts(**k):
    return {**sp.defaults(heard=False), **k}


def staccato(x):
    return x.replace('<staff>1</staff>', '<staff>1</staff><notations><articulations><staccato/></articulations></notations>', 1)


def test_remove_staccato():
    x = score([[staccato(n('C5', 1)), n('D5', 3)]], [[n('C3', 4, 2)]])
    out, a, b, found = sp.make(x, opts(main=False, staccato=True))
    assert '<staccato' not in out and found['staccato'] == 1 and full(out) and tune(out) == tune(x)
    out, *_ = sp.make(x, opts(main=False))
    assert '<staccato' in out


def test_slider_lengthening_drops_staccato():
    x = score([[staccato(n('C5', Fr(3, 4))), n('R', Fr(1, 4)), n('D5', 3)]], [[n('C3', 4, 2)]])
    out, *_ = sp.make(x, opts(main=False, level=30))
    assert merged(out)[0] == ('C5', 1) and '<staccato' not in out


def test_remove_grace_notes_trills_and_short_artefacts():
    grace = '<note><grace/><pitch><step>B</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>'
    trill = n('E5', 1).replace('</staff>', '</staff><notations><ornaments><trill-mark/></ornaments></notations>')
    short = n('F5', Fr(1, 8))   # a 32nd right before the G: the transcription's grace note
    x = score([[grace, n('C5', 1), trill, short, n('G5', Fr(15, 8)), ]], [[n('C3', 4, 2)]])
    out, a, b, found = sp.make(x, opts(main=False, grace=True))
    assert found == {'grace': 1, 'ornaments': 1, 'short': 1}
    assert '<grace' not in out and 'trill-mark' not in out and full(out) and ties_ok(out)
    assert merged(out) == [('C5', 1), ('E5', 1), ('G5', 2)]       # the G gets the 32nd's time
    out, *_ = sp.make(x, opts(main=False))
    assert '<grace' in out and 'trill-mark' in out


def test_remove_dynamics_and_pedal():
    d = ('<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>'
         '<direction><direction-type><pedal type="start"/></direction-type></direction>'
         '<direction><direction-type><words>slowly</words></direction-type></direction>')
    x = score([[d + n('C5', 4)]], [[n('C3', 4, 2)]])
    out, _, _, found = sp.make(x, opts(main=False, marks=True))
    assert '<dynamics' not in out and '<pedal' not in out and 'slowly' in out and found['marks'] == 2
    assert '<pedal' in sp.make(x, opts(main=False))[0]


def test_hands_off():
    x = score([[n('C5', 2), n('D5', 2)], [n('E5', 4)]], [[n('C3', 1, 2), n('R', 1, 2), n('G2', 2, 2)], [n('C3', 4, 2)]])
    out, _, _, found = sp.make(x, opts(main=False, left=False))
    assert tune(out) == {'1': ['C5', 'D5', 'E5']} and found['left'] == 3 and full(out)
    out, _, _, found = sp.make(x, opts(main=False, right=False))
    assert tune(out) == {'2': ['C3', 'G2', 'C3']} and full(out)
    with pytest.raises(Exception): sp.settings({'right': False, 'left': False})


def test_main_note_only(tmp_path):
    chord = n('E4', 2) + n('C5', 2).replace('<note>', '<note><chord/>')
    x = score([[chord, n('D5', 2)]], [[n('C3', 2, 2) + n('G3', 2, 2).replace('<note>', '<note><chord/>'), n('G2', 2, 2)]])
    out, *_ = sp.make(x, opts(main=True))
    assert '<chord/>' not in out
    t = tune(out)
    assert t['1'] == ['C5', 'D5'] and t['2'] == ['C3', 'G2']
    assert full(out)


def test_defaults_follow_the_source(client, app):
    x = score([[n('C5', 4)]])
    heard = client.post('/api/items', json={'kind': 'score', 'title': 'A', 'musicxmlText': x, **HEARD}).json()
    sheet = client.post('/api/items', json={'kind': 'score', 'title': 'B', 'musicxmlText': x, 'source': 'From the sheet “B” (photo → score, beta)'}).json()
    a = client.get(f'/api/items/{heard["id"]}/simplepiano').json()
    b = client.get(f'/api/items/{sheet["id"]}/simplepiano').json()
    assert a['allowed'] and b['allowed']
    assert a['defaults']['staccato'] and a['defaults']['level'] > 0 and a['defaults']['grace']
    assert not b['defaults']['staccato'] and b['defaults']['level'] == 0 and not b['defaults']['marks']


@pytest.fixture
def item(client):
    x = score([[staccato(n('C5', Fr(7, 2))), n('D5', Fr(1, 2))], [n('E5', Fr(15, 4)), n('R', Fr(1, 4))]], [[n('C3', 4, 2)], [n('G2', 4, 2)]])
    return client.post('/api/items', json={'kind': 'score', 'title': 'Home NDP', 'musicxmlText': x, 'tags': ['NDP'], **HEARD}).json()


def test_api_preview_save_this_and_undo(client, item, data):
    i = item['id']
    p0 = client.post(f'/api/items/{i}/simplepiano/preview', json={'level': 0, 'main': False, 'staccato': False, 'grace': False}).json()
    assert not p0['changed']
    p = client.post(f'/api/items/{i}/simplepiano/preview', json={'level': 70, 'main': False}).json()
    assert p['changed'] and p['after']['rests'] < p['before']['rests'] and full(p['xml']) and p['found']['staccato'] == 1
    assert client.post(f'/api/items/{i}/simplepiano/preview', json={'level': 101}).status_code == 400
    f = data / 'items' / item['folder'] / item['musicxml']
    was = f.read_text()
    assert client.post(f'/api/items/{i}/simplepiano', json={'level': 70, 'mode': 'this', 'sha': 'nope'}).status_code == 409
    j = client.post(f'/api/items/{i}/simplepiano', json={'level': 70, 'main': False, 'mode': 'this', 'sha': p['sha']}).json()
    assert f.read_text() == p['xml'] and (f.parent / j['history']).read_text() == was and '.history/simple-' in j['history']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert row['type'] == 'simple-piano' and row['action'] == 'undo'
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was


def test_api_save_as_new_version(client, item):
    j = client.post(f'/api/items/{item["id"]}/simplepiano', json={'level': 100, 'mode': 'new'}).json()
    new = j['item']
    assert new['id'] != item['id'] and new['version'] == 'clear' and sp.TAG in new['tags'] and 'NDP' in new['tags']
    assert new['groupId'] and client.get(f'/api/items/{item["id"]}').json()['groupId'] == new['groupId']
    assert full(client.get(f'/api/items/{new["id"]}/musicxml').text)
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{new["id"]}').json().get('deleted')


def test_api_nothing_to_change(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Plain', 'musicxmlText': score([[n('C5', 4)]])}).json()
    assert client.post(f'/api/items/{it["id"]}/simplepiano', json={'level': 50, 'main': False}).status_code == 422
    for old in ('easerests', 'smooth'):
        assert client.post(f'/api/items/{it["id"]}/{old}', json={}).status_code in (404, 405)


def test_make_version_simple_piano_uses_the_defaults(client, data, monkeypatch):
    """Make another version → Simple piano: main note + the menu's defaults (a transcription: smoothed, no staccato)."""
    from test_runners import wait
    monkeypatch.setenv('MEOWSIC_PDF', '0')
    bars = [[staccato(n('C5', Fr(3, 4))), n('R', Fr(1, 4)), n('E4', 3) + n('G4', 3).replace('<note>', '<note><chord/>')]] * 2
    x = score(bars, [[n('C3', Fr(7, 4), 2), n('R', Fr(1, 4), 2), n('G2', 2, 2)]] * 2)
    made = {}
    for name, src in (('heard', HEARD), ('sheet', {})):
        it = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': x, **src}).json()
        j = wait(client, client.post('/api/jobs', json={'kind': 'version', 'title': 'S', 'fromItemId': it['id'], 'outputs': ['clear']}).json()['id'])
        assert j['status'] == 'done', j['log']
        made[name] = client.get(f'/api/items/{j["result"][0]}/musicxml').text
        assert full(made[name]) and '<chord/>' not in made[name]
    assert '<staccato' not in made['heard'] and '<staccato' in made['sheet']
    count = lambda t: sum(1 for _ in ET.fromstring(t.encode()).iter('rest'))
    assert count(made['heard']) < count(made['sheet'])
