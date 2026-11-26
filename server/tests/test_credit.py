"""Score credits: composer = the song's real artist, plus what Meowsic did ("Transcribed by Meowsic" …)."""
from meowsic.db import credit_xml, score_byline
from meowsic.runners import credit_meowsic


def test_credit_replaces_creators(tmp_path):
    p = tmp_path / 'a.musicxml'
    p.write_text('<score-partwise><identification><creator type="composer">transcribed by Emi Music Note</creator><creator type="lyricist">X</creator></identification><part-list/></score-partwise>')
    credit_meowsic(p, 'Dick Lee', 'Transcribed by Meowsic')
    x = p.read_text()
    assert x.count('<creator') == 2 and '<creator type="composer">Dick Lee</creator><creator type="arranger">Transcribed by Meowsic</creator>' in x


def test_credit_added_when_missing(tmp_path):
    p = tmp_path / 'b.musicxml'
    p.write_text('<score-partwise><part-list></part-list></score-partwise>')
    credit_meowsic(p, '')
    assert '<identification><creator type="arranger">Made by Meowsic</creator></identification><part-list>' in p.read_text()


def test_credit_never_meowsic_as_composer():
    x = '<score-partwise><identification><creator type="composer">Meowsic</creator></identification><part-list/></score-partwise>'
    assert '<creator type="composer">' not in credit_xml(x)  # keeps the composer it has, but Meowsic is not one
    y = credit_xml('<score-partwise><identification><creator type="composer">Tom &amp; Jerry</creator></identification><part-list/></score-partwise>', None, 'Arranged by Meowsic')
    assert '<creator type="composer">Tom &amp; Jerry</creator><creator type="arranger">Arranged by Meowsic</creator>' in y
    assert credit_xml(x, 'Meowsic', '') == x.replace('<creator type="composer">Meowsic</creator>', '')


def test_byline():
    assert score_byline('From the score “X”', 1) == 'Arranged by Meowsic'
    assert score_byline('From the sheet “X” (photo → score, beta)') == 'Transcribed by Meowsic'
    assert score_byline('Meowsic', 1) == 'Made by Meowsic'
    assert score_byline('YouTube') == 'Transcribed by Meowsic' and score_byline('Audio file') == 'Transcribed by Meowsic'


OLD_READ = ('<score-partwise><identification><creator type="composer">Dick Lee</creator><creator type="arranger">Read by Meowsic</creator>'
            '</identification><part-list/></score-partwise>')


def test_credit_route_read_to_transcribed(client, data):
    """POST /api/items/{id}/credit: an old "Read by Meowsic" -> "Transcribed by Meowsic", logged and undoable; 423 while edited."""
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Sheet song', 'source': 'From the sheet “X” (photo → score, beta)',
                                         'musicxmlText': OLD_READ}).json()
    f = data / 'items' / it['folder'] / it['musicxml']
    f.write_text(OLD_READ)  # as an older Meowsic wrote it
    assert '<creator type="composer">' not in credit_xml(OLD_READ.replace('Dick Lee', 'Read by Meowsic'))  # the old credit is never the composer
    before = client.get(f'/api/items/{it["id"]}').json()['updatedAt']
    dry = client.post(f'/api/items/{it["id"]}/credit', json={'dryRun': True}).json()
    assert dry['files'] == [it['musicxml']] and dry['by'] == 'Transcribed by Meowsic' and f.read_text() == OLD_READ
    r = client.post(f'/api/items/{it["id"]}/credit').json()
    new = f.read_text()
    assert r['activity'] and '<creator type="composer">Dick Lee</creator><creator type="arranger">Transcribed by Meowsic</creator>' in new
    assert 'Read by' not in new and client.get(f'/api/items/{it["id"]}').json()['updatedAt'] == before
    assert client.post(f'/api/items/{it["id"]}/credit').json()['files'] == []  # nothing left to do
    acts = client.get('/api/activity').json()
    acts = acts if isinstance(acts, list) else acts.get('activities', acts.get('items', []))
    row = next(a for a in acts if a['id'] == r['activity'])
    assert row['type'] == 'credit' and '1 score(s)' in row['detail']
    u = client.post(f'/api/activity/{r["activity"]}/undo', json={})
    assert u.status_code == 200, u.text
    assert f.read_text() == OLD_READ
    assert client.post(f'/api/items/{it["id"]}/editsession', json={'session': 'agent-test'}).status_code == 200
    lk = client.post(f'/api/items/{it["id"]}/credit')
    assert lk.status_code == 423 and f.read_text() == OLD_READ
