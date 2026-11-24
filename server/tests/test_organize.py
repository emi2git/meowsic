"""Organize pages: delete and reorder pages (kept in .history, undo puts back exact files and order),
cross-song moves keep the song-start marks on their pages, the Refresh scan and "This is a complete song"."""
import hashlib
import json

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


def test_crops_follow_their_page(client):
    it = make(client, 'Cropped', COLS[:3])
    box = {'top': 0.1, 'bottom': 0.9, 'left': 0.0, 'right': 1.0}
    client.post(f'/api/items/{it["id"]}/pages/2/trim', json=box)
    cr = client.get(f'/api/items/{it["id"]}/crops').json()['pages']
    assert [p['crop'] is not None for p in cr] == [False, True, False] and cr[1]['trims'] == 1
    # re-crop: always from the original (the crop is of the original photo, not of the cropped file)
    client.post(f'/api/items/{it["id"]}/pages/2/trim', json={**box, 'top': 0.2})
    assert client.get(f'/api/items/{it["id"]}/crops').json()['pages'][1]['crop']['top'] == 0.2
    # the page moves: its crop history moves with it, and the original is still there
    r = client.post(f'/api/items/{it["id"]}/pages/2/move', json={'to': 1}).json()
    cr = client.get(f'/api/items/{it["id"]}/crops').json()['pages']
    assert cr[0]['crop']['top'] == 0.2 and cr[0]['trims'] == 2 and cr[1]['crop'] is None
    assert client.get(f'/api/items/{it["id"]}/pages/1/original').status_code == 200
    undo(client, r['activity'])
    cr = client.get(f'/api/items/{it["id"]}/crops').json()['pages']
    assert cr[1]['crop']['top'] == 0.2 and cr[0]['crop'] is None  # back on page 2 with its history
    client.post(f'/api/items/{it["id"]}/pages/2/untrim', json={})
    assert client.get(f'/api/items/{it["id"]}/crops').json()['pages'][1]['crop']['top'] == 0.1  # undo one crop


def test_crop_after_the_daily_clean_up(client, data):
    """24 h after a crop the daily clean-up removes the page's .history: the cropped file is the original then."""
    it = make(client, 'Old crop', COLS[:2])
    client.post(f'/api/items/{it["id"]}/pages/1/trim', json={'top': 0.1, 'bottom': 0.9, 'left': 0, 'right': 1})
    for f in (data / 'items' / it['folder'] / '.history').glob('p1-*'): f.unlink()
    cr = client.get(f'/api/items/{it["id"]}/crops').json()['pages']
    assert cr[0]['crop'] is None and cr[0]['trims'] == 0
    assert client.get(f'/api/items/{it["id"]}/pages/1/original').status_code == 200  # the page file itself
    assert client.post(f'/api/items/{it["id"]}/pages/1/trim', json={'top': 0.2, 'bottom': 1, 'left': 0, 'right': 1}).status_code == 200
    assert client.get(f'/api/items/{it["id"]}/crops').json()['pages'][0]['trims'] == 1
    # a deleted page whose copy was cleaned up: Undo says so instead of breaking
    r = client.post(f'/api/items/{it["id"]}/pages/2/delete').json()
    for f in (data / 'items' / it['folder'] / '.history').glob('deleted-*'): f.unlink()
    u = client.post(f'/api/activity/{r["activity"]}/undo', json={})
    assert u.status_code == 409 and 'missing' in u.text


def twice_sheet(client, data, title):
    """A sheet whose page 2 is page 1 again and page 3 is blank (a 'duplicate' and a 'blank' candidate)."""
    files = [('files', (f'{k}.png', busy_png(k), 'image/png')) for k in range(2)] + [('files', ('w.png', png((255, 255, 255)), 'image/png'))]
    it = client.post('/api/sheets', data={'title': title}, files=files).json()['item']
    d = data / 'items' / it['folder']
    (d / it['pageFiles'][1]).write_bytes((d / it['pageFiles'][0]).read_bytes())
    return it


def test_books_are_left_out_of_organize(client, app, data):
    """Books are read-only PDFs: never listed, scanned or offered for merging, even with a page twice / blank."""
    bk = twice_sheet(client, data, 'Songbook (part 1)')
    bk = client.post('/api/items/book', json={'ids': [bk['id']], 'book': True}).json()['items'][0]
    assert bk['book']
    other = make(client, 'Songbook (part 2)', COLS[:2])  # "one song in parts" with the book: no merge offered
    client.post('/api/organize/scan', json={'wait': True})
    g = client.get('/api/organize').json()
    ids = {x['id'] for x in g['items']}
    assert bk['id'] not in ids and other['id'] in ids
    assert not any(x['id'] == bk['id'] or bk['id'] in (x.get('others') or []) for x in g['scan']['candidates'])
    assert g['scan']['items'] == len(ids)
    # a scan stored before it became a book still lists it: left out when shown
    c = app.state.connect()
    c.execute('UPDATE organize_scan SET result=? WHERE id=1', (json.dumps({'items': 2, 'candidates': [
        {'id': bk['id'], 'kind': 'blank', 'score': 0.6, 'reason': 'x', 'pages': [3]},
        {'id': other['id'], 'kind': 'merge', 'score': 0.75, 'reason': 'x', 'others': [bk['id']]}]}),))
    c.commit(); c.close()
    assert client.get('/api/organize').json()['scan']['candidates'] == []


def test_complete_songs_never_come_back(client, app, data):
    """Marked "This is a complete song": out of what is shown at once, out of a scan that read the marks before
    they were made (it was running), out of every later scan — as the item and as the other half of a merge."""
    from meowsic import organize
    from meowsic.db import connect
    a = make(client, 'Moon River (part 1)', COLS[:2])
    b = make(client, 'Moon River (part 2)', COLS[2:4])
    dup = twice_sheet(client, data, 'Twice')
    client.post('/api/organize/scan', json={'wait': True})
    cands = lambda: client.get('/api/organize').json()['scan']['candidates']
    assert {x['id'] for x in cands()} >= {a['id'], dup['id']}
    marked = {b['id'], dup['id']}
    shown = lambda: [x for x in cands() if x['id'] in marked or set(x.get('others') or []) & marked]
    for i in marked: assert client.post('/api/organize/reviewed', json={'id': i, 'on': True}).json()['reviewed']
    assert shown() == []
    # the scan ran before the marks: what it stored has them, what is shown does not
    cf = app.state.cfg
    c = connect(cf); c.execute('DELETE FROM organize_reviewed'); c.commit(); c.close()
    res = organize.scan(cf, read=False)
    assert any(x['id'] in marked or set(x.get('others') or []) & marked for x in res['candidates'])
    c = connect(cf)
    for i in marked: organize.set_reviewed(c, i, True)
    c.execute('INSERT OR REPLACE INTO organize_scan(id, job_id, at, result) VALUES (1,?,?,?)', ('j', res['at'], json.dumps({'items': res['items'], 'candidates': res['candidates']})))
    c.commit(); c.close()
    assert shown() == []
    client.post('/api/organize/scan', json={'wait': True})
    assert shown() == []
    assert {x['id'] for x in client.get('/api/organize').json()['items'] if x['reviewed']} == marked
    # marking it again is a no-op (no second Activities row), never a toggle
    assert client.post('/api/organize/reviewed', json={'id': dup['id'], 'on': True}).json()['activity'] is None
    assert shown() == []
