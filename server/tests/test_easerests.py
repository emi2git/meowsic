"""Ease rests (easerests.py): short rests merged into the note before, rests in a row combined, bars full, ties
right, Light / Strong, preview, saving into the score (history + Activities undo) or as a new score."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest

from meowsic import easerests as er

TY = {Fr(1, 4): '16th', Fr(1, 2): 'eighth', Fr(3, 4): ('eighth', 1), Fr(1): 'quarter', Fr(3, 2): ('quarter', 1), Fr(2): 'half', Fr(3): ('half', 1), Fr(4): 'whole'}


def ev(x, q, staff=1, voice=1, extra=''):
    """x: 'C4' | 'R' | 'C4+E4' (a chord); q in quarters (divisions = 4)."""
    t = TY[Fr(q)]
    t, dots = (t, 0) if isinstance(t, str) else t
    tail = f'<duration>{int(Fr(q) * 4)}</duration><voice>{voice}</voice><type>{t}</type>' + '<dot/>' * dots + f'<staff>{staff}</staff>'
    if x == 'R': return extra + f'<note><rest/>{tail}{"" }</note>'
    out = extra
    for k, p in enumerate(x.split('+')):
        out += f'<note>{"<chord/>" if k else ""}<pitch><step>{p[0]}</step><octave>{p[1]}</octave></pitch>{tail}<notations><articulations><staccato/></articulations></notations></note>'
    return out


def score(bars, lh=None, beats=4):
    ms = []
    for i, b in enumerate(bars):
        x = f'<measure number="{i + 1}">'
        if i == 0: x += f'<attributes><divisions>4</divisions><time><beats>{beats}</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>'
        x += ''.join(b)
        if lh: x += f'<backup><duration>{beats * 4}</duration></backup>' + ''.join(lh[i])
        ms.append(x + '</measure>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
            '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


def voice(text, bar=0, staff='1'):
    """[(pitches or 'R', quarters, ties)] of one staff in one bar."""
    m = ET.fromstring(text.encode()).findall('part/measure')[bar]
    out = []
    for n in m.findall('note'):
        if (n.findtext('staff') or '1') != staff: continue
        ties = tuple(sorted(t.get('type') for t in n.findall('tie')))
        p = 'R' if n.find('rest') is not None else n.findtext('pitch/step') + n.findtext('pitch/octave')
        if n.find('chord') is not None: out[-1] = (out[-1][0] + '+' + p, out[-1][1], out[-1][2]); continue
        out.append((p, Fr(int(n.findtext('duration')), 4), ties))
    return out


def full(text):
    return all(all(v == L for v in vs.values()) for _, vs, L in er.bar_lengths(text))


def ties_ok(text):
    """Every tie start is followed (same staff / voice, next onset) by a stop on the same pitch, and the other way round."""
    root = ET.fromstring(text.encode())
    seq = {}
    for m in root.iter('measure'):
        for n in m.findall('note'):
            if n.find('pitch') is None: k = (n.findtext('staff'), n.findtext('voice')); seq.setdefault(k, []).append(None); continue
            k = (n.findtext('staff'), n.findtext('voice'))
            p = n.findtext('pitch/step') + n.findtext('pitch/octave')
            ty = {t.get('type') for t in n.findall('tie')}
            assert {t.get('type') for t in n.findall('notations/tied')} == ty, 'tie and tied differ'
            if n.find('chord') is not None and seq[k] and seq[k][-1] is not None: seq[k][-1].append((p, ty)); continue
            seq.setdefault(k, []).append([(p, ty)])
    for s in seq.values():
        for a, b in zip(s, s[1:]):
            starts = {p for p, ty in (a or []) if 'start' in ty}
            stops = {p for p, ty in (b or []) if 'stop' in ty}
            if starts != stops: return False
    return True


BAR = [ev('C4', 1), ev('R', 0.25), ev('D4', 0.75), ev('R', 0.5), ev('E4', 0.5), ev('R', 1)]  # 4 quarters


def test_light_merges_rests_up_to_an_eighth():
    x = score([BAR])
    out, a, b = er.ease(x, 'light')
    assert (a, b) == (3, 1)
    v = voice(out)
    # C 1¼ = quarter tied to a 16th; D ¾ + ½ = 1¼ = quarter tied to a 16th; E ½; the quarter rest stays
    assert v == [('C4', 1, ('start',)), ('C4', Fr(1, 4), ('stop',)), ('D4', 1, ('start',)), ('D4', Fr(1, 4), ('stop',)), ('E4', Fr(1, 2), ()), ('R', 1, ())]
    assert sum(q for _, q, _ in v) == 4 and full(out) and ties_ok(out)
    assert v[0][2] == ('start',) and v[1][2] == ('stop',)
    assert '<staccato' not in ET.tostring(ET.fromstring(out.encode()).find('part/measure/note')).decode()  # lengthened: no staccato
    assert out.startswith('<?xml') and '<!DOCTYPE score-partwise' in out


def test_strong_merges_up_to_a_quarter():
    out, a, b = er.ease(score([BAR]), 'strong')
    assert b == 0 and full(out) and ties_ok(out)
    assert sum(q for p, q, _ in voice(out) if p.startswith('E')) == Fr(3, 2)


def test_rests_in_a_row_become_one():
    x = score([[ev('C4', 1), ev('R', 1), ev('R', 1), ev('R', 1)]])
    out, a, b = er.ease(x, 'light')
    assert (a, b) == (3, 1) and voice(out) == [('C4', 1, ()), ('R', 3, ())] and full(out)


def test_chords_ties_and_both_staves():
    rh = [[ev('C4+E4', 1), ev('R', 0.5), ev('G4', 0.5, extra=''), ev('A4', 2)], [ev('R', 0.5), ev('B4', 1.5), ev('C5', 2)]]
    lh = [[ev('C3', 1, 2, 2), ev('R', 0.25, 2, 2), ev('G2', 0.75, 2, 2), ev('C3', 2, 2, 2)], [ev('F2', 2, 2, 2), ev('R', 0.5, 2, 2), ev('G2', 1.5, 2, 2)]]
    x = score(rh, lh)
    out, a, b = er.ease(x, 'light')
    assert voice(out)[0] == ('C4+E4', Fr(3, 2), ())                     # dotted quarter, both chord notes
    assert all(p != 'R' for p, *_ in voice(out, 0, '2')) and full(out) and ties_ok(out)
    assert voice(out, 1)[0][0] == 'R'                                   # Light: a rest opening a bar stays
    out, a, b = er.ease(x, 'strong')
    assert voice(out, 1)[0] == ('A4', Fr(1, 2), ('stop',))              # Strong: the A before ties over the bar line
    assert voice(out, 0)[-1] == ('A4', 2, ('start',))
    assert b == 0 and full(out) and ties_ok(out)


def test_existing_ties_are_kept():
    a = ev('C4', 2).replace('</duration>', '</duration><tie type="start"/>', 1).replace('<notations>', '<notations><tied type="start"/>', 1)
    b = ev('C4', 1).replace('</duration>', '</duration><tie type="stop"/>', 1).replace('<notations>', '<notations><tied type="stop"/>', 1)
    x = score([[ev('D4', 1), ev('R', 0.5), ev('E4', 0.5), a], [b, ev('R', 0.25), ev('F4', 0.75), ev('G4', 2)]])
    out, *_ = er.ease(x, 'light')
    assert ties_ok(out) and full(out)
    assert voice(out, 1)[0][0] == 'C4' and 'stop' in voice(out, 1)[0][2]


def test_harmony_on_a_merged_rest_moves_to_the_next_note():
    h = '<harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>'
    x = score([[ev('C4', 1), ev('R', 0.5, extra=h), ev('D4', 0.5), ev('E4', 2)]])
    out, *_ = er.ease(x, 'light')
    kids = [e.tag for e in ET.fromstring(out.encode()).find('part/measure')]
    assert kids == ['attributes', 'note', 'harmony', 'note', 'note']        # just before the D (the next onset)


def test_tuplets_are_left_alone():
    t = ev('C4', 0.5).replace('<type>', '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><type>')
    x = score([[t, ev('R', 0.5), ev('D4', 3)]])
    out, a, b = er.ease(x, 'strong')
    assert a == b == 1


@pytest.fixture
def eased(client):
    x = score([BAR, [ev('R', 0.5), ev('C4', 1.5), ev('G4', 2)]])
    return client.post('/api/items', json={'kind': 'score', 'title': 'Home NDP', 'musicxmlText': x, 'tags': ['NDP'],
                                           'source': 'YouTube', 'sourceUrl': 'https://youtu.be/x'}).json()


def test_api_preview_save_this_and_undo(client, eased, data):
    i = eased['id']
    p = client.post(f'/api/items/{i}/easerests/preview', json={'strength': 'strong'}).json()
    assert p['changed'] and p['after'] < p['before'] and full(p['xml'])
    f = data / 'items' / eased['folder'] / eased['musicxml']
    was = f.read_text()
    assert client.post(f'/api/items/{i}/easerests', json={'strength': 'strong', 'mode': 'this', 'sha': 'nope'}).status_code == 409
    j = client.post(f'/api/items/{i}/easerests', json={'strength': 'strong', 'mode': 'this', 'sha': p['sha']}).json()
    assert f.read_text() == p['xml'] and (f.parent / j['history']).read_text() == was
    acts = client.get('/api/activity').json()
    row = next(a for a in acts if a['id'] == j['activity'])
    assert row['type'] == 'ease-rests' and row['action'] == 'undo'
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was


def test_api_save_as_new(client, eased, data):
    j = client.post(f'/api/items/{eased["id"]}/easerests', json={'strength': 'light', 'mode': 'new'}).json()
    new = j['item']
    assert new['id'] != eased['id'] and new['title'] == 'Home NDP' and er.TAG in new['tags'] and 'NDP' in new['tags']
    assert new['groupId'] and client.get(f'/api/items/{eased["id"]}').json()['groupId'] == new['groupId']
    assert full(client.get(f'/api/items/{new["id"]}/musicxml').text)
    assert client.post(f'/api/activity/{j["activity"]}/undo', json={}).status_code == 200
    assert client.get(f'/api/items/{new["id"]}').json().get('deleted')


def test_nothing_to_ease(client):
    x = score([[ev('C4', 4)]])
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Plain', 'musicxmlText': x, 'source': 'Audio file · a.mp3'}).json()
    assert client.post(f'/api/items/{it["id"]}/easerests', json={'strength': 'light'}).status_code == 422


def test_only_for_transcriptions(client, app):
    """AI lead sheets, scores read from a sheet and imported MusicXML: no Ease rests (409); a transcribe job's score,
    and the score Ease rests saved "as new" from it: yes."""
    x = score([BAR])
    mk = lambda **k: client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': x, **k}).json()
    for it in (mk(ai=1), mk(source='From the sheet “S” (photo → score, beta)'), mk()):
        assert client.get(f'/api/items/{it["id"]}/easerests').json()['allowed'] is False
        assert client.post(f'/api/items/{it["id"]}/easerests/preview', json={'strength': 'light'}).status_code == 409
        assert client.post(f'/api/items/{it["id"]}/easerests', json={'strength': 'light', 'mode': 'this'}).status_code == 409
    job = mk(source='vimeo.com')   # a link the platform list does not know: the transcribe job says so
    c = app.state.connect()
    c.execute("INSERT INTO job(id, kind, title, outputs, status, result, started_at) VALUES ('job-t1','transcribe','S','[]','done',?,1)",
              (f'["{job["id"]}"]',))
    c.commit(); c.close()
    assert client.get(f'/api/items/{job["id"]}/easerests').json()['allowed'] is True
    new = client.post(f'/api/items/{job["id"]}/easerests', json={'strength': 'light', 'mode': 'new'}).json()['item']
    assert client.get(f'/api/items/{new["id"]}/easerests').json()['allowed'] is True
