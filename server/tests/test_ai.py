"""AI tag suggestions with the LLM mocked; one real-model test runs only with MEOWSIC_SLOW=1."""
import json
import os
import re
import sqlite3
import time

import pytest

from meowsic import ai
from meowsic.db import Config, connect, init_db


def add(client, title, artist='', tags=(), kind='chords'):
    return client.post('/api/items', json={'kind': kind, 'title': title, 'artist': artist, 'text': 'x', 'tags': list(tags)}).json()['id']


def songs_of(prompt):
    """{number: title} from a collections / autotag prompt."""
    part = prompt.split('Songs:\n')[-1] if 'Songs:\n' in prompt else prompt
    return {int(m[1]): m[2].split(' | ')[0].strip().strip('"') for m in re.finditer(r'^(\d+)\. (.+)$', part, re.M)}


KNOWN = {'Let It Go': {'w': 'Frozen', 's': 'Idina Menzel', 'c': 'Kristen Anderson-Lopez & Robert Lopez'},
         'Into The Unknown': {'w': 'Frozen (2019 film)', 's': 'Idina Menzel'},
         'Memory': {'w': 'Cats', 'c': 'Andrew Lloyd Webber'},
         'The Phantom Of The Opera': {'w': 'The Phantom of the Opera', 'c': 'Andrew Lloyd Webber'},
         'Silent Night': {'w': 'Christmas', 'o': 'Christmas', 'l': 'English'},
         'Cong Chua Bong Bong': {'l': 'vietnamese'}}


def fake_llm(calls):
    def complete(prompts, max_tokens=0):
        out = []
        for p in prompts:
            calls.append(p)
            if 'Tag list' in p:  # auto-tag: one item about Frozen, plus one tag that is not in the list
                reply = {str(n): {'add': ['frozen', 'Disney', 'Made Up'] if 'Let It Go' in t else [], 'why': 'Frozen song'}
                         for n, t in songs_of(p).items()}
            else:
                asked = set(re.findall(r'^  "(\w)":', p, re.M)) - {'t'}
                reply = {str(n): {'t': t, **{k: v for k, v in KNOWN.get(t, {}).items() if k in asked}} for n, t in songs_of(p).items()}
                reply['99'] = {'t': 'Ghost', 'w': 'Frozen'}  # a number that was never asked about
            out.append('```json\n' + json.dumps(reply) + '\n```')
        return out
    return complete


@pytest.fixture
def llm(monkeypatch):
    calls = []
    monkeypatch.setattr(ai, 'complete_many', fake_llm(calls))
    return calls


def test_language_by_script():
    assert ai.script_language('Má Hồng Đà Lạt') == 'Vietnamese'
    assert ai.script_language('童话') == 'Chinese'
    assert ai.script_language('となりのトトロ') == 'Japanese'
    assert ai.script_language('아리랑') == 'Korean'
    assert ai.script_language('Катюша') == 'Russian'
    assert ai.script_language('Für Elise') is None and ai.script_language('Let It Go') is None


def test_parse_json_and_norm():
    assert ai.parse_json('Sure!\n```json\n{"1": {"w": "Frozen"}}\n```') == {'1': {'w': 'Frozen'}}
    assert ai.parse_json('{"1": {"w": "A"}, "2": {"w": "B"}, "3": {"w": "C') == {'1': {'w': 'A'}, '2': {'w': 'B'}}  # cut off
    assert ai.parse_json('no json') == {}
    assert ai.norm('Les Misérables (musical)') == ai.norm('les miserables') == ai.norm('The Les Miserables')
    assert ai.norm('Trịnh Công Sơn') == 'trinh cong son'


def test_copied_runs():
    reply = {str(n): {'t': 'x', 's': 'Đinh Hiếu'} for n in range(3, 8)} | {'1': {'s': 'Adele'}, '9': {'s': 'Adele'}}
    assert ai.copied_runs(reply, 's') == {3, 4, 5, 6, 7}
    assert ai.copied_runs({'1': {'s': 'A'}, '2': {'s': 'A'}}, 's') == set()


def test_collections_job(client, llm):
    ids = {t: add(client, t, a) for t, a in [('Let It Go', ''), ('Into The Unknown', ''), ('Let It Go (C)', ''), ('Memory', ''),
                                             ('The Phantom Of The Opera', ''), ('Silent Night', ''), ('Má Hồng Đà Lạt', ''),
                                             ('Bèo Dạt Mây Trôi', ''), ('Cong Chua Bong Bong', ''), ('Ghost', '')]}
    client.post('/api/tags', json={'name': 'Phantom of the opera'})
    client.post('/api/printed', json={'ids': [ids['Memory'], ids['Ghost']]})
    j = client.post('/api/ai/collections', json={'scope': 'all'})
    assert j.status_code == 201 and j.json()['kind'] == 'tags'
    end = time.time() + 5
    while (job := client.get(f'/api/jobs/{j.json()["id"]}').json())['status'] in ('queued', 'running') and time.time() < end:
        time.sleep(0.02)
    assert job['status'] == 'done', job['log']
    assert any('Asking about' in x['msg'] for x in job['log']) and job['progress'] == 1
    g = {x['name']: x for x in job['result']['groups']}
    assert set(g['Frozen']['ids']) == {ids['Let It Go'], ids['Into The Unknown'], ids['Let It Go (C)']}  # 2019 film == Frozen; "(C)" twin
    assert ids['Ghost'] not in g['Frozen']['ids']  # hallucinated number dropped
    assert g['Frozen']['look'] == 'work' and g['Cats']['ids'] == [ids['Memory']]  # works may have one song
    assert g['Phantom of the opera']['existing'] and not g['Frozen']['existing']
    assert set(g['Andrew Lloyd Webber']['ids']) == {ids['Memory'], ids['The Phantom Of The Opera']}
    assert len(g['Idina Menzel']['ids']) == 3
    assert g['Christmas']['look'] == 'occasion'  # "Christmas" as a work is moved to occasion
    assert set(g['Vietnamese']['ids']) == {ids['Má Hồng Đà Lạt'], ids['Bèo Dạt Mây Trôi'], ids['Cong Chua Bong Bong']}
    assert g['Printed']['ids'] and len(g['Never printed']['ids']) == 8
    # the model is asked once per distinct title, and only about titles without a script language for 'l'
    asked = [t for p in llm for t in songs_of(p).values()]
    assert asked.count('Let It Go') + asked.count('Let It Go (C)') == 2  # one per prompt family


def test_collections_scope_look_and_wait(client, llm):
    add(client, 'Let It Go')
    s = add(client, 'Memory', kind='sheet')
    add(client, 'Into The Unknown', tags=['Disney'])
    r = client.post('/api/ai/collections', json={'scope': 'untagged', 'look': ['work'], 'wait': True}).json()
    assert {x['name'] for x in r['groups']} == {'Frozen', 'Cats'} and client.get(f'/api/jobs/{r["job"]}').json()['status'] == 'done'
    r = client.post('/api/ai/collections', json={'scope': 'sheet', 'look': ['work', 'printed'], 'wait': True}).json()
    assert [(x['name'], x['ids']) for x in r['groups']] == [('Cats', [s])]  # Never printed needs 2 songs
    assert client.post('/api/ai/collections', json={'scope': 'nope'}).status_code == 400
    assert client.post('/api/ai/collections', json={'look': ['mood']}).status_code == 400
    n = len(llm)
    client.post('/api/ai/collections', json={'look': ['language', 'printed'], 'wait': True})
    assert len(llm) == n + 1  # language only: one prompt family


def test_autotag(client, llm):
    for t in ('Frozen', 'Disney', 'Christmas'): client.post('/api/tags', json={'name': t})
    a = add(client, 'Let It Go', tags=['Disney'])
    b = add(client, 'Memory', tags=['Never printed'])
    client.post('/api/printed', json={'ids': [b]})
    before = client.get('/api/items').json()
    r = client.post('/api/ai/autotag', json={'ids': [a, b], 'wait': True})
    assert r.status_code == 201
    s = {x['id']: x for x in r.json()['suggestions']}
    assert s[a]['add'] == ['Frozen', 'Never printed'] and 'Frozen' in s[a]['why']  # Disney already there, "Made Up" not in the list
    assert s[b] == {'id': b, 'add': ['Printed'], 'remove': ['Never printed'], 'why': 'printed before'}
    assert client.get('/api/items').json() == before  # nothing saved
    assert 'Frozen' in llm[-1] and 'Never printed' not in llm[-1].split('Tag list')[1].split('\n')[1]
    assert client.post('/api/ai/autotag', json={'ids': []}).status_code == 400
    j = client.post('/api/ai/autotag', json={'ids': [a]}).json()
    assert j['kind'] == 'tags' and j['status'] in ('queued', 'running', 'done')


def test_autotag_uses_page_text(client, llm, monkeypatch):
    calls = []
    monkeypatch.setattr(ai, 'vision_ocr', lambda p: calls.append(p) or 'Let It Go from Disney\'s Frozen')
    client.post('/api/tags', json={'name': 'Frozen'})
    files = {'files': ('a.png', b'\x89PNG fake', 'image/png')}
    it = client.post('/api/sheets', files=files, data={'title': 'Song 1'}).json()['item']
    r = client.post('/api/ai/autotag', json={'ids': [it['id']], 'wait': True}).json()
    assert calls and 'page text: Let It Go' in llm[-1]
    assert client.post('/api/ai/autotag', json={'ids': [it['id']], 'wait': True}).json() == {**r, 'job': client.get('/api/jobs').json()[0]['id']}
    assert len(calls) == 1  # OCR kept in sheet_page.ocr_text, not run again


def test_failing_model_fails_the_job(client, monkeypatch):
    def boom(prompts, max_tokens=0): raise ai.ModelMissing('No local model found')
    monkeypatch.setattr(ai, 'complete_many', boom)
    add(client, 'Let It Go')
    r = client.post('/api/ai/collections', json={'look': ['work'], 'wait': True})
    assert r.status_code == 500 and 'No local model' in r.json()['detail']


def test_job_table_gets_tags_kind(tmp_path):
    """An old db (job kind CHECK without 'tags') is rebuilt with its rows kept."""
    d = tmp_path / 'old'
    d.mkdir()
    c = sqlite3.connect(d / 'meowsic.db')
    c.execute("""CREATE TABLE job (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('transcribe','version')), title TEXT NOT NULL,
                 source TEXT NOT NULL DEFAULT '', outputs TEXT NOT NULL, status TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0,
                 progress REAL NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '[]', result TEXT, started_at INTEGER NOT NULL,
                 done_at INTEGER, dismissed INTEGER NOT NULL DEFAULT 0)""")
    c.execute("INSERT INTO job(id, kind, title, outputs, status, started_at) VALUES ('job-1','transcribe','Old','[]','done',1)")
    c.commit()
    c.close()
    cfg = Config(d)
    init_db(cfg)
    init_db(cfg)
    c = connect(cfg)
    assert c.execute('SELECT title, params FROM job').fetchall()[0][:] == ('Old', '{}')
    c.execute("INSERT INTO job(id, kind, title, outputs, status, started_at) VALUES ('job-2','tags','AI','[]','done',1)")
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO job(id, kind, title, outputs, status, started_at) VALUES ('job-3','nope','x','[]','done',1)")


def test_idle_unload(monkeypatch):
    llm = ai.LocalLLM(idle=0.05)
    llm.model = object()
    llm._arm()
    time.sleep(0.3)
    assert llm.model is None


@pytest.mark.skipif(os.environ.get('MEOWSIC_SLOW') != '1', reason='real model: set MEOWSIC_SLOW=1')
def test_real_model():
    try: ai.LLM.find()
    except ai.ModelMissing: pytest.skip('no local model')
    rows = [{'id': f'c-{n}', 'kind': 'chords', 'title': t, 'artist': '', 'version': '', 'printed': False, 'tags': [], 'page': ''}
            for n, t in enumerate(['Let It Go', 'Do You Want To Build A Snowman', 'For The First Time In Forever', 'Silent Night',
                                   'Jingle Bells', 'Bèo Dạt Mây Trôi', 'Memory', 'The Phantom Of The Opera', 'All I Ask Of You'])]
    t = time.time()
    g = {x['name']: x for x in ai.collections(rows, ['work', 'occasion', 'language'], ['Frozen', 'Christmas', 'Phantom of the opera'])}
    assert time.time() - t < 120
    assert len(g['Frozen']['ids']) >= 2 and g['Frozen']['existing']
    assert 'c-3' in g['Christmas']['ids'] and 'Vietnamese' not in g  # one song: no group
    s = ai.autotag(rows[:1], ['Frozen', 'Christmas', 'Rock'])
    assert 'Frozen' in s[0]['add'] and set(s[0]['add']) <= {'Frozen', 'Christmas', 'Rock', 'Never printed'}
