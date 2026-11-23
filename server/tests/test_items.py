"""Items CRUD, trash/restore/purge, tags, plays, annotations, printed, settings, activity, static."""


def test_static_ui_no_store(client):
    r = client.get('/')
    assert r.status_code == 200 and '<html' in r.text.lower()
    assert r.headers['cache-control'] == 'no-store'
    assert client.get('/api/health').headers['cache-control'] == 'no-store'


def test_db_created(client, data):
    assert (data / 'meowsic.db').is_file() and (data / 'items').is_dir()


def test_item_crud(client, chord):
    assert chord['id'].startswith('c-') and chord['tags'] == ['Folk'] and chord['deleted'] is False
    assert chord['text'] == 'A[G]mazing grace' and chord['key'] == 'G'
    r = client.patch(f'/api/items/{chord["id"]}', json={'transpose': 2, 'zoom': 'two', 'capo': 1, 'tags': ['Folk', 'Hymn']})
    it = r.json()
    assert it['transpose'] == 2 and it['zoom'] == 'two' and it['capo'] == 1 and it['tags'] == ['Folk', 'Hymn']
    assert it['updatedAt'] >= chord['updatedAt']
    assert client.patch(f'/api/items/{chord["id"]}', json={'zoom': 1.5}).json()['zoom'] == 1.5
    assert client.get(f'/api/items/{chord["id"]}').json()['title'] == 'Amazing Grace'
    assert [x['id'] for x in client.get('/api/items').json()] == [chord['id']]
    assert client.get('/api/items?kind=sheet').json() == []
    assert client.get('/api/items/nope').status_code == 404
    assert client.post('/api/items', json={'kind': 'bad', 'title': 'x'}).status_code == 400


def test_trash_restore_purge(client, chord, data):
    i = chord['id']
    assert client.post('/api/items/trash', json={'ids': [i]}).json()['count'] == 1
    assert client.get('/api/items').json() == []
    trashed = client.get('/api/items?deleted=true').json()
    assert trashed[0]['deleted'] and trashed[0]['deletedAt']
    client.post('/api/items/restore', json={'ids': i})
    assert len(client.get('/api/items').json()) == 1
    client.post('/api/items/purge', json={'ids': [i]})
    assert client.get(f'/api/items/{i}').status_code == 404
    types = [a['type'] for a in client.get('/api/activity').json()]
    assert types == ['delete', 'restore', 'bin']


def test_tags(client, chord):
    i = chord['id']
    client.post('/api/tags', json={'name': ' Recital '})
    tags = {t['name']: t['count'] for t in client.get('/api/tags').json()}
    assert tags == {'Folk': 1, 'Recital': 0}
    client.post('/api/tags/set', json={'ids': [i], 'add': ['Recital', 'New'], 'remove': ['Folk']})
    assert client.get(f'/api/items/{i}').json()['tags'] == ['Recital', 'New']
    client.patch('/api/tags/Recital', json={'to': 'Piano recital'})
    assert 'Piano recital' in client.get(f'/api/items/{i}').json()['tags']
    client.patch('/api/tags/New', json={'to': 'Piano recital'})  # merge into an existing tag
    assert client.get(f'/api/items/{i}').json()['tags'] == ['Piano recital']
    client.post('/api/tags', json={'name': 'AC/DC'})
    client.delete('/api/tags/AC/DC')
    client.delete('/api/tags/Piano recital')
    assert client.get(f'/api/items/{i}').json()['tags'] == []
    assert [t['name'] for t in client.get('/api/tags').json()] == ['Folk']
    client.post('/api/items/trash', json={'ids': [i]})
    assert client.get('/api/tags').json() == [{'name': 'Folk', 'count': 0}]  # trash does not count


def test_plays(client, chord):
    i = chord['id']
    assert client.post('/api/plays', json={'itemId': i, 'openedAt': 1000, 'closedAt': 5000}).json()['logged'] is False
    assert client.post('/api/plays', json={'itemId': i, 'openedAt': 1000, 'closedAt': 61000}).json()['logged'] is True
    assert client.get('/api/plays').json() == [{'itemId': i, 'openedAt': 1000, 'closedAt': 61000}]
    assert len(client.get(f'/api/plays?item_id={i}').json()) == 1
    it = client.get(f'/api/items/{i}').json()
    assert it['playCount'] == 1 and it['lastPlayed'] == 1000


def test_annotations(client, chord):
    i = chord['id']
    assert client.get(f'/api/items/{i}/annotations/1').json() == []
    s = [{'tool': 'blue', 'pts': [[0.1, 0.2], [0.3, 0.4]]}, {'tool': 'text', 'pts': [[0.5, 0.5]], 'text': 'p', 'color': 'red'}]
    client.put(f'/api/items/{i}/annotations/1', json=s)
    client.put(f'/api/items/{i}/annotations/score-lead', json=[])
    assert client.get(f'/api/items/{i}/annotations/1').json() == s
    assert set(client.get(f'/api/items/{i}/annotations').json()) == {'1', 'score-lead'}
    assert client.get(f'/api/items/{i}').json()['hasStrokes'] is True


def test_printed(client, chord):
    client.post('/api/printed', json={'ids': [chord['id']]})
    assert client.get(f'/api/items/{chord["id"]}').json()['printedAt'] > 0


def test_settings(client):
    assert client.get('/api/settings').json() == {}
    client.put('/api/settings', json={'theme': 'dark', 'zoom': {'a': 1}})
    assert client.put('/api/settings', json={'theme': None}).json() == {'zoom': {'a': 1}}


def test_activity_log(client):
    client.post('/api/activity', json={'type': 'print', 'title': 'Recital', 'detail': '3 items'})
    a = client.get('/api/activity').json()
    assert a[0]['type'] == 'print' and a[0]['detail'] == '3 items' and a[0]['status'] == 'done'


def test_score_musicxml(client, data):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'version': 'lead', 'musicxmlText': '<score>v1</score>'}).json()
    i = it['id']
    assert i.startswith('m-') and it['folder'] == i and it['musicxml'] == f'{i}.musicxml'
    assert client.get(f'/api/items/{i}/musicxml').text == '<score>v1</score>'
    assert client.post(f'/api/items/{i}/musicxml/revert').status_code == 409
    client.put(f'/api/items/{i}/musicxml', content='<score>v2</score>')
    client.put(f'/api/items/{i}/musicxml', content='<score>v3</score>')
    assert client.get(f'/api/items/{i}/musicxml').text == '<score>v3</score>'
    assert client.get(f'/api/items/{i}/musicxml?original=true').text == '<score>v1</score>'
    assert client.get(f'/api/items/{i}').json()['musicxmlOriginal'] == f'{i} (original).musicxml'
    client.post(f'/api/items/{i}/musicxml/revert')
    assert client.get(f'/api/items/{i}/file/{i}.musicxml').text == '<score>v1</score>'
    # a title change moves nothing: folder and files are named by id
    client.patch(f'/api/items/{i}', json={'title': 'Ode to Joy'})
    it = client.get(f'/api/items/{i}').json()
    assert it['title'] == 'Ode to Joy' and (it['folder'], it['musicxml'], it['musicxmlOriginal']) == (i, f'{i}.musicxml', f'{i} (original).musicxml')
    assert sorted(p.name for p in (data / 'items' / i).iterdir()) == [f'{i} (original).musicxml', f'{i}.musicxml']
    assert client.get(f'/api/items/{i}/musicxml').text == '<score>v1</score>'


def test_file_no_traversal(client, data):
    (data / 'secret.txt').write_text('no')
    chord = client.post('/api/items', json={'kind': 'sheet', 'title': 'S'}).json()
    (data / 'items' / chord['folder']).mkdir()
    for bad in ('../../secret.txt', '..%2F..%2Fsecret.txt', '%2e%2e/%2e%2e/secret.txt', '/etc/passwd'):
        r = client.get(f'/api/items/{chord["id"]}/file/{bad}')
        assert r.status_code in (400, 404) and 'no' != r.text
    assert client.get('/api/items/../file/secret.txt').status_code in (400, 404)
    assert client.get('/api/items/..%2F/file/secret.txt').status_code in (400, 404)


def test_client_supplied_id(client):
    r = client.post('/api/items', json={'id': 'c-abc123', 'kind': 'chords', 'title': 'A', 'text': ''}).json()
    assert r['id'] == 'c-abc123' and r['folder'] is None
    again = client.post('/api/items', json={'id': 'c-abc123', 'kind': 'chords', 'title': 'B', 'text': ''}).json()
    assert again['id'] != 'c-abc123' and again['id'].startswith('c-')  # taken -> new id
    for bad in ('s-abc123', 'c-AB', 'c-../x', 'c-' + 'a' * 17):  # wrong prefix / bad shape -> new id
        assert client.post('/api/items', json={'id': bad, 'kind': 'chords', 'title': 'C', 'text': ''}).json()['id'] != bad
    assert client.post('/api/items', json={'id': 'm-x1y2z3', 'kind': 'score', 'title': 'D'}).json()['id'] == 'm-x1y2z3'


def test_folder_names(client):
    from meowsic.db import folder_name
    assert folder_name('s-1', '  ..AC/DC: Live  ') == 's-1' and folder_name('s-1', 'Bèo Dạt Mây Trôi') == 's-1'
    a = client.post('/api/items', json={'kind': 'sheet', 'title': 'Memory'}).json()
    b = client.post('/api/items', json={'kind': 'sheet', 'title': 'Memory'}).json()
    assert a['folder'] == a['id'] and b['folder'] == b['id'] and a['folder'] != b['folder']


def test_old_db_gets_folder_column(tmp_path):
    import sqlite3
    from meowsic.app import create_app
    d = tmp_path / 'M'
    d.mkdir()
    old = sqlite3.connect(d / 'meowsic.db')
    old.execute("CREATE TABLE item (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, zoom TEXT, rate REAL, transpose INTEGER, printed_at INTEGER, legacy_ref TEXT)")
    old.close()
    create_app(d, background=False)
    cols = [r[1] for r in sqlite3.connect(d / 'meowsic.db').execute('PRAGMA table_info(item)')]
    assert 'folder' in cols and 'origin_at' in cols
