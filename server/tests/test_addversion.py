"""POST /api/items with fromItemId: a hand-made MusicXML saved as a new version of a score (same song, Activities + Undo)."""
from meowsic.db import credit_xml

XML = ('<?xml version="1.0"?><score-partwise version="4.0"><identification>{c}</identification>'
       '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1">'
       '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
       '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>')
SRC = XML.format(c='<creator type="composer">Jane Composer</creator><creator type="arranger">Transcribed by Meowsic</creator>')
PRO = XML.format(c='<creator type="composer">Jane Composer</creator><creator type="arranger">Transcribed by Meowsic</creator>')


def _score(client, **kw):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Song A', 'source': 'YouTube', 'sourceUrl': 'https://youtu.be/x',
                                           'key': 'G', 'bpm': 90, 'tags': ['Folk', 'Notes edited'], 'musicxmlText': SRC, **kw}).json()


def _acts(client):
    a = client.get('/api/activity').json()
    return a if isinstance(a, list) else a.get('activities', a.get('items', []))


def test_version_links_logs_and_undoes(client, data):
    src = _score(client)
    assert not src.get('groupId')
    before = client.get(f'/api/items/{src["id"]}').json()
    r = client.post('/api/items', json={'fromItemId': src['id'], 'version': 'pro', 'musicxmlText': PRO})
    assert r.status_code == 201, r.text
    new = r.json()
    after = client.get(f'/api/items/{src["id"]}').json()
    # same song: a group made for the source, its Last modified untouched
    assert after['groupId'] and new['groupId'] == after['groupId'] and after['updatedAt'] == before['updatedAt']
    assert new['id'] != src['id'] and new['kind'] == 'score' and new['version'] == 'pro' and new['title'] == 'Song A'
    assert new['source'] == 'From the score “Song A”, pro version' and new['sourceUrl'] == 'https://youtu.be/x'
    assert new['key'] == 'G' and new['bpm'] == 90 and 'Folk' in new['tags'] and 'Notes edited' not in new['tags']
    # credits: composer kept, "Transcribed by Meowsic" kept, "Arranged by Meowsic" added
    x = (data / 'items' / new['folder'] / new['musicxml']).read_text()
    assert ('<creator type="composer">Jane Composer</creator><creator type="arranger">Transcribed by Meowsic</creator>'
            '<creator type="arranger">Arranged by Meowsic</creator>') in x and x.count('<creator') == 3
    assert credit_xml(x, None, 'Arranged by Meowsic') == x  # POST /credit has nothing to change
    assert client.post(f'/api/items/{new["id"]}/credit').json()['files'] == []
    # Activities row + Undo (moves the new score to the Trash)
    row = next(a for a in _acts(client) if a['id'] == new['activity'])
    assert row['type'] == 'add-version' and 'Song A' in row['title']
    u = client.post(f'/api/activity/{new["activity"]}/undo', json={})
    assert u.status_code == 200, u.text
    assert client.get(f'/api/items/{new["id"]}').json()['deleted']
    assert not client.get(f'/api/items/{src["id"]}').json()['deleted']


def test_version_joins_existing_group_and_keeps_file_composer(client, data):
    src = _score(client, artist='')
    v1 = client.post('/api/items', json={'fromItemId': src['id'], 'version': 'easy', 'musicxmlText': PRO}).json()
    gid = client.get(f'/api/items/{src["id"]}').json()['groupId']
    v2 = client.post('/api/items', json={'fromItemId': src['id'], 'version': 'pro', 'title': 'Song A (pro)', 'note': 'vocal merged into the RH',
                                         'musicxmlText': PRO}).json()
    assert v1['groupId'] == v2['groupId'] == gid and v2['title'] == 'Song A (pro)'
    assert v2['source'] == 'From the score “Song A”, vocal merged into the RH'
    x = (data / 'items' / v2['folder'] / v2['musicxml']).read_text()
    assert '<creator type="composer">Jane Composer</creator>' in x  # no Artist on the item: the file's composer stays


def test_version_artist_is_composer(client, data):
    src = _score(client, artist='Real Artist')
    new = client.post('/api/items', json={'fromItemId': src['id'], 'version': 'pro', 'musicxmlText': PRO}).json()
    x = (data / 'items' / new['folder'] / new['musicxml']).read_text()
    assert new['artist'] == 'Real Artist' and '<creator type="composer">Real Artist</creator>' in x and 'Transcribed by Meowsic' in x


def test_version_refusals(client):
    src = _score(client)
    assert client.post('/api/items', json={'fromItemId': 'm-nosuch', 'musicxmlText': PRO}).status_code == 404
    assert client.post('/api/items', json={'fromItemId': src['id'], 'musicxmlText': 'nope'}).status_code == 400
    assert client.post('/api/items', json={'fromItemId': src['id'], 'version': 'bogus', 'musicxmlText': PRO}).status_code in (400, 422)
    chord = client.post('/api/items', json={'kind': 'chords', 'title': 'C', 'text': '[C]la'}).json()
    assert client.post('/api/items', json={'fromItemId': chord['id'], 'musicxmlText': PRO}).status_code == 400
    # Edit notes open on the source: 423, nothing made
    n = len(client.get('/api/items').json())
    assert client.post(f'/api/items/{src["id"]}/editsession', json={'session': 'agent-test'}).status_code == 200
    lk = client.post('/api/items', json={'fromItemId': src['id'], 'musicxmlText': PRO})
    assert lk.status_code == 423 and len(client.get('/api/items').json()) == n


def test_credit_keeps_transcribed_for_arranged():
    old = XML.format(c='<creator type="composer">J</creator><creator type="arranger">Read by Meowsic</creator>')
    y = credit_xml(old, None, 'Arranged by Meowsic')
    assert '<creator type="arranger">Transcribed by Meowsic</creator><creator type="arranger">Arranged by Meowsic</creator>' in y
    assert 'Read by' not in y
    assert 'Transcribed' not in credit_xml(XML.format(c=''), None, 'Arranged by Meowsic')  # nothing to keep
