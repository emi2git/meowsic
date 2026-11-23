"""Clean up → Versions: same-song grouping, keep / delete decisions, "not the same song" marks."""
import sqlite3

import pytest

from meowsic.versions import norm_title

PNG = b'\x89PNG\r\n\x1a\nversions-%d'


@pytest.mark.parametrize('a,b', [
    ('Moon River', 'moon river'),
    ('Moon River (C)', 'Moon River'),
    ('Moon River (Easy Piano)', 'Moon River'),
    ('Moon River - Sheet Music', 'Moon River'),
    ('Moon River — p7', 'Moon River'),
    ('Moon River (part 2)', 'Moon River'),
    ('Moon River Piano Solo', 'Moon River'),
    ('Moon River (Am) [Lead Sheet]', 'Moon River'),
    ('Moon River.pdf', 'Moon River'),
    ('Moon River - Easy Piano Version', 'Moon River'),
    ('Moon-River!', 'Moon River'),
    ('The Music Of The Night (G)', 'Music Of The Night (C) (Version 3)'),
    ('Do You Want To Build A Snowman? (Frozen)', 'Do You Want To Build A Snowman'),
    ("How Far I’ll Go", "How Far I'll Go"),
    # Vietnamese: diacritics and đ fold away
    ('Đêm Đông', 'dem dong'),
    ('Mưa hồng (F)', 'MƯA HỒNG'),
    ('Ánh trăng nói hộ lòng tôi', 'Anh trang noi ho long toi'),
    ('Tiến quân ca', 'Tien Quan Ca - Piano'),
])
def test_same_song(a, b):
    assert norm_title(a) == norm_title(b)


@pytest.mark.parametrize('a,b', [
    ('Moon River', 'Moon Riverside'),
    ('Piano Sonata No. 8', 'Piano Sonata No. 14'),
    ('The Sound of Music', 'The Sound of Silence'),
    ('Mưa hồng', 'Mưa'),
    ('Chopin - Nocturne Op. 9 No. 2', 'Chopin - Ballade No. 1'),
])
def test_not_same_song(a, b):
    assert norm_title(a) != norm_title(b)


def test_titles_never_empty():
    assert norm_title('Piano Solo') and norm_title('(C)') and norm_title('Sheet Music')


def sheet(client, title, n=1, book=False):
    global _k
    _k = globals().get('_k', 0) + 1
    files = [('files', (f'{_k}-{p}.png', PNG % (_k * 100 + p), 'image/png')) for p in range(n)]
    it = client.post('/api/sheets', data={'title': title}, files=files).json()['item']
    if book: client.post('/api/items/book', json={'ids': [it['id']], 'book': True})
    return it


def item(client, kind, title, **kw):
    return client.post('/api/items', json={'kind': kind, 'title': title, **kw}).json()


def group_of(st, iid):
    return next((g for g in st['groups'] if iid in g['ids']), None)


def test_groups(client, chord):
    a = sheet(client, 'Mưa hồng', n=2)
    b = sheet(client, 'Mua Hong (C)')
    c = item(client, 'chords', 'MƯA HỒNG - Easy Piano', text='[C]Mưa [G]hồng')
    book = sheet(client, 'Mưa hồng', book=True)  # books are left out
    gone = sheet(client, 'Mưa hồng (Am)')
    client.post('/api/items/trash', json={'ids': [gone['id']]})  # so is the Trash
    sheet(client, 'Alone')
    # score versions sharing a group_id belong together, whatever their titles
    m1 = item(client, 'score', 'Tiến quân ca', version='original', groupId='g1')
    m2 = item(client, 'score', 'Tiến quân ca — lead', version='lead', groupId='g1')
    m3 = item(client, 'score', 'National anthem (duet)', version='duet', groupId='g1')
    m4 = item(client, 'score', 'Tien Quan Ca', version='original', groupId='g2')  # same title, other recording
    sheet(client, 'Amazing Grace (G)')  # joins the chord chart from the fixture

    st = client.get('/api/versions').json()
    g = group_of(st, a['id'])
    assert set(g['ids']) == {a['id'], b['id'], c['id']} and g['key'] == 't:mua hong'
    assert book['id'] not in st['items'] and gone['id'] not in st['items']
    s = group_of(st, m1['id'])
    assert set(s['ids']) == {m1['id'], m2['id'], m3['id'], m4['id']}
    assert group_of(st, chord['id'])['title'] == 'Amazing Grace'
    assert not any(st['items'][i]['title'] == 'Alone' for i in st['items'])
    # biggest first, then A–Z; counts
    assert [len(x['ids']) for x in st['groups']] == [4, 3, 2]
    assert st['counts'] == {'groups': 3, 'items': 9, 'notSame': 0}
    # what a card shows
    ca = st['items'][a['id']]
    assert ca['kind'] == 'sheet' and ca['pages'] == 2 and 'playCount' in ca and ca['createdAt']
    assert st['items'][c['id']]['text'].startswith('[C]') and st['items'][m2['id']]['version'] == 'lead'


def test_decisions_persist_and_log(client, app, data):
    a, b, c = sheet(client, 'Hallelujah'), sheet(client, 'Hallelujah (C)'), sheet(client, 'Hallelujah - Piano Solo')
    key = group_of(client.get('/api/versions').json(), a['id'])['key']
    # keep only this one: the others are marked delete in one call
    r = client.post('/api/versions/decide', json={'key': key, 'set': {a['id']: 'keep', b['id']: 'delete', c['id']: 'delete'}})
    assert r.json()['decisions'] == {a['id']: 'keep', b['id']: 'delete', c['id']: 'delete'}
    # undo = set back what was there
    client.post('/api/versions/decide', json={'key': key, 'set': {a['id']: None, b['id']: None, c['id']: None}})
    assert client.get('/api/versions').json()['decisions'] == {}
    client.post('/api/versions/decide', json={'id': b['id'], 'decision': 'delete', 'key': key})
    assert client.post('/api/versions/decide', json={'id': 'nope', 'decision': 'keep'}).status_code == 404
    assert client.post('/api/versions/decide', json={'id': a['id'], 'decision': 'maybe'}).status_code == 400
    # saved on the Mac: a new app on the same data still has it
    from fastapi.testclient import TestClient
    from meowsic.app import create_app
    with TestClient(create_app(data, background=False)) as c2:
        assert c2.get('/api/versions').json()['decisions'] == {b['id']: 'delete'}
    # finish: to the Trash, decisions cleared; the group falls apart (2 left = still a group)
    client.post('/api/items/trash', json={'ids': [b['id']]})
    client.post('/api/versions/decide', json={'clear': [b['id']], 'key': key})
    st = client.get('/api/versions').json()
    assert st['decisions'] == {} and set(group_of(st, a['id'])['ids']) == {a['id'], c['id']}
    # history is never deleted, even after delete for good
    client.post('/api/items/purge', json={'ids': [b['id']]})
    db = sqlite3.connect(data / 'meowsic.db')
    ops = [r[0] for r in db.execute('SELECT op FROM version_log WHERE item_id=? ORDER BY id', (b['id'],))]
    assert ops == ['delete', 'clear', 'delete', 'trashed']
    assert db.execute('SELECT COUNT(*) FROM version_log').fetchone()[0] == 8


def test_not_same(client, data):
    a, b = sheet(client, 'Home'), sheet(client, 'Home (G)')
    st = client.get('/api/versions').json()
    g = group_of(st, a['id'])
    st = client.post('/api/versions/notsame', json={'key': g['key'], 'ids': g['ids']}).json()
    assert group_of(st, a['id'])['notSame'] and st['counts'] == {'groups': 0, 'items': 0, 'notSame': 1}
    # a new copy of the song brings the group back (it is not all in the mark)
    c = sheet(client, 'Home - Piano')
    st = client.get('/api/versions').json()
    assert not group_of(st, a['id'])['notSame'] and st['counts']['groups'] == 1
    client.post('/api/items/trash', json={'ids': [c['id']]})
    assert group_of(client.get('/api/versions').json(), a['id'])['notSame']
    # undo: the mark stays in the table, undone
    st = client.post('/api/versions/notsame', json={'key': g['key'], 'ids': g['ids'], 'undo': True}).json()
    assert not group_of(st, a['id'])['notSame']
    db = sqlite3.connect(data / 'meowsic.db')
    assert db.execute('SELECT COUNT(*), COUNT(undone_at) FROM version_notsame').fetchone() == (1, 1)
    assert client.post('/api/versions/notsame', json={'key': 'x'}).status_code == 400
