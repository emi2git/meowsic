"""Sheet upload: images, PDFs (pdftoppm), sha256 dedupe, appending pages, file serving."""
import shutil

import pytest

PNG = b'\x89PNG\r\n\x1a\nfake-page-%d'


def pdf_bytes(pages=2):
    """A tiny valid PDF with blank pages."""
    objs = ['<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join(f'{3 + k} 0 R' for k in range(pages)), pages)]
    objs += ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>'] * pages
    out, offs = b'%PDF-1.4\n', []
    for n, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f'{n} 0 obj\n{o}\nendobj\n'.encode()
    x = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offs)
    return out + f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()


def test_upload_images_and_dedupe(client, data):
    files = [('files', ('p1.jpeg', PNG % 1, 'image/jpeg')), ('files', ('p2.png', PNG % 2, 'image/png'))]
    r = client.post('/api/sheets', files=files, data={'title': 'Memory', 'artist': 'ALW', 'tags': '["Musical"]'})
    assert r.status_code == 201
    it = r.json()['item']
    f = it['folder']
    assert f == f"{it['id']} Memory"
    assert it['source'] == 'photos' and it['pages'] == 2 and it['pageFiles'] == [f'{f} 1.jpg', f'{f} 2.png']
    assert it['tags'] == ['Musical']
    assert client.get(f'/api/items/{it["id"]}/file/{f} 2.png').content == PNG % 2
    assert (data / 'items' / f / f'{f} 1.jpg').read_bytes() == PNG % 1
    # the same files again -> 409
    r = client.post('/api/sheets', files=files, data={'title': 'Again'})
    assert r.status_code == 409 and r.json()['detail']['skipped'][0]['duplicateOf'] == it['id']
    # append one new page, one duplicate
    r = client.post('/api/sheets', files=[('files', ('p3.png', PNG % 3, 'image/png')), files[0]], data={'item_id': it['id']})
    assert r.json()['item']['pages'] == 3 and len(r.json()['skipped']) == 1
    assert r.json()['item']['pageFiles'][-1] == f'{f} 3.png'  # numbering continues
    # rename: folder and every page follow the new title
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory: Cats'})
    it2 = client.get(f'/api/items/{it["id"]}').json()
    g = f"{it['id']} Memory- Cats"
    assert it2['folder'] == g and it2['pageFiles'] == [f'{g} 1.jpg', f'{g} 2.png', f'{g} 3.png']
    assert not (data / 'items' / f).exists()
    assert sorted(p.name for p in (data / 'items' / g).iterdir()) == it2['pageFiles']
    assert client.get(f'/api/items/{it["id"]}/file/{g} 3.png').content == PNG % 3
    client.post('/api/items/purge', json={'ids': [it['id']]})
    assert not (data / 'items' / g).exists()
    assert client.post('/api/sheets', files=[('files', ('x.txt', b'hi', 'text/plain'))]).status_code == 400


@pytest.mark.skipif(not shutil.which('pdftoppm'), reason='pdftoppm not installed')
def test_upload_pdf(client, data):
    r = client.post('/api/sheets', files=[('files', ('Clair de Lune.pdf', pdf_bytes(2), 'application/pdf'))])
    it = r.json()['item']
    f = it['folder']
    assert it['title'] == 'Clair de Lune' and it['source'] == 'pdf' and it['pages'] == 2
    assert (data / 'items' / f / f'{f}.pdf').is_file() and it['pageFiles'] == [f'{f} 1.jpg', f'{f} 2.jpg']
    assert client.get(f'/api/items/{it["id"]}/file/{f} 2.jpg').content[:2] == b'\xff\xd8'
    client.post('/api/items/purge', json={'ids': [it['id']]})
    assert not (data / 'items' / f).exists()


def test_rename_rolls_back_on_failure(client, data, monkeypatch):
    import os
    it = client.post('/api/sheets', files=[('files', ('a.png', PNG % 7, 'image/png')), ('files', ('b.png', PNG % 8, 'image/png'))],
                     data={'title': 'Old'}).json()['item']
    real, calls = os.rename, []
    def flaky(a, b):
        calls.append(a)
        if len(calls) == 3: raise OSError('disk says no')  # folder ok, first page ok, second page fails
        real(a, b)
    monkeypatch.setattr(os, 'rename', flaky)
    after = client.patch(f'/api/items/{it["id"]}', json={'title': 'New'}).json()
    monkeypatch.setattr(os, 'rename', real)
    assert after['title'] == 'New' and after['folder'] == it['folder'] and after['pageFiles'] == it['pageFiles']
    assert sorted(p.name for p in (data / 'items' / it['folder']).iterdir()) == it['pageFiles']
    assert not (data / 'items' / f"{it['id']} New").exists()


def jpeg_with_exif(when: str | None, color=(200, 10, 10)):
    import io
    from PIL import Image
    buf, img = io.BytesIO(), Image.new('RGB', (8, 8), color)
    ex = Image.Exif()
    if when: ex.get_ifd(0x8769)[36867] = when
    img.save(buf, 'JPEG', exif=ex.tobytes())
    return buf.getvalue()


def test_origin_dates(client):
    import datetime, json
    exif_ms = int(datetime.datetime(2019, 5, 4, 10, 30, 0).timestamp() * 1000)
    files = [('files', ('a.jpg', jpeg_with_exif('2019:05:04 10:30:00'), 'image/jpeg')),
             ('files', ('b.jpg', jpeg_with_exif(None, (1, 2, 3)), 'image/jpeg')),
             ('files', ('c.png', PNG % 9, 'image/png'))]
    # lastModified per file; the first is ignored because EXIF wins, the last has none
    it = client.post('/api/sheets', files=files, data={'title': 'Dated', 'last_modified': json.dumps([1, 1600000000000, None])}).json()['item']
    assert it['pageDates'] == [exif_ms, 1600000000000, None]
    assert it['originAt'] == exif_ms  # earliest page
    # appending an older page moves the item's date back; numbering continues
    it = client.post('/api/sheets', files=[('files', ('d.png', PNG % 10, 'image/png'))],
                     data={'item_id': it['id'], 'last_modified': '[1000]'}).json()['item']
    assert it['originAt'] == 1000 and it['pageDates'][-1] == 1000
    # no dates at all -> upload time
    it = client.post('/api/sheets', files=[('files', ('e.png', PNG % 11, 'image/png'))]).json()['item']
    assert it['originAt'] > 1600000000000 and it['pageDates'] == [None]
    assert client.post('/api/sheets', files=[('files', ('f.png', PNG % 12, 'image/png'))], data={'last_modified': 'x'}).status_code == 400


@pytest.mark.skipif(not shutil.which('pdftoppm'), reason='pdftoppm not installed')
def test_pdf_origin_is_last_modified(client):
    it = client.post('/api/sheets', files=[('files', ('p.pdf', pdf_bytes(2), 'application/pdf'))], data={'last_modified': '[1500000000000]'}).json()['item']
    assert it['originAt'] == 1500000000000 and it['pageDates'] == [1500000000000] * 2


def test_origin_at_on_items(client):
    c = client.post('/api/items', json={'kind': 'chords', 'title': 'C', 'text': ''}).json()
    assert c['originAt'] >= c['createdAt']  # fetch time
    s = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'originAt': 123}).json()
    assert s['originAt'] == 123
    assert client.patch(f"/api/items/{s['id']}", json={'originAt': 456}).json()['originAt'] == 456
