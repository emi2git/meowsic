"""Bars to check (barcheck.py): check.json beside a score made from a sheet; mark a bar OK or put the other reading in."""
import json
import xml.etree.ElementTree as ET

import pytest
from PIL import Image

from meowsic import barcheck

ALT = ('<measure number="2"><attributes><divisions>4</divisions></attributes>'
       '<note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><type>half</type></note>'
       '<note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type></note>'
       '<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type></note>'
       '<note><rest/><duration>4</duration><type>quarter</type></note></measure>')


def note(step, dur, typ, word=None):
    ly = f'<lyric number="1"><syllabic>single</syllabic><text>{word}</text></lyric>' if word else ''
    return f'<note><pitch><step>{step}</step><octave>4</octave></pitch><duration>{dur}</duration><type>{typ}</type>{ly}</note>'


def score_xml():
    m1 = ('<measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>'
          '<clef><sign>G</sign><line>2</line></clef></attributes>' + note('C', 8, 'whole', 'One') + '</measure>')
    m2 = ('<measure number="2"><direction placement="above"><direction-type><words color="#DD2222">⚠ check</words></direction-type></direction>'
          '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>' + note('D', 4, 'half', 'two') +
          '<harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>' + note('D', 4, 'half', 'three') + '</measure>')
    m3 = '<measure number="3">' + note('C', 8, 'whole', 'four') + '</measure>'
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><identification><miscellaneous>'
            '<miscellaneous-field name="meowsic-check-bars">2 3</miscellaneous-field></miscellaneous></identification>'
            '<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>'
            f'<part id="P1">{m1}{m2}{m3}</part></score-partwise>')


@pytest.fixture
def score(client, data, tmp_path):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Baby Song', 'musicxmlText': score_xml()}).json()
    src = tmp_path / 'out'; src.mkdir()
    Image.new('L', (400, 300), 255).save(src / 'page1.png')
    (src / 'check.json').write_text(json.dumps({'version': 1, 'pages': [{'page': 1, 'file': 'page1.png', 'width': 400, 'height': 300}], 'bars': [
        {'bar': 2, 'page': 1, 'box': [100, 10, 220, 120], 'reasons': ['the two readers disagree'],
         'alternatives': [{'id': 'audiveris', 'label': 'Second reader (Audiveris)', 'musicxml': ALT}]},
        {'bar': 3, 'page': 1, 'box': [220, 10, 390, 120], 'reasons': ['rest added to fill the bar'], 'alternatives': []}]}))
    d = data / 'items' / it['folder']
    barcheck.keep_check(d, it['folder'], src, 's-sheet')
    it['_d'] = d
    return it


def bar(xml, n):
    root = ET.fromstring(xml.encode())
    return next(m for m in root.iter('measure') if m.get('number') == str(n))


def test_get(client, score):
    j = client.get(f'/api/items/{score["id"]}/check').json()
    assert j['open'] == [2, 3] and j['sheetId'] == 's-sheet'
    assert j['bars'][0]['box'] == [100, 10, 220, 120] and j['bars'][0]['reasons'] == ['the two readers disagree'] and j['bars'][0]['open']
    assert j['bars'][0]['alternatives'][0]['id'] == 'audiveris'
    assert client.get(j['pages'][0]['url']).status_code == 200  # the page as it was read, beside the score
    assert client.get('/api/items/m-nothere/check').status_code == 404


def test_mark_ok_then_undo(client, score):
    before = client.get(f'/api/items/{score["id"]}/musicxml').text
    j = client.post(f'/api/items/{score["id"]}/check', json={'bar': 3, 'action': 'ok'}).json()
    assert j['open'] == [2]
    x = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert 'meowsic-check-bars">2<' in x and [n.findtext('pitch/step') for n in bar(x, 3).iter('note')] == ['C']
    g = client.get(f'/api/items/{score["id"]}/check').json()
    assert g['open'] == [2] and g['bars'][1]['decision']['action'] == 'ok'
    assert client.post(f'/api/items/{score["id"]}/check', json={'bar': 3, 'action': 'ok'}).status_code == 409  # done already
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{score["id"]}/musicxml').text == before
    assert client.get(f'/api/items/{score["id"]}/check').json()['open'] == [2, 3]  # open again


def test_use_other_reading_keeps_chords_words_and_bar_length(client, score):
    j = client.post(f'/api/items/{score["id"]}/check', json={'bar': 2, 'action': 'use', 'alt': 'audiveris'}).json()
    assert j['open'] == [3]
    x = client.get(f'/api/items/{score["id"]}/musicxml').text
    m = bar(x, 2)
    notes = m.findall('note')
    assert [n.findtext('pitch/step') or 'r' for n in notes] == ['E', 'F', 'G', 'r']
    assert [int(n.findtext('duration')) for n in notes] == [4, 1, 1, 2]  # in the score's own unit (2 a quarter)
    assert sum(int(n.findtext('duration')) for n in notes) == 8  # the bar is still full
    assert [n.findtext('lyric/text') for n in notes] == ['two', 'three', None, None]
    assert len(m.findall('harmony')) == 2 and '⚠' not in ET.tostring(m, encoding='unicode')
    kids = [e.tag for e in m]
    assert kids.index('harmony') < kids.index('note')
    assert client.post(f'/api/items/{score["id"]}/check', json={'bar': 3, 'action': 'use', 'alt': 'audiveris'}).status_code == 400


def test_unit_finer_than_the_score(client, score):
    alt = ALT.replace('<divisions>4</divisions>', '<divisions>12</divisions>').replace('<duration>8</duration>', '<duration>24</duration>') \
        .replace('<duration>2</duration>', '<duration>6</duration>', 1).replace('<duration>2</duration>', '<duration>4</duration><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>', 1) \
        .replace('<duration>4</duration><type>quarter', '<duration>14</duration><type>quarter')
    p = score['_d'] / f'{score["folder"]} check.json'
    d = json.loads(p.read_text()); d['bars'][0]['alternatives'][0]['musicxml'] = alt; p.write_text(json.dumps(d))
    assert client.post(f'/api/items/{score["id"]}/check', json={'bar': 2, 'action': 'use', 'alt': 'audiveris'}).status_code == 200
    x = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert bar(x, 2).findtext('attributes/divisions') == '12' and bar(x, 3).findtext('attributes/divisions') == '2'


def test_stale_sha_refused(client, score):
    r = client.post(f'/api/items/{score["id"]}/check', json={'bar': 2, 'action': 'ok', 'sha': 'nope'})
    assert r.status_code == 409
