"""Activities: rows carry rollback info; POST /api/activity/{id}/undo rolls back through the normal code paths."""
import json
import sqlite3
import threading
import time

from test_booksplit import colors, make_book
from test_pages import color_of, make
from test_trim import make as make_white, page, trim


def acts(client):
    return client.get('/api/activity').json()


def last(client, type_):
    return next(a for a in acts(client) if a['type'] == type_)


def undo(client, aid, **body):
    return client.post(f'/api/activity/{aid}/undo', json=body)


def item(client, i):
    return client.get(f'/api/items/{i}').json()


def test_rename_undo_and_refusals(client):
    it = client.post('/api/items', json={'kind': 'chords', 'title': 'Memry', 'artist': 'ALW', 'text': 'x'}).json()
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory', 'artist': 'Andrew Lloyd Webber'})
    a = last(client, 'edit')
    assert a['action'] == 'undo' and a['title'] == 'Memory' and 'was “Memry”' in a['detail'] and a['undoText']
    r = undo(client, a['id']).json()
    assert r['ok'] and r['changed'] == 1
    assert (item(client, it['id'])['title'], item(client, it['id'])['artist']) == ('Memry', 'ALW')
    a = next(x for x in acts(client) if x['id'] == a['id'])
    assert a['undoneAt'] and a['action'] is None and a['undoneBy']  # the row is kept, marked rolled back
    rb = last(client, 'rollback')
    assert rb['title'] == 'Rolled back: Memory' and rb['undoOf'] == a['id'] and rb['action'] is None
    # already undone
    r = undo(client, a['id'])
    assert r.status_code == 409 and r.json()['detail']['reason'] == 'done'
    # a later edit of the same field: refuse, force is offered (and works)
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory (Cats)'})
    a2 = last(client, 'edit')
    time.sleep(3.1)  # (edits within 3 s share a row)
    client.patch(f'/api/items/{it["id"]}', json={'title': 'Memory from Cats'})
    r = undo(client, a2['id'])
    assert r.status_code == 409 and r.json()['detail']['reason'] == 'conflict' and r.json()['detail']['canForce']
    assert undo(client, a2['id'], force=True).json()['ok']
    assert item(client, it['id'])['title'] == 'Memry'
    # not undoable / unknown
    assert undo(client, 'act-nothere').status_code == 404
    client.post('/api/activity', json={'type': 'print', 'title': 'Set list'})
    r = undo(client, last(client, 'print')['id'])
    assert r.status_code == 409 and r.json()['detail']['reason'] == 'not-undoable'


def test_quick_edits_share_one_row(client):
    it = client.post('/api/items', json={'kind': 'chords', 'title': 'A', 'text': 'x'}).json()
    client.patch(f'/api/items/{it["id"]}', json={'title': 'B'})
    client.patch(f'/api/items/{it["id"]}', json={'title': 'C', 'key': 'G'})
    edits = [a for a in acts(client) if a['type'] == 'edit']
    assert len(edits) == 1
    undo(client, edits[0]['id'])
    assert (item(client, it['id'])['title'], item(client, it['id'])['key']) == ('A', '')


def test_zoom_and_other_patches_are_not_logged(client, chord):
    client.patch(f'/api/items/{chord["id"]}', json={'zoom': 1.2, 'transpose': 2})
    assert not [a for a in acts(client) if a['type'] == 'edit']


def test_tag_batch_undo(client):
    a = client.post('/api/items', json={'kind': 'chords', 'title': 'One', 'text': 'x', 'tags': ['Folk']}).json()
    b = client.post('/api/items', json={'kind': 'chords', 'title': 'Two', 'text': 'x'}).json()
    act = {'id': 'act-batch1', 'type': 'make-tags', 'title': '2 tags'}
    client.post('/api/tags/set', json={'ids': [a['id'], b['id']], 'add': ['Easy'], 'act': act})
    client.post('/api/tags/set', json={'ids': [b['id']], 'add': ['Kids'], 'remove': [], 'act': act})
    rows = [x for x in acts(client) if x['type'] == 'make-tags']
    assert len(rows) == 1 and rows[0]['id'] == 'act-batch1' and rows[0]['action'] == 'undo'
    assert set(item(client, b['id'])['tags']) == {'Easy', 'Kids'}
    r = undo(client, 'act-batch1').json()
    assert r['changed'] == 2
    assert item(client, a['id'])['tags'] == ['Folk'] and item(client, b['id'])['tags'] == []
    # single-item tag edit (PATCH) and remove-all
    client.patch(f'/api/items/{a["id"]}', json={'tags': []})
    undo(client, last(client, 'edit')['id'])
    assert item(client, a['id'])['tags'] == ['Folk']


def test_tag_rename_and_delete_undo(client):
    a = client.post('/api/items', json={'kind': 'chords', 'title': 'One', 'text': 'x', 'tags': ['Folk']}).json()
    client.patch('/api/tags/Folk', json={'to': 'Folk songs'})
    assert item(client, a['id'])['tags'] == ['Folk songs']
    undo(client, last(client, 'tag-rename')['id'])
    assert item(client, a['id'])['tags'] == ['Folk']
    client.delete('/api/tags/Folk')
    assert item(client, a['id'])['tags'] == []
    undo(client, last(client, 'tag-delete')['id'])
    assert item(client, a['id'])['tags'] == ['Folk']


def test_version_and_key_undo_bulk(client):
    s1 = client.post('/api/items', json={'kind': 'sheet', 'title': 'S1', 'version': 'piano'}).json()
    s2 = client.post('/api/items', json={'kind': 'sheet', 'title': 'S2'}).json()
    client.post('/api/items/version', json={'ids': [s1['id'], s2['id']], 'version': 'lead'})
    a = last(client, 'version')
    assert a['title'] == '2 items' and a['action'] == 'undo'
    # a later change of one of them: that one conflicts
    client.patch(f'/api/items/{s2["id"]}', json={'version': 'duet', 'key': 'F'})
    r = undo(client, a['id'])
    assert r.status_code == 409 and 'S2' in r.json()['detail']['message']
    assert item(client, s1['id'])['version'] == 'lead'  # nothing changed by the refusal
    assert undo(client, a['id'], force=True).json()['changed'] == 2
    assert (item(client, s1['id'])['version'], item(client, s2['id'])['version']) == ('piano', '')
    assert item(client, s2['id'])['key'] == 'F'  # key was not part of that change
    assert undo(client, last(client, 'edit')['id']).status_code == 409  # its version was rolled back already (forced)
    undo(client, last(client, 'edit')['id'], force=True)
    assert item(client, s2['id'])['key'] == ''


def test_trash_restore_delete(client):
    a = client.post('/api/items', json={'kind': 'chords', 'title': 'Gone', 'text': 'x'}).json()
    b = client.post('/api/items', json={'kind': 'chords', 'title': 'Also', 'text': 'x'}).json()
    client.post('/api/items/trash', json={'ids': [a['id'], b['id']]})
    t = last(client, 'bin')
    assert t['action'] == 'undo' and 'Gone' in t['undoText'][0]
    client.post('/api/items/restore', json={'ids': [b['id']]})  # one came back by hand already
    r = undo(client, t['id']).json()
    assert r['changed'] == 1 and r['skipped'][0]['why'] == 'already back'
    assert not item(client, a['id'])['deleted']
    # undo of the restore: to the Trash again
    undo(client, last(client, 'restore')['id'])
    assert item(client, b['id'])['deleted']
    client.post('/api/items/purge', json={'ids': [b['id']]})
    d = last(client, 'delete')
    assert d['action'] is None and 'for good' in d['noUndo']
    assert undo(client, d['id']).json()['detail']['reason'] == 'not-undoable'
    # Clean up names the row (act)
    client.post('/api/items/trash', json={'ids': [a['id']], 'act': {'type': 'cleanup', 'title': 'Deleted 1 sheets', 'detail': 'Clean up → Go through sheets'}})
    cu = last(client, 'cleanup')
    assert cu['title'] == 'Deleted 1 sheets' and cu['action'] == 'undo'
    undo(client, cu['id'])
    assert not item(client, a['id'])['deleted']


def test_book_toggle_undo(client, data):
    it = make(client, 'Songs', ['red', 'green'])
    client.post('/api/items/book', json={'ids': [it['id']], 'book': True})
    b = item(client, it['id'])
    assert b['book'] and b['folder'].startswith('Books/')
    undo(client, last(client, 'book')['id'])
    s = item(client, it['id'])
    assert not s['book'] and s['folder'] == it['id'] and (data / 'items' / it['id']).is_dir()
    assert color_of(client, s, 2) == (0, 128, 0)


def test_split_and_join_undo(client):
    it = make(client, 'Mixed', ['red', 'green', 'blue', 'yellow'])
    r = client.post(f'/api/items/{it["id"]}/split', json={'pages': [2, 4], 'title': 'Other'}).json()
    sp = last(client, 'split')
    assert sp['action'] == 'undo'
    undo(client, sp['id'])
    back = item(client, it['id'])
    assert back['pages'] == 4 and [color_of(client, back, n) for n in range(1, 5)] == [(255, 0, 0), (0, 128, 0), (0, 0, 255), (255, 255, 0)]
    assert client.get(f'/api/items/{r["new"]["id"]}').status_code == 404  # the split-off sheet was just made: gone
    # join, then undo
    other = make(client, 'Second', ['white', 'black'])
    client.patch(f'/api/items/{other["id"]}', json={'tags': ['Kids']})
    client.post(f'/api/items/{it["id"]}/join', json={'other': other['id']})
    jn = last(client, 'join')
    undo(client, jn['id'])
    a, o = item(client, it['id']), item(client, other['id'])
    assert a['pages'] == 4 and o['pages'] == 2 and not o['deleted'] and 'Kids' not in a['tags']
    assert [color_of(client, o, n) for n in (1, 2)] == [(255, 255, 255), (0, 0, 0)]
    # refusal: split, then change the pages of the new sheet
    r = client.post(f'/api/items/{it["id"]}/split', json={'pages': [4]}).json()
    client.post(f'/api/items/{r["new"]["id"]}/join', json={'other': other['id']})
    r2 = undo(client, last(client, 'split')['id'])
    assert r2.status_code == 409 and r2.json()['detail']['reason'] == 'conflict' and not r2.json()['detail']['canForce']
    assert undo(client, last(client, 'split')['id'], force=True).status_code == 409  # never forced


def test_booksplit_undo(client):
    b = make_book(client, n=6)
    client.post(f'/api/books/{b["id"]}/make-sheets', json={'starts': {'1': 'A', '4': 'B'}})
    a = last(client, 'booksplit')
    assert a['action'] == 'undo'
    undo(client, a['id'])
    bk = item(client, b['id'])
    assert bk['pages'] == 6 and not bk['deleted'] and len(colors(client, bk)) == 6
    # put back in Clean up instead: the row then has nothing to do
    client.post(f'/api/books/{b["id"]}/make-sheets', json={'starts': {'3': 'C'}})
    a2 = last(client, 'booksplit')
    client.post(f'/api/books/{b["id"]}/unmake')
    r = undo(client, a2['id']).json()
    assert r['changed'] == 0 and 'already put back' in r['skipped'][0]['why']


def test_crop_undo(client):
    it = make_white(client, n=1)
    trim(client, it, top=0.25, bottom=0.75)
    trim(client, it, top=0.1, bottom=0.6)
    rows = [a for a in acts(client) if a['type'] == 'trim']
    assert len(rows) == 1 and rows[0]['title'] == 'Trimmed 1 page'
    undo(client, rows[0]['id'])
    assert page(client, it)['crop'] is None  # back to the original, the history kept
    # trimmed again by hand after: conflict (force is safe)
    trim(client, it, top=0.2, bottom=0.8)
    t2 = last(client, 'trim')
    assert t2['id'] != rows[0]['id']
    client.post(f'/api/items/{it["id"]}/pages/1/untrim', json={})  # merges into the same row (within 10 min)
    r = undo(client, t2['id']).json()
    assert r['changed'] == 0 and r['skipped'][0]['why'] == 'already back'


def test_marks_undo(client):
    it = make_white(client, n=1)
    client.post('/api/cleanup/later', json={'key': f'{it["id"]}:1'})
    client.post('/api/cleanup/ok', json={'key': f'{it["id"]}:1'})  # keep: also takes "later" off
    client.post('/api/cleanup/ok', json={'key': f'title:{it["id"]}'})
    rows = [a for a in acts(client) if a['type'] == 'cleanup-marks']
    assert len(rows) == 1
    undo(client, rows[0]['id'])
    st = client.get('/api/cleanup', params={'id': it['id']}).json()
    assert not (client.get('/api/cleanup').json().get('marks') or [])  # no marks left
    con = sqlite3.connect(client.app.state.cfg.db_path)
    assert con.execute('SELECT COUNT(*) FROM cleanup_mark').fetchone()[0] == 0
    assert con.execute('SELECT COUNT(*) FROM page_later').fetchone()[0] == 0  # 'later' was taken back too (it came first)


def test_suggest_accept_undo(client, data):
    it = client.post('/api/items', json={'kind': 'chords', 'title': 'memory', 'text': 'x'}).json()
    client.post('/api/cleanup/suggest', json={'id': it['id'], 'title': 'Memory', 'why': 'capitals'})
    client.post(f'/api/cleanup/suggest/{it["id"]}/done', json={'action': 'accept'})
    assert not [a for a in acts(client) if a['type'] == 'edit']  # one row: the suggestion
    a = last(client, 'suggest')
    undo(client, a['id'])
    assert item(client, it['id'])['title'] == 'memory'
    assert client.get('/api/cleanup/suggest').json()[0]['id'] == it['id']  # open again


def test_ai_score_undo(client):
    sc = client.post('/api/items', json={'kind': 'score', 'title': 'Lullaby', 'ai': True, 'musicxmlText': '<score-partwise/>'}).json()
    a = last(client, 'ai-score')
    assert a['action'] == 'undo'
    undo(client, a['id'])
    assert item(client, sc['id'])['deleted']


def test_record_undo_helper(client, app):
    """The helper other modules (the Photos import) call: by type, then more steps into the same row by id."""
    from meowsic.db import connect
    from meowsic.undolog import record_undo
    x = client.post('/api/items', json={'kind': 'chords', 'title': 'P1', 'text': 'x'}).json()
    y = client.post('/api/items', json={'kind': 'chords', 'title': 'P2', 'text': 'x'}).json()
    c = connect(app.state.cfg)
    aid = record_undo(c, 'import-photos', {'op': 'created', 'ids': [x['id']], 'titles': ['P1']}, 'Photos import', '1 sheet')
    assert record_undo(c, aid, [{'op': 'created', 'ids': [y['id']], 'titles': ['P2']}], detail='2 sheets') == aid
    c.commit(); c.close()
    a = last(client, 'import-photos')
    assert a['detail'] == '2 sheets' and a['action'] == 'undo'
    assert undo(client, aid).json()['changed'] == 2
    assert item(client, x['id'])['deleted'] and item(client, y['id'])['deleted']


def test_script_log_replay(client, data):
    a = client.post('/api/items', json={'kind': 'sheet', 'title': 'Song (F)'}).json()
    b = client.post('/api/items', json={'kind': 'sheet', 'title': 'Tune - Am'}).json()
    c_ = client.post('/api/items', json={'kind': 'sheet', 'title': 'Other'}).json()
    from meowsic.titlekeys import run
    res = run(data)
    assert len(res['changes']) == 2
    client.patch(f'/api/items/{b["id"]}', json={'title': 'Tune renamed'})  # changed since: skipped
    # older script styles: renames-*.json (before/after dicts) and a tag batch
    h = data / 'history'
    (h / 'renames-x.json').write_text(json.dumps({'at': 'x', 'changes': [{'id': c_['id'], 'before': {'title': 'Other', 'artist': '', 'tags': []}, 'after': {'title': 'Other One', 'tags': ['Easy']}}]}))
    client.patch(f'/api/items/{c_["id"]}', json={'title': 'Other One', 'tags': ['Easy']})
    client.post('/api/activity', json={'type': 'rename', 'title': '1 titles tidied', 'detail': 'history: renames-x.json'})
    (h / 'tags-super-easy-1.json').write_text(json.dumps({'tag': 'Super Easy', 'ids': [a['id']]}))
    client.patch(f'/api/items/{a["id"]}', json={'tags': ['Super Easy']})
    client.post('/api/activity', json={'type': 'tags', 'title': 'Super Easy', 'detail': 'log: history/tags-super-easy-1.json'})
    acts_ = acts(client)
    keys = next(x for x in acts_ if x['title'] == 'Keys out of sheet titles')
    ren = next(x for x in acts_ if x['title'] == '1 titles tidied')
    tg = next(x for x in acts_ if x['title'] == 'Super Easy')
    assert keys['action'] == ren['action'] == tg['action'] == 'undo'
    r = undo(client, tg['id']).json()
    assert r['changed'] == 1 and item(client, a['id'])['tags'] == []
    r = undo(client, keys['id']).json()
    assert r['changed'] == 1 and [s['why'] for s in r['skipped']] == ['changed since']
    assert (item(client, a['id'])['title'], item(client, a['id'])['key']) == ('Song (F)', '')
    assert item(client, b['id'])['title'] == 'Tune renamed'
    r = undo(client, ren['id']).json()
    assert r['changed'] == 1 and item(client, c_['id'])['title'] == 'Other' and item(client, c_['id'])['tags'] == []
    # a log that is gone: refused
    client.post('/api/activity', json={'type': 'migrate', 'title': 'Old', 'detail': 'log: history/versions-gone.jsonl'})
    r = undo(client, next(x for x in acts(client) if x['title'] == 'Old')['id'])
    assert r.status_code == 409 and 'missing' in r.json()['detail']['message']


def test_version_fill_log_replay(client, data):
    s = client.post('/api/items', json={'kind': 'sheet', 'title': 'Duet for two'}).json()
    from meowsic.sheetversion import fill
    fill(data, backup=False)
    assert item(client, s['id'])['version'] == 'duet'
    a = next(x for x in acts(client) if x['title'] == 'Sheet versions')
    assert a['action'] == 'undo'
    assert undo(client, a['id']).json()['changed'] == 1 and item(client, s['id'])['version'] == ''


def wait_job(client, jid, cond, t=5):
    end = time.time() + t
    while time.time() < end:
        j = client.get(f'/api/jobs/{jid}').json()
        if cond(j): return j
        time.sleep(0.02)
    return j


def test_job_stop_rolls_back_what_it_made(client, app, tmp_path):
    xml = tmp_path / 'a.musicxml'; xml.write_text('<score-partwise/>')
    from meowsic.jobs import Cancelled
    from meowsic.runners import save_outputs
    gate = threading.Event()

    def runner(ctx):
        save_outputs(ctx, [('original', xml, None, None, {})], title='Half done', source='test')
        ctx.update(stage=2, progress=0.5, msg='made one')
        gate.wait(5)
        ctx.update(progress=0.9)  # raises Cancelled after a Stop

    app.state.job_runner = runner
    jid = client.post('/api/jobs', json={'kind': 'transcribe', 'title': 'Half done', 'outputs': ['original']}).json()['id']
    wait_job(client, jid, lambda j: j['stage'] == 2)
    a = next(x for x in acts(client) if x['id'] == jid)
    assert a['action'] == 'stop'
    made = client.get(f'/api/jobs/{jid}').json()['result']
    assert len(made) == 1
    r = undo(client, jid).json()
    gate.set()
    assert r['stopped'] and r['changed'] == 1
    assert client.get(f'/api/jobs/{jid}').json()['status'] == 'cancelled'
    assert item(client, made[0])['deleted']
    a = next(x for x in acts(client) if x['id'] == jid)
    assert a['undoneAt'] and a['action'] is None
    assert undo(client, jid).json()['detail']['reason'] == 'done'


def test_finished_job_undo_and_tags_job_refused(client, app, tmp_path):
    xml = tmp_path / 'a.musicxml'; xml.write_text('<score-partwise/>')
    from meowsic.runners import save_outputs, finish
    app.state.job_runner = lambda ctx: finish(ctx, save_outputs(ctx, [('original', xml, None, None, {})], title='Done one', source='t'), ['original'])
    jid = client.post('/api/jobs', json={'kind': 'version', 'title': 'Done one', 'outputs': ['original']}).json()['id']
    j = wait_job(client, jid, lambda j: j['status'] == 'done')
    assert next(x for x in acts(client) if x['id'] == jid)['action'] == 'undo'
    assert undo(client, jid).json()['changed'] == 1 and item(client, j['result'][0])['deleted']
    con = sqlite3.connect(app.state.cfg.db_path)
    con.execute("INSERT INTO job(id, kind, title, source, outputs, status, log, started_at, result) VALUES ('job-tags1','tags','AI tags','', '[]','done','[]',1,'{\"suggestions\": []}')")
    con.commit(); con.close()
    a = next(x for x in acts(client) if x['id'] == 'job-tags1')
    assert a['action'] is None and 'change nothing' in a['noUndo']
    assert undo(client, 'job-tags1').json()['detail']['reason'] == 'not-undoable'


def test_old_rows_and_migration(data):
    """An older db: activity gets the new columns; rows logged before keep working (not undoable)."""
    data.mkdir(exist_ok=True)
    con = sqlite3.connect(data / 'meowsic.db')
    con.execute('CREATE TABLE activity (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT "", at INTEGER NOT NULL)')
    con.execute("INSERT INTO activity VALUES ('act-old1', 'bin', 'Old', 'Old', 5)")
    con.commit(); con.close()
    from fastapi.testclient import TestClient
    from meowsic.app import create_app
    with TestClient(create_app(data, background=False)) as cl:
        a = next(x for x in cl.get('/api/activity').json() if x['id'] == 'act-old1')
        assert a['action'] is None and 'before Activities' in a['noUndo']
        assert cl.post('/api/activity/act-old1/undo', json={}).status_code == 409


def test_songsplit_undo(client):
    """Manage library → Split songs (a sheet, not a book): Undo puts the pages back into the sheet."""
    it = make(client, 'Two songs', ['red', 'green', 'blue'])
    r = client.post(f'/api/sheets/{it["id"]}/make-sheets', json={'starts': {'3': 'Second'}})
    assert r.status_code == 200, r.text
    a = last(client, 'songsplit')
    assert a['action'] == 'undo' and 'sheet' in a['undoText'][0]
    assert undo(client, a['id']).json()['changed'] == 1
    back = item(client, it['id'])
    assert back['pages'] == 3 and [color_of(client, back, n) for n in (1, 2, 3)] == [(255, 0, 0), (0, 128, 0), (0, 0, 255)]
