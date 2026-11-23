"""Feedback: create, newest first, edit (history kept), soft remove, Claude's status, locked once Fixed / Won't fix."""
import sqlite3
import time


def add(client, text, **kw):
    r = client.post('/api/feedback', json={'text': text, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_create_and_list_newest_first(client):
    a = add(client, 'First thing\nmore detail', device='Mac')
    time.sleep(0.005)
    b = add(client, 'Second thing', device='iPad')
    assert a['status'] == 'new' and a['device'] == 'Mac' and a['createdAt'] and not a['locked']
    rows = client.get('/api/feedback').json()
    assert [r['id'] for r in rows] == [b['id'], a['id']]
    assert rows[1]['text'] == 'First thing\nmore detail'


def test_empty_text_refused(client):
    assert client.post('/api/feedback', json={'text': '   '}).status_code == 400


def test_same_id_twice_is_one_row(client):
    a = add(client, 'Offline note', id='fb-offline1')
    b = add(client, 'Offline note', id='fb-offline1')
    assert a['id'] == b['id'] == 'fb-offline1'
    assert len(client.get('/api/feedback').json()) == 1


def test_edit_keeps_history(client):
    a = add(client, 'Old words')
    r = client.patch(f'/api/feedback/{a["id"]}', json={'text': 'New words'})
    assert r.status_code == 200 and r.json()['text'] == 'New words'
    h = client.get(f'/api/feedback/{a["id"]}').json()['history']
    assert [(x['change'], x['text']) for x in h] == [('edit', 'Old words')]


def test_remove_is_soft(client, data):
    a = add(client, 'Remove me')
    assert client.delete(f'/api/feedback/{a["id"]}').status_code == 200
    assert client.get('/api/feedback').json() == []
    gone = client.get('/api/feedback?removed=1').json()
    assert gone[0]['id'] == a['id'] and gone[0]['removedAt']
    c = sqlite3.connect(data / 'meowsic.db')
    assert c.execute('SELECT text, removed_at IS NOT NULL FROM feedback WHERE id=?', (a['id'],)).fetchone() == ('Remove me', 1)
    assert c.execute("SELECT change FROM feedback_history WHERE feedback_id=?", (a['id'],)).fetchall() == [('remove',)]
    # a removed one is not edited any more
    assert client.patch(f'/api/feedback/{a["id"]}', json={'text': 'x'}).status_code == 409


def test_status_flow_and_lock(client):
    a = add(client, 'Fix the mic')
    r = client.patch(f'/api/feedback/{a["id"]}', json={'status': 'in_progress'}).json()
    assert r['status'] == 'in_progress' and r['fixedAt'] is None
    assert client.patch(f'/api/feedback/{a["id"]}', json={'text': 'Fix the mic please'}).status_code == 200  # still editable
    r = client.patch(f'/api/feedback/{a["id"]}', json={'status': 'fixed', 'fixNote': 'Mic restarts now'}).json()
    assert r['status'] == 'fixed' and r['fixedAt'] and r['fixNote'] == 'Mic restarts now' and r['locked']
    e = client.patch(f'/api/feedback/{a["id"]}', json={'text': 'changed'})
    assert e.status_code == 409
    assert client.delete(f'/api/feedback/{a["id"]}').status_code == 409
    got = client.get(f'/api/feedback/{a["id"]}').json()
    assert got['text'] == 'Fix the mic please' and got['removedAt'] is None
    assert [x['change'] for x in got['history']] == ['status', 'edit', 'status']
    # Claude can still change the status (e.g. reopen)
    assert client.patch(f'/api/feedback/{a["id"]}', json={'status': 'in_progress'}).json()['fixedAt'] is None


def test_wontfix_locked_and_bad_status(client):
    a = add(client, 'Make it purple')
    assert client.patch(f'/api/feedback/{a["id"]}', json={'status': 'done'}).status_code == 400
    assert client.patch(f'/api/feedback/{a["id"]}', json={'status': 'wontfix', 'fixNote': 'Theme stays'}).json()['locked']
    assert client.delete(f'/api/feedback/{a["id"]}').status_code == 409
    assert client.patch(f'/api/feedback/{a["id"]}', json={'text': 'x'}).status_code == 409


def test_missing_is_404(client):
    assert client.patch('/api/feedback/fb-nope', json={'text': 'x'}).status_code == 404
