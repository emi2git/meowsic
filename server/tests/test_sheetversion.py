"""Sheet versions (Lead / Piano / Duet): the column, the migration, PATCH, bulk set and the one-time fill script."""
import json
import sqlite3

from meowsic import sheetversion as versions
from meowsic.app import create_app
from fastapi.testclient import TestClient

import importlib.util
from pathlib import Path


def sheet(client, title, tags=(), **kw):
    return client.post('/api/items', json={'kind': 'sheet', 'title': title, 'pages': 1, 'tags': list(tags), **kw}).json()


def test_sheet_version_defaults_blank_and_patches(client):
    s = sheet(client, 'Moon River')
    assert s['version'] == ''
    r = client.patch(f'/api/items/{s["id"]}', json={'version': 'Duet'})
    assert r.status_code == 200 and r.json()['version'] == 'duet'
    assert client.get(f'/api/items/{s["id"]}').json()['version'] == 'duet'
    assert client.patch(f'/api/items/{s["id"]}', json={'version': ''}).json()['version'] == ''
    assert client.patch(f'/api/items/{s["id"]}', json={'version': 'vocal'}).status_code == 400  # a score version, not a sheet one
    assert sheet(client, 'X', version='lead')['version'] == 'lead'
    assert client.post('/api/items', json={'kind': 'sheet', 'title': 'Y', 'pages': 1, 'version': 'banjo'}).status_code == 400


def test_score_version_still_checked(client):
    m = client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'version': 'clear'}).json()
    assert m['version'] == 'clear'
    assert client.patch(f'/api/items/{m["id"]}', json={'version': 'piano'}).status_code == 400
    assert client.patch(f'/api/items/{m["id"]}', json={'version': 'duet'}).json()['version'] == 'duet'


def test_bulk_set_version_skips_scores(client):
    a, b = sheet(client, 'A'), sheet(client, 'B')
    m = client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'version': 'original'}).json()
    r = client.post('/api/items/version', json={'ids': [a['id'], b['id'], m['id']], 'version': 'piano'}).json()
    assert r['count'] == 2 and r['skipped'] == 1 and {x['version'] for x in r['items']} == {'piano'}
    assert client.get(f'/api/items/{m["id"]}').json()['version'] == 'original'
    assert client.post('/api/items/version', json={'ids': [a['id']], 'version': 'x'}).status_code == 400


def test_migration_adds_column(data):
    app = create_app(data, background=False)
    with TestClient(app): pass
    c = sqlite3.connect(data / 'meowsic.db')
    # an older db: sheet table without the version column
    c.executescript("""PRAGMA foreign_keys=OFF; INSERT INTO item(id, kind, title, created_at, updated_at) VALUES ('s-old0001','sheet','Old',1,1);
      CREATE TABLE sheet2 (item_id TEXT PRIMARY KEY, source TEXT NOT NULL, pages INTEGER NOT NULL, book INTEGER NOT NULL DEFAULT 0);
      INSERT INTO sheet2 VALUES ('s-old0001','photos',1,0); DROP TABLE sheet; ALTER TABLE sheet2 RENAME TO sheet;""")
    c.commit(); c.close()
    with TestClient(create_app(data, background=False)) as cl:
        assert cl.get('/api/items/s-old0001').json()['version'] == ''


def test_guess():
    g = versions.guess
    assert g('Canon in D (Piano Duet)', []) == 'duet'
    assert g('Waltz for 4 hands', []) == 'duet'
    assert g('Waltz — four-hands', []) == 'duet'
    assert g('Sonatina Primo', []) == 'duet'
    assert g('Song', ['Secondo']) == 'duet'
    assert g('Song', ['Piano duet', 'Super Easy']) == 'duet'
    assert g('Song', ['Super Easy']) == 'lead'
    assert g('Song', ['lead sheet']) == 'lead'
    assert g('Primordial', ['Pop']) == ''
    assert g('Song', []) == ''


def test_fill_script(client, data):
    d = sheet(client, 'Canon (Piano Duet)')
    le = sheet(client, 'Twinkle', ['Super Easy'])
    bl = sheet(client, 'Moon River', ['Pop'])
    kept = sheet(client, 'Kept duet', version='piano')
    bk = sheet(client, 'Duets book')
    client.post('/api/items/book', json={'ids': [bk['id']], 'book': True})
    spec = importlib.util.spec_from_file_location('fsv', Path(__file__).resolve().parents[1] / 'scripts' / 'fill_sheet_versions.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    # dry run: nothing written
    assert mod.main(['--data', str(data), '--dry-run']) == 0
    assert client.get(f'/api/items/{d["id"]}').json()['version'] == ''
    assert not (data / 'history').exists() or not list((data / 'history').glob('versions-*.jsonl'))
    r = versions.fill(data)
    assert r['counts'] == {'duet': 1, 'lead': 1, 'blank': 1, 'kept': 1, 'books': 1}
    get = lambda it: client.get(f'/api/items/{it["id"]}').json()['version']
    assert (get(d), get(le), get(bl), get(kept), get(bk)) == ('duet', 'lead', '', 'piano', '')
    logs = list((data / 'history').glob('versions-*.jsonl'))
    assert len(logs) == 1
    lines = [json.loads(x) for x in logs[0].read_text().splitlines()]
    assert {(x['id'], x['before'], x['after']) for x in lines} == {(d['id'], '', 'duet'), (le['id'], '', 'lead')}
    assert list((data / 'backups').glob('meowsic-before-versions-*.db'))
    # again: nothing to do, no new log, history kept
    r2 = versions.fill(data)
    assert r2['changes'] == [] and r2['log'] is None
    assert list((data / 'history').glob('versions-*.jsonl')) == logs
