"""Album field (db, API, undo) + the one-time song info fill (metafill.py): what it reads, what it fills, history, undo."""
import json
import sqlite3

from meowsic import metafill as mf
from meowsic.db import Config, init_db

XML = ('<score-partwise><identification><creator type="composer">Meowsic</creator></identification><part-list><score-part id="P1"/></part-list>'
       '<part id="P1"><measure number="1"><attributes><key><fifths>-1</fifths><mode>minor</mode></key><staves>2</staves></attributes></measure></part></score-partwise>')


def test_album_column_migrates_on_an_old_db(tmp_path):
    d = tmp_path / 'M'; d.mkdir()
    db = sqlite3.connect(d / 'meowsic.db')
    db.executescript("""CREATE TABLE item (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, zoom TEXT, rate REAL, transpose INTEGER, printed_at INTEGER, legacy_ref TEXT);
        CREATE TABLE chord_chart (item_id TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', key TEXT NOT NULL DEFAULT '', capo INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
        INSERT INTO item(id, kind, title, created_at, updated_at) VALUES ('c-old1234', 'chords', 'Old', 1, 1);
        INSERT INTO chord_chart(item_id, source, text) VALUES ('c-old1234', 'pasted', '[C]la');""")
    db.commit(); db.close()
    init_db(Config(d))
    db = sqlite3.connect(d / 'meowsic.db')
    assert db.execute('SELECT album FROM item').fetchone() == ('',)
    assert db.execute('SELECT version FROM chord_chart').fetchone() == ('',)


def test_album_api_and_undo(client, chord):
    it = client.patch(f'/api/items/{chord["id"]}', json={'album': '  Les   Misérables '}).json()
    assert it['album'] == 'Les Misérables'
    assert client.get('/api/items').json()[0]['album'] == 'Les Misérables'
    it = client.patch(f'/api/items/{chord["id"]}', json={'version': 'Lead'}).json()  # chord charts get Lead / Piano / Duet too
    assert it['version'] == 'lead'
    assert client.patch(f'/api/items/{chord["id"]}', json={'version': 'vocal'}).status_code == 400
    row = next(a for a in client.get('/api/activity').json() if a['type'] == 'edit')
    assert 'album' in row['detail']
    assert client.post(f'/api/activity/{row["id"]}/undo', json={}).status_code == 200
    it = client.get(f'/api/items/{chord["id"]}').json()
    assert it['album'] == '' and it['version'] == ''


def test_titles_keys_chords():
    assert mf.key_in_title('Canon In D') == 'D' and mf.key_in_title('Waltz In A Minor') == 'Am'
    assert mf.key_in_title('Piano Sonata No. 17 In D Minor, Op. 31') == 'Dm' and mf.key_in_title('In My Life') is None
    assert mf.key_in_text('Hợp âm viết ở tone [Am] - Tone gốc A#m') == 'Am' and mf.key_in_text('Key of Eb major') == 'Eb'
    assert [mf.chord_root(x) for x in ('Am7', 'F/C', 'Bbm', 'Gsus4', 'Hello')] == ['Am', 'F', 'Bbm', 'G', None]
    assert mf.xml_key(XML) == 'D minor' and mf.xml_key('<key><fifths>2</fifths></key>') == 'D major'
    k = mf.load_known()
    assert mf.album_from_title(k, 'Edelweiss - Sound Of Music') == 'The Sound of Music'
    assert mf.album_from_title(k, 'Từ đó - OST Mắt Biếc') == 'Mắt Biếc'
    assert mf.known_song(k, {'title': 'Home', 'artist': '', 'tags': []}) is None  # only Dick Lee's Home is the NDP song
    assert mf.known_song(k, {'title': 'Home', 'artist': 'Dick Lee', 'tags': []})['album'] == 'NDP songs'


def page(lines, systems=()):
    return {'lines': [{'text': t, 'x': 0.1, 'y': y, 'w': 0.5, 'h': 0.02, 'conf': 1} for y, t in lines], 'systems': list(systems)}


def test_propose_sheet_from_page():
    k = mf.load_known()
    it = {'id': 's-x', 'kind': 'sheet', 'title': 'Some New Song', 'artist': '', 'album': '', 'key': '', 'version': '', 'tags': []}
    p1 = page([(0.05, 'SOME NEW SONG'), (0.08, 'from the Walt Disney film WHATEVER LAND'), (0.10, 'Words and Music by JANE DOE'), (0.12, 'and JOHN ROE'),
               (0.2, 'G  D  Em  C'), (0.3, 'Hel - lo there')], systems=[2, 2, 2, 2])
    last = page([(0.8, 'C  D  G')])
    new, review = mf.propose(it, k, p1, last)
    assert new['artist'][0] == 'Jane Doe & John Roe' and new['key'][0] == 'G' and new['version'][0] == 'piano'
    assert 'album' not in new and any(r[0] == 'album' and r[1] == 'Whatever Land' for r in review)  # an unknown album: review only
    lead = page([(0.2, 'Am F C G')], systems=[1, 1, 1, 1])
    assert mf.propose({**it, 'title': 'X'}, k, lead, page([(0.9, 'E7 Am')]))[0]['version'][0] == 'lead'
    duet = page([(0.1, 'Primo')], systems=[2, 2])
    assert mf.propose(it, k, duet)[0]['version'][0] == 'duet'


def test_propose_keeps_hand_values_and_fixes_wrong_ones():
    k = mf.load_known()
    it = {'id': 's-y', 'kind': 'sheet', 'title': 'River Flows in You', 'artist': 'Paul Anka', 'album': 'Mine', 'key': 'A', 'version': 'piano', 'tags': []}
    new, _ = mf.propose(it, k)
    assert new == {'artist': ('Yiruma', 'known song (was wrong)')}  # album / key / version set: kept
    assert mf.propose(it, k, hand={('s-y', 'artist')})[0] == {}  # set by hand in the app: never replaced
    s = {'id': 'm-z', 'kind': 'score', 'title': 'Amazing Grace', 'artist': 'Meowsic', 'album': '', 'key': '', 'version': 'lead', 'tags': [], 'source': 'Meowsic', 'ai': 1}
    new, _ = mf.propose(s, k, xml=XML)
    assert new['artist'][0] == 'John Newton' and new['key'][0] == 'D minor'


def test_fill_run_history_and_undo(client, data, chord):
    sheet = client.post('/api/items', json={'kind': 'sheet', 'title': 'Bring Him Home', 'artist': '', 'tags': ['Super Easy']}).json()
    score = client.post('/api/items', json={'kind': 'score', 'title': 'One Day More', 'artist': 'Les Miserables', 'version': 'original',
                                            'source': 'YouTube', 'musicxmlText': XML}).json()
    hand = client.post('/api/items', json={'kind': 'sheet', 'title': 'Hello', 'artist': 'Someone'}).json()
    client.patch(f'/api/items/{hand["id"]}', json={'album': 'My own'})  # set by hand: stays
    before = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert '<creator type="composer">Les Miserables</creator>' in before  # a new score: composer = its artist
    review = data / 'review.json'
    r = mf.run(data, ocr=False, review_file=review, log=lambda *a: None)
    assert r['applied']['count'] >= 3
    g = lambda i: client.get(f'/api/items/{i}').json()  # noqa: E731
    s = g(sheet['id'])
    assert (s['artist'], s['album'], s['version']) == ('Claude-Michel Schönberg', 'Les Misérables', 'lead')
    m = g(score['id'])
    assert (m['artist'], m['album'], m['key']) == ('Claude-Michel Schönberg', 'Les Misérables', 'D minor')
    x = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert '<creator type="composer">Claude-Michel Schönberg</creator><creator type="arranger">Transcribed by Meowsic</creator>' in x
    c = g(chord['id'])
    assert c['version'] == 'lead' and c['artist'] == 'John Newton'
    assert g(hand['id'])['album'] == 'My own'
    hist = json.loads(open(r['applied']['log']).read())
    assert any(ch['id'] == score['id'] and ch['old']['artist'] == 'Les Miserables' for ch in hist['changes'])
    assert (data / 'backups').is_dir() and list((data / 'backups').glob('pre-metafill-*.db'))
    assert json.loads(review.read_text())['review']
    assert mf.run(data, ocr=False, log=lambda *a: None)['applied']['count'] == 0  # nothing left to do
    row = next(a for a in client.get('/api/activity').json() if a['type'] == 'metafill')
    u = client.post(f'/api/activity/{row["id"]}/undo', json={})
    assert u.status_code == 200, u.text
    assert (g(sheet['id'])['artist'], g(sheet['id'])['album'], g(sheet['id'])['version']) == ('', '', '')
    assert (g(score['id'])['artist'], g(score['id'])['album']) == ('Les Miserables', '')
    assert client.get(f'/api/items/{score["id"]}/musicxml').text == before  # the file before, from .history
    assert g(chord['id'])['version'] == ''
