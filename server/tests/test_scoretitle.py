"""The title drawn on a score = its Info title (scoretitle.py): the XML edit, junk-free credit lines, Info → rename
updating the MusicXML (history + Activities undo), new transcriptions, and the one-time pass."""
import json
import sqlite3

from meowsic import scoretitle as st

VIDEO = 'Home (Kit Chan) Easy Piano with Paranoma Score View, Singapore NDP Song 1998'


def xml(title=VIDEO, credits=''):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n'
            f'  <work>\n    <work-title>{title}</work-title>\n  </work>\n  <movement-title>{title}</movement-title>\n{credits}'
            '  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n'
            '  <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
            '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>\n</score-partwise>\n')


def test_junk():
    assert st.junk(VIDEO) == 'Home (Kit Chan)'
    assert st.junk('NDP 2019 Song: Our Singapore') == 'Our Singapore'
    assert st.junk('Some Song - Piano Tutorial') == 'Some Song'
    assert st.junk('with Panorama Score View') == ''
    assert st.junk('Words and Music by Dick Lee') == 'Words and Music by Dick Lee'


def test_title_xml_sets_titles_and_cleans_credits():
    cr = (f'  <credit page="1"><credit-type>title</credit-type><credit-words>{VIDEO}</credit-words></credit>\n'
          '  <credit page="1"><credit-type>subtitle</credit-type><credit-words>Piano Tutorial</credit-words></credit>\n'
          '  <credit page="1"><credit-words>Kit Chan - Easy Piano</credit-words></credit>\n'
          '  <credit page="1"><credit-type>composer</credit-type><credit-words>Dick Lee</credit-words></credit>\n')
    out = st.title_xml(xml(credits=cr), 'Home & Away')
    assert out.count('Home &amp; Away') == 3 and 'Score View' not in out and 'Tutorial' not in out
    assert '<credit-words>Kit Chan</credit-words>' in out and '<credit-words>Dick Lee</credit-words>' in out
    assert st.title_xml(out, 'Home & Away') == out                      # stable
    assert out.split('<part-list>')[1] == xml().split('<part-list>')[1]  # the music byte for byte
    bare = st.title_xml('<score-partwise version="4.0"><part-list/></score-partwise>', 'T')
    assert '<movement-title>T</movement-title>' in bare


def _score(client, title='Home NDP', x=None):
    return client.post('/api/items', json={'kind': 'score', 'title': title, 'musicxmlText': x or xml()}).json()


def _file(data, it):
    return data / 'items' / it['folder'] / it['musicxml']


def test_rename_updates_musicxml_with_history_and_undo(client, data):
    it = _score(client)
    before = _file(data, it).read_text()
    r = client.patch(f'/api/items/{it["id"]}', json={'title': 'Home'}).json()
    p = _file(data, r)
    now = p.read_text()
    assert '<work-title>Home</work-title>' in now and '<movement-title>Home</movement-title>' in now and 'Score View' not in now
    hist = list((p.parent / '.history').glob('title-*'))
    assert len(hist) == 1 and hist[0].read_text() == before
    acts = client.get('/api/activity').json()
    row = next(a for a in (acts['items'] if isinstance(acts, dict) else acts) if a.get('type') == 'edit')
    assert client.post(f'/api/activity/{row["id"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{it["id"]}').json()['title'] == 'Home NDP'
    # the file before (from .history), whose title then follows the Info title back
    assert p.read_text() == st.title_xml(before, 'Home NDP') and '<movement-title>Home NDP</movement-title>' in p.read_text()
    assert len(list((p.parent / '.history').glob('title-*'))) >= 2      # what the undo replaced is kept too


def test_rename_of_a_sheet_or_same_title_touches_nothing(client, data):
    it = _score(client, 'Home', xml('Home'))
    client.patch(f'/api/items/{it["id"]}', json={'artist': 'Kit Chan'})
    assert not (_file(data, it).parent / '.history').exists()


def test_new_transcription_file_gets_the_item_title(tmp_path):
    p = tmp_path / 'x.musicxml'
    p.write_text(xml())
    st.set_file_title(p, 'Home')
    assert '<movement-title>Home</movement-title>' in p.read_text() and VIDEO not in p.read_text()


def test_one_time_pass(client, data):
    a = _score(client)                                   # mismatched
    b = _score(client, 'Twinkle', xml('Twinkle'))        # already right
    res = st.run(data, dry_run=True, log=lambda *_: None)
    assert res['scores'] == 1 and res['changed'][0][0] == a['id'] and not res['backup']
    assert VIDEO in _file(data, a).read_text()           # dry run: nothing written
    res = st.run(data, log=lambda *_: None)
    assert res['backup'] and (data / 'backups').is_dir() and sqlite3.connect(res['backup']).execute('select count(*) from item').fetchone()[0] >= 2
    assert '<movement-title>Home NDP</movement-title>' in _file(data, a).read_text()
    assert (_file(data, a).parent / '.history').is_dir() and not (_file(data, b).parent / '.history').exists()
    assert st.run(data, dry_run=True, log=lambda *_: None)['scores'] == 0   # safe to run again
    logs = list((data / 'history').glob('title-sync-*.json'))
    assert logs and json.loads(logs[0].read_text())['steps'][0]['id'] == a['id']
    assert client.post(f'/api/activity/{res["activity"]}/undo', json={}).status_code == 200
    assert VIDEO in _file(data, a).read_text()
