"""Add music → From Photos with a fake Photos album (MEOWSIC_FAKE_PHOTOS): listing, what is in the library
already, fetch + read in the background, grouping into songs, import (with crops) and undo."""
import io
import json
import sqlite3
import time

import pytest
from PIL import Image

from meowsic import grouping, photoimport, titles


def page(color, w=600, h=800):
    b = io.BytesIO(); Image.new('RGB', (w, h), color).save(b, 'PNG'); return b.getvalue()


COLS = [(200, 30, 30), (30, 200, 30), (30, 30, 200), (200, 200, 30), (30, 200, 200)]


@pytest.fixture
def album(tmp_path, monkeypatch):
    root = tmp_path / 'Photos'
    d = root / 'Sheet'  # the album is "SHEET" in any case
    d.mkdir(parents=True)
    (root / 'Holiday').mkdir()
    t0 = 1_700_000_000_000
    dates = {}
    for k, col in enumerate(COLS):
        (d / f'IMG_{k + 1}.png').write_bytes(page(col))
        dates[f'IMG_{k + 1}.png'] = t0 + k * 10_000 + (600_000 if k >= 3 else 0)  # photos 4-5 ten minutes later
    (d / 'dates.json').write_text(json.dumps(dates))
    (d / 'notes.txt').write_text('not a photo')
    monkeypatch.setenv('MEOWSIC_FAKE_PHOTOS', str(root))
    monkeypatch.setattr(titles, 'available', lambda: False)  # no Vision in these tests: grouping comes from time + layout
    return d


def wait(client, sid):
    for _ in range(200):
        s = client.get(f'/api/photos/sessions/{sid}').json()
        if s['status'] in ('ready', 'failed'): return s
        time.sleep(0.05)
    raise AssertionError('session never got ready')


def color_of(client, it, n):
    r = client.get(f'/api/items/{it["id"]}/file/{it["pageFiles"][n - 1]}')
    return Image.open(io.BytesIO(r.content)).convert('RGB').getpixel((5, 5))


def test_album_listing(client, album):
    a = client.get('/api/photos/album?name=SHEET').json()
    assert a['album'] == 'Sheet' and a['new'] == 5 and a['fake']
    assert [p['filename'] for p in a['photos']] == [f'IMG_{k}.png' for k in range(1, 6)]  # capture order
    assert all(p['inLibrary'] is None and p['w'] == 600 and p['h'] == 800 for p in a['photos'])
    # default album name from the settings, else SHEET
    assert client.get('/api/photos/album').json()['album'] == 'Sheet'
    client.put('/api/settings', json={'photosAlbum': 'holiday'})
    assert client.get('/api/photos/album').json()['album'] == 'Holiday'
    bad = client.get('/api/photos/album?name=Nope').json()
    assert bad['error'] == 'no-album' and 'Sheet' in bad['albums'] and bad['photos'] == []


def test_same_image_already_in_library(client, album):
    # the third photo was uploaded before (same bytes): it counts as in the library
    client.post('/api/sheets', data={'title': 'Old'}, files=[('files', ('x.png', (album / 'IMG_3.png').read_bytes(), 'image/png'))])
    a = client.get('/api/photos/album?name=sheet').json()
    assert a['new'] == 4
    p3 = a['photos'][2]
    assert p3['inLibrary']['how'] == 'same image' and p3['inLibrary']['title'] == 'Old'


def test_migrated_from_meowsic1(client, album, data):
    # migrate.py's manifest says photo IMG_2 became a page whose sha is X; a page with sha X exists
    client.post('/api/sheets', data={'title': 'Migrated'}, files=[('files', ('m.png', page((1, 2, 3)), 'image/png'))])
    sha = sqlite3.connect(data / 'meowsic.db').execute("SELECT sha256 FROM sheet_page").fetchone()[0]
    (data / 'migrate').mkdir()
    (data / 'migrate' / 'manifest.json').write_text(json.dumps({'s-x': {'plan': [{'asset': 'fake-IMG_2/L0/001', 'quality': 'preview'}], 'shas': [sha]}}))
    a = client.get('/api/photos/album').json()
    assert a['photos'][1]['inLibrary']['how'] == 'from Meowsic 1' and a['new'] == 4


def test_import_group_crop_and_undo(client, album, data):
    s = client.post('/api/photos/sessions', json={'name': 'SHEET'}).json()
    assert s['total'] == 5
    s = wait(client, s['id'])
    assert s['status'] == 'ready', s
    pages = s['pages']
    assert [p['filename'] for p in pages] == [f'IMG_{k}.png' for k in range(1, 6)]
    # 10 s apart = one song; ten minutes later = a new song
    assert [p['start'] for p in pages] == [True, False, False, True, False]
    assert all(p['sha256'] and p['file'] and p['quality'] == 'original' and not p.get('dup') for p in pages)
    img = client.get(f'/api/photos/sessions/{s["id"]}/pages/{pages[0]["id"]}/image?w=120')
    assert img.status_code == 200 and Image.open(io.BytesIO(img.content)).width == 120
    # the user moves photo 2 after photo 3, leaves photo 5 out, crops photo 4
    ids = [p['id'] for p in pages]
    body = {'songs': [{'title': 'Moon River', 'pages': [{'id': ids[0]}, {'id': ids[2]}, {'id': ids[1]}]},
                      {'title': '', 'pages': [{'id': ids[3], 'crop': {'top': 0.1, 'bottom': 0.9, 'left': 0, 'right': 1}}]}],
            'tags': ['Piano']}
    r = client.post(f'/api/photos/sessions/{s["id"]}/import', json=body)
    assert r.status_code == 200, r.text
    r = r.json()
    a, b = r['items']
    assert a['title'] == 'Moon River' and a['pages'] == 3 and a['tags'] == ['Piano']
    assert [color_of(client, a, n) for n in (1, 2, 3)] == [COLS[0], COLS[2], COLS[1]]
    assert a['originAt'] == 1_700_000_000_000
    assert b['title'] == 'Untitled' and b['pages'] == 1
    im = Image.open(io.BytesIO(client.get(f'/api/items/{b["id"]}/file/{b["pageFiles"][0]}').content))
    assert im.size == (600, 640)  # cropped
    orig = Image.open(io.BytesIO(client.get(f'/api/items/{b["id"]}/pages/1/original').content))
    assert orig.size == (600, 800)  # the photo is kept in .history
    db = sqlite3.connect(data / 'meowsic.db')
    assert db.execute('SELECT photo_id FROM sheet_page WHERE item_id=? ORDER BY page', (a['id'],)).fetchall() == [(ids[0],), (ids[2],), (ids[1],)]
    acts = client.get('/api/activity').json()
    assert any(x['type'] == 'photo-import' and 'Moon River' in x['detail'] for x in acts)
    # now 4 of them are in the library; photo 5 (left out) is still new
    al = client.get('/api/photos/album').json()
    assert al['new'] == 1 and al['photos'][4]['inLibrary'] is None and al['photos'][0]['inLibrary']['how'] == 'photo'
    assert al['lastImport']['id'] == r['import']['id']
    # importing the same photos again is refused
    assert client.post(f'/api/photos/sessions/{s["id"]}/import', json=body).status_code == 409
    # a split keeps the Photos id on the moved page
    sp = client.post(f'/api/items/{a["id"]}/split', json={'pages': [3], 'title': 'Part'}).json()
    assert db.execute('SELECT photo_id FROM sheet_page WHERE item_id=?', (sp['new']['id'],)).fetchone()[0] == ids[1]
    assert client.post(f'/api/photos/imports/{r["import"]["id"]}/undo').status_code == 409  # Moon River changed since
    client.post(f'/api/items/{a["id"]}/join', json={'other': sp['new']['id']})
    client.post('/api/items/purge', json={'ids': [sp['new']['id']]})
    # undo: the sheets are gone, the photos are new again
    u = client.post(f'/api/photos/imports/{r["import"]["id"]}/undo')
    assert u.status_code == 200, u.text
    assert set(u.json()['removed']) == {a['id'], b['id']}
    assert client.get(f'/api/items/{a["id"]}').status_code == 404
    assert not (data / 'items' / a['folder']).exists() and not (data / 'items' / b['folder']).exists()
    assert client.get('/api/photos/album').json()['new'] == 5
    assert client.post(f'/api/photos/imports/{r["import"]["id"]}/undo').status_code == 409
    assert db.execute('SELECT undone_at FROM photo_import').fetchone()[0]  # the record stays
    # … and the same session can add them again
    assert client.post(f'/api/photos/sessions/{s["id"]}/import', json=body).status_code == 200


def test_bad_imports(client, album):
    s = wait(client, client.post('/api/photos/sessions', json={}).json()['id'])
    ids = [p['id'] for p in s['pages']]
    url = f'/api/photos/sessions/{s["id"]}/import'
    assert client.post(url, json={'songs': []}).status_code == 400
    assert client.post(url, json={'songs': [{'title': 'A', 'pages': [{'id': ids[0]}]}, {'title': 'B', 'pages': [{'id': ids[0]}]}]}).status_code == 400
    assert client.post(url, json={'songs': [{'title': 'A', 'pages': [{'id': 'nope'}]}]}).status_code == 400
    assert client.post(url, json={'songs': [{'title': 'A', 'pages': [{'id': ids[0], 'crop': {'top': 0.5, 'bottom': 0.55}}]}]}).status_code == 400
    assert client.get('/api/photos/sessions/pi-nope').status_code == 404
    # only the photos asked for, in that order
    s2 = wait(client, client.post('/api/photos/sessions', json={'ids': [ids[3], ids[0]]}).json()['id'])
    assert [p['id'] for p in s2['pages']] == [ids[3], ids[0]]


def test_no_photos_access(client, monkeypatch):
    monkeypatch.delenv('MEOWSIC_FAKE_PHOTOS', raising=False)
    monkeypatch.setattr(photoimport, '_run_helper', lambda args, timeout: {'error': 'access', 'message': photoimport_help()})
    a = client.get('/api/photos/album').json()
    assert a['error'] == 'access' and 'Privacy & Security' in a['message'] and a['photos'] == []
    r = client.post('/api/photos/sessions', json={})
    assert r.status_code == 400 and 'Privacy & Security' in r.json()['detail']


def photoimport_help():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location('pa', pathlib.Path(photoimport.HELPER))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m.ACCESS_HELP


# ---------- grouping rules (no images) ----------

def P(date, title='', conf=0.0, dots=None, staff=0.3, layout=None):
    return {'date': date, 'title': {'title': title, 'confidence': conf}, 'dots': dots, 'staff': staff, 'layout': layout}


def test_grouping_rules():
    L = {'l': 0.1, 'r': 0.9, 'top': 0.2, 'aspect': 0.75}
    # title on a page = a new song even 40 s later; the music at the top with no title = it goes on
    pages = [P(0, 'Moon River', 0.9, layout=L), P(40_000, staff=0.05, layout=L), P(80_000, 'Yesterday', 0.8, layout=L), P(90_000, layout=L)]
    assert [r['start'] for r in grouping.propose(pages)] == [True, False, True, False]
    # page dots win: 1 of 3, 2 of 3, 3 of 3, then 1 of 2
    d = lambda lit, n: {'lit': lit, 'count': n}
    pages = [P(0, dots=d(1, 3)), P(5_000, dots=d(2, 3)), P(9_000, dots=d(3, 3)), P(12_000, dots=d(1, 2)), P(15_000, dots=d(2, 2))]
    r = grouping.propose(pages)
    assert [x['start'] for x in r] == [True, False, False, True, False] and all(x['sure'] for x in r)
    # a long break with nothing else known: a new song, but not sure
    r = grouping.propose([P(0), P(200_000, staff=None)])
    assert r[1]['start'] and not r[1]['sure']
    # a running header (same heading on each page) is not a new song
    r = grouping.propose([P(0, 'Easy Piano', 0.9), P(20_000, 'Easy Piano', 0.9)])
    assert not r[1]['start']
    # a different layout tips an unsure page
    r = grouping.propose([P(0, layout=L), P(60_000, staff=None, layout={**L, 'aspect': 1.4})])
    assert r[1]['start']
    s = grouping.songs([P(0, 'A', 0.9), P(1), P(2, 'B', 0.3)], [True, False, True])
    assert [(x['title'], x['pages']) for x in s] == [('A', [0, 1]), ('Untitled', [2])]


def test_layout_of_staves(tmp_path):
    from PIL import ImageDraw
    im = Image.new('RGB', (1000, 1400), 'white'); g = ImageDraw.Draw(im)
    for s in range(4):
        for k in range(5): g.line((100, 300 + s * 250 + k * 14, 900, 300 + s * 250 + k * 14), fill='black', width=2)
    im.save(tmp_path / 'p.png')
    lay = grouping.layout(tmp_path / 'p.png')
    assert abs(lay['l'] - 0.1) < 0.02 and abs(lay['r'] - 0.9) < 0.02 and abs(lay['top'] - 300 / 1400) < 0.02
