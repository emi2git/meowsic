"""Sheet keys: the column, PATCH, title-key detection and the one-time move (with undo)."""
import importlib.util
import json
from pathlib import Path

import pytest

from meowsic import titlekeys
from meowsic.titlekeys import split_key


@pytest.mark.parametrize('title, want', [
    ('A Little Bit Of You (F)', ('A Little Bit Of You', 'F')),
    ('16 Going On 17 (C)', ('16 Going On 17', 'C')),
    ('Từ đó - OST Mắt Biếc (G)', ('Từ đó - OST Mắt Biếc', 'G')),
    ('Ghibli Easy (C)', ('Ghibli Easy', 'C')),
    ('Nơi này có anh - Am', ('Nơi này có anh', 'Am')),
    ('Waltz (Dm)', ('Waltz', 'Dm')),
    ('Song [F#m]', ('Song', 'F#m')),
    ('Song – Bb', ('Song', 'Bb')),
    ('Song — Eb major', ('Song', 'Eb major')),
    ('Song (C major)', ('Song', 'C major')),
    ('Song (A minor)', ('Song', 'A minor')),
    ('Song (Abm)', ('Song', 'Abm')),
    ('Song (C♯m)', ('Song', 'C♯m')),
    ('Song ( G )', ('Song', 'G')),
    ('Song - (G)', ('Song', 'G')),
])
def test_split_key_positives(title, want):
    assert split_key(title) == want


@pytest.mark.parametrize('title', [
    'Moon River (Easy Piano)', 'Mắt Biếc (OST)', 'Faber (Book 2)', 'Sonata (part 2)', 'Canon in D', 'Plan B',
    'Song (H)', 'Song (Cm7)', 'Song (G) live', '(C)', 'Mamma Mia - ABBA', 'Em của ngày hôm qua', 'Bài ca (Am nhạc)',
    'Song (c)', 'Song-A', 'Hello (Adele)',
])
def test_split_key_negatives(title):
    assert split_key(title) is None


def sheet(client, title, **kw):
    return client.post('/api/items', json={'kind': 'sheet', 'title': title, 'pages': 1, **kw}).json()


def test_sheet_key_field(client):
    s = sheet(client, 'Moon River')
    assert s['key'] == ''
    assert client.patch(f'/api/items/{s["id"]}', json={'key': ' Am '}).json()['key'] == 'Am'
    assert client.get(f'/api/items/{s["id"]}').json()['key'] == 'Am'


def test_move_title_keys(client, data):
    a = sheet(client, 'A Little Bit Of You (F)')
    b = sheet(client, 'Từ đó - OST Mắt Biếc (G)')
    same = sheet(client, 'Waltz - Am', key='Am')
    other = sheet(client, 'Kept (C)', key='D')
    plain = sheet(client, 'Moon River (Easy Piano)')
    bk = sheet(client, 'Ghibli Easy (C)')
    client.post('/api/items/book', json={'ids': [bk['id']], 'book': True})
    score = client.post('/api/items', json={'kind': 'score', 'title': 'Ode (C)', 'version': 'original'}).json()
    spec = importlib.util.spec_from_file_location('mtk', Path(__file__).resolve().parents[1] / 'scripts' / 'move_title_keys.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    assert mod.main(['--data', str(data), '--dry-run']) == 0
    assert client.get(f'/api/items/{a["id"]}').json()['title'] == 'A Little Bit Of You (F)'
    r = titlekeys.run(data)
    assert {x['id'] for x in r['changes']} == {a['id'], b['id'], same['id'], bk['id']}
    assert [x['id'] for x in r['skipped']] == [other['id']]
    get = lambda it: (lambda j: (j['title'], j['key']))(client.get(f'/api/items/{it["id"]}').json())
    assert get(a) == ('A Little Bit Of You', 'F')
    assert get(b) == ('Từ đó - OST Mắt Biếc', 'G')
    assert get(same) == ('Waltz', 'Am')
    assert get(other) == ('Kept (C)', 'D')
    assert get(plain) == ('Moon River (Easy Piano)', '')
    assert get(bk) == ('Ghibli Easy', 'C')
    assert client.get(f'/api/items/{bk["id"]}').json()['folder'] == 'Books/Ghibli Easy'  # the book's folder follows its title
    assert client.get(f'/api/items/{score["id"]}').json()['title'] == 'Ode (C)'  # scores untouched
    log = Path(r['log'])
    lines = [json.loads(x) for x in log.read_text().splitlines()]
    assert {(x['before']['title'], x['after']['title'], x['after']['key']) for x in lines} >= {('A Little Bit Of You (F)', 'A Little Bit Of You', 'F')}
    # again: nothing to do
    assert titlekeys.run(data)['changes'] == []
    # undo: back as it was, except an item changed since
    client.patch(f'/api/items/{b["id"]}', json={'title': 'Từ đó'})
    u = titlekeys.undo(data, log)
    assert len(u['back']) == 3 and [x['id'] for x in u['skipped']] == [b['id']]
    assert get(a) == ('A Little Bit Of You (F)', '') and get(same) == ('Waltz - Am', 'Am') and get(bk) == ('Ghibli Easy (C)', '')
    assert get(b) == ('Từ đó', 'G')
    assert log.exists() and list((data / 'history').glob('title-keys-undo-*.jsonl'))
