"""Fix pages: Later marks, done counts, grouping issues are only hints, saved frames."""
import sqlite3

from meowsic.cleanup import song_state
from tests.test_trim import png, trim


def make(client, n=2):
    files = [('files', (f'{k}.png', png(200 + k, 400), 'image/png')) for k in range(n)]
    return client.post('/api/sheets', data={'title': 'Later me'}, files=files).json()['item']


def song(client, it):
    return client.get('/api/cleanup', params={'id': it['id']}).json()['songs'][0]


def test_later_mark_and_clear(client, data):
    it = make(client, n=2)
    key = f"{it['id']}:1"
    assert client.post('/api/cleanup/later', json={'key': key}).json()['later'] is True
    s = song(client, it)
    assert s['pages'][0]['later'] and not s['pages'][1]['later'] and s['later'] == 1 and s['done'] == 0
    trim(client, it, 1, top=0.1, bottom=0.9)  # crop clears the mark
    s = song(client, it)
    assert not s['pages'][0]['later'] and s['pages'][0]['done'] and s['done'] == 1 and s['later'] == 0
    client.post('/api/cleanup/later', json={'key': f"{it['id']}:2"})
    client.post('/api/cleanup/ok', json={'key': f"{it['id']}:2"})  # keep clears it too
    s = song(client, it)
    assert s['later'] == 0 and s['done'] == 2 and s['pages'][1]['kept']
    c = sqlite3.connect(data / 'meowsic.db')
    log = c.execute('SELECT op FROM page_later_log ORDER BY id').fetchall()
    assert [x[0] for x in log] == ['later', 'cropped', 'later', 'kept']
    # history stays even when the sheet is deleted for good (the marks follow the item)
    client.post('/api/cleanup/later', json={'key': key})
    client.post('/api/items/purge', json={'ids': [it['id']]})
    assert c.execute('SELECT COUNT(*) FROM page_later').fetchone()[0] == 0
    assert c.execute('SELECT COUNT(*) FROM page_later_log').fetchone()[0] == 5
    assert not (data / 'work' / 'cleanup.json').exists()


def test_later_undo(client):
    it = make(client, n=1)
    key = f"{it['id']}:1"
    client.post('/api/cleanup/later', json={'key': key})
    client.post('/api/cleanup/later', json={'key': key, 'undo': True})
    assert not song(client, it)['pages'][0]['later']
    assert client.post('/api/cleanup/later', json={'key': 'nope'}).status_code == 400


def test_state_grouping_is_only_a_hint():
    p = lambda **k: {'trim': None, 'done': False, 'later': False, **k}
    mixed = [{'kind': 'mixed', 'text': ''}]
    assert song_state([p(), p()], mixed) == 'todo'
    assert song_state([p(done=True), p(done=True)], mixed) == 'done'
    assert song_state([p(done=True), p(later=True)], mixed) == 'later'
    assert song_state([p(), p()], []) == 'done'  # nothing found
    assert song_state([p(trim={'x': 1}), p()], [{'kind': 'trim', 'text': ''}]) == 'todo'
    assert song_state([p(trim={'x': 1}, later=True), p()], [{'kind': 'trim', 'text': ''}]) == 'later'
    assert song_state([], []) == 'todo'
    assert song_state([p()], mixed, reviewed=True) == 'done'


def test_frames(client):
    assert client.get('/api/cleanup/frames').json() == {'1': None, '2': None}
    box = {'top': 0.05, 'bottom': 0.94, 'left': 0, 'right': 1}
    assert client.post('/api/cleanup/frames', json={'n': 1, 'box': box}).json()['1'] == box
    assert client.get('/api/cleanup/frames').json() == {'1': box, '2': None}
    assert client.post('/api/cleanup/frames', json={'n': 3, 'box': box}).status_code == 400
    assert client.post('/api/cleanup/frames', json={'n': 2, 'box': {**box, 'top': 0.99}}).status_code == 400
    client.post('/api/cleanup/frames', json={'n': 1, 'box': None})
    assert client.get('/api/cleanup/frames').json()['1'] is None
