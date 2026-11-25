"""Jobs (pluggable runner), backup export/import, daily db snapshots."""
import threading
import time

from meowsic import backup
from meowsic.db import Config


def wait(client, jid, status, t=5):
    end = time.time() + t
    while time.time() < end:
        j = client.get(f'/api/jobs/{jid}').json()
        if j['status'] == status: return j
        time.sleep(0.02)
    raise AssertionError(f'job never became {status}: {j}')


def test_stub_runner_fails_cleanly(client, app):
    from meowsic.jobs import stub_runner
    app.state.job_runner = stub_runner
    j = client.post('/api/jobs', json={'kind': 'transcribe', 'title': 'Memory', 'source': 'YouTube · x', 'outputs': ['original']})
    assert j.status_code == 201
    j = wait(client, j.json()['id'], 'failed')
    assert 'not installed' in j['log'][-1]['msg']


def test_runner_progress_cancel_dismiss(client, app):
    gate = threading.Event()

    def runner(ctx):
        ctx.update(stage=1, progress=0.5, msg='Download audio — done')
        gate.wait(5)
        ctx.update(progress=0.9)  # raises Cancelled after a cancel

    app.state.job_runner = runner
    jid = client.post('/api/jobs', json={'gen': True, 'title': 'Ode', 'outputs': ['easy']}).json()['id']
    j = wait(client, jid, 'running')
    end = time.time() + 5
    while client.get(f'/api/jobs/{jid}').json()['stage'] != 1 and time.time() < end: time.sleep(0.02)
    j = client.get(f'/api/jobs/{jid}').json()
    assert j['kind'] == 'version' and j['gen'] and j['progress'] == 0.5
    assert client.post(f'/api/jobs/{jid}/cancel').json()['status'] == 'cancelled'
    gate.set()
    time.sleep(0.1)
    assert client.get(f'/api/jobs/{jid}').json()['status'] == 'cancelled'
    client.post(f'/api/jobs/{jid}/dismiss')
    assert client.get('/api/jobs').json()[0]['dismissed'] is True
    assert any(a['type'] == 'version' for a in client.get('/api/activity').json())


def test_runner_done_and_patch(client, app):
    app.state.job_runner = lambda ctx: ctx.update(stage=3, progress=1, msg='Saved', status='done', result=['m-abc'])
    jid = client.post('/api/jobs', json={'title': 'Twinkle', 'outputs': ['lead']}).json()['id']
    assert wait(client, jid, 'done')['result'] == ['m-abc']
    gate = threading.Event()  # the job runs until the PATCH is in (a timed sleep could end first on a busy Mac)
    app.state.job_runner = lambda ctx: gate.wait(5)
    jid = client.post('/api/jobs', json={'title': 'X'}).json()['id']
    wait(client, jid, 'running')
    assert client.patch(f'/api/jobs/{jid}', json={'stage': 2, 'msg': 'halfway'}).json()['stage'] == 2
    gate.set()
    assert wait(client, jid, 'done')['log'][-2]['msg'] == 'halfway'
    assert client.post('/api/jobs', json={'kind': 'nope', 'title': 'x'}).status_code == 400


def test_restart_marks_running_jobs_failed(client, app, data):
    gate = threading.Event()  # still running when recover() looks (a timed sleep could end first on a busy Mac)
    app.state.job_runner = lambda ctx: gate.wait(5)
    jid = client.post('/api/jobs', json={'title': 'X'}).json()['id']
    wait(client, jid, 'running')
    from meowsic.jobs import recover
    try:
        recover(Config(data))
        assert client.get(f'/api/jobs/{jid}').json()['status'] == 'failed'
    finally:
        gate.set()
    time.sleep(0.05)
    assert client.get(f'/api/jobs/{jid}').json()['status'] == 'failed'  # the runner ending later does not undo it


def test_backup_round_trip(client, chord):
    i = chord['id']
    client.put(f'/api/items/{i}/annotations/1', json=[{'tool': 'red', 'pts': [[0, 0]]}])
    client.post('/api/plays', json={'itemId': i, 'openedAt': 0, 'closedAt': 20000})
    client.post('/api/printed', json={'ids': [i]})
    client.put('/api/settings', json={'theme': 'dark'})
    client.post('/api/tags', json={'name': 'Empty'})
    s = client.post('/api/sheets', files=[('files', ('m.png', b'png-bytes', 'image/png'))], data={'title': 'Memory', 'last_modified': '[777]'}).json()['item']
    client.post('/api/items/trash', json={'ids': [s['id']]})
    r = client.get('/api/backup')
    assert 'attachment' in r.headers['content-disposition']
    dump = r.json()
    client.post('/api/items/purge', json={'ids': [i, s['id']]})
    client.put('/api/settings', json={'theme': 'light'})
    assert client.post('/api/backup/import', json=dump).json() == {'ok': True, 'items': 2}
    again = client.get('/api/backup').json()
    for k in ('items', 'tags', 'plays', 'annotations', 'printed', 'settings', 'activity'):
        assert again[k] == dump[k], k
    assert client.get('/api/items?deleted=true').json()[0]['id'] == s['id']
    assert client.post('/api/backup/import', json={'nope': 1}).status_code == 400


def test_import_mock_store_shape(client):
    """A backup exported from the phase-1 UI (mock store) imports."""
    mock = {'version': 6, 'tags': ['Folk'], 'items': [
        {'id': 'c-aaa', 'kind': 'chords', 'title': 'Clementine', 'artist': 'Trad', 'tags': ['Folk', 'Children'], 'createdAt': 1, 'updatedAt': 2,
         'source': 'ultimate-guitar', 'url': 'u', 'key': 'F', 'capo': 0, 'text': '[F]In a cavern', 'transpose': None, 'deleted': False},
        {'id': 's-bbb', 'kind': 'sheet', 'title': 'Memory', 'artist': 'ALW', 'tags': [], 'createdAt': 1, 'updatedAt': 1, 'pages': 3, 'deleted': True, 'deletedAt': 5},
        {'id': 'm-ccc', 'kind': 'score', 'title': 'Ode', 'artist': 'B', 'tags': ['Original'], 'createdAt': 1, 'updatedAt': 1, 'tune': 'ode',
         'version': 'original', 'source': 'YouTube', 'key': 'C major', 'bpm': 104, 'transpose': 0, 'deleted': False}],
        'plays': [{'itemId': 'c-aaa', 'openedAt': 1, 'closedAt': 20000}, {'itemId': 'gone', 'openedAt': 1, 'closedAt': 2}],
        'jobs': [{'id': 'job-1', 'title': 'One Day More', 'outputs': ['vocal'], 'status': 'running', 'startedAt': 9, 'log': []}],
        'activity': [{'id': 'act-1', 'type': 'bin', 'title': 'x', 'detail': 'x', 'status': 'done', 'at': 3}],
        'annotations': {'c-aaa:1': [{'tool': 'blue', 'pts': [[0, 0]]}]}, 'printed': {'c-aaa': 7}}
    assert client.post('/api/backup/import', json=mock).json()['items'] == 3
    c = client.get('/api/items/c-aaa').json()
    assert c['tags'] == ['Folk', 'Children'] and c['printedAt'] == 7 and c['hasStrokes'] and c['playCount'] == 1
    assert client.get('/api/items/s-bbb').json()['deletedAt'] == 5
    assert client.get('/api/jobs/job-1').json()['status'] == 'failed'


def test_snapshots_keep_30(client, data):
    assert client.post('/api/backup/snapshot').json()['file'].startswith('meowsic-')
    b = data / 'backups'
    for d in range(1, 40):
        (b / f'meowsic-2025-01-{d:02d}.db').write_bytes(b'')
    backup.snapshot(Config(data))
    assert len(list(b.glob('meowsic-????-??-??.db'))) == 30
    assert not (b / 'meowsic-2025-01-01.db').exists()


def test_daily_loop_makes_todays_copy(data, app):
    stop = threading.Event()
    stop.set()
    backup.daily_loop(Config(data), stop)
    assert len(list((data / 'backups').glob('meowsic-*.db'))) == 1
