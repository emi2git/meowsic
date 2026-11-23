"""Fit lyrics by hand (lyricsedit.py): reading the melody lines, saving words (syllabic, extend, verses), keeping
history, Activities undo, "Save as new score", and the words of a sheet. Public-domain words only (Twinkle Twinkle)."""
import io
import json
import xml.etree.ElementTree as ET

import pytest

from meowsic import lyricsedit as le

# Twinkle Twinkle, first line: C C G G A A G(half) | F F E E D D C(half), on top of a piano's upper staff (with a
# third below it) and a bass note per bar in the lower staff; a pickup-free 4/4 in 4 bars
MEL = [[(60, 1), (60, 1), (67, 1), (67, 1)], [(69, 1), (69, 1), (67, 2)], [(65, 1), (65, 1), (64, 1), (64, 1)], [(62, 1), (62, 1), (60, 2)]]
STEPS = {60: ('C', 4), 62: ('D', 4), 64: ('E', 4), 65: ('F', 4), 67: ('G', 4), 69: ('A', 4), 56: ('A', 3), 57: ('A', 3), 53: ('F', 3), 55: ('G', 3), 61: ('C', 4), 48: ('C', 3)}
TYPES = {1: 'quarter', 2: 'half', 4: 'whole'}


def n(m, q, staff, chord=False, voice=1):
    s, o = STEPS[m]
    return (f'<note>{"<chord/>" if chord else ""}<pitch><step>{s}</step><octave>{o}</octave></pitch><duration>{q * 2}</duration>'
            f'<voice>{voice}</voice><type>{TYPES[q]}</type><staff>{staff}</staff></note>')


def score_xml():
    ms = []
    for k, bar in enumerate(MEL, 1):
        x = f'<measure number="{k}">'
        if k == 1: x += '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        for m, q in bar: x += n(m, q, 1) + n(m - 4 if m - 4 in STEPS else 48, q, 1, chord=True)
        x += '<backup><duration>8</duration></backup>' + n(48, 4, 2, voice=5) + '</measure>'
        ms.append(x)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


WORDS = [('Twin', 'begin'), ('kle', 'end'), ('twin', 'begin'), ('kle', 'end'), ('lit', 'begin'), ('tle', 'end'), ('star', 'single'),
         ('how', 'single'), ('I', 'single'), ('won', 'begin'), ('der', 'end'), ('what', 'single'), ('you', 'single'), ('are', 'single')]


@pytest.fixture
def score(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Twinkle Twinkle', 'artist': 'Traditional', 'musicxmlText': score_xml(), 'tags': ['Kids']}).json()
    it['_xml'] = client.get(f'/api/items/{it["id"]}/musicxml').text  # as stored (the server adds the Meowsic credit)
    return it


def lyrics_of(xml, verse='1'):
    """[(midi of the note, text, syllabic, extend)] of a verse on the upper staff, in order."""
    root = ET.fromstring(xml.encode())
    out = []
    for e in root.iter('note'):
        for ly in e.findall('lyric'):
            if (ly.get('number') or '1') == verse:
                p = e.find('pitch')
                out.append((p.findtext('step') + p.findtext('octave'), ly.findtext('text'), ly.findtext('syllabic'), ly.find('extend') is not None))
    return out


def test_melody_lines(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    assert m['line'] == 'P1/1/top'
    keys = [l['key'] for l in m['lines']]
    assert keys[:2] == ['P1/1/top', 'P1/2/top'] and 'upper staff' in m['lines'][0]['label']
    assert [x['name'] for x in m['notes']] == ['C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4', 'F4', 'F4', 'E4', 'E4', 'D4', 'D4', 'C4']  # the top of each chord
    assert [x['bar'] for x in m['notes']][:7] == [0, 0, 0, 0, 1, 1, 1] and m['notes'][6]['type'] == 'half' and m['notes'][6]['dur'] == 2
    assert [b['start'] for b in m['bars']] == [0, 4, 8, 12] and m['verses'] == ['1']
    low = client.get(f'/api/items/{score["id"]}/lyrics', params={'line': 'P1/2/top'}).json()
    assert len(low['notes']) == 4 and low['line'] == 'P1/2/top'
    assert client.get(f'/api/items/{score["id"]}/lyrics', params={'line': 'P9/1/top'}).status_code == 400


def test_save_this_score(client, score, data):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    # "star" held over two notes (A A → hold the second), so the rest moves on by one; the last note gets nothing
    notes = [{'ref': refs[0], 'text': 'Twin', 'syllabic': 'begin'}, {'ref': refs[1], 'text': 'kle', 'syllabic': 'end'},
             {'ref': refs[2], 'text': 'twin', 'syllabic': 'begin'}, {'ref': refs[3], 'text': 'kle', 'syllabic': 'end'},
             {'ref': refs[4], 'text': 'star', 'syllabic': 'single'}]
    notes += [{'ref': refs[6 + k], 'text': t, 'syllabic': s} for k, (t, s) in enumerate(WORDS[7:14]) if 6 + k < 13]
    r = client.post(f'/api/items/{score["id"]}/lyrics', json={'line': m['line'], 'verse': 1, 'notes': notes, 'holds': [refs[5]], 'sha': m['sha']})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j['mode'] == 'this' and j['history'].startswith('.history/lyrics-')
    xml = client.get(f'/api/items/{score["id"]}/musicxml').text
    got = lyrics_of(xml)
    assert [g[1] for g in got] == ['Twin', 'kle', 'twin', 'kle', 'star', 'how', 'I', 'won', 'der', 'what', 'you', 'are']
    assert got[0][2] == 'begin' and got[1][2] == 'end' and got[4] == ('A4', 'star', 'single', True)  # melisma: extend
    assert sum(g[3] for g in got) == 1
    # lyrics sit on the top note of each chord, never on the lower staff
    root = ET.fromstring(xml.encode())
    assert all(e.find('lyric') is None for e in root.iter('note') if e.findtext('staff') == '2' or e.find('chord') is not None)
    # the file before is kept; the very first change also keeps the untouched original
    d = data / 'items' / score['folder']
    assert (d / j['history']).read_text() == score['_xml'] and (d / f'{score["folder"]} (original).musicxml').is_file()
    # music21 reads it, the words are there and every bar is still full
    import music21
    s = music21.converter.parse(xml, format='musicxml')
    assert [ly.text for ly in s.parts[0].recurse().notes[4].lyrics] == ['star']
    for p in s.parts:
        for meas in p.getElementsByClass('Measure'):
            assert meas.duration.quarterLength == 4
    # read back: the same words, the hold comes back as a note after an extended syllable
    m2 = client.get(f'/api/items/{score["id"]}/lyrics').json()
    assert m2['notes'][4]['lyrics']['1'] == {'text': 'star', 'syllabic': 'single', 'extend': True} and m2['notes'][5]['lyrics'] == {}
    # a stale editor is refused
    assert client.post(f'/api/items/{score["id"]}/lyrics', json={'line': m['line'], 'verse': 1, 'notes': notes, 'sha': m['sha']}).status_code == 409


def test_verse_two_keeps_verse_one(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    v1 = [{'ref': r, 'text': t, 'syllabic': s} for r, (t, s) in zip(refs, WORDS)]
    assert client.post(f'/api/items/{score["id"]}/lyrics', json={'verse': '1', 'notes': v1}).status_code == 200
    v2 = [{'ref': refs[0], 'text': 'Up', 'syllabic': 'single'}, {'ref': refs[1], 'text': 'a', 'syllabic': 'single'}, {'ref': refs[2], 'text': 'bove', 'syllabic': 'end'}]
    v2[1]['syllabic'], v2[2]['syllabic'] = 'begin', 'end'
    assert client.post(f'/api/items/{score["id"]}/lyrics', json={'verse': 2, 'notes': v2}).status_code == 200
    xml = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert [g[1] for g in lyrics_of(xml, '1')] == [w for w, _ in WORDS]
    assert [g[1:3] for g in lyrics_of(xml, '2')] == [('Up', 'single'), ('a', 'begin'), ('bove', 'end')]
    # verse 1 comes before verse 2 inside each note
    first = next(e for e in ET.fromstring(xml.encode()).iter('note') if len(e.findall('lyric')) == 2)
    assert [l.get('number') for l in first.findall('lyric')] == ['1', '2']
    m2 = client.get(f'/api/items/{score["id"]}/lyrics').json()
    assert m2['verses'] == ['1', '2']
    # saving verse 1 again (fewer words) leaves verse 2 alone
    assert client.post(f'/api/items/{score["id"]}/lyrics', json={'verse': 1, 'notes': v1[:2]}).status_code == 200
    xml = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert len(lyrics_of(xml, '1')) == 2 and len(lyrics_of(xml, '2')) == 3
    import music21
    music21.converter.parse(xml, format='musicxml')


def test_bad_requests(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    r0 = m['notes'][0]['ref']
    bass = client.get(f'/api/items/{score["id"]}/lyrics', params={'line': 'P1/2/top'}).json()['notes'][0]['ref']
    post = lambda **b: client.post(f'/api/items/{score["id"]}/lyrics', json={'verse': 1, **b}).status_code
    assert post(notes=[{'ref': bass, 'text': 'x'}]) == 400  # not in the melody line
    assert post(notes=[{'ref': r0, 'text': ''}]) == 400
    assert post(notes=[{'ref': r0, 'text': 'a', 'syllabic': 'start'}]) == 400
    assert post(notes=[{'ref': r0, 'text': 'a'}, {'ref': r0, 'text': 'b'}]) == 400
    assert post(notes=[], verse=0) == 400


def test_activity_undo_restores(client, score, data):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    j = client.post(f'/api/items/{score["id"]}/lyrics', json={'notes': [{'ref': r, 'text': t, 'syllabic': s} for r, (t, s) in zip(refs, WORDS)]}).json()
    acts = client.get('/api/activity').json()
    row = next(a for a in acts if a['id'] == j['activity'])
    assert row['type'] == 'lyrics-fit' and row['action'] == 'undo' and 'back to the score before' in row['undoText'][0]
    u = client.post(f'/api/activity/{j["activity"]}/undo', json={})
    assert u.status_code == 200, u.text
    assert client.get(f'/api/items/{score["id"]}/musicxml').text == score['_xml']
    hist = sorted(p.name for p in (data / 'items' / score['folder'] / '.history').iterdir())
    assert len(hist) == 2  # the score before the fit, and the fitted one that the undo replaced: nothing is lost
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 409


def test_undo_conflict_when_changed_since(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    a = client.post(f'/api/items/{score["id"]}/lyrics', json={'notes': [{'ref': refs[0], 'text': 'Twin', 'syllabic': 'begin'}]}).json()
    client.post(f'/api/items/{score["id"]}/lyrics', json={'notes': [{'ref': refs[0], 'text': 'Up', 'syllabic': 'single'}]})
    r = client.post(f'/api/activity/{a["activity"]}/undo', json={})
    assert r.status_code == 409 and r.json()['detail']['canForce']


def test_save_as_new_score(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    j = client.post(f'/api/items/{score["id"]}/lyrics', json={'mode': 'new', 'notes': [{'ref': r, 'text': t, 'syllabic': s} for r, (t, s) in zip(refs, WORDS)]}).json()
    new = j['item']
    assert new['id'] != score['id'] and new['title'] == 'Twinkle Twinkle' and 'Lyrics added' in new['tags'] and 'Kids' in new['tags']
    assert new['groupId'] and new['groupId'] == client.get(f'/api/items/{score["id"]}').json()['groupId']
    assert len(lyrics_of(client.get(f'/api/items/{new["id"]}/musicxml').text)) == 14
    assert client.get(f'/api/items/{score["id"]}/musicxml').text == score['_xml']  # the score itself is untouched
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{new["id"]}').json()['deleted']


def test_words_from_a_sheet(client, score, app):
    """The sheet's reading is cached (work/lyricsfit/<sheet>-<updatedAt>/out/score.musicxml): seed it, no OMR."""
    sh = client.post('/api/items', json={'kind': 'sheet', 'title': 'Twinkle Twinkle'}).json()
    cache = app.state.cfg.work_dir / 'lyricsfit' / f'{sh["id"]}-{sh["updatedAt"]}' / 'out'
    cache.mkdir(parents=True)
    ms = []
    k = 0
    for b, bar in enumerate(MEL, 1):  # the sheet: the bare tune a fifth up, with the words
        x = f'<measure number="{b}">' + ('<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' if b == 1 else '')
        for m, q in bar:
            t, s = WORDS[k]; k += 1
            st, o = {60: ('G', 4), 62: ('A', 4), 64: ('B', 4), 65: ('C', 5), 67: ('D', 5), 69: ('E', 5)}[m]
            x += f'<note><pitch><step>{st}</step><octave>{o}</octave></pitch><duration>{q}</duration><lyric number="1"><syllabic>{s}</syllabic><text>{t}</text></lyric></note>'
        ms.append(x + '</measure>')
    (cache / 'score.musicxml').write_text('<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>'
                                          f'<part id="P1">{"".join(ms)}</part></score-partwise>')
    r = client.post(f'/api/items/{score["id"]}/lyrics/sheet', json={'sheetId': sh['id']}).json()
    assert r['status'] == 'done' and r['syllables'] == 14
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    assert [a['ref'] for a in r['assign']] == [x['ref'] for x in m['notes']][:len(r['assign'])] and len(r['assign']) >= 12
    assert [a['text'] for a in r['assign']][:3] == ['Twin', 'kle', 'twin']
    assert client.post(f'/api/items/{score["id"]}/lyrics/sheet', json={'sheetId': 'nope'}).status_code == 404


def test_preview_saves_nothing(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    r = client.post(f'/api/items/{score["id"]}/lyrics/preview', json={'notes': [{'ref': m['notes'][0]['ref'], 'text': 'Twin', 'syllabic': 'begin'}]})
    assert r.status_code == 200 and '<text>Twin</text>' in r.text
    assert client.get(f'/api/items/{score["id"]}/musicxml').text == score['_xml']
    assert not [a for a in client.get('/api/activity').json() if a['type'] == 'lyrics-fit']


def test_several_verses_at_once(client, score):
    m = client.get(f'/api/items/{score["id"]}/lyrics').json()
    refs = [x['ref'] for x in m['notes']]
    j = client.post(f'/api/items/{score["id"]}/lyrics', json={'verses': {
        '1': {'notes': [{'ref': refs[0], 'text': 'Twin', 'syllabic': 'begin'}, {'ref': refs[1], 'text': 'kle', 'syllabic': 'end'}], 'holds': [refs[2]]},
        '2': {'notes': [{'ref': refs[0], 'text': 'Up', 'syllabic': 'single'}]}}}).json()
    xml = client.get(f'/api/items/{score["id"]}/musicxml').text
    assert [g[1:] for g in lyrics_of(xml, '1')] == [('Twin', 'begin', False), ('kle', 'end', True)]
    assert [g[1] for g in lyrics_of(xml, '2')] == ['Up']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert 'verses 1, 2' in row['detail']
