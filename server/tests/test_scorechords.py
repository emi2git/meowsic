"""Chords for the ukulele panel (scorechords.py): the score's symbols in order of first use, else from the notes."""
from meowsic import chordfind as cf


def _xml(body, harmony=''):
    return ('<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>'
            '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>'
            f'<time><beats>4</beats><beat-type>4</beat-type></time></attributes>{harmony}{body}</measure></part></score-partwise>')


def note(step, octave, dur=4, chord=False):
    return f'<note>{"<chord/>" if chord else ""}<pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>{dur}</duration><type>whole</type></note>'


def h(root, kind):
    return f'<harmony><root><root-step>{root}</root-step></root><kind>{kind}</kind></harmony>'


def test_symbols_in_order_deduplicated(client):
    x = _xml(note('C', 4, 1) + h('G', 'major') + note('D', 4, 1) + h('C', 'major') + note('E', 4, 1) + h('A', 'minor') + note('C', 4, 1), h('C', 'major'))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': x}).json()
    assert client.get(f'/api/items/{it["id"]}/score-chords').json() == {'chords': ['C', 'G', 'Am'], 'from': 'symbols'}


def test_from_the_notes_when_no_symbols(client):
    x = _xml(note('C', 3) + note('E', 3, chord=True) + note('G', 3, chord=True) + note('C', 4, chord=True))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': x}).json()
    j = client.get(f'/api/items/{it["id"]}/score-chords').json()
    assert j['from'] == 'notes' and j['chords'] == ['C']


def test_nothing(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'S', 'musicxmlText': _xml('<note><rest/><duration>4</duration></note>')}).json()
    assert client.get(f'/api/items/{it["id"]}/score-chords').json() == {'chords': [], 'from': 'none'}
