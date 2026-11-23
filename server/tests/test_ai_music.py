"""AI music: scores Claude composed (score.ai = 1), added only through POST /api/items."""
import sqlite3

from fastapi.testclient import TestClient

from meowsic.app import create_app

XML = '<?xml version="1.0"?><score-partwise version="3.1"><part-list/></score-partwise>'


def test_ai_score_create(client, data):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Little Tune', 'version': 'original', 'ai': True,
                                         'tags': ['AI music'], 'source': 'Meowsic AI', 'musicxmlText': XML}).json()
    assert it['id'].startswith('m-') and it['ai'] == 1 and it['tags'] == ['AI music'] and it['source'] == 'Meowsic' and it['artist'] == 'Meowsic'  # the old name 'Meowsic AI' comes in as 'Meowsic'
    assert it['musicxml'] == f'{it["folder"]}.musicxml'
    assert (data / 'items' / it['folder'] / it['musicxml']).read_text() == XML.replace('<part-list/>', '<identification><creator type="composer">Meowsic</creator></identification><part-list/>')
    plain = client.post('/api/items', json={'kind': 'score', 'title': 'Plain'}).json()
    assert plain['ai'] == 0
    assert [x['ai'] for x in client.get('/api/items?kind=score').json()] == [0, 1]


def test_ai_flag_not_patchable(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'T', 'ai': True}).json()
    r = client.patch(f'/api/items/{it["id"]}', json={'ai': 0, 'title': 'T2'}).json()
    assert r['ai'] == 1 and r['title'] == 'T2'
    other = client.post('/api/items', json={'kind': 'score', 'title': 'U'}).json()
    assert client.patch(f'/api/items/{other["id"]}', json={'ai': 1}).json()['ai'] == 0


def test_ai_only_for_scores(client):
    ch = client.post('/api/items', json={'kind': 'chords', 'title': 'C', 'ai': True}).json()
    assert 'ai' not in ch


def test_ai_column_migration(tmp_path):
    """An old db without score.ai gets the column (0 for every existing score)."""
    d = tmp_path / 'M'
    d.mkdir()
    with TestClient(create_app(d, background=False)) as c:
        c.post('/api/items', json={'kind': 'score', 'title': 'Old'})
    db = sqlite3.connect(d / 'meowsic.db')
    db.execute('ALTER TABLE score DROP COLUMN ai')
    db.commit()
    db.close()
    with TestClient(create_app(d, background=False)) as c:
        assert [x['ai'] for x in c.get('/api/items').json()] == [0]
