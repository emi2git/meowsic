"""Daily clean-up: Undo is open 24 h, then the activity is Final and the old copies kept for undo are deleted."""
import json
import os
import sqlite3

from meowsic import dailycleanup as dc
from meowsic.db import connect, folder_path, now_ms
from test_pages import make as make_color
from test_trim import make, page, trim
from test_undo import acts, last, undo

H = 3600 * 1000
LATER = 2 * 24 * H  # "now" two days on: everything made in the test is 48 h old


def con(app):
    return connect(app.state.cfg)


def age_activities(app, ms, where='1=1'):
    c = sqlite3.connect(app.state.cfg.db_path)
    c.execute(f'UPDATE activity SET at = at - ? WHERE {where}', (ms,))
    c.commit(); c.close()


def files(root):
    out = {}
    for top, _, fs in os.walk(root, followlinks=False):
        for f in fs:
            p = os.path.join(top, f)
            if not f.startswith('meowsic.db'): out[p] = os.lstat(p).st_mtime_ns  # (the db itself changes as it is read)
    return out


def set_mtime(p, ms):
    os.utime(p, (ms / 1000, ms / 1000), follow_symlinks=False)


def test_undo_open_24h_then_final(client, app):
    it = client.post('/api/items', json={'kind': 'chords', 'title': 'Memry', 'text': 'x'}).json()
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory'})
    a = last(client, 'edit')
    assert a['action'] == 'undo' and not a['final'] and abs(a['undoUntil'] - (a['at'] + 24 * H)) < 5
    age_activities(app, 23 * H)  # 23 h: still open
    a = last(client, 'edit')
    assert a['action'] == 'undo' and not a['final']
    age_activities(app, 2 * H)  # 25 h: Final, refused
    a = last(client, 'edit')
    assert a['final'] and a['action'] is None and 'Final' in a['noUndo'] and a['finalAt']
    r = undo(client, a['id'])
    assert r.status_code == 409 and r.json()['detail']['reason'] == 'final' and 'Too late to undo' in r.json()['detail']['message']
    assert client.get(f'/api/items/{it["id"]}').json()['title'] == 'Memory'
    # a new edit of the same item is a new row (not merged into the Final one) and can be undone
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory!'})
    b = last(client, 'edit')
    assert b['id'] != a['id'] and b['action'] == 'undo'
    assert undo(client, b['id']).json()['ok']


def test_dry_run_then_run(client, app, data, tmp_path):
    cf = app.state.cfg
    it = make(client, 'Keep me', n=1)
    trim(client, it, top=0.25, bottom=0.75)
    d = folder_path(cf, client.get(f'/api/items/{it["id"]}').json()['folder'])
    page_file = d / client.get(f'/api/items/{it["id"]}').json()['pageFiles'][0]
    page_bytes = page_file.read_bytes()
    hist = sorted((d / '.history').iterdir())
    assert hist
    # a trashed item's history is left alone
    tr = make_color(client, 'Trashed', ['red'])
    trim(client, tr, top=0.25, bottom=0.75)
    trd = folder_path(cf, client.get(f'/api/items/{tr["id"]}').json()['folder'])
    client.post('/api/items/trash', json={'ids': [tr['id']]})
    # links pointing out of the data folder: never followed
    outside = tmp_path / 'outside'; outside.mkdir()
    (outside / 'precious.txt').write_text('keep')
    os.symlink(outside / 'precious.txt', d / '.history' / 'p9-1000000000000.png')
    (cf.work_dir).mkdir(exist_ok=True)
    os.symlink(outside, cf.work_dir / 'job-linked')
    # history logs, backups, job work
    (data / 'history').mkdir(exist_ok=True)
    (data / 'history' / 'renames-20200101-101010.jsonl').write_text('{}\n')
    (data / 'history' / 'keep.txt').write_text('not a log')
    (cf.backups_dir).mkdir(exist_ok=True)
    for n in ('pre-a-20200101-1010.db', 'pre-b-20200102-1010.db', 'meowsic-2020-01-03.db'):
        (cf.backups_dir / n).write_bytes(b'x' * 1000)
    (cf.backups_dir / 'pre-a-20200101-1010.db-wal').write_bytes(b'w')
    newest = cf.backups_dir / 'pre-newest.db'; newest.write_bytes(b'y' * 10)
    set_mtime(newest, now_ms() + LATER - 30 * H)  # newest, but older than 24 h at LATER: still kept
    c = sqlite3.connect(cf.db_path)
    c.execute("INSERT INTO job(id, kind, title, outputs, status, started_at, done_at) VALUES ('job-old1','transcribe','t','[]','done',1,2)")
    c.execute("INSERT INTO job(id, kind, title, outputs, status, started_at) VALUES ('job-run1','transcribe','t','[]','running',1)")
    c.commit(); c.close()
    for j in ('job-old1', 'job-run1'):
        (cf.work_dir / j / 'out').mkdir(parents=True)
        (cf.work_dir / j / 'out' / 'score.musicxml').write_text('<x/>' * 100)
    (cf.work_dir / 'thumbs').mkdir(exist_ok=True); (cf.work_dir / 'thumbs' / 't.jpg').write_bytes(b'j')

    before = files(data)
    # dry run (HTTP preview uses the real now: everything is fresh, nothing to do)
    p = client.get('/api/daily-cleanup/preview').json()
    assert p['dry'] and p['activities'] == 0 and p['categories']['pageHistory']['files'] == 0
    # dry run two days on: counts, but nothing deleted
    c = con(app)
    s = dc.run(cf, c, now=now_ms() + LATER, dry=True)
    cats = s['categories']
    assert s['activities'] >= 2 and cats['pageHistory']['files'] == len(hist) + 1  # + the link (unlinked, not followed)
    assert cats['history']['files'] == 1 and cats['backups']['files'] == 4 and cats['jobWork']['files'] == 1
    assert s['keptBackup'] == 'pre-newest.db' and s['bytes'] > 0
    assert files(data) == before
    assert c.execute('SELECT COUNT(*) FROM activity WHERE final_at IS NOT NULL').fetchone()[0] == 0

    s = dc.run(cf, c, now=now_ms() + LATER)
    c.close()
    assert s['failed'] == 0 and s['files'] == len(hist) + 1 + 1 + 4 + 1
    assert not any((d / '.history').iterdir())
    assert page_file.read_bytes() == page_bytes  # the current page is untouched
    assert (outside / 'precious.txt').read_text() == 'keep' and (cf.work_dir / 'job-linked').is_symlink()
    assert any((trd / '.history').iterdir())  # Trash: left alone
    assert (data / 'history' / 'keep.txt').exists() and not (data / 'history' / 'renames-20200101-101010.jsonl').exists()
    assert sorted(x.name for x in cf.backups_dir.iterdir()) == ['pre-newest.db']
    assert not (cf.work_dir / 'job-old1').exists() and (cf.work_dir / 'job-run1' / 'out' / 'score.musicxml').exists()
    assert (cf.work_dir / 'thumbs' / 't.jpg').exists() and cf.db_path.exists()
    assert (data / 'Meowsic.store').exists()
    # Final rows; the run logged itself (not undoable) and in work/cleanup.log
    c = con(app)
    assert c.execute("SELECT COUNT(*) FROM activity WHERE final_at IS NULL AND type != 'cleanup'").fetchone()[0] == 0
    c.close()
    row = last(client, 'cleanup')
    assert row['title'].startswith('Daily clean-up:') and row['action'] is None and 'nothing to bring back' in row['noUndo']
    log = (cf.work_dir / 'cleanup.log').read_text().strip().splitlines()
    assert json.loads(log[-1])['files'] == s['files']
    # the page works without its history: no crop, its own original, stays done in Clean up
    pg = page(client, it)
    assert pg['trims'] == 0 and pg['crop'] is None and pg['done']
    r = client.get(f'/api/items/{it["id"]}/pages/1/original')
    assert r.status_code == 200 and r.content == page_bytes
    r = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={'all': True})
    assert r.status_code == 404 and 'no earlier crop is kept' in r.json()['detail']
    assert trim(client, it, top=0.1, bottom=0.9)['pageFiles']  # trims again from the page as it is now


def test_recent_and_referenced_copies_kept(client, app, data):
    cf = app.state.cfg
    it = make(client, 'Recent', n=1)
    trim(client, it, top=0.25, bottom=0.75)  # this crop is fresh
    d = folder_path(cf, client.get(f'/api/items/{it["id"]}').json()['folder'])
    old = now_ms() - 30 * 24 * H
    ref = d / '.history' / f'lyrics-{old}-score.musicxml'; ref.write_text('a')
    gone = d / '.history' / f'lyrics-{old + 1}-score.musicxml'; gone.write_text('b')
    for p in (ref, gone): set_mtime(p, old)
    c = sqlite3.connect(cf.db_path)
    c.execute("INSERT INTO activity(id, type, title, at, undo) VALUES ('act-ref1','lyrics-fit','x',?,?)",
              (now_ms(), json.dumps({'steps': [{'op': 'musicxml', 'id': it['id'], 'before': f'.history/{ref.name}'}]})))
    c.commit(); c.close()
    (cf.backups_dir).mkdir(exist_ok=True)
    only = cf.backups_dir / 'pre-only-20200101-1010.db'; only.write_bytes(b'x')
    set_mtime(only, old)
    c = con(app)
    s = dc.run(cf, c)  # real now: the crop and its row are fresh
    c.close()
    assert ref.exists() and not gone.exists()
    assert any(p.name.startswith('p1-') for p in (d / '.history').iterdir())  # fresh crop history kept
    assert only.exists() and s['keptBackup'] == only.name  # the newest (only) backup is always kept
    assert last(client, 'trim')['action'] == 'undo'
    assert undo(client, last(client, 'trim')['id']).json()['ok']


def test_run_endpoint_and_loop(client, app):
    r = client.post('/api/daily-cleanup/run', json={'dry': True}).json()
    assert r['dry'] and r['lastRun'] is None
    r = client.post('/api/daily-cleanup/run', json={}).json()
    assert not r['dry'] and r['files'] == 0
    assert client.get('/api/daily-cleanup/preview').json()['lastRun']
