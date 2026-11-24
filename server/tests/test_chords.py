"""Chord search/fetch: parsers on fixed HTML, the endpoints (network stubbed), and live smoke tests."""
import html
import json
import socket
from pathlib import Path

import pytest

from meowsic import chords

UG_CONTENT = ('[Intro]\n[ch]C[/ch]   [ch]G[/ch]\n\n\n[Verse 1]\n'
              'When I [ch]find[/ch] me\n'      # inline chord, same line
              '[ch]C[/ch]       [ch]G[/ch]\nTwinkle twinkle star\n'
              'e|---0---|\nEm 022000\n[tab]x2[/tab]\n\n')


def ug_page(data):
    return f'<div class="js-store" data-content="{html.escape(json.dumps({"store": {"page": {"data": data}}}))}"></div>'


HAC_SONG = '''<h1 id="song-title"> <span>Bắc Kim Thang</span></h1>
<div id="song-info"> <span data-key="C">C</span></div>
<div id="song-author"><a class="author-item">Đồng dao</a></div>
<span class="perform-singer-list"><a class="author-item">Bé Na</a></span>
<div id="song-lyric">
<div class="chord_lyric_line"><span class="hopamchuan_chord">C</span><span class="hopamchuan_lyric">Bắc kim </span><span class="hopamchuan_chord">G</span><span class="hopamchuan_lyric">thang</span></div>
<div class="chord_lyric_line text_only">Điệp khúc:</div>
<div class="chord_lyric_line text_only"> </div>
<div class="chord_lyric_line text_only"> </div>
<div class="chord_lyric_line"><span class="hopamchuan_chord">Am</span><span class="hopamchuan_lyric"> | </span><span class="hopamchuan_chord">F</span></div>
</div><div id="song-leftover-space"></div>'''

HAC_SEARCH = '''<a href="https://hopamchuan.com/song/42/bac-kim-thang/?x=1" class="song-title">Bắc Kim Thang</a>
<a class="author-item">Đồng dao</a><a class="author-item">Đồng dao</a><div class="song-preview-lyric">[C]Bắc kim [G]thang cà lang</div>
<a href="https://hopamchuan.com/song/43/other/" class="song-title">Other &amp; Co</a>'''


def test_parse_ug_content_to_chordpro():
    text = chords.to_chordpro(chords.parse_ug_content(UG_CONTENT))
    assert text == ('{c: Intro}\n[C]   [G]\n\n{c: Verse 1}\nWhen I [find] me\n'
                    '[C]Twinkle [G]twinkle star\ne|---0---|\nx2')


def test_parse_ug_song_and_search():
    s = chords.parse_ug_song(ug_page({'tab': {'id': 7, 'song_name': 'Let It Be', 'artist_name': 'The Beatles', 'tonality_name': 'D'},
                                       'tab_view': {'meta': {'capo': '2', 'tonality': 'C'}, 'wiki_tab': {'content': '[ch]C[/ch]\nLet it be'}}}), 'u')
    assert (s['title'], s['artist'], s['key'], s['capo']) == ('Let It Be', 'The Beatles', 'C', 2)
    assert chords.to_chordpro(s['lines']) == '[C]Let it be'
    res = chords.parse_ug_search(ug_page({'results': [
        {'id': 1, 'type': 'Tabs', 'tab_url': 'https://tabs.ultimate-guitar.com/a', 'song_name': 'A', 'artist_name': 'X'},
        {'id': 2, 'type': 'Chords', 'tab_url': 'https://tabs.ultimate-guitar.com/b', 'song_name': 'B', 'artist_name': 'X', 'rating': 4, 'votes': 10},
        {'id': 3, 'type': 'Ukulele Chords', 'tab_url': 'https://tabs.ultimate-guitar.com/c', 'song_name': 'C', 'artist_name': 'X', 'rating': 5, 'votes': 100}]}))
    assert [r['id'] for r in res] == ['ug-3', 'ug-2'] and res[0]['info'] == 'ukulele · ★ 5.0 (100)'
    with pytest.raises(RuntimeError): chords.parse_ug_song('<html></html>', 'u')


def test_parse_hac():
    s = chords.parse_hac_song(HAC_SONG, 'https://hopamchuan.com/song/42/bac-kim-thang/')
    assert (s['id'], s['title'], s['artist'], s['key']) == ('hac-42', 'Bắc Kim Thang', 'Đồng dao, Bé Na', 'C')
    assert chords.to_chordpro(s['lines']) == '[C]Bắc kim [G]thang\nĐiệp khúc:\n\n[Am] | [F]'
    assert s['lines'][-1]['co'] is True
    r = chords.parse_hac_search(HAC_SEARCH)
    assert r[0]['url'] == 'https://hopamchuan.com/song/42/bac-kim-thang/' and r[0]['artist'] == 'Đồng dao'
    assert r[0]['preview'] == 'Bắc kim thang cà lang' and r[1]['title'] == 'Other & Co'


def test_endpoints_with_stubbed_network(client, monkeypatch):
    seen = []
    def fake_get(url):
        seen.append(url)
        if 'hopamchuan.com/search' in url: return HAC_SEARCH
        if 'hopamchuan.com/song' in url: return HAC_SONG
        if 'ultimate-guitar.com/search' in url: raise RuntimeError('www.ultimate-guitar.com responded 403')
        return ug_page({'tab': {'id': 1, 'song_name': 'S', 'artist_name': 'A'}, 'tab_view': {'meta': {}, 'wiki_tab': {'content': '[ch]G[/ch]\nHi'}}})
    monkeypatch.setattr(chords, 'get', fake_get)
    r = client.get('/api/chords/search', params={'q': 'bac kim thang'}).json()
    assert r['results'][0]['title'] == 'Bắc Kim Thang' and r['errors'] == ['Ultimate Guitar: www.ultimate-guitar.com responded 403']
    assert client.get('/api/chords/search', params={'q': 'x', 'lang': 'vi'}).json()['errors'] == []
    assert not any('ultimate' in u for u in seen[-1:])
    f = client.get('/api/chords/fetch', params={'url': 'https://hopamchuan.com/song/42/bac-kim-thang/'}).json()
    assert f['text'].startswith('[C]Bắc kim') and f['key'] == 'C' and f['capo'] == 0 and f['artist']
    assert client.get('/api/chords/fetch', params={'url': 'https://tabs.ultimate-guitar.com/tab/x'}).json()['text'] == '[G]Hi'
    assert client.get('/api/chords/fetch', params={'url': 'https://evil.com/x'}).status_code == 400
    assert client.get('/api/chords/fetch', params={'url': 'http://hopamchuan.com/song/1'}).status_code == 400


def test_digits_spelled_for_hac():
    assert chords.spell_digits('3 ngon nen') == 'ba ngon nen'
    assert chords.words('Ba Ngọn Nến Đỏ') == ['ba', 'ngon', 'nen', 'do']


def online(host):
    try:
        socket.create_connection((host, 443), timeout=3).close()
        return True
    except OSError:
        return False


@pytest.mark.live
@pytest.mark.skipif(not online('www.ultimate-guitar.com'), reason='offline')
def test_live_ultimate_guitar():
    r = chords.search('let it be', 'en')
    assert r['results'], r['errors']
    s = chords.fetch_song(r['results'][0]['url'])
    assert s['source'] == 'ultimate-guitar' and '[' in s['text'] and s['title']


@pytest.mark.live
@pytest.mark.skipif(not online('hopamchuan.com'), reason='offline')
def test_live_hopamchuan():
    r = chords.search('3 ngon nen', 'vi')
    assert r['results'], r['errors']
    s = chords.fetch_song(r['results'][0]['url'])
    assert s['source'] == 'hopamchuan' and '[' in s['text'] and s['key']


# ---------- a real tab page's layout (synthesised: same JSON store, made-up words) ----------

FIX = Path(__file__).parent / 'fixtures'


def test_ug_tab_page_fixture():
    """Shape of tabs.ultimate-guitar.com/tab/962805: [tab]-wrapped chord-over-lyric pairs, \\r\\n, bar lines, no key."""
    s = chords.parse_ug_song((FIX / 'ug_chords_page.html').read_text(), 'u')
    text = chords.to_chordpro(s['lines'])
    assert s['title'] == 'Synthetic Test Song' and s['artist'] == 'Misc Musicals'
    assert s['key'] == 'A'  # no tonality in the page: the first chord
    assert '[ch]' not in text and '[tab]' not in text and '\r' not in text
    assert '{c: Intro}' in text and '{c: Chorus}' in text
    assert '[A]' in text and '[F#m/E]' in text and '[Bm7]' in text
    lyric = [l for l in text.split('\n') if l and not l.startswith('{') and not l.startswith('|')]
    assert len(lyric) == 8 and all('[' in l for l in lyric[2:])  # 2 header lines, then every lyric line has its chords merged in


def test_ug_layout_variants():
    data = {'tab': {'id': 5, 'song_name': 'S', 'artist_name': 'A'}, 'tab_view': {'wiki_tab': {'content': '[ch]G[/ch]\nHi'}}}
    attr_first = f'<div data-content="{html.escape(json.dumps({"store": {"page": {"data": data}}}))}" class="js-store x"></div>'
    script = f'<script>window.UGAPP.store.page = {json.dumps({"data": data})};</script>'
    for page in (attr_first, script):
        assert chords.to_chordpro(chords.parse_ug_song(page, 'u')['lines']) == '[G]Hi'


def test_ug_official_tab_says_so():
    with pytest.raises(RuntimeError, match='Official.*no chord text'):
        chords.parse_ug_song((FIX / 'ug_official_page.html').read_text(), 'u')


def test_fetch_never_returns_empty_text(client, monkeypatch):
    pages = {'962805': (FIX / 'ug_chords_page.html').read_text(), 'off': (FIX / 'ug_official_page.html').read_text(),
             'empty': ug_page({'tab': {'id': 1, 'song_name': 'S'}, 'tab_view': {'wiki_tab': {'content': '[Intro]\n\n'}}})}
    monkeypatch.setattr(chords, 'get', lambda url: pages[url.rsplit('/', 1)[1]])
    f = client.get('/api/chords/fetch', params={'url': 'https://tabs.ultimate-guitar.com/tab/962805'}).json()
    assert f['text'].strip() and f['chordCount'] >= 20 and f['lineCount'] >= 8 and 'lines' not in f
    r = client.get('/api/chords/fetch', params={'url': 'https://tabs.ultimate-guitar.com/tab/off'})
    assert r.status_code == 502 and 'Official' in r.json()['detail']
    r = client.get('/api/chords/fetch', params={'url': 'https://tabs.ultimate-guitar.com/tab/empty'})
    assert r.status_code == 502 and 'No chords' in r.json()['detail']


def test_web_chord_chart_never_saved_empty(client):
    url = 'https://tabs.ultimate-guitar.com/tab/1'
    for text in ('', '   ', None):
        r = client.post('/api/items', json={'kind': 'chords', 'title': 'X', 'source': 'ultimate-guitar', 'url': url, 'text': text})
        assert r.status_code == 400 and 'no chords' in r.json()['detail']
    it = client.post('/api/items', json={'kind': 'chords', 'title': 'X', 'source': 'hopamchuan', 'url': url, 'text': '[C]la'}).json()
    assert client.patch(f'/api/items/{it["id"]}', json={'text': ''}).status_code == 400
    # a chart refilled by PATCH gets an Activities row that rolls back (the detail never echoes the words)
    assert client.patch(f'/api/items/{it["id"]}', json={'text': '[G]new words'}).json()['text'] == '[G]new words'
    act = next(a for a in client.get('/api/activity').json() if 'chord chart text' in (a.get('detail') or ''))
    assert 'new words' not in act['detail'] and act['title'] == 'X'
    assert client.post(f'/api/activity/{act["id"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{it["id"]}').json()['text'] == '[C]la'
