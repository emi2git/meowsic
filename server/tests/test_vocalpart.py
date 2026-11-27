"""A score with a voice part and a piano part (two <part>s, the voice on its own staff): Edit notes can work on
either (body.part / op.part = the part id; staffmove.using_part). The default stays the piano part."""
import xml.etree.ElementTree as ET

from meowsic import staffmove as sm

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


def test_default_is_the_piano_part_and_op_part_edits_the_voice():
    x = score()
    assert sm.notes(ET.fromstring(x.encode()))[0]['midi'] == 60  # piano by default
    with sm.using_part('P1'):
        vn = sm.notes(ET.fromstring(x.encode()))
    assert [v['midi'] for v in vn] == [72, 74, None]
    out, _, _ = sm.edit_ex(x, {'op': 'pitch', 'refs': [1], 'by': 1, 'part': 'P1'})
    assert midis(out, 'P1')[:2] == [72, 75] and midis(out, 'P2') == [60, 48]
    rest = vn[2]['ref']
    out, _, _ = sm.edit_ex(out, {'op': 'set', 'refs': [rest], 'midis': [79], 'part': 'P1'})
    assert midis(out, 'P1')[2] == 79 and midis(out, 'P2') == [60, 48]


def test_api_preview_and_save_on_the_voice_part(client, data):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Song', 'musicxmlText': score()}).json()
    i = it['id']
    p0 = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': []}).json()
    assert p0['partId'] == 'P2' and [p['id'] for p in p0['parts']] == ['P1', 'P2'] and p0['parts'][0]['name'] == 'Voice'
    pv = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': [], 'part': 'P1'}).json()
    assert pv['part'] == 0 and pv['partId'] == 'P1' and not pv['hands'] and [n['midi'] for n in pv['notes']] == [72, 74, None]
    ops = [{'op': 'pitch', 'refs': [0], 'by': 2, 'part': 'P1'}]
    p = client.post(f'/api/items/{i}/editnotes/preview', json={'ops': ops, 'part': 'P1'}).json()
    assert [n['midi'] for n in p['notes']][:1] == [74] and midis(p['xml'], 'P2') == [60, 48]
    client.post(f'/api/items/{i}/editnotes', json={'ops': ops, 'mode': 'this', 'sha': p['sha']})
    saved = (data / 'items' / it['folder'] / it['musicxml']).read_text()
    assert midis(saved, 'P1')[0] == 74 and '<lyric' in saved
