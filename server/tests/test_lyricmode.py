"""Edit notes → Lyrics mode (web/js/views/lyricmode.js): the {op: 'lyrics'} step of Edit notes (lyricsedit.set_lyrics,
run by staffmove.apply_ops). Writes <lyric> syllabic / extend / number on one staff and verse, keeps the notes, ties,
slurs and chords, mixes with note edits in one save (.history + an undoable Activities row). Made-up words only."""
import copy
import xml.etree.ElementTree as ET

import pytest

from meowsic import staffmove as sm
from test_lyricsedit import score_xml


def lyr(xml, verse='1'):
    root = ET.fromstring(xml.encode())
    out = []
    for e in root.iter('note'):
        for ly in e.findall('lyric'):
            if (ly.get('number') or '1') == verse:
                out.append((ly.findtext('text'), ly.findtext('syllabic'), ly.find('extend') is not None))
    return out


def strip(xml):
    """The score without its words (and without whitespace) — what must not change."""
    root = ET.fromstring(xml.encode())
    for e in root.iter('note'):
        for ly in e.findall('lyric'): e.remove(ly)
    for e in root.iter():
        e.tail = (e.tail or '').strip() or None
        e.text = (e.text or '').strip() or None
    return ET.tostring(root, encoding='unicode')


def line_refs(xml, staff=1):
    """refs of the top note of each onset of a staff (as lyricmode.js builds its line)."""
    ns = [n for n in sm.notes(ET.fromstring(xml.encode())) if not n.get('rest') and n['staff'] == staff]
    top = {}
    for n in ns:
        k = (n['bar'], n['on'])
        if k not in top or n['midi'] > top[k]['midi']: top[k] = n
    return [top[k]['ref'] for k in sorted(top)]


def op(refs, words, verse=1, staff=1):
    return {'op': 'lyrics', 'staff': staff, 'verse': verse,
            'notes': [{'ref': r, 'text': t, 'syllabic': s, **({'extend': True} if e else {})} for r, (t, s, e) in zip(refs, words)]}


W = [('Ma', 'begin', False), ('ple', 'end', False), ('moon', 'single', True), ('rise', 'single', False)]


def test_set_lyrics_writes_syllabic_extend_and_keeps_the_notes():
    x = score_xml()
    refs = line_refs(x)
    out, moved = sm.apply_ops(x, [op(refs[:4], W)])
    assert moved == [] and lyr(out) == W
    assert strip(out) == strip(x)  # notes, chords, ties, slurs untouched
    # rewrite: the verse becomes exactly the new set
    out2, _ = sm.apply_ops(out, [op([refs[1]], [('lo', 'single', False)])])
    assert lyr(out2) == [('lo', 'single', False)]
    # a lower note of a chord never gets the words: only the refs sent
    root = ET.fromstring(out.encode())
    assert all(e.find('lyric') is None for e in root.iter('note') if e.find('chord') is not None)


def test_verse_two_and_lower_staff_leave_the_others():
    x = score_xml()
    refs = line_refs(x)
    out, _ = sm.apply_ops(x, [op(refs[:4], W), op(refs[:2], [('Hi', 'begin', False), ('ya', 'end', False)], verse=2)])
    assert lyr(out, '1') == W and lyr(out, '2') == [('Hi', 'begin', False), ('ya', 'end', False)]
    # inside a note verse 1 comes first
    root = ET.fromstring(out.encode())
    first = next(e for e in root.iter('note') if len(e.findall('lyric')) == 2)
    assert [ly.get('number') for ly in first.findall('lyric')] == ['1', '2']
    low = line_refs(x, 2)
    out2, _ = sm.apply_ops(out, [op(low[:1], [('bass', 'single', False)], staff=2)])
    assert lyr(out2, '1')[:4] == W and ('bass', 'single', False) in lyr(out2, '1')


def test_bad_lyrics_ops():
    x = score_xml()
    refs = line_refs(x)
    from fastapi import HTTPException
    for bad in [op([999], [('a', 'single', False)]), op([refs[0]], [('', 'single', False)]), op([refs[0]], [('a', 'weird', False)]),
                op([refs[0]], [('a', 'single', False)], staff=2), op([refs[0]], [('a', 'single', False)], verse=99)]:
        with pytest.raises(HTTPException):
            sm.apply_ops(x, [bad])


def test_note_edits_keep_the_words():
    x = score_xml()
    refs = line_refs(x)
    out, _ = sm.apply_ops(x, [op(refs[:4], W), {'op': 'pitch', 'refs': [refs[0]], 'by': 2}, {'op': 'len', 'refs': [refs[3]], 'q': 0.5}])
    assert [w[0] for w in lyr(out)] == ['Ma', 'ple', 'moon', 'rise']


def test_api_lyrics_and_notes_in_one_save_with_undo(client, data):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Made up', 'musicxmlText': score_xml()}).json()
    i = it['id']
    p0 = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    refs = line_refs(p0['xml'])
    ops = [op(refs[:4], W), {'op': 'pitch', 'refs': [refs[5]], 'by': 1}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()
    assert lyr(p['xml']) == W
    f = data / 'items' / it['folder'] / it['musicxml']
    was = f.read_text()
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p0['sha']}).json()
    assert f.read_text() == p['xml'] and (f.parent / j['history']).read_text() == was
    row = next(a for a in client.get('/api/activity').json() if a['id'] == j['activity'])
    assert 'lyrics of verse 1' in row['detail'] and 'higher / lower' in row['detail']
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was


def test_api_lyrics_only_new_version_is_tagged(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Made up 2', 'musicxmlText': score_xml()}).json()
    p0 = client.post(f'/api/items/{it["id"]}/editnotes/preview', json={'ops': []}).json()
    j = client.post(f'/api/items/{it["id"]}/editnotes', json={'ops': [op(line_refs(p0['xml'])[:4], W)], 'mode': 'new'}).json()
    assert 'Lyrics added' in j['item']['tags']
    assert lyr(client.get(f'/api/items/{j["item"]["id"]}/musicxml').text) == W
