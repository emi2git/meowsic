"""Clean up · Suggested names: add, list, accept (renames folder + history), undo, dismiss."""
import json
import sqlite3

from test_pages import make


def test_suggest_flow(client, data):
    it = make(client, 'IMG_4821', ['red'])
    assert client.get('/api/cleanup/suggest').json() == []
    assert client.post('/api/cleanup/suggest', json={'id': 'nope', 'title': 'x'}).status_code == 404
    r = client.post('/api/cleanup/suggest', json={'id': it['id'], 'title': 'Moon Rivr', 'artist': 'Mancini', 'why': 'photo name'}).json()
    assert r['status'] == 'open'
    client.post('/api/cleanup/suggest', json={'id': it['id'], 'title': 'Moon River', 'artist': 'Henry Mancini', 'why': 'photo name'})  # replaces
    s = client.get('/api/cleanup/suggest').json()
    assert len(s) == 1 and s[0]['title'] == 'IMG_4821' and s[0]['artist'] == ''
    assert s[0]['suggest'] == {'title': 'Moon River', 'artist': 'Henry Mancini'} and s[0]['why'] == 'photo name'
    # accept with an edited title: renamed like PATCH (files are named by id: nothing moves)
    r = client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'accept', 'title': 'Moon River (Edit)'}).json()
    assert r['status'] == 'accepted' and r['item']['title'] == 'Moon River (Edit)' and r['item']['artist'] == 'Henry Mancini'
    assert r['item']['folder'] == it['id'] and r['item']['pageFiles'] == it['pageFiles']
    assert (data / 'items' / r['item']['folder'] / it['pageFiles'][0]).is_file()
    assert client.get('/api/cleanup/suggest').json() == []
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'accept'}).status_code == 409
    h = [json.loads(x) for x in (data / 'history' / 'renames-cleanup.jsonl').read_text().splitlines()]
    assert h[-1]['old'] == {'title': 'IMG_4821', 'artist': ''} and h[-1]['new'] == {'title': 'Moon River (Edit)', 'artist': 'Henry Mancini'} and h[-1]['at']
    # undo: old name back, suggestion open again, history only grows
    r = client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'undo'}).json()
    assert r['status'] == 'open' and r['item']['title'] == 'IMG_4821' and r['item']['artist'] == ''
    assert len((data / 'history' / 'renames-cleanup.jsonl').read_text().splitlines()) == 2
    # dismiss: hidden, kept in the database with its status
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'dismiss'}).json()['status'] == 'dismissed'
    assert client.get('/api/cleanup/suggest').json() == []
    c = sqlite3.connect(data / 'meowsic.db')
    rows = c.execute('SELECT title, status, undone_at IS NOT NULL FROM name_suggestion WHERE item_id=? ORDER BY id', (it['id'],)).fetchall()
    # every step stays: the replaced one, the accept that was undone, the dismissed one
    assert rows == [('Moon Rivr', 'replaced', 0), ('Moon River', 'accepted', 1), ('Moon River', 'dismissed', 0)]
    assert client.get(f'/api/items/{it["id"]}').json()['title'] == 'IMG_4821'
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'bad'}).status_code == 400
    # the history stays when the item is deleted for good
    client.post('/api/items/purge', json={'ids': [it['id']]})
    assert c.execute('SELECT COUNT(*) FROM name_suggestion WHERE item_id=?', (it['id'],)).fetchone()[0] == 3
    assert client.get('/api/cleanup/suggest').json() == []
