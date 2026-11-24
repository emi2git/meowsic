"""Manage library → Complete info: the queue of items with no Key / Version, Skip / Don't know marks, suggestions."""
import json

from meowsic.db import folder_path
from test_pages import make


def q(client):
    return client.get('/api/completeinfo').json()


def ids(client):
    return [r['id'] for r in q(client)['items']]


def test_queue_order_marks_and_save(client):
    a = make(client, 'Alpha', ['red'])                       # no key, no version
    b = make(client, 'Bravo', ['blue'])
    client.patch(f'/api/items/{b["id"]}', json={'version': 'piano'})  # only the key missing
    done = make(client, 'Done', ['green'])
    client.patch(f'/api/items/{done["id"]}', json={'version': 'lead', 'key': 'G'})
    unk = make(client, 'Unknown key', ['white'])
    client.patch(f'/api/items/{unk["id"]}', json={'version': 'lead', 'key': 'unknown'})  # "unknown" counts as empty
    sc = client.post('/api/items', json={'kind': 'score', 'title': 'A score', 'key': ''}).json()
    ch = client.post('/api/items', json={'kind': 'chords', 'title': 'Chart', 'text': '[C]hi', 'key': 'C', 'version': 'lead'}).json()

    r = q(client)
    got = {x['id']: x for x in r['items']}
    assert done['id'] not in got and ch['id'] not in got
    assert got[a['id']]['need'] == ['key', 'version'] and got[b['id']]['need'] == ['key'] and got[unk['id']]['need'] == ['key']
    assert got[sc['id']]['need'] == ['key']  # a score's version is its arrangement: only the key
    kinds = [x['kind'] for x in r['items']]
    assert kinds.index('score') > max(i for i, k in enumerate(kinds) if k == 'sheet')  # sheets first
    assert r['count'] == len(r['items']) == client.get('/api/completeinfo/count').json()['count']

    # Skip → to the end; Don't know → hidden (same on every device: it is on the Mac)
    assert client.put(f'/api/completeinfo/{a["id"]}/mark', json={'how': 'skip'}).json()['ok']
    assert ids(client)[-1] == a['id']
    client.put(f'/api/completeinfo/{b["id"]}/mark', json={'how': 'unknown'})
    r = q(client)
    assert b['id'] not in [x['id'] for x in r['items']] and r['hidden'] == 1
    assert client.get('/api/completeinfo/count').json()['count'] == r['count']
    assert client.put(f'/api/completeinfo/{a["id"]}/mark', json={'how': 'nope'}).status_code == 400
    assert client.put('/api/completeinfo/s-nothere/mark', json={'how': 'skip'}).status_code == 404

    # Reset brings the Don't know ones back (skips stay unless all)
    assert client.post('/api/completeinfo/reset', json={}).json()['reset'] == 1
    assert b['id'] in ids(client) and ids(client)[-1] == a['id']
    client.post('/api/completeinfo/reset', json={'all': True})
    assert ids(client)[0] == a['id']  # skip forgotten: back in title order (Alpha first)
    client.delete(f'/api/completeinfo/{a["id"]}/mark')

    # saving through the normal PATCH takes it off the queue, with an Activities row (undo puts it back)
    client.patch(f'/api/items/{a["id"]}', json={'key': 'F#m', 'version': 'accomp'})
    assert a['id'] not in ids(client)
    row = next(x for x in client.get('/api/activity').json() if x.get('action') == 'undo')
    assert client.post(f'/api/activity/{row["id"]}/undo', json={}).status_code == 200
    assert a['id'] in ids(client)


def test_suggestions(client, app, data):
    s1 = make(client, 'Canon In D', ['red'])                 # key from the title
    s2 = make(client, 'Some song', ['navy'])                  # key + version from the cached page reading
    s3 = make(client, 'Piano duet for kids', ['olive'])        # version from the title
    cf = app.state.cfg
    it = client.get(f'/api/items/{s2["id"]}').json()
    p = folder_path(cf, it['folder']) / it['pageFiles'][0]
    lines = [{'text': t, 'x': .1, 'y': y, 'w': .5, 'h': .02, 'conf': 1} for t, y in (('Some Song', .02), ('G   Em   C   D', .2), ('words here', .25))]
    (cf.work_dir).mkdir(exist_ok=True)
    (cf.work_dir / 'metafill-ocr.json').write_text(json.dumps({f'{p}|{p.stat().st_mtime_ns}': {'lines': lines, 'systems': [2, 2, 2, 1]}}))
    got = {x['id']: x['suggest'] for x in q(client)['items']}
    assert got[s1['id']]['key']['value'] == 'D'
    assert got[s2['id']]['key']['value'] == 'G' and 'chord' in got[s2['id']]['key']['why']
    assert got[s2['id']]['version']['value'] == 'piano'
    assert got[s3['id']]['version']['value'] == 'duet'


def test_accomp_is_a_sheet_version(client):
    a = make(client, 'Acc', ['teal'])
    assert client.patch(f'/api/items/{a["id"]}', json={'version': 'Accomp'}).json()['version'] == 'accomp'
    assert client.patch(f'/api/items/{a["id"]}', json={'version': 'banjo'}).status_code == 400


def test_books_and_deleted_are_left_out():
    from meowsic.completeinfo import needs
    base = {'kind': 'sheet', 'key': '', 'version': ''}
    assert needs(base) == ['key', 'version']
    assert needs({**base, 'book': 1}) == [] and needs({**base, 'deleted': True}) == []
    assert needs({**base, 'key': ' ? ', 'version': 'lead'}) == ['key']
    assert needs({'kind': 'score', 'key': 'G major', 'version': 'original'}) == []
