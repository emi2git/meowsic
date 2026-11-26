"""Edit notes → tempo marks and note values at the wrong scale (rescaleops.py): {op:'tempo'} sets / changes /
removes a tempo mark; {op:'rescale'} halves (bars merged in pairs) or doubles (each bar split in two) the note values
of a stretch in every part, keeping lyrics, chord names, dynamics, ties and full bars; preview, Save, Activities, Undo."""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from test_barops import bars
from test_staffmove import ev, score


def root(text): return ET.fromstring(text.encode())
def run(text, **o):
    info = {}
    out, _, gone = sm.edit_ex(text, o, info)
    return out, info, gone
def measures(text, k=0): return root(text).findall('part')[k].findall('measure')


def attacks(text, a=0, b=10 ** 6, part=0):
    """(onset in quarters from bar a, staff, midi) of every struck note (a tied-on note is no new attack)."""
    r = root(text)
    p = r.findall('part')[part]
    out, held, t0, div, ts = [], set(), Fr(0), Fr(1), (4, 4)
    for bi, m in enumerate(p.findall('measure')):
        for at in m.findall('attributes'):
            if at.findtext('divisions'): div = Fr(int(at.findtext('divisions')))
            tm = at.find('time')
            if tm is not None: ts = (int(tm.findtext('beats')), int(tm.findtext('beat-type')))
        t = last = Fr(0)
        for e in m:
            if e.tag == 'backup': t -= Fr(int(e.findtext('duration'))) / div
            elif e.tag == 'forward': t += Fr(int(e.findtext('duration'))) / div
            elif e.tag == 'note':
                d = Fr(int(e.findtext('duration'))) / div
                on = last if e.find('chord') is not None else t
                if e.find('chord') is None: last, t = t, t + d
                if e.find('rest') is not None or not (a <= bi <= b): continue
                key = ((e.findtext('staff') or '1'), sm._midi(e))
                stop, start = e.find("tie[@type='stop']") is not None, e.find("tie[@type='start']") is not None
                if not (stop and key in held): out.append((t0 + on, int(key[0]), key[1]))
                if start: held.add(key)
                elif stop: held.discard(key)
        if a <= bi <= b: t0 += Fr(4 * ts[0], ts[1])
    return sorted(out)


def with_words(x, bar, k, word):
    """Lyric `word` on the k-th note of a bar (upper staff)."""
    r = root(x)
    n = [n for n in r.find('part').findall('measure')[bar].findall('note') if n.findtext('staff') == '1'][k]
    ly = ET.SubElement(n, 'lyric', number='1'); ET.SubElement(ly, 'syllabic').text = 'single'; ET.SubElement(ly, 'text').text = word
    return sm._head(x) + ET.tostring(r, encoding='unicode')


def with_el(x, bar, before_note, xml):
    """An element (harmony / direction) put in front of the before_note-th <note> of a bar."""
    r = root(x)
    m = r.find('part').findall('measure')[bar]
    n = m.findall('note')[before_note]
    m.insert(list(m).index(n), ET.fromstring(xml))
    return sm._head(x) + ET.tostring(r, encoding='unicode')


CHORD = '<harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>'
FORTE = '<direction placement="below"><direction-type><dynamics><f/></dynamics></direction-type><staff>1</staff></direction>'


def doubled():
    """4 bars written at double values: bar 0 quarters, bars 1–2 halves (chord name + f on bar 1's second half), bar 3 a whole."""
    rh = [[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('F5', 1)], [ev('G5', 2), ev('A5', 2)], [ev('B5', 2), ev('C5', 2)], [ev('D5', 4)]]
    lh = [[ev('C3', 4, 2)], [ev('G2', 2, 2), ev('B2', 2, 2)], [ev('C3', 4, 2)], [ev('G2', 4, 2)]]
    x = score(rh, lh)
    x = with_words(x, 1, 1, 'la')
    x = with_el(x, 1, 1, CHORD)  # in front of A5 (beat 3 of bar 1)
    x = with_el(x, 1, 1, FORTE)
    return x


def test_halve_merges_bars_in_pairs_and_keeps_words_chords_dynamics():
    x = doubled()
    y, info, gone = run(x, op='rescale', **{'from': 0, 'to': 3}, factor=0.5)
    ms = measures(y)
    assert len(ms) == 2 and bars(y) and gone == 0
    assert attacks(y) == [(on / 2, s, m) for on, s, m in attacks(x)]
    # A5 carries its word; the chord name and the f stand at its new place: bar 0, beat 4 (3 quarters in)
    a5 = next(n for n in sm.notes(root(y)) if n['midi'] == 81)
    assert (a5['bar'], a5['on'], a5['dur']) == (0, 3.0, 1.0)
    el = next(n for n in ms[0].findall('note') if sm._midi(n) == 81)
    assert el.findtext('lyric/text') == 'la'
    kids = list(ms[0])
    h = next(i for i, e in enumerate(kids) if e.tag == 'harmony')
    t, div = Fr(0), Fr(4)
    for e in kids[:h]:
        if e.tag == 'note' and e.find('chord') is None: t += Fr(int(e.findtext('duration'))) / div
        if e.tag == 'backup': t -= Fr(int(e.findtext('duration'))) / div
        if e.tag == 'forward': t += Fr(int(e.findtext('duration'))) / div
    assert t == 3 and ms[0].find('direction/direction-type/dynamics/f') is not None
    assert [n.findtext('type') for n in ms[0].findall('note') if n.findtext('staff') == '1'][:4] == ['eighth'] * 4
    assert ms[-1].find('barline/bar-style').text == 'light-heavy'
    assert [m.get('number') for m in ms] == ['1', '2']
    assert any('halved' in s for s in info['said'])


def test_double_splits_each_bar_and_ties_over_new_bar_lines():
    # one bar: a quarter, then a half note on beat 2 (doubled: on beat 3 of bar 1, 4 quarters long → over the new bar line)
    x = score([[ev('C5', 1), ev('E5', 2), ev('G5', 1)]], [[ev('C3', 4, 2)]])
    x = with_words(x, 0, 1, 'long')
    y, info, gone = run(x, op='rescale', **{'from': 0, 'to': 0}, factor=2)
    ms = measures(y)
    assert len(ms) == 2 and bars(y) and gone == 0
    assert attacks(y) == [(on * 2, s, m) for on, s, m in attacks(x)]
    e5 = [n for n in sm.notes(root(y)) if n['midi'] == 76]
    assert [(n['bar'], n['on'], n['dur'], bool(n.get('tie'))) for n in e5] == [(0, 2.0, 2.0, True), (1, 0.0, 2.0, False)]
    words = [(sm._midi(n), n.findtext('lyric/text')) for m in ms for n in m.findall('note') if n.find('lyric') is not None]
    assert words == [(76, 'long')]  # on the first piece only
    c3 = [n for n in sm.notes(root(y)) if n['midi'] == 48]  # the left hand's whole note: two tied wholes
    assert [(n['bar'], n['dur'], bool(n.get('tie'))) for n in c3] == [(0, 4.0, True), (1, 4.0, False)]
    assert [n.findtext('type') for n in ms[0].findall('note') if n.findtext('staff') == '1'][0] == 'half'


def test_round_trip_double_then_halve():
    x = doubled()
    y, _, _ = run(x, op='rescale', **{'from': 0, 'to': 3}, factor=0.5)
    z, _, _ = run(y, op='rescale', **{'from': 0, 'to': 1}, factor=2)
    assert len(measures(z)) == 4 and bars(z) and attacks(z) == attacks(x)


def test_odd_bar_count_halved_pads_the_last_bar_with_rests():
    x = score([[ev('C5', 4)], [ev('D5', 4)], [ev('E5', 4)], [ev('F5', 4)]], [[ev('C3', 4, 2)] for _ in range(4)])
    y, info, _ = run(x, op='rescale', **{'from': 1, 'to': 3}, factor=0.5)  # 3 bars → 1.5 → 2, the last half rest
    ms = measures(y)
    assert len(ms) == 3 and bars(y)
    assert attacks(y, 1, 2) == [(on / 2, s, m) for on, s, m in attacks(x, 1, 3)]
    assert attacks(y, 0, 0) == attacks(x, 0, 0)
    last = ms[2]
    assert [n.findtext('type') for n in last.findall('note') if n.findtext('staff') == '1'] == ['half', 'half']
    assert last.findall('note')[1].find('rest') is not None
    assert any('odd number of bars' in s and '2 quarters of rest' in s for s in info['said'])


def test_bars_after_the_stretch_follow_and_keep_their_music():
    x = score([[ev('C5', 4)], [ev('D5', 4)], [ev('E5', 4)]], [[ev('C3', 4, 2)] for _ in range(3)])
    y, _, _ = run(x, op='rescale', **{'from': 0, 'to': 1}, factor=0.5)
    assert len(measures(y)) == 2 and attacks(y, 1, 1) == attacks(x, 2, 2)
    z, _, _ = run(x, op='rescale', **{'from': 0, 'to': 0}, factor=2)
    assert len(measures(z)) == 4 and attacks(z, 2, 3) == attacks(x, 1, 2)


def two_parts(x):
    """A voice part (one staff) above the piano: the same score with a melody part in front."""
    r = root(x)
    piano = r.find('part')
    voice = copy.deepcopy(piano)
    voice.set('id', 'P0')
    for m in voice.findall('measure'):
        kids = list(m)
        cut = next((i for i, e in enumerate(kids) if e.tag == 'backup'), len(kids))
        for e in kids[cut:]:
            if e.tag != 'barline': m.remove(e)
        for a in m.findall('attributes'):
            for e in [e for e in a if e.tag == 'staves' or (e.tag == 'clef' and e.get('number') == '2')]: a.remove(e)
        for n in m.iter('note'):
            for s in n.findall('staff'): n.remove(s)
    pl = r.find('part-list')
    sp = ET.Element('score-part', id='P0'); ET.SubElement(sp, 'part-name').text = 'Voice'
    pl.insert(0, sp)
    r.insert(list(r).index(piano), voice)
    return sm._head(x) + ET.tostring(r, encoding='unicode')


def test_every_part_and_staff_is_rescaled_alike():
    x = two_parts(doubled())
    y, _, _ = run(x, op='rescale', **{'from': 0, 'to': 3}, factor=0.5)
    r = root(y)
    assert [len(p.findall('measure')) for p in r.findall('part')] == [2, 2]
    assert attacks(y, part=0) == [(on / 2, s, m) for on, s, m in attacks(x, part=0)]
    assert attacks(y, part=1) == [(on / 2, s, m) for on, s, m in attacks(x, part=1)]
    assert {s for _, s, _ in attacks(y, part=1)} == {1, 2}
    assert sm.incomplete_bars(r) == []  # the piano (edit part): every voice of every bar full


def test_refused_when_the_stretch_cannot_be_barred_again():
    x = score([[ev('C5', 4)], [ev('D5', 2)], [ev('E5', 4)]], [[ev('C3', 4, 2)], [ev('C3', 2, 2)], [ev('C3', 4, 2)]])  # bar 1 short
    with pytest.raises(HTTPException) as e: run(x, op='rescale', **{'from': 0, 'to': 2}, factor=0.5)
    assert 'not full' in e.value.detail
    ok = score([[ev('C5', 4)], [ev('D5', 4)]], [[ev('C3', 4, 2)], [ev('C3', 4, 2)]])
    for bad in ({'from': 0, 'to': 1, 'factor': 3}, {'from': 1, 'to': 0, 'factor': 2}, {'from': 0, 'to': 5, 'factor': 2}):
        with pytest.raises(HTTPException): run(ok, op='rescale', **bad)
    # a time change inside the stretch
    r = root(ok)
    m1 = r.find('part').findall('measure')[1]
    m1.insert(0, ET.fromstring('<attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>'))
    with pytest.raises(HTTPException) as e: run(sm._head(ok) + ET.tostring(r, encoding='unicode'), op='rescale', **{'from': 0, 'to': 1}, factor=0.5)
    assert 'time' in e.value.detail


def test_halving_a_sixteenth_makes_divisions_finer():
    x = score([[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('F5', 1)], [ev('G5', 4)]], [[ev('C3', 4, 2)], [ev('C3', 4, 2)]])
    r = root(x)  # the first quarter as four 16ths (divisions 4: one each); halved they are 32nds
    m = r.find('part').find('measure')
    first = m.findall('note')[0]
    at = list(m).index(first)
    m.remove(first)
    for k, s in enumerate('CDEF'):
        m.insert(at + k, ET.fromstring(f'<note><pitch><step>{s}</step><octave>6</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>'))
    x = sm._head(x) + ET.tostring(r, encoding='unicode')
    y, _, _ = run(x, op='rescale', **{'from': 0, 'to': 1}, factor=0.5)
    assert len(measures(y)) == 1 and bars(y)
    assert attacks(y) == [(on / 2, s, mm) for on, s, mm in attacks(x)]
    assert root(y).find('part/measure/attributes/divisions').text == '8'
    assert [n.findtext('type') for n in measures(y)[0].findall('note')][:4] == ['32nd'] * 4


def test_tempo_set_change_and_remove():
    x = score([[ev('C5', 4)], [ev('D5', 4)], [ev('E5', 4)]], [[ev('C3', 4, 2)] for _ in range(3)])
    y, info, _ = run(x, op='tempo', bar=1, bpm=267)
    m1 = measures(y)[1]
    assert m1.find('direction/sound').get('tempo') == '267' and m1.find('direction/direction-type/metronome/per-minute').text == '267'
    assert list(m1)[0].tag == 'direction' and attacks(y) == attacks(x)
    z, info, _ = run(y, op='tempo', bar=1, bpm=130)
    assert [s.get('tempo') for s in root(z).iter('sound')] == ['130'] and info['said'] == ['Bar 2: tempo 130 (was 267)']
    assert len(measures(z)[1].findall('direction')) == 1  # changed in place, not a second mark
    w, _, _ = run(z, op='tempo', bar=1, bpm=None)
    assert not list(root(w).iter('sound')) and not list(root(w).iter('metronome')) and not measures(w)[1].findall('direction')
    with pytest.raises(HTTPException): run(w, op='tempo', bar=1, bpm=None)  # nothing to remove
    with pytest.raises(HTTPException): run(x, op='tempo', bar=9, bpm=100)
    with pytest.raises(HTTPException): run(x, op='tempo', bar=0, bpm='fast')
    # a half-note metronome mark: the sound is in quarters, the mark in its own unit
    h = with_el(x, 0, 0, '<direction><direction-type><words>Allegro</words></direction-type><direction-type><metronome><beat-unit>half</beat-unit>'
                         '<per-minute>60</per-minute></metronome></direction-type><sound tempo="120"/></direction>')
    h2, _, _ = run(h, op='tempo', bar=0, bpm=140)
    assert root(h2).find('.//metronome/per-minute').text == '70' and root(h2).find('.//sound').get('tempo') == '140'
    h3, _, _ = run(h, op='tempo', bar=0, bpm=None)  # the word stays
    assert root(h3).find('.//words').text == 'Allegro' and root(h3).find('.//sound') is None


def test_through_preview_save_activities_and_undo(client, data):
    x = doubled()
    r = root(x)  # the wrong tempo the stretch was written with
    m = r.find('part').find('measure')
    m.insert(list(m).index(m.find('note')), ET.fromstring('<direction><direction-type><metronome><beat-unit>quarter</beat-unit>'
                                                          '<per-minute>240</per-minute></metronome></direction-type><sound tempo="240"/></direction>'))
    x = sm._head(x) + ET.tostring(r, encoding='unicode')
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Rescale', 'musicxmlText': x}).json()
    url = f'/api/items/{it["id"]}/editnotes'
    ops = [{'op': 'rescale', 'from': 0, 'to': 3, 'factor': 0.5}, {'op': 'tempo', 'bar': 0, 'bpm': 120}]
    p0 = client.post(f'{url}/preview', json={'ops': []}).json()
    pv = client.post(f'{url}/preview', json={'ops': ops, 'sha': p0['sha']}).json()
    assert pv['changed'] and not pv['incomplete'] and len(measures(pv['xml'])) == 2
    assert [s.get('tempo') for s in root(pv['xml']).iter('sound')] == ['120']
    f = data / 'items' / it['folder'] / it['musicxml']
    was = f.read_text()
    sv = client.post(url, json={'ops': ops, 'mode': 'this', 'sha': pv['sha']}).json()
    assert sv['ok'] and f.read_text() == pv['xml']
    row = next(a for a in client.get('/api/activity').json() if a['id'] == sv['activity'])
    assert row['type'] == 'edit-notes' and 'note values halved' in row['detail'] and '1 tempo mark changed' in row['detail']
    assert client.post(f'/api/activity/{sv["activity"]}/undo', json={}).status_code == 200
    assert f.read_text() == was
    bad = client.post(f'{url}/preview', json={'ops': [{'op': 'rescale', 'from': 0, 'to': 3, 'factor': 4}]})
    assert bad.status_code == 400
