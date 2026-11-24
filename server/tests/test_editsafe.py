"""Edit notes never loses edits (editsafe.py + staffmove.save): a save on a score changed meanwhile merges (rebase)
or keeps the full edit as "<title> (my edits)"; an open editor locks other API writes (423); drafts live on disk
and survive a server restart."""
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from meowsic import staffmove as sm
from meowsic.app import create_app

from test_staffmove import LH, RH, score

H = {'X-Edit-Session': 'sess-user-1'}


@pytest.fixture
def piano(client):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'musicxmlText': score(RH, LH), 'tags': ['Kids']}).json()


def music(text):
    return sorted((n['bar'], n['staff'], n['on'], n['midi']) for n in sm.notes(ET.fromstring(text.encode())) if not n.get('rest'))


def ref_of(notes, bar, midi):
    return next(n['ref'] for n in notes if n['bar'] == bar and n['midi'] == midi)


def xml(client, i): return client.get(f'/api/items/{i}/musicxml').text


def opened(client, i):
    return client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()


def test_merge_clean_with_newer_change(client, piano):
    i = piano['id']
    p0 = opened(client, i)  # the user opens Edit notes
    user = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 79)], 'by': 2}]  # bar 2: G5 -> A5
    mine = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': user, 'sha': p0['sha']}).json()
    # meanwhile another client changes bar 1 (D5 -> D#5) and adds a note there: every later ref shifts
    a = opened(client, i)
    other = [{'op': 'pitch', 'refs': [ref_of(a['notes'], 0, 74)], 'by': 1}, {'op': 'add', 'refs': [ref_of(a['notes'], 0, 72)], 'by': 2}]
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': other, 'mode': 'this', 'sha': a['sha']}).status_code == 200
    theirs = xml(client, i)
    # the user's preview still replays on the score as it opened it
    again = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': user, 'sha': p0['sha']}).json()
    assert again['xml'] == mine['xml']
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': user, 'mode': 'this', 'sha': p0['sha']})
    assert j.status_code == 200, j.text
    j = j.json()
    assert j['merged'] and j['applied'] == 1 and not j['failed'] and 'copy' not in j and 'merged' in j['message']
    now = music(xml(client, i))
    assert (1, 1, 0.0, 81) in now and (1, 1, 0.0, 79) not in now  # the user's edit
    assert (0, 1, 1.0, 75) in now and len(now) == len(music(theirs))  # theirs stayed
    row = next(r for r in client.get('/api/activity').json() if r['id'] == j['activity'])
    assert 'merged with a newer change' in row['detail']


def test_conflict_keeps_full_edit_as_copy(client, piano):
    i = piano['id']
    p0 = opened(client, i)
    user = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 0, 74)], 'by': -2},   # bar 1 — also changed by the other client
            {'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 77)], 'by': 1}]    # bar 2 — merges
    mine = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': user, 'sha': p0['sha']}).json()['xml']
    a = opened(client, i)
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': [{'op': 'pitch', 'refs': [ref_of(a['notes'], 0, 74)], 'by': 1}], 'mode': 'this', 'sha': a['sha']}).status_code == 200
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': user, 'mode': 'this', 'sha': p0['sha']}).json()
    assert j['merged'] and j['applied'] == 1 and j['failed'] == 1
    cp = j['copy']
    assert cp['title'] == 'Ode (my edits)' and cp['groupId'] == j['item']['groupId']
    assert music(xml(client, cp['id'])) == music(mine)  # nothing of the user's edit lost
    now = music(xml(client, i))
    assert (0, 1, 1.0, 75) in now and (1, 1, 1.0, 78) in now  # theirs + the user's mergeable edit
    assert 'my edits' in j['message'] and 'close the editor' not in j['message']


def test_save_without_base_uses_client_xml(client, piano):
    i = piano['id']
    p0 = opened(client, i)
    ops = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 79)], 'by': 2}]
    mine = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()['xml']
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': 'deadbeefdeadbeef', 'xml': mine}).json()
    assert j['failed'] == 1 and j['copy']['title'] == 'Ode (my edits)' and xml(client, j['copy']['id']) == mine


def test_lock_refuses_other_writes(client, piano):
    i = piano['id']
    assert client.post(f'/api/items/{i}/editsession', json={'session': 'sess-user-1'}).json()['ok']
    assert client.get(f'/api/items/{i}/editsession').json()['active']
    p0 = opened(client, i)  # reads go ahead
    ops = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 79)], 'by': 2}]
    r = client.put(f'/api/items/{i}/musicxml', content=score(RH, LH))
    assert r.status_code == 423 and 'Edit notes is open' in r.json()['detail']
    for path, body in ((f'/api/items/{i}/editnotes', {'ops': ops, 'mode': 'this'}), (f'/api/items/{i}/lyrics', {}),
                       (f'/api/items/{i}/check', {'bar': 1, 'action': 'ok'}), (f'/api/items/{i}/simplepiano', {}),
                       (f'/api/items/{i}/musicxml/revert', {}), ('/api/items/trash', {'ids': [i]}),
                       ('/api/jobs', {'kind': 'lyrics', 'title': 'x', 'fromItemId': i, 'sheetId': 's-x'})):
        r = client.post(path, json=body)
        assert r.status_code == 423, (path, r.status_code, r.text)
    assert client.patch(f'/api/items/{i}', json={'title': 'X'}).status_code == 423
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p0['sha'], 'session': 'sess-user-1'},
                       headers={'X-Edit-Session': 'sess-other'}).status_code == 423
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p0['sha']}, headers=H)  # the editor itself
    assert j.status_code == 200
    assert client.post(f'/api/items/{i}/editsession/end', content=b'{"session": "sess-user-1"}').status_code == 200
    assert not client.get(f'/api/items/{i}/editsession').json()['active']
    assert client.patch(f'/api/items/{i}', json={'title': 'Ode 2'}).status_code == 200


def test_lock_lapses_without_heartbeat(client, piano, app):
    i = piano['id']
    client.post(f'/api/items/{i}/editsession', json={'session': 'sess-user-1'})
    assert client.patch(f'/api/items/{i}', json={'title': 'X'}).status_code == 423
    c = app.state.connect(); c.execute('UPDATE edit_session SET beat_at=beat_at-200000'); c.commit(); c.close()
    assert client.patch(f'/api/items/{i}', json={'title': 'X'}).status_code == 200


def test_drafts_on_disk_survive_restart_and_go_on_save(client, piano, data):
    i = piano['id']
    p0 = opened(client, i)
    ops = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 79)], 'by': 2}]
    r = client.post(f'/api/items/{i}/editnotes/draft', json={'session': 'sess-user-1', 'sha': p0['sha'], 'ops': ops, 'xml': '<score-partwise/>'})
    assert r.status_code == 200
    assert (data / 'drafts' / i / 'draft-sess-user-1.json').is_file() and (data / 'drafts' / i / 'draft-sess-user-1.musicxml').is_file()
    assert client.get(f'/api/items/{i}/editsession').json()['active']  # a draft is a heartbeat too
    # another client changes the score; then the server restarts
    c = client.app.state.connect(); c.execute('DELETE FROM edit_session'); c.commit(); c.close()
    a = opened(client, i)
    client.post(f'/api/items/{i}/editnotes', json={'ops': [{'op': 'pitch', 'refs': [ref_of(a['notes'], 0, 74)], 'by': 1}], 'mode': 'this', 'sha': a['sha']})
    client.post(f'/api/items/{i}/editsession', json={'session': 'sess-user-1', 'beat': True})
    with TestClient(create_app(data, background=False)) as c2:
        assert c2.get(f'/api/items/{i}/editsession').json()['active']  # the lock is in the DB
        ds = c2.get(f'/api/items/{i}/editnotes/draft').json()['drafts']
        assert len(ds) == 1 and ds[0]['session'] == 'sess-user-1' and ds[0]['n'] == 1 and ds[0]['title'] == 'Ode'
        d = c2.get(f'/api/items/{i}/editnotes/draft/sess-user-1').json()
        assert d['ops'] == ops and d['sha'] == p0['sha']
        pv = c2.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops, 'sha': p0['sha']}, headers=H)  # the base is on disk
        assert pv.status_code == 200
        j = c2.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p0['sha'], 'session': 'sess-user-1'}, headers=H).json()
        assert j['merged'] and j['applied'] == 1
        assert c2.get(f'/api/items/{i}/editnotes/draft').json()['drafts'] == []
    client.post(f'/api/items/{i}/editnotes/draft', json={'session': 'sess-user-2', 'ops': []})
    assert client.delete(f'/api/items/{i}/editnotes/draft').json()['deleted'] == 1


def test_lyrics_by_another_client_then_note_edit(client, piano):
    i = piano['id']
    p0 = opened(client, i)
    ops = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 79)], 'by': 2}]
    a = opened(client, i)
    rh = [n for n in a['notes'] if n['staff'] == 1 and not n.get('rest') and n['bar'] == 0]
    words = {'op': 'lyrics', 'staff': 1, 'verse': 1, 'notes': [{'ref': n['ref'], 'text': 'la', 'syllabic': 'single'} for n in rh[:2]]}
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': [words], 'mode': 'this', 'sha': a['sha']}).status_code == 200
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p0['sha']}).json()
    assert j['applied'] == 1 and not j['failed']
    x = xml(client, i)
    assert x.count('<lyric') == 2 and (1, 1, 0.0, 81) in music(x)
