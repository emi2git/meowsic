"""creditfix: every score credited to "Meowsic" (artist, source, MusicXML composer), history kept, undoable."""
import json
import sqlite3

from meowsic import creditfix

OLD = '<score-partwise><identification><creator type="composer">Meowsic AI</creator></identification><part-list/></score-partwise>'


def _old_style(data, client):
    ai = client.post('/api/items', json={'kind': 'score', 'title': 'Tune', 'ai': True, 'musicxmlText': OLD}).json()
    song = client.post('/api/items', json={'kind': 'score', 'title': 'Song', 'artist': 'Les Miserables', 'source': 'YouTube'}).json()
    db = sqlite3.connect(data / 'meowsic.db')  # as an older Meowsic wrote them
    db.execute("UPDATE item SET artist='Meowsic AI' WHERE id=?", (ai['id'],))
    db.execute("UPDATE score SET source='Meowsic AI' WHERE item_id=?", (ai['id'],))
    db.execute("INSERT INTO activity(id, type, title, detail, at) VALUES ('act-oldone', 'migrate', 'Score sources', '2 AI piece(s) → Meowsic AI', 1)")
    db.commit(); db.close()
    (data / 'items' / ai['folder'] / ai['musicxml']).write_text(OLD)
    return ai, song


def test_credit_run_and_undo(client, data):
    ai, song = _old_style(data, client)
    assert client.get(f'/api/items/{ai["id"]}').json()['source'] == 'Meowsic AI'
    r = creditfix.run(data, log=lambda *a: None)
    assert r['items'] == 1 and r['files'] == 1 and r['activities'] == 1
    it = client.get(f'/api/items/{ai["id"]}').json()
    assert (it['artist'], it['source']) == ('Meowsic', 'Meowsic')
    assert client.get(f'/api/items/{song["id"]}').json()['artist'] == 'Les Miserables'
    f = data / 'items' / ai['folder'] / ai['musicxml']
    assert '<creator type="composer">Meowsic</creator>' in f.read_text() and 'Meowsic AI' not in f.read_text()
    kept = list((f.parent / '.history').glob('credit-*'))
    assert len(kept) == 1 and kept[0].read_text() == OLD
    log = json.loads(open(r['log']).read())
    assert log['scores'][0]['before'] == {'artist': 'Meowsic AI', 'source': 'Meowsic AI'}
    assert not any('Meowsic AI' in json.dumps(x) for x in client.get('/api/items').json())
    assert creditfix.run(data, log=lambda *a: None)['items'] == 0  # nothing left to do
    acts = client.get('/api/activity').json()
    row = next(a for a in (acts if isinstance(acts, list) else acts.get('activities', acts.get('items', []))) if a.get('type') == 'credit')
    u = client.post(f'/api/activity/{row["id"]}/undo', json={})
    assert u.status_code == 200, u.text
    it = client.get(f'/api/items/{ai["id"]}').json()
    assert (it['artist'], it['source']) == ('Meowsic AI', 'Meowsic AI') and f.read_text() == OLD
    assert len(list((f.parent / '.history').glob('credit-*'))) == 2  # the Meowsic one kept too
