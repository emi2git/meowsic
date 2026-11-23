"""Clean up · Suggested names: add, list, accept (renames folder + history), undo, dismiss."""
import json

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
    # accept with an edited title: renamed like PATCH (folder + files follow)
    r = client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'accept', 'title': 'Moon River (Edit)'}).json()
    assert r['status'] == 'accepted' and r['item']['title'] == 'Moon River (Edit)' and r['item']['artist'] == 'Henry Mancini'
    assert 'Moon River (Edit)' in r['item']['folder'] and 'Moon River (Edit) 1' in r['item']['pageFiles'][0]
    assert (data / 'items' / r['item']['folder']).is_dir()
    assert client.get('/api/cleanup/suggest').json() == []
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'accept'}).status_code == 409
    h = [json.loads(x) for x in (data / 'history' / 'renames-cleanup.jsonl').read_text().splitlines()]
    assert h[-1]['old'] == {'title': 'IMG_4821', 'artist': ''} and h[-1]['new'] == {'title': 'Moon River (Edit)', 'artist': 'Henry Mancini'} and h[-1]['at']
    # undo: old name back, suggestion open again, history only grows
    r = client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'undo'}).json()
    assert r['status'] == 'open' and r['item']['title'] == 'IMG_4821' and r['item']['artist'] == ''
    assert 'IMG_4821' in r['item']['folder']
    assert len((data / 'history' / 'renames-cleanup.jsonl').read_text().splitlines()) == 2
    # dismiss: hidden, kept in the json with its status
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'dismiss'}).json()['status'] == 'dismissed'
    assert client.get('/api/cleanup/suggest').json() == []
    saved = json.loads((data / 'work' / 'cleanup.json').read_text())['suggest'][it['id']]
    assert saved['status'] == 'dismissed' and saved['title'] == 'Moon River'
    assert client.get(f'/api/items/{it["id"]}').json()['title'] == 'IMG_4821'
    assert client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'bad'}).status_code == 400
