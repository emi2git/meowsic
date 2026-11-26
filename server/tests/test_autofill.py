"""A new song's Artist / Album from the user's own library (autofill.py): matching, choosing, never the key,
never overwriting, the score credit rule, and the add paths that call it."""
import json
from fractions import Fraction as Fr
from types import SimpleNamespace

from meowsic import autofill as af
from meowsic import runners
from meowsic.db import connect
from test_pages import png
from test_photoimport import album, wait  # noqa: F401 (fixture)
from test_smooth import n, score

KNOWN = {'songs': {}, 'albums': {}, 'albums_by_tag': {}}


def lib(*rows):
    return [{'id': f'x{k}', 'kind': r.get('kind', 'sheet'), 'title': r['title'], 'artist': r.get('artist', ''),
             'album': r.get('album', ''), 'updated_at': 100 - k, 'book': 0} for k, r in enumerate(rows)]


def add(client, title, **k):
    return client.post('/api/items', json={'kind': k.pop('kind', 'chords'), 'title': title, 'text': '[C]la', **k}).json()


# ---------- matching and choosing ----------

def test_core_title_ignores_case_accents_punctuation_and_suffixes():
    al = {'aladdin', 'les miserables', 'cinderella'}
    same = ['On My Own', 'on my own', 'On My Own!', 'On My Own (Les Misérables)', 'On my own - Les Miserables', 'ON MY OWN [Lead]']
    assert {af.core(t, al) for t in same} == {'on my own'}
    assert af.core('Aladdin - A Whole New World', al) == af.core('A Whole New World (Aladdin)', al) == 'a whole new world'
    assert af.core('Còn gì đẹp hơn', al) == 'con gi dep hon'
    assert af.core('A Dream Is A Wish Your Heart Makes (Cinderella)', al) != af.core('A Dream', al)


def test_most_common_artist_and_album():
    l = lib({'title': 'Memory', 'artist': 'Andrew Lloyd Webber', 'album': 'Cats'},
            {'title': 'memory (Cats)', 'artist': 'Andrew Lloyd Webber'},
            {'title': 'Memory', 'artist': 'Barbra Streisand'},
            {'title': 'Memories', 'artist': 'Maroon 5', 'album': 'Jordi'})
    assert af.propose({'kind': 'score', 'title': 'Memory'}, l, KNOWN) == {'artist': 'Andrew Lloyd Webber', 'album': 'Cats'}
    assert af.propose({'kind': 'sheet', 'title': 'Something else'}, l, KNOWN) == {}


def test_album_hint_in_the_title_wins_and_filters_other_songs():
    l = lib({'title': 'Memory', 'artist': 'Someone Else', 'album': 'Other Show'},
            {'title': 'Memory', 'artist': 'Andrew Lloyd Webber', 'album': 'Cats'},
            {'title': 'Memory', 'artist': 'Andrew Lloyd Webber'})
    assert af.propose({'kind': 'sheet', 'title': 'Memory (Cats)'}, l, KNOWN) == {'artist': 'Andrew Lloyd Webber', 'album': 'Cats'}


def test_known_songs_file_when_the_library_does_not_know():
    out = af.propose({'kind': 'sheet', 'title': 'Bring Him Home'}, [], None)  # metafill_known.json
    assert out == {'artist': 'Claude-Michel Schönberg', 'album': 'Les Misérables'}


def test_never_the_key_and_never_a_version():
    l = lib({'title': 'Let It Go', 'artist': 'Idina Menzel', 'album': 'Frozen'})
    l[0].update(key='Ab', version='piano')
    out = af.propose({'kind': 'sheet', 'title': 'Let It Go', 'key': '', 'version': ''}, l, KNOWN)
    assert out == {'artist': 'Idina Menzel', 'album': 'Frozen'}


def test_never_overwrites():
    l = lib({'title': 'Let It Go', 'artist': 'Idina Menzel', 'album': 'Frozen'})
    assert af.propose({'kind': 'sheet', 'title': 'Let It Go', 'artist': 'Demi Lovato'}, l, KNOWN) == {'album': 'Frozen'}
    assert af.propose({'kind': 'sheet', 'title': 'Let It Go', 'artist': 'X', 'album': 'Y'}, l, KNOWN) == {}


def test_meowsic_is_never_an_artist():
    l = lib({'title': 'Home', 'artist': 'Meowsic', 'kind': 'score'}, {'title': 'Home', 'artist': 'Made by Meowsic'},
            {'title': 'Home', 'artist': 'Dick Lee'})
    assert af.propose({'kind': 'score', 'title': 'Home', 'artist': 'Meowsic'}, l, KNOWN) == {'artist': 'Dick Lee'}


def test_untitled_and_books_are_left_alone():
    l = lib({'title': 'Untitled', 'artist': 'A'})
    assert af.propose({'kind': 'sheet', 'title': 'Untitled'}, l, KNOWN) == {}
    assert af.propose({'kind': 'sheet', 'title': 'Songbook', 'book': 1}, lib({'title': 'Songbook', 'artist': 'A'}), KNOWN) == {}


def test_recredit_keeps_the_arranger():
    x = '<score-partwise><identification><creator type="arranger">Transcribed by Meowsic</creator></identification><part-list/></score-partwise>'
    out = af.recredit(x, 'Dick Lee')
    assert '<creator type="composer">Dick Lee</creator><creator type="arranger">Transcribed by Meowsic</creator>' in out


# ---------- the add paths ----------

def activity(client):
    return [a for a in client.get('/api/activity').json() if a['type'] == 'autofill']


def test_add_chords_fills_and_logs_and_undo(client):
    a = add(client, 'Let It Go', artist='Idina Menzel', album='Frozen', key='G')
    b = add(client, 'let it go (Frozen)', key='Ab')
    assert (b['artist'], b['album'], b['key']) == ('Idina Menzel', 'Frozen', 'Ab')  # key: never copied
    c = add(client, 'Let It Go', artist='Demi Lovato')
    assert (c['artist'], c['album'], c['key']) == ('Demi Lovato', 'Frozen', '')  # set by the add path: kept
    rows = activity(client)
    assert len(rows) == 2 and rows[-1]['detail'].startswith('Info filled from your library: artist, album')
    assert client.post(f'/api/activity/{rows[-1]["id"]}/undo', json={}).status_code == 200
    back = client.get(f'/api/items/{b["id"]}').json()
    assert (back['artist'], back['album'], back['key']) == ('', '', 'Ab') and not back.get('deleted')
    assert client.get(f'/api/items/{a["id"]}').json()['key'] == 'G'


def test_deleted_items_do_not_count(client):
    a = add(client, 'Paper Kites Lullaby', artist='Leonard Cohen')
    client.post('/api/items/trash', json={'ids': [a['id']]})
    assert add(client, 'Paper Kites Lullaby')['artist'] == ''


def test_new_score_keeps_the_real_artist_in_the_credits(client):
    add(client, 'Home', artist='Dick Lee', album='NDP')
    x = score([[n('C5', 4)]], [[n('C3', 4, 2)]])
    m = client.post('/api/items', json={'kind': 'score', 'title': 'Home (NDP)', 'artist': 'Meowsic', 'musicxmlText': x, 'ai': 1}).json()
    assert (m['artist'], m['album']) == ('Dick Lee', 'NDP')
    xml = client.get(f'/api/items/{m["id"]}/musicxml').text
    assert '<creator type="composer">Dick Lee</creator><creator type="arranger">Made by Meowsic</creator>' in xml


def test_upload_sheet_and_page_split(client):
    add(client, 'Edelweiss', artist='Rodgers & Hammerstein', album='The Sound of Music')
    add(client, 'Do-Re-Mi', artist='Rodgers & Hammerstein')
    files = [('files', (f'{k}.png', png(c), 'image/png')) for k, c in enumerate(['red', 'green'])]
    s = client.post('/api/sheets', data={'title': 'Edelweiss - Sound Of Music'}, files=files).json()['item']
    assert (s['artist'], s['album']) == ('Rodgers & Hammerstein', 'The Sound of Music')
    r = client.post(f'/api/items/{s["id"]}/split', json={'pages': [2], 'title': 'Do Re Mi'}).json()
    assert r['new']['artist'] == 'Rodgers & Hammerstein'  # same artist as the sheet it came from anyway
    s2 = client.post('/api/sheets', data={'title': 'Mixed'}, files=[('files', ('a.png', png('blue'), 'image/png')),
                                                                     ('files', ('b.png', png('yellow'), 'image/png'))]).json()['item']
    r = client.post(f'/api/items/{s2["id"]}/split', json={'pages': [2], 'title': 'Do-Re-Mi!'}).json()
    assert r['new']['artist'] == 'Rodgers & Hammerstein'


def test_book_split(client):
    add(client, 'Memory', artist='Andrew Lloyd Webber', album='Cats')
    files = [('files', (f'{k}.png', png((20 * k, 200, 40)), 'image/png')) for k in range(4)]
    it = client.post('/api/sheets', data={'title': 'Songbook'}, files=files).json()['item']
    b = client.post('/api/items/book', json={'ids': [it['id']], 'book': True}).json()['items'][0]
    r = client.post(f'/api/books/{b["id"]}/make-sheets', json={'starts': {'1': 'Memory', '3': 'Unknown tune'}}).json()
    got = {m['title']: client.get(f'/api/items/{m["id"]}').json() for m in r['sheets']}
    assert (got['Memory']['artist'], got['Memory']['album']) == ('Andrew Lloyd Webber', 'Cats')
    assert got['Unknown tune']['artist'] == ''


def test_photo_import(client, album):
    add(client, 'Moon River', artist='Henry Mancini', album="Breakfast at Tiffany's")
    s = wait(client, client.post('/api/photos/sessions', json={}).json()['id'])
    ids = [p['id'] for p in s['pages']]
    r = client.post(f'/api/photos/sessions/{s["id"]}/import', json={'songs': [{'title': 'Moon River', 'pages': [{'id': ids[0]}]},
                                                                               {'title': 'Nobody knows', 'pages': [{'id': ids[1]}]}]}).json()
    a, b = r['items']
    assert (a['artist'], a['album']) == ('Henry Mancini', "Breakfast at Tiffany's") and b['artist'] == ''
    assert any('Moon River' == x['title'] for x in activity(client))


def test_job_outputs_fill_and_log(client, app):
    add(client, 'Memory', artist='Andrew Lloyd Webber', album='Cats', key='Bb')
    x = score([[n('C5', 4)]], [[n('C3', 4, 2)]])
    f = app.state.cfg.work_dir / 'in.musicxml'
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(x)
    msgs = []
    ctx = SimpleNamespace(cfg=app.state.cfg, id='job-x', cancelled=lambda: False, update=lambda **k: msgs.append(k.get('msg')))
    ids = runners.save_outputs(ctx, [('original', str(f), None, None, {})], title='Memory (Cats)',
                               source='From the sheet “Memory” (photo → score, beta)', artist='', tags=['From a sheet'])
    m = client.get(f'/api/items/{ids[0]}').json()
    assert (m['artist'], m['album'], m['key'], m['version']) == ('Andrew Lloyd Webber', 'Cats', '', 'original')
    xml = client.get(f'/api/items/{ids[0]}/musicxml').text
    assert '<creator type="composer">Andrew Lloyd Webber</creator><creator type="arranger">Transcribed by Meowsic</creator>' in xml
    assert 'Info filled from your library: artist, album' in msgs
    assert activity(client)


def test_editor_copy_simple_piano(client):
    x = score([[n('C5', Fr(7, 2)), n('D5', Fr(1, 2))], [n('E5', 4)]], [[n('C3', 4, 2)], [n('G2', 4, 2)]])
    src = client.post('/api/items', json={'kind': 'score', 'title': 'Sunny Day Song', 'musicxmlText': x, 'source': 'YouTube',
                                          'key': 'C'}).json()
    add(client, 'Sunny Day Song (Lead)', artist='Dick Lee', album='NDP 1998')
    j = client.post(f'/api/items/{src["id"]}/simplepiano', json={'level': 100, 'mode': 'new'}).json()
    new = j['item']
    assert (new['artist'], new['album'], new['key'], new['version']) == ('Dick Lee', 'NDP 1998', 'C', 'clear')
    xml = client.get(f'/api/items/{new["id"]}/musicxml').text
    assert '<creator type="composer">Dick Lee</creator><creator type="arranger">Transcribed by Meowsic</creator>' in xml
    assert client.get(f'/api/items/{src["id"]}').json()['artist'] == ''  # the score it came from is untouched


def test_dry_run_counts(client, app):
    add(client, 'Memory', artist='Andrew Lloyd Webber', album='Cats')
    c = connect(app.state.cfg)
    try:
        c.execute("INSERT INTO item(id, kind, title, artist, album, created_at, updated_at) VALUES ('c-old0001','chords','memory','','',1,1)")
        c.execute("INSERT INTO chord_chart(item_id, source, text) VALUES ('c-old0001','pasted','[C]la')")
        c.commit()
        res = af.dry_run(c, KNOWN)
    finally:
        c.close()
    assert [(r['id'], f) for r, f in res] == [('c-old0001', {'artist': 'Andrew Lloyd Webber', 'album': 'Cats'})]
