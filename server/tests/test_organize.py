"""Organize pages: delete and reorder pages (kept in .history, undo puts back exact files and order),
cross-song moves keep the song-start marks on their pages, the Refresh scan and "This is a complete song"."""
import hashlib

import pytest

from meowsic import titles
from test_pages import color_of, make, png

COLS = [(200, 10 * k, 255 - 20 * k) for k in range(1, 9)]


@pytest.fixture(autouse=True)
def no_vision(monkeypatch):
    monkeypatch.setattr(titles, 'available', lambda: False)


def busy_png(k):
    """A page with 'music' on it (not blank): lines at places that depend on k."""
    import io
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (120, 160), 'white'); d = ImageDraw.Draw(im)
    for y in range(10, 150, 12): d.line((5, y, 115, y), fill='black', width=1)
    for j in range(12): d.ellipse(((j * 9 + k * 23) % 110, (j * 13 + k * 31) % 150, (j * 9 + k * 23) % 110 + 8, (j * 13 + k * 31) % 150 + 6), fill='black')
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()


def colors(client, it):
    return [color_of(client, it, n) for n in range(1, it['pages'] + 1)]


def files_of(data, it):
    d = data / 'items' / it['folder']
    return {f.name: hashlib.sha1(f.read_bytes()).hexdigest() for f in d.iterdir() if f.is_file()}


def undo(client, aid):
    r = client.post(f'/api/activity/{aid}/undo', json={})
    assert r.status_code == 200, r.text
    return r.json()


def test_delete_page_kept_in_history_and_undo(client, data):
    it = make(client, 'Six pages', COLS[:6])
    client.put(f'/api/items/{it["id"]}/annotations/4', json=[{'tool': 'blue', 'pts': [[0.3, 0.4]]}])
    before = files_of(data, it)
    r = client.post(f'/api/items/{it["id"]}/pages/2/delete').json()
    a = r['item']
    assert a['pages'] == 5 and colors(client, a) == [COLS[0], *COLS[2:6]]
    assert client.get(f'/api/items/{it["id"]}/annotations/3').json()[0]['pts'] == [[0.3, 0.4]]  # ink moved with its page
    hist = list((data / 'items' / it['folder'] / '.history').glob('deleted-*'))
    assert len(hist) == 1  # never deleted for good
    act = next(x for x in client.get('/api/activity').json() if x['id'] == r['activity'])
    assert act['action'] == 'undo' and 'deleted page 2' in act['detail']
    undo(client, r['activity'])
    back = client.get(f'/api/items/{it["id"]}').json()
    assert back['pages'] == 6 and colors(client, back) == COLS[:6]
    assert files_of(data, back) == before  # the exact original files, names and order
    assert client.get(f'/api/items/{it["id"]}/annotations/4').json()[0]['pts'] == [[0.3, 0.4]]
    assert not list((data / 'items' / it['folder'] / '.history').glob('deleted-*'))


def test_reorder_and_undo(client, data):
    it = make(client, 'Order', COLS[:5])
    before = files_of(data, it)
    r = client.post(f'/api/items/{it["id"]}/pages/arrange', json={'order': [3, 1, 2, 5, 4]}).json()
    assert colors(client, r['item']) == [COLS[2], COLS[0], COLS[1], COLS[4], COLS[3]]
    assert client.get(f'/api/items/{it["id"]}/pages/1').content == client.get(f'/api/items/{it["id"]}/file/{r["item"]["pageFiles"][0]}').content
    m = client.post(f'/api/items/{it["id"]}/pages/5/move', json={'to': 1}).json()  # 4th colour to the front
    assert colors(client, m['item'])[0] == COLS[3]
    undo(client, m['activity']); undo(client, r['activity'])
    back = client.get(f'/api/items/{it["id"]}').json()
    assert colors(client, back) == COLS[:5] and files_of(data, back) == before


def test_bad_orders(client):
    it = make(client, 'Bad', COLS[:3])
    assert client.post(f'/api/items/{it["id"]}/pages/arrange', json={'order': [1, 1, 2]}).status_code == 400
    assert client.post(f'/api/items/{it["id"]}/pages/arrange', json={'order': [1, 2, 4]}).status_code == 400
    assert client.post(f'/api/items/{it["id"]}/pages/arrange', json={'order': [1, 2, 3]}).status_code == 400
    assert client.post(f'/api/items/{it["id"]}/pages/9/delete').status_code == 404


def test_cross_song_move_keeps_marks_on_pages(client):
    it = make(client, 'Two songs', COLS[:6])
    client.post(f'/api/sheets/{it["id"]}/split', json={'starts': {'4': 'Second'}})  # song 1 = p1–3, song 2 = p4–6
    # page 5 (song 2) moves before page 4: now it ends song 1; the start mark stays on its page (now 5)
    r = client.post(f'/api/items/{it["id"]}/pages/5/move', json={'to': 4}).json()
    assert r['starts'] == {'5': 'Second'}
    assert colors(client, r['item']) == [COLS[0], COLS[1], COLS[2], COLS[4], COLS[3], COLS[5]]
    # deleting the start page drops its mark; undo brings mark and page back
    d = client.post(f'/api/items/{it["id"]}/pages/5/delete').json()
    assert d['starts'] == {}
    undo(client, d['activity'])
    assert client.get(f'/api/sheets/{it["id"]}/split').json()['starts'] == {'5': 'Second'}
    undo(client, r['activity'])
    assert client.get(f'/api/sheets/{it["id"]}/split').json()['starts'] == {'4': 'Second'}
    assert colors(client, client.get(f'/api/items/{it["id"]}').json()) == COLS[:6]


def test_delete_every_page_trashes_and_undo_restores(client, data):
    it = make(client, 'Lonely', COLS[:1])
    r = client.post(f'/api/items/{it["id"]}/pages/1/delete').json()
    assert r['trashed'] and r['item']['deleted'] and r['item']['pages'] == 1  # the page stays with it in the Trash
    undo(client, r['activity'])
    back = client.get(f'/api/items/{it["id"]}').json()
    assert not back['deleted'] and colors(client, back) == COLS[:1]


def test_undo_refuses_after_later_change(client):
    it = make(client, 'Changed', COLS[:4])
    r = client.post(f'/api/items/{it["id"]}/pages/arrange', json={'order': [2, 1, 3, 4]}).json()
    client.post(f'/api/items/{it["id"]}/pages/4/delete')
    assert client.post(f'/api/activity/{r["activity"]}/undo', json={}).status_code == 409


def test_books_too_and_join_returns_activity(client):
    a = make(client, 'Book A', COLS[:3])
    b = make(client, 'Song B', COLS[3:5])
    book = client.post('/api/items/book', json={'ids': [a['id']], 'book': True}).json()['items'][0]
    r = client.post(f'/api/items/{book["id"]}/pages/arrange', json={'order': [3, 2, 1]}).json()
    assert colors(client, r['item']) == [COLS[2], COLS[1], COLS[0]]
    assert client.get(f'/api/sheets/{book["id"]}/split').status_code == 200  # the editor opens books too
    j = client.post(f'/api/items/{book["id"]}/join', json={'other': b['id']}).json()
    assert j['item']['pages'] == 5 and j['other']['deleted'] and j['activity']
    undo(client, j['activity'])
    assert client.get(f'/api/items/{book["id"]}').json()['pages'] == 3


def test_scan_and_complete_song(client, app, data):
    s1 = make(client, 'Moon River (part 1)', COLS[:2])
    s2 = make(client, 'Moon River (part 2)', COLS[2:4])
    files = [('files', (f'{k}.png', busy_png(k), 'image/png')) for k in range(2)] + [('files', ('w.png', png((255, 255, 255)), 'image/png'))]
    dup = client.post('/api/sheets', data={'title': 'Twice'}, files=files).json()['item']
    c = app.state.connect()
    d = data / 'items' / dup['folder']
    (d / dup['pageFiles'][1]).write_bytes((d / dup['pageFiles'][0]).read_bytes())  # page 2 = page 1
    c.execute("UPDATE sheet_page SET ocr_text='3' WHERE item_id=? AND page=1", (s2['id'],))
    c.execute("UPDATE sheet_page SET ocr_text='2' WHERE item_id=? AND page=2", (s2['id'],))
    c.commit(); c.close()
    job = client.post('/api/organize/scan', json={'wait': True}).json()
    assert job['kind'] == 'organize' and job['status'] == 'done'
    g = client.get('/api/organize').json()
    assert {x['id'] for x in g['items']} >= {s1['id'], s2['id'], dup['id']}
    kinds = {(x['id'], x['kind']) for x in g['scan']['candidates']}
    assert (s1['id'], 'merge') in kinds and (dup['id'], 'duplicate') in kinds and (dup['id'], 'blank') in kinds and (s2['id'], 'order') in kinds
    m = next(x for x in g['scan']['candidates'] if x['kind'] == 'merge')
    assert m['others'] == [s2['id']] and 'one song in parts' in m['reason']
    scores = [x['score'] for x in g['scan']['candidates']]
    assert scores == sorted(scores, reverse=True)
    # This is a complete song: hidden now and in later scans; undo shows it again
    r = client.post('/api/organize/reviewed', json={'id': dup['id'], 'on': True}).json()
    g = client.get('/api/organize').json()
    assert not any(x['id'] == dup['id'] for x in g['scan']['candidates'])
    assert next(x for x in g['items'] if x['id'] == dup['id'])['reviewed']
    client.post('/api/organize/scan', json={'wait': True})
    assert not any(x['id'] == dup['id'] for x in client.get('/api/organize').json()['scan']['candidates'])
    undo(client, r['activity'])
    assert any(x['id'] == dup['id'] for x in client.get('/api/organize').json()['scan']['candidates']) is False  # scan was without it
    client.post('/api/organize/scan', json={'wait': True})
    assert any(x['id'] == dup['id'] for x in client.get('/api/organize').json()['scan']['candidates'])


def test_base_title():
    from meowsic.organize import base_title
    assert base_title('Moon River (2)') == ('moon river', 2)
    assert base_title('Moon River part 2') == ('moon river', 2)
    assert base_title('Songbook — p6') == ('songbook', 6)
    assert base_title('Yesterday')[1] is None
