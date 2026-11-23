"""Score staves: Lead = one staff, Piano = right + left hand; cached in score.staves; AI lead sheets migrated to 'lead'."""
import json
import sqlite3

from fastapi.testclient import TestClient

from meowsic import sheetversion as sv
from meowsic.app import create_app

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'


def xml(*parts):
    """parts: staff count per part (0 = no <staves> element at all)."""
    plist = ''.join(f'<score-part id="P{i}"><part-name>P{i}</part-name></score-part>' for i in range(1, len(parts) + 1))
    body = ''.join(f'<part id="P{i}"><measure number="1"><attributes><divisions>1</divisions>{f"<staves>{n}</staves>" if n else ""}</attributes>'
                   f'<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure></part>'
                   for i, n in enumerate(parts, 1))
    return f'{HEAD}<score-partwise version="4.0"><part-list>{plist}</part-list>{body}</score-partwise>'


def test_staves_detection():
    assert sv.staves_of(xml(0)) == 1            # single melody staff, no <staves>
    assert sv.staves_of(xml(1)) == 1
    assert sv.staves_of(xml(2)) == 2            # grand staff: one part, two staves
    assert sv.staves_of(xml(0, 0)) == 2         # two parts, one staff each
    assert sv.staves_of(xml(0, 2)) == 3         # voice + piano
    assert sv.staves_of(xml(2, 2)) == 4         # duet
    assert sv.staves_of('') == 0
    assert sv.staves_of(xml(2).replace('</score-partwise>', '')) == 2  # broken file: counted by text


def score(client, title, text, **kw):
    return client.post('/api/items', json={'kind': 'score', 'title': title, 'musicxmlText': text, **kw}).json()


def test_staves_on_create_and_save(client):
    lead = score(client, 'Lead', xml(0))
    piano = score(client, 'Piano', xml(2))
    assert lead['staves'] == 1 and piano['staves'] == 2
    r = client.put(f'/api/items/{lead["id"]}/musicxml', content=xml(2))
    assert r.json()['staves'] == 2 and client.get(f'/api/items/{lead["id"]}').json()['staves'] == 2
    assert client.post(f'/api/items/{lead["id"]}/musicxml/revert').json()['staves'] == 1
    assert client.patch(f'/api/items/{lead["id"]}', json={'staves': 9}).json()['staves'] == 1  # not writable
    assert score(client, 'No file', None)['staves'] == 0


def test_migration_fills_staves_and_ai_lead_idempotent(data):
    with TestClient(create_app(data, background=False)) as c:
        ai = score(c, 'AI tune', xml(0), ai=1)
        ai2 = score(c, 'AI piano', xml(2), ai=1)
        human = score(c, 'Human lead', xml(0))
    # AI scores made before this change: version 'original', staves not read yet
    with sqlite3.connect(data / 'meowsic.db') as db:
        db.execute("UPDATE score SET staves=NULL, version='original'")
    for _ in range(2):
        with TestClient(create_app(data, background=False)) as c:
            got = {i['id']: i for i in c.get('/api/items').json()}
    assert got[ai['id']]['staves'] == 1 and got[ai['id']]['version'] == 'lead'
    assert got[ai2['id']]['staves'] == 2 and got[ai2['id']]['version'] == 'original'
    assert got[human['id']]['staves'] == 1 and got[human['id']]['version'] == 'original'  # only AI ones change
    logs = list((data / 'history').glob('score-versions-*.jsonl'))
    assert len(logs) == 1  # the second start changed nothing
    rows = [json.loads(x) for x in logs[0].read_text().splitlines()]
    assert [(r['id'], r['before'], r['after']) for r in rows] == [(ai['id'], 'original', 'lead')]
