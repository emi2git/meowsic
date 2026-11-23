"""Score sources: the platform ('YouTube' / 'Facebook' / 'Meowsic' …) + the full original link (score.source_url)."""
import json
import sqlite3

from fastapi.testclient import TestClient

from meowsic.app import create_app
from meowsic.db import platform_of
from test_runners import fake_pipeline, no_pdf, small_xml, wait  # noqa: F401  (fixtures)


def test_platform_of():
    for u in ('https://www.youtube.com/watch?v=a', 'https://youtu.be/a', 'https://m.youtube.com/watch?v=a', 'youtu.be/a'):
        assert platform_of(u) == 'YouTube', u
    for u in ('https://www.facebook.com/watch/?v=1', 'https://fb.watch/x', 'https://m.facebook.com/x'):
        assert platform_of(u) == 'Facebook', u
    assert platform_of('https://vimeo.com/1') == 'vimeo.com' and platform_of('') == ''


def test_new_job_keeps_the_full_link(client, data, fake_pipeline, no_pdf):
    url = 'https://www.youtube.com/watch?v=abc&t=42s'
    j = client.post('/api/jobs', json={'title': 'Memory', 'url': url, 'source': 'YouTube · youtube.com/watch?v=abc&t=42s', 'outputs': ['original']}).json()
    assert j['source'] == 'YouTube'
    j = wait(client, j['id'])
    assert j['status'] == 'done', j['log']
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['source'] == 'YouTube' and it['sourceUrl'] == url
    # Facebook, link only in an old-style source
    j = wait(client, client.post('/api/jobs', json={'title': 'F', 'source': 'Facebook · https://www.facebook.com/watch/?v=9', 'outputs': ['original']}).json()['id'])
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['source'] == 'Facebook' and it['sourceUrl'] == 'https://www.facebook.com/watch/?v=9'
    # a version made from it keeps the original link
    v = wait(client, client.post('/api/jobs', json={'kind': 'version', 'title': 'F', 'fromItemId': it['id'], 'outputs': ['lead'],
                                                    'source': 'From the score “F”'}).json()['id'])
    assert v['status'] == 'done', v['log']
    lead = client.get(f'/api/items/{v["result"][0]}').json()
    assert lead['source'] == 'From the score “F”' and lead['sourceUrl'] == 'https://www.facebook.com/watch/?v=9'


def test_upload_job_has_no_link(client, fake_pipeline, no_pdf):
    j = wait(client, client.post('/api/jobs/upload', files={'file': ('a.mp3', b'ID3x', 'audio/mpeg')}, data={'outputs': 'original'}).json()['id'])
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['source'] == 'Audio file · a.mp3' and it['sourceUrl'] == ''


def test_ai_piece_source(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'T', 'ai': True, 'source': 'Composed by Claude'}).json()
    assert it['source'] == 'Meowsic'
    assert client.post('/api/items', json={'kind': 'score', 'title': 'U', 'ai': True}).json()['source'] == 'Meowsic'
    assert client.post('/api/items', json={'kind': 'score', 'title': 'V', 'source': 'Composed by Claude'}).json()['source'] == 'Composed by Claude'


def test_migration(tmp_path):
    d = tmp_path / 'M'
    d.mkdir()
    with TestClient(create_app(d, background=False)) as c:
        mk = lambda **kw: c.post('/api/items', json={'kind': 'score', 'title': 'S', **kw}).json()['id']
        yt = mk(source='x', groupId='g1')
        fb = mk(source='x')
        ver = mk(source='From the score “S”', groupId='g1')
        aud = mk(source='Audio file · a.mp3')
        ai = mk(source='x', ai=True, tags=['AI Studio', 'Calm'])
        other = mk(source='Composed by Claude', tags=['AI Studio'])
    db = sqlite3.connect(d / 'meowsic.db')
    db.execute('ALTER TABLE score DROP COLUMN source_url')
    db.execute("UPDATE score SET source='YouTube · youtu.be/abc' WHERE item_id=?", (yt,))
    db.execute("UPDATE score SET source='Facebook · facebook.com/watch/?v=1' WHERE item_id=?", (fb,))
    db.execute("UPDATE score SET source='Composed by Claude' WHERE item_id=?", (ai,))
    # the job that made `yt` still has the full link
    db.execute("INSERT INTO job(id, kind, title, source, outputs, status, log, started_at, params, result) VALUES "
               "('job-1','transcribe','S','YouTube · youtu.be/abc','[]','done','[]',1,?,?)",
               (json.dumps({'url': 'https://youtu.be/abc?si=XYZ'}), json.dumps([yt])))
    n_act = db.execute('SELECT COUNT(*) FROM activity').fetchone()[0]
    db.commit()
    db.close()
    with TestClient(create_app(d, background=False)) as c:
        g = lambda i: c.get(f'/api/items/{i}').json()
        assert (g(yt)['source'], g(yt)['sourceUrl']) == ('YouTube', 'https://youtu.be/abc?si=XYZ')
        assert (g(fb)['source'], g(fb)['sourceUrl']) == ('Facebook', 'https://facebook.com/watch/?v=1')
        assert (g(ver)['source'], g(ver)['sourceUrl']) == ('From the score “S”', 'https://youtu.be/abc?si=XYZ')
        assert (g(aud)['source'], g(aud)['sourceUrl']) == ('Audio file · a.mp3', '')
        assert g(ai)['source'] == 'Meowsic' and g(ai)['tags'] == ['Calm'] and g(ai)['kind'] == 'score' and g(ai)['ai'] == 1
        assert g(other)['source'] == 'Composed by Claude' and g(other)['tags'] == []
        assert 'AI Studio' not in {t['name'] for t in c.get('/api/tags').json()}
    db = sqlite3.connect(d / 'meowsic.db')
    mig = db.execute("SELECT detail FROM activity WHERE type='migrate'").fetchall()
    assert db.execute('SELECT COUNT(*) FROM activity').fetchone()[0] == n_act + 1  # history kept, one line added
    db.close()
    assert len(mig) == 1 and '3 link source' in mig[0][0] and '1 AI piece' in mig[0][0], mig
    with TestClient(create_app(d, background=False)) as c:  # runs again: nothing to do, no new line
        pass
    db = sqlite3.connect(d / 'meowsic.db')
    assert db.execute("SELECT COUNT(*) FROM activity WHERE type='migrate'").fetchone()[0] == 1
    db.close()
