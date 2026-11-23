"""Split / join move real page files, history and notes."""
import io
from PIL import Image


def png(color):
    b = io.BytesIO(); Image.new('RGB', (40, 60), color).save(b, 'PNG'); return b.getvalue()


def make(client, title, colors):
    files = [('files', (f'{k}.png', png(col), 'image/png')) for k, col in enumerate(colors)]
    return client.post('/api/sheets', data={'title': title}, files=files).json()['item']


def color_of(client, it, n):
    r = client.get(f'/api/items/{it["id"]}/file/{it["pageFiles"][n - 1]}')
    return Image.open(io.BytesIO(r.content)).convert('RGB').getpixel((1, 1))


def test_split_and_join(client):
    it = make(client, 'Mixed', ['red', 'green', 'blue', 'yellow'])
    client.put(f'/api/items/{it["id"]}/annotations/3', json=[{'tool': 'blue', 'pts': [[0.1, 0.2]]}])
    r = client.post(f'/api/items/{it["id"]}/split', json={'pages': [3, 4], 'title': 'Other song'}).json()
    a, b = r['item'], r['new']
    assert a['pages'] == 2 and b['pages'] == 2 and b['title'] == 'Other song'
    assert [color_of(client, a, n) for n in (1, 2)] == [(255, 0, 0), (0, 128, 0)]
    assert [color_of(client, b, n) for n in (1, 2)] == [(0, 0, 255), (255, 255, 0)]
    assert all(f.startswith(b['folder'] + ' ') for f in b['pageFiles'])
    assert client.get(f'/api/items/{b["id"]}/annotations/1').json()[0]['pts'] == [[0.1, 0.2]]
    assert client.post(f'/api/items/{it["id"]}/split', json={'pages': [1, 2]}).status_code == 400  # not all pages
    j = client.post(f'/api/items/{a["id"]}/join', json={'other': b['id']}).json()['item']
    assert j['pages'] == 4 and [color_of(client, j, n) for n in (3, 4)] == [(0, 0, 255), (255, 255, 0)]
    assert client.get(f'/api/items/{b["id"]}').json()['deleted']


def test_page_by_number_survives_rename(client):
    it = make(client, 'Stable', ['red', 'green'])
    url = f'/api/items/{it["id"]}/pages/2'
    r = client.get(url)
    assert r.status_code == 200 and r.headers['cache-control'] == 'no-cache' and r.headers['etag'] and r.headers['last-modified']
    assert Image.open(io.BytesIO(r.content)).convert('RGB').getpixel((1, 1)) == (0, 128, 0)
    assert client.get(url, headers={'If-None-Match': r.headers['etag']}).status_code == 304
    renamed = client.patch(f'/api/items/{it["id"]}', json={'title': 'Stable renamed'}).json()
    assert renamed['pageFiles'] == it['pageFiles'] == [f'{it["id"]} 1.png', f'{it["id"]} 2.png']  # named by id: nothing moves
    assert client.get(url, headers={'If-None-Match': r.headers['etag']}).status_code == 304
    # a book is named after its title: renaming it moves the files, the page URL still works
    book = client.post('/api/items/book', json={'ids': [it['id']], 'book': True}).json()['items'][0]
    renamed = client.patch(f'/api/items/{it["id"]}', json={'title': 'Stable book'}).json()
    assert renamed['pageFiles'] != book['pageFiles'] and renamed['folder'] == 'Books/Stable book'
    assert client.get(f'/api/items/{it["id"]}/file/{book["pageFiles"][1]}').status_code == 404  # old name gone
    r2 = client.get(url)
    assert r2.status_code == 200 and r2.headers['etag'] != r.headers['etag']
    assert Image.open(io.BytesIO(r2.content)).convert('RGB').getpixel((1, 1)) == (0, 128, 0)
    assert client.get(f'/api/items/{it["id"]}/file/{renamed["pageFiles"][1]}').status_code == 200  # /file/ still works
    assert client.get(f'/api/items/{it["id"]}/pages/3').status_code == 404
    assert client.get('/api/items/nope/pages/1').status_code == 404
