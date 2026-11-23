"""Add lyrics from a sheet: the aligner on made-up tunes with made-up syllables, and the 'lyrics' job
(the sheet reading — OMR — is replaced by a ready sheet score)."""
import random
import time
import xml.etree.ElementTree as ET

import pytest

from meowsic import lyricsfit as lf

NAMES = [('C', 0), ('C', 1), ('D', 0), ('D', 1), ('E', 0), ('F', 0), ('F', 1), ('G', 0), ('G', 1), ('A', 0), ('A', 1), ('B', 0)]
SCALE = [0, 2, 4, 5, 7, 9, 11]


def tune(seed, bars=16, base=60):
    """[[(midi, quarters), …] per 4/4 bar] — a stepwise made-up melody."""
    r = random.Random(seed)
    deg, out = 7, []
    for _ in range(bars):
        left, bar = 4.0, []
        while left > 0:
            d = min(left, r.choice([0.5, 0.5, 1, 1, 1, 2]))
            deg = max(0, min(13, deg + r.choice([-2, -1, -1, 1, 1, 2, 0])))
            bar.append((base + 12 * (deg // 7) + SCALE[deg % 7], d))
            left -= d
        out.append(bar)
    return out


def pitch(m):
    step, alter = NAMES[m % 12]
    return f'<pitch><step>{step}</step>{"<alter>1</alter>" if alter else ""}<octave>{m // 12 - 1}</octave></pitch>'


def note(m, q, staff=None, chord=False, lyric=None):
    d = int(q * 4)
    ly = ''
    if lyric: ly = f'<lyric number="1"><syllabic>{lyric[1]}</syllabic><text>{lyric[0]}</text></lyric>'
    body = '<rest/>' if m is None else pitch(m)
    return (f'<note>{"<chord/>" if chord else ""}{body}<duration>{d}</duration><voice>1</voice><type>quarter</type>'
            f'{f"<staff>{staff}</staff>" if staff else ""}{ly}</note>')


def piano_xml(bars, intro=0):
    """A piano score: the tune on top of staff 1 with a third below it, a bass note per bar in staff 2,
    after `intro` bars of high broken chords."""
    ms = []
    allbars = [[(84 + (k % 4) * 3, 0.5) for k in range(8)] for _ in range(intro)] + bars
    for k, bar in enumerate(allbars, 1):
        x = f'<measure number="{k}">'
        if k == 1: x += '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>'
        for m, q in bar:
            x += note(m, q, 1)
            if m is not None and k > intro: x += note(m - 4, q, 1, chord=True)
        x += '<backup><duration>16</duration></backup>' + note(48, 4, 2) + '</measure>'
        ms.append(x)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
            '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


def sheet_xml(bars, words):
    """A lead sheet: one staff, a made-up syllable (text, syllabic) on each note (None: a held note)."""
    it = iter(words)
    ms = []
    for k, bar in enumerate(bars, 1):
        x = f'<measure number="{k}">'
        if k == 1: x += '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
        x += ''.join(note(m, q, lyric=next(it)) for m, q in bar) + '</measure>'
        ms.append(x)
    return ('<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Voice 1</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


def made_up_words(bars):
    """Unique nonsense syllables ('zu0', 'zu1'…): every third note starts a two-syllable word; every seventh is held."""
    n = sum(len(b) for b in bars)
    out, k = [], 0
    while len(out) < n:
        if len(out) % 7 == 6: out.append(None); continue
        if len(out) % 3 == 0 and len(out) + 1 < n and (len(out) + 1) % 7 != 6:
            out += [(f'zu{k}', 'begin'), (f'zu{k + 1}', 'end')]; k += 2
        else:
            out.append((f'zu{k}', 'single')); k += 1
    return out[:n]


def transpose(bars, k): return [[(m + k, q) for m, q in b] for b in bars]


def ornament(bars, every=5):
    """The transcription's habits: every `every`-th long note is played as two notes (the second a step up)."""
    out, n = [], 0
    for b in bars:
        nb = []
        for m, q in b:
            n += 1
            if n % every == 0 and q >= 1: nb += [(m, q / 2), (m + 2, q / 2)]
            else: nb.append((m, q))
        out.append(nb)
    return out


def sheet_pitches(bars, words):
    flat = [m for b in bars for m, _ in b]
    return {w[0]: m for w, m in zip(words, flat) if w}


def placed(xml):
    """{syllable: (midi, onset)} of the lyrics in the new score."""
    return {n.text: (n.midi, n.onset) for n in lf.read_tune(ET.fromstring(xml.encode()), lyrics=True) if n.text}


def test_transposed_ornamented_tune_with_an_intro():
    bars = tune(1)
    words = made_up_words(bars)
    out, rep = lf.fit(piano_xml(ornament(transpose(bars, 3)), intro=2), sheet_xml(bars, words))
    want = sheet_pitches(bars, words)
    got = placed(out)
    assert rep['syllables'] == len(want) and rep['coverage'] >= 95 and rep['shift'] == 3
    right = sum(1 for t, (m, _) in got.items() if m == want[t] + 3)
    assert right >= 0.95 * len(want)
    onsets = [got[w[0]][1] for w in words if w and w[0] in got]
    assert onsets == sorted(onsets) and min(onsets) >= 8  # never in the intro, always in order
    assert rep['checkBars'] <= 2


def test_key_change_halfway():
    bars = tune(2, bars=24)
    words = made_up_words(bars)
    score = transpose(bars[:12], 3) + transpose(bars[12:], 8)
    out, rep = lf.fit(piano_xml(score), sheet_xml(bars, words))
    want, got = sheet_pitches(bars, words), placed(out)
    assert rep['coverage'] >= 90 and rep['blocks'] == 2
    right = sum(1 for t, (m, _) in got.items() if (m - want[t]) % 12 in (3, 8))
    assert right >= 0.9 * len(want)


def test_section_left_out_of_the_recording():
    bars = tune(3, bars=24)
    words = made_up_words(bars)
    out, rep = lf.fit(piano_xml(bars[:8] + bars[16:]), sheet_xml(bars, words))
    got = placed(out)
    cut = {w[0] for w in made_up_words(bars)[sum(len(b) for b in bars[:8]):sum(len(b) for b in bars[:16])] if w}
    assert not (cut & set(got))  # the left-out bars' words go nowhere
    kept = {t for t in sheet_pitches(bars, words) if t not in cut}
    assert len(kept & set(got)) >= 0.95 * len(kept)


def test_other_tune_gets_few_sure_words():
    bars, other = tune(4), tune(99)
    out, rep = lf.fit(piano_xml(other), sheet_xml(bars, made_up_words(bars)))
    assert rep['sure'] <= 0.35 * rep['syllables']


def test_written_lyrics_are_valid_musicxml():
    bars = tune(5, bars=6)
    words = made_up_words(bars)
    src = piano_xml(transpose(bars, -2))
    out, rep = lf.fit(src, sheet_xml(bars, words))
    assert out.startswith('<?xml') and '<!DOCTYPE score-partwise' in out
    root, before = ET.fromstring(out.encode()), ET.fromstring(src.encode())
    assert len(list(root.iter('note'))) == len(list(before.iter('note')))  # no note added or lost
    lys = list(root.iter('lyric'))
    assert len(lys) == rep['placed'] and all(l.find('syllabic') is not None and l.find('text').text for l in lys)
    for n in root.iter('note'):  # <lyric> after <staff>/<notations>, as the schema orders it
        tags = [c.tag for c in n]
        if 'lyric' in tags: assert tags.index('lyric') > tags.index('staff')
    # a second run replaces the lyrics instead of adding more
    out2, _ = lf.fit(out, sheet_xml(bars, words))
    assert len(list(ET.fromstring(out2.encode()).iter('lyric'))) == rep['placed']


def test_unsure_words_are_marked():
    bars = tune(6, bars=12)
    words = made_up_words(bars)
    score = [list(b) for b in transpose(bars, 0)]
    score[5] = [(m + 1, q) for m, q in score[5]]  # one bar played wrong
    out, rep = lf.fit(piano_xml(score), sheet_xml(bars, words))
    assert rep['unsure'] >= 1 and rep['checkBars'] >= 1
    root = ET.fromstring(out.encode())
    assert sum(1 for w in root.iter('words') if w.text == lf.CHECK) == rep['checkBars']
    assert sum(1 for l in root.iter('lyric') if l.get('color') == lf.RED) == rep['unsure']


def test_no_words_on_the_sheet():
    bars = tune(7, bars=4)
    with pytest.raises(ValueError):
        lf.fit(piano_xml(bars), sheet_xml(bars, [None] * 99))


# ---------- the job ----------

def wait(client, jid, t=30):
    end = time.time() + t
    while time.time() < end:
        j = client.get(f'/api/jobs/{jid}').json()
        if j['status'] in ('done', 'failed', 'cancelled'): return j
        time.sleep(0.05)
    raise AssertionError(j['log'])


PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 64


def test_lyrics_job_makes_a_new_score(client, data, tmp_path, monkeypatch):
    monkeypatch.setenv('MEOWSIC_PDF', '0')
    bars = tune(8)
    words = made_up_words(bars)
    sheet_file = tmp_path / 'sheet.musicxml'
    sheet_file.write_text(sheet_xml(bars, words))
    seen = []
    monkeypatch.setattr(lf, 'read_sheet', lambda cfg, sheet, ev=None, cancelled=None: seen.append(sheet['id']) or sheet_file)
    src = client.post('/api/items', json={'kind': 'score', 'title': 'Made Up Song', 'artist': 'Nobody', 'version': 'original',
                                          'tags': ['Original', 'Folk'], 'key': 'C major', 'bpm': 90, 'groupId': 'g-x',
                                          'musicxmlText': piano_xml(transpose(bars, 2), intro=1)}).json()
    sh = client.post('/api/sheets', files=[('files', ('p1.png', PNG, 'image/png'))], data={'title': 'Made Up Song'}).json()['item']
    before = client.get(f'/api/items/{src["id"]}/musicxml').text
    assert client.post('/api/jobs', json={'kind': 'lyrics', 'title': 'x', 'fromItemId': src['id']}).status_code == 400
    j = client.post('/api/jobs', json={'kind': 'lyrics', 'title': 'Made Up Song', 'fromItemId': src['id'], 'sheetId': sh['id'],
                                       'outputs': ['original'], 'source': 'From the score “Made Up Song” + lyrics from the sheet'}).json()
    assert j['kind'] == 'lyrics' and j['gen'] is True
    j = wait(client, j['id'])
    assert j['status'] == 'done', j['log']
    assert seen == [sh['id']] and len(j['result']) == 1
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['kind'] == 'score' and it['version'] == 'original' and it['groupId'] == 'g-x'
    assert it['tags'] == ['Original', 'Folk', lf.TAG] and it['artist'] == 'Nobody' and it['bpm'] == 90
    assert it['source'] == 'From the score “Made Up Song” + lyrics from the sheet'
    x = client.get(f'/api/items/{it["id"]}/musicxml').text
    assert x.count('<lyric') >= 0.9 * sum(1 for w in words if w) and '<creator type="composer">Nobody</creator><creator type="arranger">Arranged by Meowsic</creator>' in x
    assert client.get(f'/api/items/{src["id"]}/musicxml').text == before  # the score itself is untouched
    assert any('of the words placed' in l['msg'] for l in j['log']) and j['stage'] == 3
