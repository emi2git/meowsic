"""Books: a sheet becomes a book (items/Books/<title>/, pages '<title> <n>.png'), renames, splits and goes back."""
from test_pages import make, color_of


def test_book_roundtrip(client, tmp_path):
    it = make(client, 'Big: Songbook', ['red', 'green', 'blue'])
    assert it['book'] == 0
    r = client.post('/api/items/book', json={'ids': [it['id']], 'book': True}).json()
    b = r['items'][0]
    assert r['count'] == 1 and b['book'] == 1 and b['folder'] == 'Books/Big- Songbook'
    assert b['pageFiles'] == ['Big- Songbook 1.png', 'Big- Songbook 2.png', 'Big- Songbook 3.png']
    assert [color_of(client, b, n) for n in (1, 3)] == [(255, 0, 0), (0, 0, 255)]
    # a second book with the same name gets ' (2)'
    other = make(client, 'Big: Songbook', ['purple'])
    b2 = client.post('/api/items/book', json={'ids': [other['id']]}).json()['items'][0]
    assert b2['folder'] == 'Books/Big- Songbook (2)'
    # rename keeps it in Books/
    b = client.patch(f'/api/items/{b["id"]}', json={'title': 'Jumbo Book'}).json()
    assert b['folder'] == 'Books/Jumbo Book' and b['pageFiles'][0] == 'Jumbo Book 1.png'
    assert color_of(client, b, 2) == (0, 128, 0)
    # adding a page to a book names it after the book
    from test_pages import png
    b = client.post('/api/sheets', data={'item_id': b['id']}, files=[('files', ('x.png', png('orange'), 'image/png'))]).json()['item']
    assert b['pages'] == 4 and b['pageFiles'][3] == 'Jumbo Book 4.png' and color_of(client, b, 4) == (255, 165, 0)
    t = client.get(f'/api/items/{b["id"]}/thumb/1?w=120')
    assert t.status_code == 200 and t.headers['content-type'] == 'image/jpeg'
    assert client.get(f'/api/items/{b["id"]}/thumb/99').status_code == 404
    # PATCH cannot flip the flag (files would not move)
    assert client.patch(f'/api/items/{b["id"]}', json={'book': 0}).json()['book'] == 1
    # split a song out of a book: the new one is a plain sheet
    s = client.post(f'/api/items/{b["id"]}/split', json={'pages': [3, 4], 'title': 'One song'}).json()
    assert s['new']['book'] == 0 and not s['new']['folder'].startswith('Books/')
    assert s['item']['pageFiles'] == ['Jumbo Book 1.png', 'Jumbo Book 2.png']
    # back to a sheet
    back = client.post('/api/items/book', json={'ids': [b['id']], 'book': False}).json()['items'][0]
    assert back['book'] == 0 and back['folder'] == f'{b["id"]} Jumbo Book' and back['pageFiles'][0] == f'{b["id"]} Jumbo Book 1.png'
    assert color_of(client, back, 1) == (255, 0, 0)
    # delete for good works inside Books/ too
    client.post('/api/items/trash', json={'ids': [b2['id']]})
    assert client.post('/api/items/purge', json={'ids': [b2['id']]}).json()['count'] == 1


def test_sort_decisions(client):
    assert client.get('/api/cleanup/sort').json() == {'decisions': {}}
    client.post('/api/cleanup/sort', json={'id': 's-a', 'decision': 'delete'})
    client.post('/api/cleanup/sort', json={'id': 's-b', 'decision': 'keep'})
    assert client.get('/api/cleanup/sort').json()['decisions'] == {'s-a': 'delete', 's-b': 'keep'}
    client.post('/api/cleanup/sort', json={'id': 's-b', 'decision': None})
    assert client.post('/api/cleanup/sort', json={'clear': ['s-a']}).json()['decisions'] == {}


def test_books_get_no_trim(client, app, monkeypatch):
    """Clean up is sheets only: the scan skips book pages and books are not in songs or odd titles."""
    from meowsic import cleanup
    seen = []

    def fake(path, original=None):
        seen.append(path.name)
        return {'trim': {'top': 0.1, 'bottom': 0.9, 'reasons': ['status bar']}, 'dots': None, 'box': {'top': 0.1, 'bottom': 0.9}}
    monkeypatch.setattr(cleanup.trim, 'analyze', fake)
    make(client, 'Plain Song', ['red', 'green'])
    book = make(client, 'Big Songbook', ['blue', 'yellow', 'navy'])
    odd = make(client, 'IMG_1234', ['purple', 'orange'])
    client.post('/api/items/book', json={'ids': [book['id'], odd['id']], 'book': True})
    cleanup._scan.update(running=True)
    cleanup._run_scan(app)
    assert seen and not any(n.startswith(('Big Songbook', 'IMG')) for n in seen)  # book pages not analysed
    d = client.get('/api/cleanup').json()
    assert not d['scan']['running']  # book pages do not count as 'not looked at yet'
    by = {s['title']: s for s in d['songs']}
    assert [i['kind'] for i in by['Plain Song']['issues']] == ['trim'] and by['Plain Song']['pages'][0]['trim']
    # Clean up shows only sheets: books are nowhere in it (songs, odd titles, single-song lookups)
    assert set(by) == {'Plain Song'}
    assert not any(t['id'] in (book['id'], odd['id']) for t in d['titles'])
    assert client.get(f'/api/cleanup?id={book["id"]}').json()['songs'] == []


def test_notes(client):
    a, b = make(client, 'Moon Song', ['red']), make(client, 'Star Song', ['blue'])
    assert client.get('/api/cleanup/notes').json() == []
    client.post('/api/cleanup/notes', json={'id': a['id'], 'text': 'split after page 3'})
    client.post('/api/cleanup/notes', json={'id': b['id'], 'text': '  rename to Moon River '})
    n = client.get('/api/cleanup/notes').json()
    assert [(x['id'], x['title'], x['text']) for x in n] == [(b['id'], 'Star Song', 'rename to Moon River'), (a['id'], 'Moon Song', 'split after page 3')]
    assert n[0]['at'] >= n[1]['at']
    by = {s['id']: s for s in client.get('/api/cleanup').json()['songs']}
    assert by[a['id']]['note'] == 'split after page 3'
    # the current title, after a rename
    client.patch(f'/api/items/{a["id"]}', json={'title': 'Moon Song Renamed'})
    assert next(x for x in client.get('/api/cleanup/notes').json() if x['id'] == a['id'])['title'] == 'Moon Song Renamed'
    # editing replaces; empty text removes it; other cleanup state stays
    client.post('/api/cleanup/sort', json={'id': a['id'], 'decision': 'keep'})
    client.post('/api/cleanup/notes', json={'id': a['id'], 'text': 'from the Disney book'})
    assert next(x for x in client.get('/api/cleanup/notes').json() if x['id'] == a['id'])['text'] == 'from the Disney book'
    client.post('/api/cleanup/notes', json={'id': a['id'], 'text': '   '})
    assert [x['id'] for x in client.get('/api/cleanup/notes').json()] == [b['id']]
    assert client.get('/api/cleanup/sort').json()['decisions'] == {a['id']: 'keep'}
    assert client.post('/api/cleanup/notes', json={'text': 'x'}).status_code == 400
