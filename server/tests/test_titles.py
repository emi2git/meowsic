"""Song title from a page photo (Apple Vision through omr/title.py) and the picking rules (no Vision needed)."""
import io
import json

import pytest
from PIL import Image, ImageDraw, ImageFont

from meowsic import titles

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
vision = pytest.mark.skipif(not titles.available() or not __import__('os').path.exists(FONT), reason='Apple Vision (omr/.venv) not available')


def page_png(title, credit='Words and Music by John Smith', num='12', tempo='Moderately'):
    """A letter-size sheet page: big title, small credit + tempo, page number, and some staves."""
    w, h = 1240, 1754
    im = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(im)
    big, small = ImageFont.truetype(FONT, 64), ImageFont.truetype(FONT, 24)
    d.text((60, 50), num, fill='black', font=small)
    tw = d.textlength(title, font=big)
    d.text(((w - tw) / 2, 120), title, fill='black', font=big)
    d.text((w - 80 - d.textlength(credit, font=small), 240), credit, fill='black', font=small)
    d.text((100, 300), tempo, fill='black', font=small)
    for s in range(5):  # staves
        top = 360 + s * 260
        for k in range(5): d.line((80, top + k * 16, w - 80, top + k * 16), fill='black', width=2)
    b = io.BytesIO(); im.save(b, 'PNG')
    return b.getvalue()


def make_sheet(client, pages):
    files = [('files', (f'{k}.png', p, 'image/png')) for k, p in enumerate(pages)]
    return client.post('/api/sheets', data={'title': 'Songbook', 'artist': '', 'tags': '[]'}, files=files).json()['item']


@vision
def test_detects_big_title(client, data):
    it = make_sheet(client, [page_png('Moon River'), page_png('Yesterday', credit='Music by Paul McCartney', num='13')])
    r = client.get(f'/api/items/{it["id"]}/pages/1/title').json()
    assert r['title'] == 'Moon River' and r['confidence'] >= 0.5, r
    assert 'John Smith' not in r['title'] and 'Moderately' not in r['title']
    assert client.get(f'/api/items/{it["id"]}/pages/2/title').json()['title'] == 'Yesterday'


@vision
def test_vietnamese_title_and_caps(client):
    it = make_sheet(client, [page_png('Bèo Dạt Mây Trôi', credit='Nhạc: Dân ca Quan họ'), page_png('MỘT CÕI ĐI VỀ'), page_png('LET IT BE')])
    r = client.get(f'/api/items/{it["id"]}/pages/1/title').json()
    assert r['title'] == 'Bèo Dạt Mây Trôi', r
    assert client.get(f'/api/items/{it["id"]}/pages/2/title').json()['title'] == 'Một cõi đi về'
    assert client.get(f'/api/items/{it["id"]}/pages/3/title').json()['title'] == 'Let It Be'


@vision
def test_cached_by_file(client, data, monkeypatch):
    it = make_sheet(client, [page_png('Moon River')])
    assert client.get(f'/api/items/{it["id"]}/pages/1/title').json()['title'] == 'Moon River'
    cache = json.loads((data / 'work' / 'titles.json').read_text())
    assert len(cache) == 1 and next(iter(cache.values()))['lines']
    calls = []
    monkeypatch.setattr(titles, 'read_lines', lambda paths: calls.append(paths) or {})
    assert client.get(f'/api/items/{it["id"]}/pages/1/title').json()['title'] == 'Moon River'
    assert calls == []  # from the cache, Vision not run again


def L(text, y, h, x=0.3, w=0.4, conf=1.0):
    return {'text': text, 'x': x, 'y': y, 'w': w, 'h': h, 'conf': conf}


def test_pick_rules():
    page = {'w': 1240, 'h': 1754, 'staff': 0.25, 'lines': [
        L('14', 0.03, 0.012, x=0.05, w=0.02), L('THE CIRCLE', 0.06, 0.03), L('OF LIFE', 0.095, 0.03, x=0.38, w=0.25),
        L('from Walt Disney Pictures\' THE LION KING', 0.14, 0.016), L('Music by Elton John', 0.16, 0.012, x=0.7, w=0.2),
        L('Moderately', 0.19, 0.013, x=0.1, w=0.12), L('Am7 D/F#', 0.21, 0.012, x=0.1, w=0.15),
        L('lyrics under the notes', 0.4, 0.05)]}
    r = titles.pick(page)
    assert r['title'] == 'The Circle of Life' and r['confidence'] >= 0.8, r
    # a page that goes on with a song: the music starts at the top, nothing above it
    assert titles.pick({'w': 1, 'h': 1, 'staff': 0.05, 'lines': [L('7', 0.02, 0.01), L('love you so', 0.1, 0.02)]})['title'] == ''
    # the book's running header is not a title
    r = titles.pick({'w': 1240, 'h': 1754, 'staff': 0.3, 'lines': [L('Easy Piano Hits', 0.03, 0.03), L('Hey Jude', 0.1, 0.028)]},
                    repeats={titles.fold('Easy Piano Hits')})
    assert r['title'] == 'Hey Jude'


def test_pick_rules_from_the_old_app():
    # a two-line title whose second line starts lower case ("for Christmas"), a subtitle in brackets stays out
    r = titles.pick({'w': 1477, 'h': 2126, 'staff': 0.32, 'lines': [
        L('62', 0.08, 0.016, x=0.1, w=0.03), L('I Want a Hippopotamus', 0.09, 0.032, x=0.24, w=0.51),
        L('for Christmas', 0.1235, 0.0276, x=0.35, w=0.3), L('(Hippo the Hero)', 0.15, 0.021, x=0.41, w=0.18)]})
    assert r['title'] == 'I Want a Hippopotamus for Christmas', r
    # … but not a "from THE FILM" line under an ALL CAPS title
    r = titles.pick({'w': 1, 'h': 1, 'staff': 0.3, 'lines': [L("HOW FAR I'LL GO", 0.08, 0.03), L('from MOANA', 0.115, 0.026)]})
    assert r['title'] == "How Far I'll Go"
    # chord-diagram grids / bar lines Vision reads as letters never join the title, nor win when they are bigger
    r = titles.pick({'w': 1, 'h': 1, 'staff': 0.3, 'lines': [L('Rudolph the', 0.09, 0.03), L('Red-Nosed Reindeer', 0.12, 0.028),
                                                         L('HI II', 0.17, 0.04, conf=0.3)]})
    assert r['title'] == 'Rudolph the Red-Nosed Reindeer'
    r = titles.pick({'w': 1, 'h': 1, 'staff': 0.35, 'lines': [L('I Dreamed a Dream', 0.06, 0.029), L('WIII', 0.13, 0.033, x=0.74, w=0.09, conf=0.3)]})
    assert r['title'] == 'I Dreamed a Dream'
    # a web page screenshot: shop banner out, the credit on the title's line cut off
    r = titles.pick({'w': 1, 'h': 1, 'staff': None, 'lines': [L('Summer Sale: 90% OFF 11 : 41 :36', 0.10, 0.023),
                                                          L('We Are Singapore Arranged by: Marvin Khoo', 0.14, 0.043, x=0.34, w=0.59)]})
    assert r['title'] == 'We Are Singapore' and r['box'][2] < 0.59


def test_second_reading_only_fixes_words_the_page_prints():
    first = {'title': 'Xe dạp oi', 'confidence': 1.0, 'box': [0.3, 0.1, 0.4, 0.04]}
    page = {'lines': [L('Xe dạp oi', 0.1, 0.04), L('Xe đạp ơi xe đạp ơi', 0.4, 0.012)]}
    assert titles.better(first, {'text': 'Xe đạp ơi'}, titles._vocab(page, first['box']))['title'] == 'Xe đạp ơi'
    # a word read differently but printed nowhere else: the first reading stays
    assert titles.better(first, {'text': 'Xe đẹp ơi'}, {'xe'})['title'] == 'Xe dạp oi'
    assert titles.better(first, {'error': 'x'}, set()) is first


def test_recase():
    assert titles.recase('YOU\'RE THE ONE THAT I WANT') == "You're the One That I Want"
    assert titles.recase('MỘT CÕI ĐI VỀ') == 'Một cõi đi về'
    assert titles.recase('Moon River') == 'Moon River'


def test_not_set_up(client, monkeypatch):
    it = make_sheet(client, [page_png('Moon River')])
    monkeypatch.setattr(titles, 'available', lambda: False)
    r = client.get(f'/api/items/{it["id"]}/pages/1/title').json()
    assert r['title'] == '' and r['confidence'] == 0
    assert client.get(f'/api/items/{it["id"]}/pages/9/title').status_code == 404
