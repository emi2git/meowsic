"""Books → sheets: marks are saved, make-sheets moves page ranges into new sheets, unmake puts them back."""
import json

from test_pages import color_of, png

COLORS = [(10 * k, 255 - 10 * k, 3 * k) for k in range(1, 11)]  # page k of the book = COLORS[k-1]


def make_book(client, title='Songbook', n=10):
    files = [('files', (f'{k}.png', png(COLORS[k]), 'image/png')) for k in range(n)]
    it = client.post('/api/sheets', data={'title': title, 'artist': 'Someone', 'tags': json.dumps(['Piano'])}, files=files).json()['item']
    return client.post('/api/items/book', json={'ids': [it['id']], 'book': True}).json()['items'][0]


def colors(client, it):
    return [color_of(client, it, n) for n in range(1, it['pages'] + 1)]


def test_marks_saved(client, data):
    b = make_book(client)
    assert client.post(f'/api/books/{b["id"]}/split', json={'page': 4, 'title': 'Song A'}).json()['starts'] == {'4': 'Song A'}
    client.post(f'/api/books/{b["id"]}/split', json={'page': 8})
    client.post(f'/api/books/{b["id"]}/split', json={'page': 2})
    client.post(f'/api/books/{b["id"]}/split', json={'page': 2, 'on': False})
    g = client.get(f'/api/books/{b["id"]}/split').json()
    assert g['starts'] == {'4': 'Song A', '8': ''} and g['pages'] == 10
    lst = client.get('/api/books/split').json()['books']
    assert [x['id'] for x in lst] == [b['id']] and lst[0]['starts'] == {'4': 'Song A', '8': ''}
    saved = json.loads((data / 'work' / 'cleanup.json').read_text())
    assert saved['booksplit'][b['id']]['starts'] == {'4': 'Song A', '8': ''}
    # replace all at once
    assert client.post(f'/api/books/{b["id"]}/split', json={'starts': {'9': 'X'}}).json()['starts'] == {'9': 'X'}


def test_title_guess(client, app):
    from meowsic.booksplit import title_guess
    assert title_guess('  Moon River  \nHenry Mancini') == 'Moon River'
    assert title_guess('12\n---\nYesterday 14') == 'Yesterday'
    assert title_guess('♩ = 120 4/4') is None and title_guess('') is None
    b = make_book(client)
    c = app.state.connect()
    c.execute('UPDATE sheet_page SET ocr_text=? WHERE item_id=? AND page=5', ('Autumn Leaves\nJ. Kosma', b['id'])); c.commit(); c.close()
    assert client.get(f'/api/books/{b["id"]}/split').json()['guess'] == {'5': 'Autumn Leaves'}


def test_make_three_and_unmake(client):
    b = make_book(client)
    before = client.get(f'/api/items/{b["id"]}').json()
    client.put(f'/api/items/{b["id"]}/annotations/6', json=[{'tool': 'blue', 'pts': [[0.1, 0.2]]}])
    for p, t in ((3, 'First'), (6, ''), (9, 'Third')):
        client.post(f'/api/books/{b["id"]}/split', json={'page': p, 'title': t})
    r = client.post(f'/api/books/{b["id"]}/make-sheets', json={}).json()
    book, sheets = r['book'], r['sheets']
    assert [s['title'] for s in sheets] == ['First', 'Songbook — p6', 'Third']
    assert [s['pages'] for s in sheets] == [3, 3, 2]
    assert all(s['book'] == 0 and s['artist'] == 'Someone' and s['tags'] == ['Piano'] and not s['deleted'] for s in sheets)
    assert colors(client, sheets[0]) == [COLORS[2], COLORS[3], COLORS[4]]
    assert colors(client, sheets[1]) == [COLORS[5], COLORS[6], COLORS[7]]
    assert colors(client, sheets[2]) == [COLORS[8], COLORS[9]]
    for s in sheets:
        assert s['folder'] == f'{s["id"]} {s["title"]}' and s['pageFiles'] == [f'{s["folder"]} {k}.png' for k in range(1, s['pages'] + 1)]
    assert client.get(f'/api/items/{sheets[1]["id"]}/annotations/1').json()[0]['pts'] == [[0.1, 0.2]]
    assert book['pages'] == 2 and not book['deleted'] and colors(client, book) == [COLORS[0], COLORS[1]]
    assert book['pageFiles'] == before['pageFiles'][:2]
    assert client.get(f'/api/books/{b["id"]}/split').json()['starts'] == {}  # marks used up
    acts = client.get('/api/activity').json()
    assert any(a['type'] == 'booksplit' and '3 sheets' in a['detail'] for a in acts)
    # undo: everything back exactly
    u = client.post(f'/api/books/{b["id"]}/unmake').json()
    back = u['book']
    assert back['pages'] == 10 and back['pageFiles'] == before['pageFiles'] and colors(client, back) == COLORS
    assert client.get(f'/api/items/{b["id"]}/annotations/6').json()[0]['pts'] == [[0.1, 0.2]]
    for s in sheets: assert client.get(f'/api/items/{s["id"]}').status_code == 404
    assert client.get(f'/api/books/{b["id"]}/split').json()['starts'] == {'3': 'First', '6': '', '9': 'Third'}
    assert client.post(f'/api/books/{b["id"]}/unmake').status_code == 400  # nothing more to undo
    items = client.get('/api/items').json()
    assert len([x for x in items if x['kind'] == 'sheet']) == 1


def test_whole_book_goes_to_trash(client):
    b = make_book(client, n=4)
    r = client.post(f'/api/books/{b["id"]}/make-sheets', json={'starts': {'1': 'A', '3': 'B'}}).json()
    assert r['book']['deleted'] and r['book']['pages'] == 0
    assert [colors(client, s) for s in r['sheets']] == [COLORS[:2], COLORS[2:4]]
    assert b['id'] not in [x['id'] for x in client.get('/api/books/split').json()['books']]
    back = client.post(f'/api/books/{b["id"]}/unmake').json()['book']
    assert not back['deleted'] and back['pages'] == 4 and back['pageFiles'] == b['pageFiles'] and colors(client, back) == COLORS[:4]


def test_bad_input(client, chord):
    b = make_book(client, n=3)
    bid = b['id']
    assert client.post(f'/api/books/{bid}/make-sheets', json={}).status_code == 400  # nothing marked
    assert client.post(f'/api/books/{bid}/make-sheets', json={'starts': {'7': 'x'}}).status_code == 400
    assert client.post(f'/api/books/{bid}/make-sheets', json={'starts': {'zero': 'x'}}).status_code == 400
    assert client.post(f'/api/books/{bid}/make-sheets', json={'starts': ['1']}).status_code == 400
    assert client.post(f'/api/books/{bid}/split', json={'page': 0}).status_code == 400
    assert client.post(f'/api/books/{bid}/split', json={}).status_code == 400
    assert client.post(f'/api/books/{chord["id"]}/make-sheets', json={'starts': {'1': ''}}).status_code == 400  # not a book
    sheet = client.post('/api/sheets', data={'title': 'Plain'}, files=[('files', ('x.png', png('red'), 'image/png'))]).json()['item']
    assert client.post(f'/api/books/{sheet["id"]}/make-sheets', json={'starts': {'1': ''}}).status_code == 400
    assert client.post(f'/api/books/{bid}/unmake').status_code == 400
    assert client.get('/api/books/nope/split').status_code == 404
    assert client.get(f'/api/items/{bid}').json()['pages'] == 3


def test_unmake_refuses_after_changes(client):
    b = make_book(client, n=4)
    r = client.post(f'/api/books/{b["id"]}/make-sheets', json={'starts': {'3': 'A'}}).json()
    s = r['sheets'][0]
    client.post(f'/api/items/{s["id"]}/split', json={'pages': [2], 'title': 'Other'})
    assert client.post(f'/api/books/{b["id"]}/unmake').status_code == 409
    assert client.get(f'/api/items/{b["id"]}').json()['pages'] == 2
