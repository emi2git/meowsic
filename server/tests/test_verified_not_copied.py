"""Verified is the user's own mark on one item: no path that makes a new version / copy from an item carries it
(db.carried_tags); the item's other tags still do."""
import json
import stat
import sys
from fractions import Fraction as Fr

from meowsic import lyricsfit as lf
from meowsic import runners
from meowsic.db import NEVER_COPIED_TAGS, carried_tags
from test_addversion import PRO, SRC
from test_editsafe import opened, ref_of
from test_lyricsfit import PNG, made_up_words, piano_xml, sheet_xml, transpose, tune, wait
from test_smooth import n, score as smooth_score
from test_staffmove import LH, RH, score as piano_score

V = 'Verified'
TAGS = ['Kids', V, 'Folk']


def made(client, iid):
    return client.get(f'/api/items/{iid}').json()


def carried(it, *extra):
    assert V not in it['tags'], it['tags']
    assert {'Kids', 'Folk', *extra} <= set(it['tags']), it['tags']


def test_helper():
    assert V in NEVER_COPIED_TAGS
    assert carried_tags(['A', V, 'B', 'C'], ('C',)) == ['A', 'B'] and carried_tags(None) == []


def test_from_item_id(client):
    src = client.post('/api/items', json={'kind': 'score', 'title': 'A', 'tags': TAGS, 'musicxmlText': SRC}).json()
    new = client.post('/api/items', json={'fromItemId': src['id'], 'version': 'pro', 'musicxmlText': PRO}).json()
    carried(new)
    assert V in made(client, src['id'])['tags']  # the source keeps its mark


def _piano(client):
    return client.post('/api/items', json={'kind': 'score', 'title': 'Ode', 'musicxmlText': piano_score(RH, LH), 'tags': TAGS}).json()


def test_editnotes_new(client):
    src = _piano(client)
    p0 = client.post(f'/api/items/{src["id"]}/editnotes/preview', json={}).json()
    lh = [x['ref'] for x in p0['notes'] if x['staff'] == 2]
    j = client.post(f'/api/items/{src["id"]}/editnotes', json={'ops': [{'refs': lh, 'to': 1}], 'mode': 'new'}).json()
    carried(j['item'])
    assert V in made(client, src['id'])['tags']


def test_editsafe_my_edits_copy(client):
    src = _piano(client)
    i = src['id']
    p0 = opened(client, i)
    user = [{'op': 'pitch', 'refs': [ref_of(p0['notes'], 0, 74)], 'by': -2}, {'op': 'pitch', 'refs': [ref_of(p0['notes'], 1, 77)], 'by': 1}]
    a = opened(client, i)
    assert client.post(f'/api/items/{i}/editnotes', json={'ops': [{'op': 'pitch', 'refs': [ref_of(a['notes'], 0, 74)], 'by': 1}],
                                                         'mode': 'this', 'sha': a['sha']}).status_code == 200
    j = client.post(f'/api/items/{i}/editnotes', json={'ops': user, 'mode': 'this', 'sha': p0['sha']}).json()
    cp = j['copy']
    assert cp['title'] == 'Ode (my edits)'
    carried(made(client, cp['id']))
    assert V in made(client, i)['tags']


def test_simple_piano_new(client):
    from test_simplepiano import staccato
    x = smooth_score([[staccato(n('C5', Fr(7, 2))), n('D5', Fr(1, 2))], [n('E5', Fr(15, 4)), n('R', Fr(1, 4))]], [[n('C3', 4, 2)], [n('G2', 4, 2)]])
    src = client.post('/api/items', json={'kind': 'score', 'title': 'H', 'musicxmlText': x, 'tags': TAGS, 'sourceUrl': 'https://youtu.be/x',
                                          'source': 'YouTube · youtu.be/x'}).json()
    j = client.post(f'/api/items/{src["id"]}/simplepiano', json={'level': 100, 'mode': 'new'}).json()
    carried(j['item'], 'Simple piano')


def test_lyrics_by_hand_new(client):
    from test_lyricsedit import WORDS, score_xml
    src = client.post('/api/items', json={'kind': 'score', 'title': 'T', 'musicxmlText': score_xml(), 'tags': TAGS}).json()
    refs = [x['ref'] for x in client.get(f'/api/items/{src["id"]}/lyrics').json()['notes']]
    j = client.post(f'/api/items/{src["id"]}/lyrics', json={'mode': 'new', 'notes': [{'ref': r, 'text': t, 'syllabic': s}
                                                                                     for r, (t, s) in zip(refs, WORDS)]}).json()
    carried(j['item'], 'Lyrics added')


def test_lyrics_from_sheet_job(client, tmp_path, monkeypatch):
    monkeypatch.setenv('MEOWSIC_PDF', '0')
    bars = tune(8)
    f = tmp_path / 'sheet.musicxml'
    f.write_text(sheet_xml(bars, made_up_words(bars)))
    monkeypatch.setattr(lf, 'read_sheet', lambda cfg, sheet, ev=None, cancelled=None: f)
    src = client.post('/api/items', json={'kind': 'score', 'title': 'M', 'tags': TAGS, 'musicxmlText': piano_xml(transpose(bars, 2), intro=1)}).json()
    sh = client.post('/api/sheets', files=[('files', ('p1.png', PNG, 'image/png'))], data={'title': 'M'}).json()['item']
    j = wait(client, client.post('/api/jobs', json={'kind': 'lyrics', 'title': 'M', 'fromItemId': src['id'], 'sheetId': sh['id'],
                                                    'outputs': ['original']}).json()['id'])
    assert j['status'] == 'done', j['log']
    carried(made(client, j['result'][0]), lf.TAG)


def test_version_job_arrangements(client, monkeypatch):
    """Make a version (job kind 'version': clear / easy / pro / … arrangements, also with tags passed in)."""
    monkeypatch.setenv('MEOWSIC_PDF', '0')
    bars = [[n('C5', 2), n('E5', 2)], [n('G5', 4)]]
    x = smooth_score(bars, [[n('C3', 4, 2)], [n('G2', 4, 2)]])
    src = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': x, 'tags': TAGS}).json()
    for extra in ({}, {'tags': TAGS}):
        j = wait(client, client.post('/api/jobs', json={'kind': 'version', 'title': 'S', 'fromItemId': src['id'],
                                                        'outputs': ['clear', 'pro'], **extra}).json()['id'], t=120)
        assert j['status'] == 'done', j['log']
        for iid in j['result']: carried(made(client, iid))


FAKE_OMR = '''#!{py}
import json, shutil, sys
out = sys.argv[sys.argv.index("--out") + 1]
import os; os.makedirs(out, exist_ok=True)
shutil.copyfile({xml!r}, os.path.join(out, "score.musicxml"))
print(json.dumps({{"step": "done", "progress": 1, "report": {{}}}}))
'''


def test_omr_sheet_to_score(client, tmp_path, monkeypatch):
    from meowsic import inkclean, trim
    xml = tmp_path / 'read.musicxml'
    xml.write_text(SRC)
    root = tmp_path / 'omr'
    (root / '.venv' / 'bin').mkdir(parents=True)
    py = root / '.venv' / 'bin' / 'python'
    py.write_text(FAKE_OMR.format(py=sys.executable, xml=str(xml)))
    py.chmod(py.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(runners, 'OMR_DIR', root)
    monkeypatch.setattr(trim, 'analyze', lambda p: {'trim': None})
    monkeypatch.setattr(inkclean, 'prepare_page', lambda src, work, k, box=None: (src, {}))
    sh = client.post('/api/sheets', files=[('files', ('p1.png', PNG, 'image/png'))], data={'title': 'O', 'tags': json.dumps(TAGS)}).json()['item']
    assert V in made(client, sh['id'])['tags']
    j = wait(client, client.post('/api/jobs', json={'kind': 'omr', 'title': 'O', 'fromItemId': sh['id'], 'outputs': ['original']}).json()['id'])
    assert j['status'] == 'done', j['log']
    carried(made(client, j['result'][0]), 'From a sheet')
