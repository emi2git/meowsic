"""Storage: Clean up state lives in the db (old work/cleanup.json imported once), folders are named by id
(old '<id> <title>' folders moved by migrate_id_folders.py, and back with --undo)."""
import json
import os
import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from meowsic.app import create_app
from test_pages import color_of, make

TABLES = {'page_scan', 'cleanup_mark', 'sheet_decision', 'sheet_note', 'page_later', 'page_later_log', 'crop_frame',
          'name_suggestion', 'book_split_mark', 'book_split_undo'}


def db(data): return sqlite3.connect(data / 'meowsic.db')


def test_fresh_db_has_cleanup_tables(client, data):
    names = {r[0] for r in db(data).execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert TABLES <= names
    assert not (data / 'work' / 'cleanup.json').exists()
    assert client.get('/api/cleanup/frames').json() == {'1': None, '2': None}
    assert client.get('/api/cleanup/sort').json() == {'decisions': {}} and client.get('/api/cleanup/notes').json() == []


def test_marks_follow_the_item_history_stays(client, data):
    a = make(client, 'Song A', ['red', 'blue'])
    for k in (f'{a["id"]}:1', f'title:{a["id"]}', f'song:{a["id"]}'):
        assert client.post('/api/cleanup/ok', json={'key': k}).json() == {'ok': True}
    assert client.post('/api/cleanup/ok', json={'key': 'nonsense'}).status_code == 400
    assert client.post('/api/cleanup/ok', json={'key': 's-nope:1'}).status_code == 404
    client.post('/api/cleanup/later', json={'key': f'{a["id"]}:2'})
    client.post('/api/cleanup/notes', json={'id': a['id'], 'text': 'split after 1'})
    client.post('/api/cleanup/sort', json={'id': a['id'], 'decision': 'keep'})
    song = client.get('/api/cleanup', params={'id': a['id']}).json()['songs'][0]
    assert song['reviewed'] and song['pages'][0]['kept'] and song['pages'][1]['later'] and song['note'] == 'split after 1'
    client.post('/api/items/trash', json={'ids': [a['id']]})
    client.post('/api/items/purge', json={'ids': [a['id']]})
    c = db(data)
    for t in ('cleanup_mark', 'page_later', 'sheet_note', 'sheet_decision'):
        assert c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] == 0, t
    assert c.execute('SELECT COUNT(*) FROM page_later_log').fetchone()[0] == 1  # history kept


def sample_json(ids):
    a, b, book = ids
    return {
        'v': 3,
        'pages': {f'{a}:1': [123, {'trim': None, 'dots': None, 'box': {'top': 0.1, 'bottom': 0.9}}, 'x.png'], 's-gone:1': [1, {}, 'y.png']},
        'ok': [f'{a}:1', f'title:{b}', f'song:{a}', 'title:s-gone'],
        'later': [f'{b}:1'],
        'later_log': [{'key': f'{b}:1', 'op': 'later', 'at': 5}, {'key': 's-gone:2', 'op': 'later', 'at': 6}],
        'frames': {'1': {'top': 0.05, 'bottom': 0.95, 'left': 0, 'right': 1}},
        'sort': {a: 'keep', b: 'delete', 's-gone': 'keep'},
        'notes': {a: {'text': 'from the Disney book', 'at': 7}},
        'suggest': {b: {'title': 'Moon River', 'why': 'photo name', 'at': 8, 'status': 'open'},
                    a: {'title': 'Old', 'why': '', 'at': 9, 'status': 'accepted', 'doneAt': 10, 'old': {'title': 'X'}, 'new': {'title': 'Old'}},
                    's-gone': {'title': 'Z', 'why': '', 'at': 11, 'status': 'dismissed', 'doneAt': 12}},
        'booksplit': {book: {'starts': {'2': 'Second song'}, 'at': 13}},
        'booksplit_undo': {book: [{'at': 14, 'lead': 0, 'trashed': True, 'sheets': [], 'starts': {'1': 'x'}}],
                           's-gone': [{'at': 15, 'lead': 1, 'trashed': False, 'sheets': [], 'starts': {}}]},
    }


def test_import_cleanup_json(client, data):
    a, b = make(client, 'Alpha', ['red']), make(client, 'IMG_1', ['blue'])
    book = make(client, 'Songbook', ['red', 'green', 'blue'])
    client.post('/api/items/book', json={'ids': [book['id']], 'book': True})
    (data / 'work').mkdir(exist_ok=True)
    (data / 'work' / 'cleanup.json').write_text(json.dumps(sample_json([a['id'], b['id'], book['id']])))
    # a restart imports it (same app factory as the server)
    with TestClient(create_app(data, background=False)) as c2:
        assert not (data / 'work' / 'cleanup.json').exists()
        kept = list((data / 'work').glob('cleanup.json.imported-*'))
        assert len(kept) == 1 and json.loads(kept[0].read_text())['sort']['s-gone'] == 'keep'  # never deleted
        assert c2.get('/api/cleanup/frames').json()['1'] == {'top': 0.05, 'bottom': 0.95, 'left': 0, 'right': 1}
        assert c2.get('/api/cleanup/sort').json()['decisions'] == {a['id']: 'keep', b['id']: 'delete'}
        assert [(n['id'], n['text'], n['at']) for n in c2.get('/api/cleanup/notes').json()] == [(a['id'], 'from the Disney book', 7)]
        sug = c2.get('/api/cleanup/suggest').json()
        assert [(s['id'], s['suggest']) for s in sug] == [(b['id'], {'title': 'Moon River'})]
        assert c2.get(f'/api/books/{book["id"]}/split').json()['starts'] == {'2': 'Second song'}
        lst = c2.get('/api/books/split').json()['books']
        assert lst[0]['canUnmake'] is True and lst[0]['starts'] == {'2': 'Second song'}
        st = {s['id']: s for s in c2.get('/api/cleanup').json()['songs']}
        assert st[a['id']]['reviewed'] and st[a['id']]['pages'][0]['kept'] and st[b['id']]['pages'][0]['later']
        assert not any(t['id'] == b['id'] for t in c2.get('/api/cleanup').json()['titles'])  # title:<b> ok mark
    c = db(data)
    assert c.execute('SELECT COUNT(*) FROM page_later_log').fetchone()[0] == 2  # history, even of an item gone since
    assert c.execute("SELECT COUNT(*) FROM name_suggestion WHERE item_id='s-gone'").fetchone()[0] == 1
    assert c.execute("SELECT COUNT(*) FROM book_split_undo WHERE book_id='s-gone'").fetchone()[0] == 1
    assert c.execute("SELECT status, old FROM name_suggestion WHERE item_id=?", (a['id'],)).fetchone() == ('accepted', '{"title": "X"}')
    act = c.execute("SELECT detail FROM activity WHERE type='migrate' AND title='Clean up state'").fetchone()[0]
    assert 'imported-' in act and '3 sort' not in act and '2 sort' in act
    # a second start with no file (or a new stray file) adds nothing twice
    (data / 'work' / 'cleanup.json').write_text(json.dumps(sample_json([a['id'], b['id'], book['id']])))
    with TestClient(create_app(data, background=False)):
        pass
    assert c.execute('SELECT COUNT(*) FROM page_later_log').fetchone()[0] == 2
    assert c.execute('SELECT COUNT(*) FROM name_suggestion').fetchone()[0] == 3
    assert c.execute('SELECT COUNT(*) FROM book_split_undo').fetchone()[0] == 2
    assert len(list((data / 'work').glob('cleanup.json.imported-*'))) == 2


def test_broken_cleanup_json_is_left_alone(data):
    (data / 'work').mkdir()
    (data / 'work' / 'cleanup.json').write_text('{not json')
    with TestClient(create_app(data, background=False)) as c:
        assert c.get('/api/cleanup/sort').json() == {'decisions': {}}
    assert (data / 'work' / 'cleanup.json').read_text() == '{not json'


# ---------- folders by id ----------

def legacy(client, data, it, title):
    """Turn a new-style item (items/<id>/) into the old layout: items/<id> <title>/ with '<id> <title> …' files."""
    old = f'{it["id"]} {title}'
    d = data / 'items' / old
    os.rename(data / 'items' / it['folder'], d)
    c = db(data)
    for f in sorted(d.iterdir()):
        if f.name.startswith(it['id']) and f.is_file():
            os.rename(f, d / (old + f.name[len(it['id']):]))
    c.execute('UPDATE item SET folder=? WHERE id=?', (old, it['id']))
    c.execute("UPDATE sheet_page SET file=? || substr(file, ?) WHERE item_id=?", (old, len(it['id']) + 1, it['id']))
    for col in ('musicxml', 'musicxml_original', 'midi', 'pdf'):
        c.execute(f"UPDATE score SET {col}=? || substr({col}, ?) WHERE item_id=? AND {col} IS NOT NULL", (old, len(it['id']) + 1, it['id']))
    c.execute("UPDATE page_scan SET file=? || substr(file, ?) WHERE item_id=?", (old, len(it['id']) + 1, it['id']))
    c.commit()
    return client.get(f'/api/items/{it["id"]}').json()


def tree(d: Path):
    return sorted(str(p.relative_to(d)) for p in d.rglob('*'))


def run_script(*args):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
    import migrate_id_folders
    return migrate_id_folders.main(list(args))


def test_migrate_folders_and_undo(client, data, capsys):
    from test_trim import trim
    s = make(client, 'Memory: Cats', ['red', 'green'])
    trim(client, s, 1, top=0.1, bottom=0.9)  # .history/p1-* inside the folder
    client.post('/api/cleanup/later', json={'key': f'{s["id"]}:2'})
    m = client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'musicxmlText': '<score>v1</score>'}).json()
    client.put(f'/api/items/{m["id"]}/musicxml', content='<score>v2</score>')  # + '(original)'
    book = make(client, 'Big Book', ['blue'])
    book = client.post('/api/items/book', json={'ids': [book['id']], 'book': True}).json()['items'][0]
    client.get('/api/cleanup')  # a scan row for every page
    s_old, m_old = legacy(client, data, s, 'Memory- Cats'), legacy(client, data, m, 'Ode')
    assert s_old['folder'] == f'{s["id"]} Memory- Cats' and s_old['pageFiles'][0] == f'{s["id"]} Memory- Cats 1.png'
    assert m_old['musicxmlOriginal'] == f'{m["id"]} Ode (original).musicxml'
    before = tree(data / 'items')
    hist = sorted(p.name for p in (data / 'items' / s_old['folder'] / '.history').iterdir())
    assert hist
    # dry run: nothing changes
    assert run_script('--data', str(data), '--dry-run') == 0
    assert 'Would move 2 folder(s): 4 file(s) renamed (2 page rows, 2 score file columns)' in capsys.readouterr().out
    assert tree(data / 'items') == before and not list(data.glob('history/folders-*'))
    # do it
    assert run_script('--data', str(data)) == 0
    out = capsys.readouterr().out
    assert 'Moved 2 folder(s)' in out
    s2, m2, b2 = (client.get(f'/api/items/{i}').json() for i in (s['id'], m['id'], book['id']))
    assert s2['folder'] == s['id'] and s2['pageFiles'] == [f'{s["id"]} 1.png', f'{s["id"]} 2.png']
    assert sorted(p.name for p in (data / 'items' / s['id'] / '.history').iterdir()) == hist  # page-based names kept
    assert (m2['folder'], m2['musicxml'], m2['musicxmlOriginal']) == (m['id'], f'{m["id"]}.musicxml', f'{m["id"]} (original).musicxml')
    assert b2['folder'] == 'Books/Big Book' and b2['pageFiles'] == ['Big Book 1.png']  # books untouched
    assert color_of(client, s2, 2) == (0, 128, 0) and client.get(f'/api/items/{s["id"]}/pages/1').status_code == 200
    assert client.get(f'/api/items/{s["id"]}/pages/1/original').status_code == 200
    assert client.get(f'/api/items/{m["id"]}/musicxml').text == '<score>v2</score>'
    assert client.get(f'/api/items/{m["id"]}/musicxml?original=true').text == '<score>v1</score>'
    files = db(data).execute('SELECT file FROM page_scan WHERE item_id=? ORDER BY page', (s['id'],)).fetchall()
    assert files == [(f'{s["id"]} 1.png',), (f'{s["id"]} 2.png',)]  # the scan cache follows: no rescan
    song = client.get('/api/cleanup', params={'id': s['id']}).json()['songs'][0]
    assert song['pages'][0]['trims'] == 1 and song['pages'][1]['later']
    logs = list((data / 'history').glob('folders-*.jsonl'))
    assert len(logs) == 1
    lines = [json.loads(x) for x in logs[0].read_text().splitlines()]
    assert {x['id'] for x in lines} == {s['id'], m['id']}
    assert next(x for x in lines if x['id'] == s['id'])['folder'] == [s_old['folder'], s['id']]
    assert list((data / 'backups').glob('meowsic-before-id-folders-*.db'))
    # again: nothing left to do
    assert run_script('--data', str(data)) == 0 and 'Moved 0 folder(s)' in capsys.readouterr().out
    assert len(list((data / 'history').glob('folders-2*.jsonl'))) == 1
    # a rename now moves nothing
    client.patch(f'/api/items/{s["id"]}', json={'title': 'Totally new'})
    assert client.get(f'/api/items/{s["id"]}').json()['pageFiles'] == s2['pageFiles']
    # undo: everything back, twice is harmless
    assert run_script('--data', str(data), '--undo', str(logs[0])) == 0
    assert tree(data / 'items') == before
    s3, m3 = client.get(f'/api/items/{s["id"]}').json(), client.get(f'/api/items/{m["id"]}').json()
    assert s3['folder'] == s_old['folder'] and s3['pageFiles'] == s_old['pageFiles'] and m3['musicxml'] == m_old['musicxml']
    assert color_of(client, s3, 2) == (0, 128, 0)
    assert run_script('--data', str(data), '--undo', str(logs[0])) == 0
    assert 'Put back 0 folder(s)' in capsys.readouterr().out.splitlines()[-1]
    assert tree(data / 'items') == before
    assert list((data / 'history').glob('folders-undo-*.jsonl'))


def test_migrate_skips_clash_and_rolls_back(client, data, monkeypatch, capsys):
    from meowsic import idfolders
    a, b = make(client, 'One', ['red']), make(client, 'Two', ['blue', 'green'])
    a_old, b_old = legacy(client, data, a, 'One'), legacy(client, data, b, 'Two')
    (data / 'items' / a['id']).mkdir()  # something already sits at items/<id>
    real, calls = os.rename, []

    def flaky(x, y):
        calls.append(x)
        if Path(x).name == f'{b["id"]} Two 2.png': raise OSError('disk says no')
        real(x, y)
    monkeypatch.setattr(os, 'rename', flaky)
    r = idfolders.migrate(data, backup=False, out=lambda *_: None)
    monkeypatch.setattr(os, 'rename', real)
    assert r['skipped'] == 1 and r['problems'][0][0] == a['id'] and r['failed'] == [b['id']]
    for it, old in ((a, a_old), (b, b_old)):
        now = client.get(f'/api/items/{it["id"]}').json()
        assert now['folder'] == old['folder'] and now['pageFiles'] == old['pageFiles']
        assert sorted(p.name for p in (data / 'items' / old['folder']).iterdir()) == old['pageFiles']
    assert not (data / 'items' / b['id']).exists()
