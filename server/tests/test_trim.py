"""Fix pages: every crop is cut from the original photo; the crop is reported on the original."""
import io
import json
import time

from PIL import Image


def png(w=200, h=400):
    b = io.BytesIO(); Image.new('RGB', (w, h), 'white').save(b, 'PNG'); return b.getvalue()


def make(client, title='Crop me', n=2):
    files = [('files', (f'{k}.png', png(), 'image/png')) for k in range(n)]
    return client.post('/api/sheets', data={'title': title}, files=files).json()['item']


def size(client, it, n=1):
    r = client.get(f'/api/items/{it["id"]}/file/{it["pageFiles"][n - 1]}')
    return Image.open(io.BytesIO(r.content)).size


def page(client, it, n=1):
    s = client.get('/api/cleanup', params={'id': it['id']}).json()['songs'][0]
    return s['pages'][n - 1]


def orig_size(client, it, n=1):
    r = client.get(f'/api/items/{it["id"]}/pages/{n}/original')
    assert r.status_code == 200
    return Image.open(io.BytesIO(r.content)).size


def trim(client, it, n=1, **box):
    r = client.post(f'/api/items/{it["id"]}/pages/{n}/trim', json=box)
    assert r.status_code == 200, r.text
    return r.json()


def test_retrim_from_original(client):
    it = make(client)
    assert page(client, it)['crop'] is None and orig_size(client, it) == (200, 400)
    it = trim(client, it, top=0.25, bottom=0.75)
    assert size(client, it) == (200, 200)
    p = page(client, it)
    assert p['crop'] == {'top': 0.25, 'bottom': 0.75, 'left': 0.0, 'right': 1.0} and p['trims'] == 1
    assert orig_size(client, it) == (200, 400)  # the original, not the cropped file
    # again: cut from the original, not from the cropped page
    it = trim(client, it, top=0.1, bottom=0.6, left=0.25, right=0.75)
    assert size(client, it) == (100, 200)
    p = page(client, it)
    assert p['crop'] == {'top': 0.1, 'bottom': 0.6, 'left': 0.25, 'right': 0.75} and p['trims'] == 2
    assert orig_size(client, it) == (200, 400)
    # one original kept
    from meowsic.cleanup import _steps
    d = client.app.state.cfg.items_dir / it['folder']
    assert sum(1 for e in _steps(d, 1) if e['img']) == 1


def test_undo_to_previous_crop_and_untrim_all(client):
    it = make(client)
    trim(client, it, top=0.25, bottom=0.75)
    it = trim(client, it, top=0.5, bottom=1.0)
    assert size(client, it) == (200, 200)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={}).json()
    assert page(client, it)['crop']['top'] == 0.25 and page(client, it)['trims'] == 1
    assert size(client, it) == (200, 200)
    it = trim(client, it, top=0.0, bottom=0.5)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={'all': True}).json()
    p = page(client, it)
    assert p['crop'] is None and p['trims'] == 0 and size(client, it) == (200, 400)
    assert client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={}).status_code == 404
    # undo of the only trim gives the original back too
    trim(client, it, top=0.25, bottom=0.75)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={}).json()
    assert page(client, it)['crop'] is None and size(client, it) == (200, 400)


def test_strokes_follow_the_crop(client):
    it = make(client)
    client.put(f'/api/items/{it["id"]}/annotations/1', json=[{'tool': 'pen', 'pts': [[0.5, 0.5]]}])
    pts = lambda: client.get(f'/api/items/{it["id"]}/annotations/1').json()[0]['pts'][0]
    trim(client, it, top=0.25, bottom=0.75)
    assert pts() == [0.5, 0.5]
    trim(client, it, top=0.5, bottom=1.0, left=0.0, right=0.5)  # re-crop from the original
    assert pts() == [1.0, 0.0]
    client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={})
    assert pts() == [0.5, 0.5]
    trim(client, it, top=0.0, bottom=0.5)
    client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={'all': True})
    assert pts() == [0.5, 0.5]


def test_old_style_trims(client):
    """Pages trimmed the old way: an image of the page before each trim + .json relative to that image."""
    it = make(client, n=1)
    d = client.app.state.cfg.items_dir / it['folder']
    f = d / it['pageFiles'][0]
    h = d / '.history'; h.mkdir(exist_ok=True)
    ts = int(time.time() * 1000) - 10000
    from meowsic import trim as t
    (h / f'p1-{ts}.png').write_bytes(f.read_bytes())
    (h / f'p1-{ts}.json').write_text(json.dumps({'top': 0.25, 'bottom': 0.75, 'left': 0, 'right': 1}))
    t.crop(f, f, 0.25, 0.75)  # 200 x 200
    (h / f'p1-{ts + 1}.png').write_bytes(f.read_bytes())
    (h / f'p1-{ts + 1}.json').write_text(json.dumps({'top': 0.5, 'bottom': 1, 'left': 0, 'right': 1}))
    t.crop(f, f, 0.5, 1)  # 200 x 100
    p = page(client, it)
    assert p['crop'] == {'top': 0.5, 'bottom': 0.75, 'left': 0.0, 'right': 1.0} and p['trims'] == 2
    assert orig_size(client, it) == (200, 400)
    it = trim(client, it, top=0.1, bottom=0.9)  # from the original
    assert size(client, it) == (200, 320)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={}).json()
    assert page(client, it)['crop']['top'] == 0.5 and size(client, it) == (200, 100)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={}).json()
    assert page(client, it)['crop']['bottom'] == 0.75 and size(client, it) == (200, 200)
    it = client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={'all': True}).json()
    assert page(client, it)['crop'] is None and size(client, it) == (200, 400)
    assert len(list(h.glob('p1-*.png'))) == 2  # old images all kept


def test_history_is_never_removed(client):
    """Keep all history: trim / undo / Original photo only add entries; the original stays."""
    it = make(client, n=1)
    h = client.app.state.cfg.items_dir / it['folder'] / '.history'
    seen = set()
    def grows():
        now = {(f.name, f.read_bytes()) for f in h.glob('p1-*')}
        assert seen <= now, 'a history file was removed or changed'
        seen.update(now)
    for act in [('trim', {'top': 0.25, 'bottom': 0.75}), ('trim', {'top': 0.1, 'bottom': 0.9}), ('untrim', {}),
                ('untrim', {'all': True}), ('trim', {'top': 0.5, 'bottom': 1.0}), ('untrim', {})]:
        client.post(f'/api/items/{it["id"]}/pages/1/{act[0]}', json=act[1]); grows()
    assert len(list(h.glob('p1-*.png'))) == 1 and len(list(h.glob('p1-*.json'))) == 6
    assert page(client, it)['crop'] is None and page(client, it)['trims'] == 0 and size(client, it) == (200, 400)
    assert orig_size(client, it) == (200, 400)
    it = trim(client, it, top=0.0, bottom=0.5)  # still crops from the one original
    assert size(client, it) == (200, 200) and len(list(h.glob('p1-*.png'))) == 1
