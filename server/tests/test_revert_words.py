"""Words survive note changes: "Revert note edits" goes back to the original notes but keeps the lyrics, chords and
credits added since (scorecarry.py); Simple piano and an Edit-notes save keep the lyrics too. (The Home NDP bug:
lyrics fitted after the "(original)" baseline was made were lost on revert.) Public-domain words only."""
import xml.etree.ElementTree as ET

import pytest

from test_lyricsedit import WORDS, lyrics_of, score_xml

from meowsic.scorecarry import carry


def chorded():
    """The Twinkle score with a chord symbol before the first note of bars 1 and 3."""
    x = score_xml()
    h = '<harmony><root><root-step>{}</root-step></root><kind>major</kind></harmony>'
    x = x.replace('<measure number="1"><attributes>', '<measure number="1"><attributes>', 1)
    out, k = [], 0
    for part in x.split('<measure number="'):
        if k in (1, 3):
            a, b = part.split('</attributes>', 1) if '</attributes>' in part else (None, part)
            j = b.find('<note>')
            b = b[:j] + h.format('C' if k == 1 else 'F') + b[j:]
            part = (a + '</attributes>' if a is not None else '') + b
        out.append(part); k += 1
    return '<measure number="'.join(out)


@pytest.fixture
def score(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Twinkle Twinkle', 'artist': 'Traditional', 'musicxmlText': chorded(),
                                         'source': 'YouTube', 'sourceUrl': 'https://example.invalid/v'}).json()
    m = client.get(f'/api/items/{it["id"]}/lyrics').json()
    v1 = [{'ref': r, 'text': t, 'syllabic': s} for r, (t, s) in zip([x['ref'] for x in m['notes']], WORDS)]
    assert client.post(f'/api/items/{it["id"]}/lyrics', json={'verse': '1', 'notes': v1}).status_code == 200
    return it


def xml(client, it, original=False):
    return client.get(f'/api/items/{it["id"]}/musicxml', params={'original': 'true'} if original else {}).text


def notes(text):
    return [(n.findtext('pitch/step'), n.findtext('pitch/octave'), n.findtext('duration'), n.find('chord') is not None)
            for n in ET.fromstring(text.encode()).iter('note')]


def creators(text):
    return [(c.get('type'), c.text) for c in ET.fromstring(text.encode()).iter('creator')]


def test_fit_lyrics_leaves_baseline_without_words(client, score):
    # the setting of the bug: Fit lyrics made the "(original)" — the file before, with no words
    assert len(lyrics_of(xml(client, score))) == 14 and lyrics_of(xml(client, score, True)) == []


def test_simple_piano_keeps_lyrics(client, score):
    j = client.post(f'/api/items/{score["id"]}/simplepiano', json={'level': 100, 'main': True, 'grace': True, 'mode': 'this'}).json()
    assert j['ok']
    got = lyrics_of(xml(client, score))
    assert [w for _, w, _, _ in got] == [w for w, _ in WORDS]


def test_revert_keeps_lyrics_chords_credits(client, score):
    before = xml(client, score)
    edited = before.replace('<step>C</step><octave>4</octave></pitch><duration>2</duration>', '<step>D</step><octave>4</octave></pitch><duration>2</duration>', 1)
    assert edited != before
    client.put(f'/api/items/{score["id"]}/musicxml', content=edited)
    j = client.post(f'/api/items/{score["id"]}/musicxml/revert').json()
    now = xml(client, score)
    assert notes(now) == notes(xml(client, score, True))  # the original notes
    assert [w for _, w, _, _ in lyrics_of(now)] == [w for w, _ in WORDS]  # the words stay
    assert lyrics_of(now) == lyrics_of(before)  # on the same notes
    assert now.count('<harmony') == 2 and creators(now) == creators(before)
    assert j['kept']['placed'] == 14 and j['kept']['dropped'] == 0
    # logged, and Undo brings the edit back
    row = next(a for a in client.get('/api/activity').json() if a.get('id') == j['activity'])
    assert row['type'] == 'edit-notes' and row['action'] == 'undo'
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert notes(xml(client, score)) == notes(edited)


def test_revert_after_simple_piano(client, score):
    client.post(f'/api/items/{score["id"]}/simplepiano', json={'level': 100, 'main': True, 'grace': True, 'mode': 'this'})
    client.post(f'/api/items/{score["id"]}/musicxml/revert')
    now = xml(client, score)
    assert notes(now) == notes(xml(client, score, True))
    assert len(lyrics_of(now)) == 14


def test_edit_notes_put_keeps_lyrics_and_credits(client, score):
    before = xml(client, score)
    # the page sends its drawn copy: display credits (lyricist line), a note changed, words as they were
    drawn = before.replace('type="arranger"', 'type="lyricist"')
    client.put(f'/api/items/{score["id"]}/musicxml', content=drawn)
    now = xml(client, score)
    assert lyrics_of(now) == lyrics_of(before) and creators(now) == creators(before)


def test_carry_moves_word_of_removed_note():
    """A syllable on a note that is gone moves to the next free note of its bar (never lost while one is left)."""
    src = score_xml().replace('<staff>1</staff></note>', '<staff>1</staff><lyric number="1"><syllabic>single</syllabic><text>la</text></lyric></note>', 1)
    root = ET.fromstring(src.encode())
    # drop the first note (and its chord member) of bar 1 in the target; the 2nd note gets twice the length
    dst = ET.fromstring(score_xml().encode())
    m = dst.find('part/measure')
    ns = m.findall('note')
    m.remove(ns[0]); m.remove(ns[1]); ns[2].find('duration').text = '4'; ns[3].find('duration').text = '4'
    out, rep = carry(src, ET.tostring(dst, encoding='unicode'))
    assert rep == {**rep, 'syllables': 1, 'placed': 1, 'dropped': 0}
    assert len(lyrics_of(out)) == 1 and root is not None
