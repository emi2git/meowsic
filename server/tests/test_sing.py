"""Make it sing (beta): MusicXML -> notes / words / phonemes for the singing voice, the 'sing' job, the vocal endpoint."""
import json
import sqlite3
import sys
import time

from fastapi.testclient import TestClient

from meowsic import singscore
from meowsic.app import create_app

# 3/4 in G at 72 bpm: pickup "A-", then "-maz-ing" (with a melisma note), "grace" tied over the bar, a rest, "how"
XML = """<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
<part id="P1">
 <measure number="1">
  <attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
  <direction><direction-type><words>Slowly</words></direction-type><sound tempo="72"/></direction>
  <note><rest/><duration>4</duration></note>
  <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration>
   <lyric number="1"><syllabic>begin</syllabic><text>A</text></lyric></note>
 </measure>
 <measure number="2">
  <harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration>
   <lyric number="1"><syllabic>middle</syllabic><text>maz</text></lyric></note>
  <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration>
   <lyric number="1"><syllabic>end</syllabic><text>ing</text></lyric></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>
 </measure>
 <measure number="3">
  <harmony><root><root-step>D</root-step></root><kind>dominant</kind></harmony>
  <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><tie type="start"/>
   <lyric number="1"><syllabic>single</syllabic><text>grace!</text></lyric></note>
  <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note>
 </measure>
 <measure number="4">
  <note><rest/><duration>2</duration></note>
  <note><pitch><step>A</step><octave>4</octave><alter>0</alter></pitch><duration>2</duration>
   <lyric number="1"><syllabic>single</syllabic><text>how</text></lyric></note>
  <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration>
   <lyric number="1"><syllabic>single</syllabic><text>you’re</text></lyric></note>
 </measure>
</part></score-partwise>"""

DICT = {'amazing': ['AH0', 'M', 'EY1', 'Z', 'IH0', 'NG'], 'grace': ['G', 'R', 'EY1', 'S'], 'how': ['HH', 'AW1'],
        "you're": ['Y', 'UH1', 'R']}
g2p = DICT.__getitem__


def test_read_melody_ties_chords_tempo():
    s = singscore.read(XML)
    assert s['bpm'] == 72 and s['beats'] == 3 and s['qPerBar'] == 3 and s['endQ'] == 12
    n = s['notes']
    assert [(x['q'], x['d'], x['midi']) for x in n] == [
        (0, 2, 0), (2, 1, 62), (3, 2, 67), (5, 0.5, 71), (5.5, 0.5, 67), (6, 3, 71), (9, 1, 0), (10, 1, 69), (11, 1, 66)]
    assert [x['text'] for x in n if x['midi']] == ['A', 'maz', 'ing', '', 'grace!', 'how', 'you’re']
    assert [(c['q'], c['root'], c['pcs']) for c in s['chords']] == [(3, 7, [7, 11, 2]), (6, 2, [2, 6, 9, 0])]


def test_words_join_syllables_and_melisma():
    ws = singscore.words(singscore.read(XML)['notes'])
    assert [(w['word'], len(w['notes'])) for w in ws] == [('', 1), ('Amazing', 4), ('grace', 1), ('', 1), ('how', 1), ("you're", 1)]
    assert ws[1]['syllables'] == ['A', 'maz', 'ing'] and ws[1]['syl'] == [0, 1, 2, 2]  # the melisma note stays on "ing"


def test_split_syllables():
    assert singscore.split_syllables(DICT['amazing'], 3) == [['AH0'], ['M', 'EY1'], ['Z', 'IH0', 'NG']]
    assert singscore.split_syllables(['B', 'Y', 'UW1', 'T', 'AH0', 'F', 'AH0', 'L'], 3) == [['B', 'Y', 'UW1'], ['T', 'AH0'], ['F', 'AH0', 'L']]
    assert singscore.split_syllables(['K', 'AE1', 'T'], 2) is None  # vowels don't match: the caller sings the whole word


def test_soulx_meta_syllable_and_word_modes():
    s = singscore.read(XML)
    seg = {'start': 0, 'end': 12, 'words': singscore.words(s['notes'])}
    m = singscore.soulx_meta(seg, 72, g2p, tail_q=1)
    assert m['language'] == 'English' and m['time'] == [0, 10833]  # 12 beats + 1 beat tail at 72 bpm
    assert m['phoneme'].split() == ['<SP>', 'en_AH0', 'en_M-EY1', 'en_Z-IH0-NG', 'en_Z-IH0-NG', 'en_G-R-EY1-S', '<SP>', 'en_HH-AW1', 'en_Y-UH1-R', '<SP>']
    assert m['note_type'].split() == ['1', '2', '2', '2', '3', '2', '1', '2', '2', '1']
    assert m['note_pitch'].split() == ['0', '62', '67', '71', '67', '71', '0', '69', '66', '0']
    dur = [float(x) for x in m['duration'].split()]
    assert abs(sum(dur) - 13 * 60 / 72) < 0.01 and abs(dur[5] - 2.5) < 0.001  # tied "grace" = 3 beats
    w = singscore.soulx_meta(seg, 72, g2p, mode='word')
    assert w['phoneme'].split()[1:5] == ['en_AH0-M-EY1-Z-IH0-NG'] * 4 and w['note_type'].split()[1:5] == ['2', '3', '3', '3']


def test_segments_cover_the_song():
    s = singscore.read(XML)
    ws = singscore.words(s['notes'])
    segs = singscore.segments(ws, 72, min_s=3, max_s=6)
    assert segs[0]['start'] == 0 and segs[-1]['end'] == 12
    assert all(a['end'] == b['start'] for a, b in zip(segs, segs[1:]))
    assert sum(len(x['words']) for x in segs) == len(ws) and len(segs) >= 2


def test_has_lyrics():
    assert singscore.has_lyrics(XML)
    assert not singscore.has_lyrics(XML.replace('<lyric', '<x').replace('</lyric>', '</x>'))
    assert not singscore.has_lyrics('<not xml')


def test_song_bpm():
    assert singscore.song_bpm({'bpm': 90}, 72) == 90
    assert singscore.song_bpm({'bpm': None}, 72) == 72
    assert singscore.song_bpm({'bpm': None}) == 100


FAKE = """#!{py}
import json, sys, pathlib
a = sys.argv[2:]
out = pathlib.Path(a[a.index('--out') + 1]); out.mkdir(parents=True, exist_ok=True)
bpm = float(a[a.index('--bpm') + 1]) if '--bpm' in a else 100.0
print(json.dumps({{'stage': 0, 'progress': 0, 'msg': 'Reading the score'}}), flush=True)
print('a warning line from torch', flush=True)
print(json.dumps({{'stage': 2, 'progress': 0.5, 'msg': 'Phrase 1 of 2'}}), flush=True)
import time; (out / 'vocal.m4a').write_bytes(b'M4A' * 1000 + str(time.time_ns()).encode())  # each take differs
(out / 'vocal.wav').write_bytes(b'RIFF')
print(json.dumps({{'done': True, 'm4a': str(out / 'vocal.m4a'), 'wav': str(out / 'vocal.wav'), 'bpm': bpm,
                  'report': {{'within50cPct': 97.1, 'notes': 35, 'notesSilent': 0}}}}), flush=True)
"""


def wait(client, jid, t=10):
    end = time.time() + t
    while time.time() < end:
        j = client.get(f'/api/jobs/{jid}').json()
        if j['status'] in ('done', 'failed', 'cancelled'): return j
        time.sleep(0.05)
    raise AssertionError(f'job never finished: {j}')


def test_sing_job_saves_vocal_and_serves_it(client, data, tmp_path, monkeypatch):
    fake = tmp_path / 'fakepy'
    fake.write_text(FAKE.format(py=sys.executable))
    fake.chmod(0o755)
    monkeypatch.setenv('MEOWSIC_SING_PYTHON', str(fake))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Amazing Grace', 'bpm': 72, 'musicxmlText': XML}).json()
    assert it['vocalAudio'] is None
    assert client.get(f'/api/items/{it["id"]}/vocal').status_code == 404
    j = client.post('/api/jobs', json={'kind': 'sing', 'title': 'Amazing Grace', 'fromItemId': it['id']})
    assert j.status_code == 201 and j.json()['kind'] == 'sing'
    j = wait(client, j.json()['id'])
    assert j['status'] == 'done', j['log']
    assert j['result'] == [it['id']] and '97.1% of 35 notes' in j['log'][-1]['msg']
    assert any(x['msg'] == 'Phrase 1 of 2' for x in j['log'])
    got = client.get(f'/api/items/{it["id"]}').json()
    assert got['vocalAudio'] == f'{it["folder"]} vocal.m4a' and got['vocalBpm'] == 72
    assert (data / 'items' / it['folder'] / f'{it["folder"]} vocal.wav').is_file()
    r = client.get(f'/api/items/{it["id"]}/vocal')
    assert r.status_code == 200 and r.headers['content-type'] == 'audio/mp4' and len(r.content) > 3000
    r = client.get(f'/api/items/{it["id"]}/vocal', headers={'Range': 'bytes=0-9'})  # Safari seeks with ranges
    assert r.status_code == 206 and r.content == b'M4AM4AM4AM'
    # the field is the server's: a PATCH can't point it elsewhere
    assert client.patch(f'/api/items/{it["id"]}', json={'vocalAudio': '../x', 'title': 'AG'}).json()['vocalAudio'] == got['vocalAudio']


def test_sing_needs_lyrics(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'No words',
                                         'musicxmlText': XML.replace('<lyric', '<x').replace('</lyric>', '</x>')}).json()
    r = client.post('/api/jobs', json={'kind': 'sing', 'title': 'x', 'fromItemId': it['id']})
    assert r.status_code == 400 and 'lyrics' in r.json()['detail']
    assert client.post(f'/api/items/{it["id"]}/sing').status_code == 400


def test_sing_failure_is_reported(client, tmp_path, monkeypatch):
    fake = tmp_path / 'badpy'
    fake.write_text(f'#!{sys.executable}\nimport sys\nprint("RuntimeError: MPS out of memory", flush=True)\nsys.exit(1)\n')
    fake.chmod(0o755)
    monkeypatch.setenv('MEOWSIC_SING_PYTHON', str(fake))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'AG', 'musicxmlText': XML}).json()
    j = wait(client, client.post(f'/api/items/{it["id"]}/sing').json()['id'])
    assert j['status'] == 'failed' and 'MPS out of memory' in j['log'][-1]['msg']
    assert client.get(f'/api/items/{it["id"]}').json()['vocalAudio'] is None


def test_vocal_columns_and_sing_kind_migrate(tmp_path):
    """An older db (no vocal columns, job kinds without 'sing') gets both, rows kept."""
    d = tmp_path / 'M'
    d.mkdir()
    with TestClient(create_app(d, background=False)) as c:
        c.post('/api/items', json={'kind': 'score', 'title': 'Old'})
        c.post('/api/jobs', json={'gen': True, 'title': 'Old job', 'outputs': ['easy']})
    db = sqlite3.connect(d / 'meowsic.db')
    db.execute('ALTER TABLE score DROP COLUMN vocal_audio')
    db.execute('ALTER TABLE score DROP COLUMN vocal_bpm')
    sql = db.execute("SELECT sql FROM sqlite_master WHERE name='job'").fetchone()[0]
    cols = ','.join(r[1] for r in db.execute('PRAGMA table_info(job)'))
    old = sql.replace(",'sing'", '')
    db.executescript(f'ALTER TABLE job RENAME TO j0; {old}; INSERT INTO job({cols}) SELECT {cols} FROM j0; DROP TABLE j0;')
    db.commit()
    assert "'sing'" not in db.execute("SELECT sql FROM sqlite_master WHERE name='job'").fetchone()[0]
    db.close()
    with TestClient(create_app(d, background=False)) as c:
        assert [x['vocalAudio'] for x in c.get('/api/items').json()] == [None]
        assert [j['title'] for j in c.get('/api/jobs').json()] == ['Old job']
    db = sqlite3.connect(d / 'meowsic.db')
    sql = db.execute("SELECT sql FROM sqlite_master WHERE name='job'").fetchone()[0]
    assert all(f"'{k}'" in sql for k in ('transcribe', 'version', 'tags', 'omr', 'lyrics', 'sing'))


def test_sing_undo_from_activities(client, data, tmp_path, monkeypatch):
    """A finished sing job logs an undoable Activities row: Undo = the earlier take (or none); takes stay in .history/."""
    fake = tmp_path / 'fakepy'
    fake.write_text(FAKE.format(py=sys.executable))
    fake.chmod(0o755)
    monkeypatch.setenv('MEOWSIC_SING_PYTHON', str(fake))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Amazing Grace', 'bpm': 72, 'musicxmlText': XML}).json()
    d = data / 'items' / it['folder']
    assert wait(client, client.post(f'/api/items/{it["id"]}/sing').json()['id'])['status'] == 'done'
    assert wait(client, client.post(f'/api/items/{it["id"]}/sing').json()['id'])['status'] == 'done'  # a second take
    acts = client.get('/api/activity').json()
    rows = [a for a in acts if a['type'] == 'sing' and a['id'].startswith('act-')]
    assert len(rows) == 2 and all(a['action'] == 'undo' for a in rows) and 'earlier sung take' in rows[0]['undoText'][0]
    jobs = [a for a in acts if a['id'].startswith('job-') and a['type'] == 'sing']
    assert jobs and all(a['action'] is None and 'Made' in a['noUndo'] for a in jobs)
    assert len(list((d / '.history').glob('vocal-*vocal.m4a'))) == 1  # the first take, kept when the second replaced it
    # the older row first: refused, the score was sung again since
    r = client.post(f'/api/activity/{rows[1]["id"]}/undo')
    assert r.status_code == 409 and r.json()['detail']['reason'] == 'conflict'
    r = client.post(f'/api/activity/{rows[0]["id"]}/undo').json()
    assert r['ok'] and r['changed'] == 1
    got = client.get(f'/api/items/{it["id"]}').json()
    assert got['vocalAudio'] == f'{it["folder"]} vocal.m4a' and (d / got['vocalAudio']).is_file()  # back to take 1
    r = client.post(f'/api/activity/{rows[1]["id"]}/undo').json()
    assert r['ok'] and client.get(f'/api/items/{it["id"]}').json()['vocalAudio'] is None
    assert client.get(f'/api/items/{it["id"]}/vocal').status_code == 404
    assert len(list((d / '.history').glob('vocal-*vocal.m4a'))) >= 2  # every take is still there
    assert all(a['undoneAt'] for a in client.get('/api/activity').json() if a['type'] == 'sing' and a['id'].startswith('act-'))
