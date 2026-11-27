"""A score with a voice part and a piano part (two <part>s, the voice on its own staff): Edit notes can work on
every part at once (global refs: part × REF_PART + index; staves in score order: voice 1, piano 2–3); an op over
notes of both parts is split by part and is still one step. op.part still picks one part."""
import xml.etree.ElementTree as ET

from meowsic import staffmove as sm
from meowsic.multipart import REF_PART

STEP = {0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B'}


def n(m, q=1, staff=None, voice='1', lyric=False):
    body = '<rest/>' if m is None else f'<pitch><step>{STEP[m % 12]}</step><octave>{m // 12 - 1}</octave></pitch>'
    st = f'<staff>{staff}</staff>' if staff else ''
    ly = '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>' if lyric else ''
    return f'<note>{body}<duration>{q * 2}</duration><voice>{voice}</voice><type>{ {1: "quarter", 2: "half", 4: "whole"}[q]}</type>{st}{ly}</note>'


def score():
    attrs1 = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
    attrs2 = ('<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
              '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>')
    voice = f'<part id="P1"><measure number="1">{attrs1}{n(72, lyric=True)}{n(74, lyric=True)}{n(None, 2)}</measure></part>'
    piano = (f'<part id="P2"><measure number="1">{attrs2}{n(60, 4, 1)}<backup><duration>8</duration></backup>{n(48, 4, 2, "5")}</measure></part>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part>'
            f'<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>{voice}{piano}</score-partwise>')


def midis(text, pid):
    p = next(p for p in ET.fromstring(text.encode()).findall('part') if p.get('id') == pid)
    return [sm._midi(x) for x in p.iter('note')]


def test_every_part_at_once_global_refs_and_staves():
    x = score()
    ns = sm.notes(ET.fromstring(x.encode()))
    voice = [n for n in ns if n['part'] == 0]
    piano = [n for n in ns if n['part'] == 1]
    assert [n['midi'] for n in voice] == [72, 74, None] and {n['staff'] for n in voice} == {1}
    assert [n['midi'] for n in piano] == [60, 48] and [n['staff'] for n in piano] == [2, 3]
    assert piano[0]['ref'] == REF_PART + 0
    # one op over a vocal note and a piano note: both change, one step
    out, moved, _ = sm.edit_ex(x, {'op': 'pitch', 'refs': [voice[1]['ref'], piano[0]['ref']], 'by': 1})
    assert midis(out, 'P1')[:2] == [72, 75] and midis(out, 'P2') == [61, 48]
    assert sorted(moved) == [1, REF_PART]
    # a rest of the voice becomes a note; Delete on a piano note; length on a vocal note
    out, _, _ = sm.edit_ex(out, {'op': 'set', 'refs': [voice[2]['ref']], 'midis': [79]})
    assert midis(out, 'P1')[2] == 79
    out, _, _ = sm.edit_ex(out, {'op': 'len', 'refs': [voice[0]['ref']], 'q': 2})
    assert full_bars(out)
    # moving a vocal note to a piano staff is refused (another part)
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException): sm.edit_ex(x, {'op': 'move', 'refs': [voice[0]['ref']], 'to': 3})
    # the left hand moves to the right hand inside the piano
    out, _, _ = sm.edit_ex(x, {'op': 'move', 'refs': [piano[1]['ref']], 'to': 2})
    assert all(n['staff'] == 2 for n in sm.notes(ET.fromstring(out.encode())) if n['part'] == 1 and not n.get('rest'))


def test_op_part_still_picks_one_part():
    x = score()
    out, _, _ = sm.edit_ex(x, {'op': 'pitch', 'refs': [1], 'by': 1, 'part': 'P1'})
    assert midis(out, 'P1')[:2] == [72, 75] and midis(out, 'P2') == [60, 48]


def full_bars(text):
    from meowsic.multipart import layout
    root = ET.fromstring(text.encode())
    return not sm.incomplete_bars(root) and layout(root)


def test_api_preview_and_save_every_part(client, data):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Song', 'musicxmlText': score()}).json()
    i = it['id']
    p0 = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    assert p0['multi'] and [p['id'] for p in p0['parts']] == ['P1', 'P2']
    assert [n['midi'] for n in p0['notes']] == [72, 74, None, 60, 48]
    ops = [{'op': 'pitch', 'refs': [0], 'by': 2}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops}).json()
    assert p['notes'][0]['midi'] == 74 and midis(p['xml'], 'P2') == [60, 48] and p['moved'] == [0]
    client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p['sha']})
    saved = (data / 'items' / it['folder'] / it['musicxml']).read_text()
    assert midis(saved, 'P1')[0] == 74 and '<lyric' in saved
