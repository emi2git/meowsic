"""Real job runners: music21 arrangements, the transcription runner (with a stand-in pipeline), cancel, upload.
The end-to-end transcription with the real models runs only with MEOWSIC_SLOW=1."""
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
from music21 import converter, harmony

from meowsic import arrange, runners

MUSICNOTE_DATA = Path.home() / 'Documents' / 'Emi Music Note'  # read-only: files are copied to tmp
MEMORY = MUSICNOTE_DATA / 'memory-from-cats-andrew-lloyd-webber' / 'memory-from-cats-andrew-lloyd-webber.musicxml'


def wait(client, jid, statuses=('done', 'failed', 'cancelled'), t=60):
    end = time.time() + t
    while time.time() < end:
        j = client.get(f'/api/jobs/{jid}').json()
        if j['status'] in statuses: return j
        time.sleep(0.05)
    raise AssertionError(f'job still {j["status"]}: {j["log"]}')


@pytest.fixture(scope='module')
def small_xml(tmp_path_factory):
    """The first 12 bars of Memory (lead sheet with chord symbols)."""
    if not MEMORY.is_file(): pytest.skip('Emi Music Note sample score is not on this Mac')
    d = tmp_path_factory.mktemp('src')
    shutil.copyfile(MEMORY, d / 'full.musicxml')
    sc = converter.parse(str(d / 'full.musicxml')).measures(1, 12)
    sc.write('musicxml', fp=str(d / 'memory.musicxml'))
    return d / 'memory.musicxml'


@pytest.fixture
def no_pdf(monkeypatch):
    monkeypatch.setenv('MEOWSIC_PDF', '0')


def notes(part):
    return [n for n in part.stripTies().flatten().notes if not isinstance(n, harmony.ChordSymbol)]


def full_bars(sc):
    return all(abs(m.duration.quarterLength - m.barDuration.quarterLength) < 1e-6
               for p in sc.parts for m in p.getElementsByClass('Measure'))


@pytest.mark.parametrize('version,parts', [('lead', 1), ('vocal', 3), ('accomp', 2), ('pro', 2), ('duet', 3)])
def test_arrange_each_version_parses_back(small_xml, tmp_path, version, parts):
    sc = arrange.arrange(small_xml, version, title='Memory')
    xml, mid = tmp_path / 'x.musicxml', tmp_path / 'x.mid'
    arrange.write_files(sc, xml, mid)
    back = converter.parse(str(xml))
    assert len(back.parts) == parts
    assert all(len(p.getElementsByClass('Measure')) == 12 for p in back.parts)
    assert full_bars(back)
    assert back.flatten().notes
    assert mid.stat().st_size > 100 and converter.parse(str(mid)).flatten().notes
    assert back.flatten().getElementsByClass(harmony.ChordSymbol)  # chord names over the top staff


def test_arrange_rules(small_xml):
    t = arrange.read(small_xml)
    assert t.melody and t.chords
    mel = [p for _, _, p, _ in t.melody]
    duet = arrange.arrange(t, 'duet')
    primo = [n.pitch.midi for n in notes(duet.parts[0])]
    assert primo == [p + 12 for p in mel]  # primo = the tune an octave up
    pro = arrange.arrange(t, 'pro')
    assert any(len(n.pitches) > 1 for n in notes(pro.parts[0]))  # fuller right hand
    assert max(n.quarterLength for n in notes(pro.parts[1])) <= 0.5  # broken chords in eighths
    lead = arrange.arrange(t, 'lead')
    assert [n.pitch.midi for n in notes(lead.parts[0])] == mel


def test_guessed_chords_without_symbols(small_xml, tmp_path):
    sc = converter.parse(str(small_xml))
    for cs in list(sc.recurse().getElementsByClass(harmony.ChordSymbol)): cs.activeSite.remove(cs)
    sc.write('musicxml', fp=str(tmp_path / 'bare.musicxml'))
    t = arrange.read(tmp_path / 'bare.musicxml')
    assert t.chords
    assert full_bars(arrange.arrange(t, 'accomp'))


def score_item(client, xml, **kw):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Memory', 'artist': 'ALW', 'version': 'original',
                                           'tags': ['Original', 'Musicals'], 'key': 'Bb major', 'bpm': 76, 'groupId': 'g-src',
                                           'musicxmlText': Path(xml).read_text(), **kw}).json()


def test_version_job_makes_items(client, data, small_xml, no_pdf):
    src = score_item(client, small_xml)
    outs = ['clear', 'lead', 'duet', 'accomp', 'pro', 'vocal']
    j = client.post('/api/jobs', json={'kind': 'version', 'title': 'Memory', 'fromItemId': src['id'], 'outputs': outs,
                                       'source': 'From the score “Memory”'}).json()
    j = wait(client, j['id'])
    assert j['status'] == 'done', j['log']
    assert len(j['result']) == 6 and j['stage'] == 3 and j['progress'] == 1
    msgs = [x['msg'] for x in j['log']]
    assert 'Read the score — done' in msgs and 'Simple Piano — arranged' in msgs and msgs[-1].startswith('Done — added Simple Piano')
    for iid, v in zip(j['result'], outs):
        it = client.get(f'/api/items/{iid}').json()
        assert it['version'] == v and it['kind'] == 'score'
        assert set(it['tags']) == {arrange.VERSION_TAGS[v], 'Musicals'}
        assert it['groupId'] == 'g-src' and it['originAt'] >= j['startedAt'] and it['source'] == 'From the score “Memory”'
        assert it['artist'] == 'ALW' and it['key'] == 'Bb major' and it['bpm'] == 76
        assert it['folder'] == iid and it['musicxml'] == f'{iid}.musicxml' and it['midi'] == f'{iid}.mid'
        assert it['pdf'] is None
        d = data / 'items' / it['folder']
        assert converter.parse(str(d / it['musicxml'])).parts and (d / it['midi']).is_file()
        assert client.get(f'/api/items/{iid}/musicxml').status_code == 200
    tags = {t['name'] for t in client.get('/api/tags').json()}
    assert {'Simple Piano', 'Lead sheet', 'Piano duet', 'Piano accompaniment', 'Piano pro', 'Piano + vocals'} <= tags
    assert (data / 'work' / j['id'] / 'out').is_dir()


@pytest.mark.skipif(not Path(arrange.MSCORE).exists(), reason='MuseScore is not installed')
def test_version_job_draws_pdf(client, data, small_xml):
    src = score_item(client, small_xml, groupId=None)
    j = wait(client, client.post('/api/jobs', json={'gen': True, 'title': 'Memory', 'fromItemId': src['id'], 'outputs': ['lead', 'original']}).json()['id'])
    assert j['status'] == 'done', j['log']
    assert any('Original — cannot be made' in x['msg'] for x in j['log'])
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['pdf'] == f'{it["id"]}.pdf' and (data / 'items' / it['folder'] / it['pdf']).read_bytes()[:4] == b'%PDF'
    assert it['groupId'].startswith('g-') and set(it['tags']) == {'Lead sheet', 'Musicals'}


def test_version_job_needs_a_score(client, no_pdf):
    j = wait(client, client.post('/api/jobs', json={'gen': True, 'title': 'X', 'outputs': ['clear']}).json()['id'])
    assert j['status'] == 'failed' and 'fromItemId' in j['log'][-1]['msg']
    chord = client.post('/api/items', json={'kind': 'chords', 'title': 'C', 'text': '[C]x'}).json()
    j = wait(client, client.post('/api/jobs', json={'gen': True, 'title': 'X', 'fromItemId': chord['id'], 'outputs': ['clear']}).json()['id'])
    assert j['status'] == 'failed' and 'gone' in j['log'][-1]['msg']


# ---------- transcription runner with a stand-in pipeline ----------

FAKE = '''#!{py}
import json, os, shutil, sys, time
src, versions = sys.argv[3], json.loads(sys.argv[4])
root = os.environ['TRANSCRIBE_ROOT']
names = ["fetch", "separate", "piano notes", "vocal notes", "lyrics", "analyze", "score", "pdf"]
def emit(o): print("@@ " + json.dumps(o), flush=True)
with open(os.path.join(root, "calls.txt"), "a") as f: f.write(json.dumps([src, versions, os.environ.get("HF_HUB_CACHE")]) + "\\n")
for v in versions:
    for i in range(len(names)):
        emit({{"ev": "stages", "version": v, "stages": [{{"name": n, "status": "done" if k < i else "running" if k == i else "pending", "secs": 1.5}} for k, n in enumerate(names)]}})
        time.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
    if os.environ.get("FAKE_FAIL"):
        emit({{"ev": "error", "error": "the video is private"}}); sys.exit(1)
    d = os.path.join(root, "song", "versions", v)
    os.makedirs(d, exist_ok=True)
    shutil.copyfile({xml!r}, os.path.join(d, "score.musicxml"))
    open(os.path.join(d, "score.mid"), "wb").write(b"MThd")
    json.dump({{"key": "Bb major", "bpm": 76}}, open(os.path.join(d, "score.json"), "w"))
    emit({{"ev": "made", "version": v, "dir": os.path.join(root, "song"), "has_vocals": False}})
'''


@pytest.fixture
def fake_pipeline(tmp_path, small_xml, monkeypatch):
    root = tmp_path / 'emi-music-note'
    (root / '.venv' / 'bin').mkdir(parents=True)
    py = root / '.venv' / 'bin' / 'python'
    py.write_text(FAKE.format(py=sys.executable, xml=str(small_xml)))
    py.chmod(py.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(runners, 'MUSICNOTE', root)
    return root


def test_link_of():
    assert runners.link_of({'source': 'YouTube · youtube.com/watch?v=abc'}, {}) == 'https://youtube.com/watch?v=abc'
    assert runners.link_of({'source': 'x'}, {'url': 'https://youtu.be/xyz'}) == 'https://youtu.be/xyz'
    assert runners.link_of({'source': 'Facebook · https://www.facebook.com/watch/?v=1'}, {}) == 'https://www.facebook.com/watch/?v=1'
    assert runners.link_of({'source': 'Audio file · a.mp3'}, {}) is None


def test_transcribe_job_with_stand_in_pipeline(client, data, fake_pipeline, no_pdf):
    j = client.post('/api/jobs', json={'title': 'Memory', 'source': 'YouTube · youtu.be/abc', 'outputs': ['original', 'clear', 'lead'],
                                       'tags': ['Musicals']}).json()
    j = wait(client, j['id'])
    assert j['status'] == 'done', j['log']
    assert j['stage'] == 6 and len(j['result']) == 3
    msgs = [x['msg'] for x in j['log']]
    for s in runners.STAGES[:5]: assert any(m.startswith(s + ' — done') for m in msgs), (s, msgs)
    assert 'Simple Piano — arranged' in msgs
    calls = [json.loads(x) for x in (data / 'work' / j['id'] / 'calls.txt').read_text().splitlines()]
    assert calls[0][:2] == ['https://youtu.be/abc', ['original', 'lead']] and calls[0][2]  # models cache passed through
    items = [client.get(f'/api/items/{i}').json() for i in j['result']]
    assert [i['version'] for i in items] == ['original', 'clear', 'lead']
    assert [set(i['tags']) for i in items] == [{'Original', 'Musicals'}, {'Simple Piano', 'Musicals'}, {'Lead sheet', 'Musicals'}]
    assert len({i['groupId'] for i in items}) == 1 and all(i['source'] == 'YouTube' and i['sourceUrl'] == 'https://youtu.be/abc' for i in items)
    assert all(i['key'] == 'Bb major' and i['bpm'] == 76 and i['originAt'] for i in items)
    for i in items:
        d = data / 'items' / i['folder']
        assert sorted(p.name for p in d.iterdir()) == [f'{i["folder"]}.mid', f'{i["folder"]}.musicxml']


def test_transcribe_failure_and_missing_source(client, fake_pipeline, no_pdf, monkeypatch):
    monkeypatch.setenv('FAKE_FAIL', '1')
    j = wait(client, client.post('/api/jobs', json={'title': 'X', 'url': 'https://youtu.be/abc', 'outputs': ['vocal']}).json()['id'])
    assert j['status'] == 'failed' and j['log'][-1]['msg'] == 'Failed: the video is private'
    j = wait(client, client.post('/api/jobs', json={'title': 'X', 'source': 'nowhere'}).json()['id'])
    assert j['status'] == 'failed' and 'No YouTube' in j['log'][-1]['msg']


def test_cancel_stops_the_pipeline(client, data, fake_pipeline, no_pdf, monkeypatch):
    monkeypatch.setenv('FAKE_SLEEP', '30')
    jid = client.post('/api/jobs', json={'title': 'X', 'url': 'https://youtu.be/abc', 'outputs': ['original']}).json()['id']
    end = time.time() + 10
    while not (data / 'work' / jid / 'calls.txt').exists() and time.time() < end: time.sleep(0.05)
    time.sleep(0.3)
    assert client.post(f'/api/jobs/{jid}/cancel').json()['status'] == 'cancelled'
    end = time.time() + 5
    while time.time() < end:
        r = subprocess.run(['pgrep', '-f', str(fake_pipeline)], capture_output=True, text=True)
        if not r.stdout.strip(): break
        time.sleep(0.1)
    assert not r.stdout.strip(), 'the pipeline is still running'
    time.sleep(0.3)
    j = client.get(f'/api/jobs/{jid}').json()
    assert j['status'] == 'cancelled' and j['result'] is None
    assert not client.get('/api/items?kind=score').json()


def test_upload_job(client, data, fake_pipeline, no_pdf):
    r = client.post('/api/jobs/upload', files={'file': ('My Song.mp3', b'ID3fake-audio', 'audio/mpeg')},
                    data={'outputs': '["lead"]', 'artist': 'Me'})
    assert r.status_code == 201
    j = r.json()
    assert j['title'] == 'My Song' and j['source'] == 'Audio file · My Song.mp3' and j['outputs'] == ['lead']
    up = data / 'work' / j['id'] / 'upload' / 'My Song.mp3'
    assert up.read_bytes() == b'ID3fake-audio'
    j = wait(client, j['id'])
    assert j['status'] == 'done', j['log']
    assert json.loads((data / 'work' / j['id'] / 'calls.txt').read_text().splitlines()[0])[0] == str(up)
    it = client.get(f'/api/items/{j["result"][0]}').json()
    assert it['artist'] == 'Me' and it['tags'] == ['Lead sheet'] and it['source'] == 'Audio file · My Song.mp3'
    assert client.post('/api/jobs/upload', files={'file': ('e.mp3', b'', 'audio/mpeg')}).status_code == 400


# ---------- the real thing (slow: separation, transcription, lyrics, MuseScore) ----------

@pytest.mark.skipif(os.environ.get('MEOWSIC_SLOW') != '1', reason='set MEOWSIC_SLOW=1 to run the real transcription')
def test_real_transcription_end_to_end(client, data, tmp_path):
    wavs = sorted(MUSICNOTE_DATA.glob(os.environ.get('MEOWSIC_SLOW_SONG', 'dem-mau*') + '/source.wav'))
    if not wavs or not runners.MUSICNOTE.is_dir(): pytest.skip('no Emi Music Note recording on this Mac')
    clip = tmp_path / 'clip.wav'  # a 20 s copy; the original stays untouched
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '30', '-t', '20', '-i', str(wavs[0]), str(clip)], check=True)
    t0 = time.time()
    with clip.open('rb') as f:
        j = client.post('/api/jobs/upload', files={'file': ('clip.wav', f, 'audio/wav')},
                        data={'title': 'Clip', 'outputs': 'vocal,clear'}).json()
    j = wait(client, j['id'], t=1800)
    secs = time.time() - t0
    print(f'\nreal transcription: {secs:.1f} s')
    for x in j['log']: print('  ', x['msg'])
    assert j['status'] == 'done', j['log']
    items = [client.get(f'/api/items/{i}').json() for i in j['result']]
    assert [i['version'] for i in items] == ['vocal', 'clear']
    for i in items:
        d = data / 'items' / i['folder']
        assert converter.parse(str(d / i['musicxml'])).parts
        assert (d / i['midi']).is_file() and (d / i['pdf']).is_file()
    assert not (MUSICNOTE_DATA / 'clip').exists()
