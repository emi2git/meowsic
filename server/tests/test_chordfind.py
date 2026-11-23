"""The music-aware chord finder (chordfind.py), its MusicXML swap, the pipeline hook and the one-time tidy."""
import json
import re
import sqlite3
from pathlib import Path

import pytest

from meowsic import chordfind as cf
from meowsic import chordtidy, runners

C, D, E, F, G, A, B = 0, 2, 4, 5, 7, 9, 11


def m(name):
    """'F#4' -> MIDI."""
    step, rest = name[0], name[1:]
    alt = rest.count('#') - rest.count('b')
    return 12 * (int(rest.strip('#b')) + 1) + cf.STEP_PC[step] + alt


def bars(n, beats=4, beat_type=4):
    L = beats * 4 / beat_type
    return [cf.Bar(i * L, L, beats, beat_type) for i in range(n)]


def arpeggio(start, length, pitches, step=0.25):
    out, t, k = [], start, 0
    while t < start + length - 1e-9:
        out.append(cf.Note(t, step, m(pitches[k % len(pitches)])))
        t += step
        k += 1
    return out


def names(notes, bs, fifths=None):
    return [c.name for c in cf.find_chords(notes, bs, fifths)]


# ---------- the finder ----------

def test_one_day_more_opening():
    """16th-note arpeggios over a bass walking down by step: A G# F# E D C# B E -> A F#m D Bm E(7),
    not A, Amaj7/G#, F#m7, F#m7/E, D, Dmaj7/C#, Bm7, E7."""
    walk = ['A3', 'G#3', 'F#3', 'E3', 'D3', 'C#3', 'B2', 'E3']
    figs = [['A5', 'F#5', 'E5', 'C#5']] * 4 + [['A5', 'F#5', 'E5', 'D5']] * 2 + [['B5', 'F#5', 'E5', 'D5'], ['B5', 'G#5', 'E5', 'D5']]
    notes = []
    for k, (b, fig) in enumerate(zip(walk, figs)):
        notes.append(cf.Note(k * 2, 2, m(b)))
        notes += arpeggio(k * 2, 2, fig)
    got = cf.find_chords(notes, bars(4), fifths=3)
    assert [c.name for c in got][:4] == ['A', 'F#m', 'D', 'Bm']
    assert [c.name for c in got][4] in ('E', 'E7') and len(got) == 5
    assert [c.at for c in got] == [0, 4, 8, 12, 14]        # one chord a bar; the last bar really moves
    assert not any('/' in c.name or 'maj7' in c.name for c in got)


def test_one_day_more_real_left_hand():
    """Same tune, left hand as transcribed: broken octaves/fifths (A2 E3 A3 E3 | G#2 E3 A3 E3 ...)."""
    lh = [('A2', 'E3', 'A3', 'E3'), ('G#2', 'E3', 'A3', 'E3'), ('F#2', 'C#3', 'F#3', 'C#3'), ('E2', 'C#3', 'F#3', 'C#3'),
          ('D2', 'A2', 'D3', 'A2'), ('C#3', 'A3', 'D4', 'A3'), ('B2', 'F#3', 'B3', 'F#3'), ('E3', 'G#3', 'B3', 'G#3')]
    tune = [('C#5', 2), ('B4', 1), ('A4', 1), ('A4', 2), ('F#4', 2), ('F#4', 2), ('A4', 2), ('B4', 2), ('G#4', 2)]
    notes, t = [], 0
    for k, half in enumerate(lh):
        notes += [cf.Note(k * 2 + i * 0.5, 0.5, m(p)) for i, p in enumerate(half)]
    for p, d in tune[:8]:
        notes.append(cf.Note(t, d, m(p)))
        t += d
    assert names(notes, bars(4), fifths=3)[:4] == ['A', 'F#m', 'D', 'Bm']


def test_one_four_five_one_with_passing_tones():
    """C | F | G | C, block chords and bass, a melody full of passing and neighbour notes."""
    chords = [('C2', ['C4', 'E4', 'G4']), ('F2', ['F3', 'A3', 'C4']), ('G2', ['G3', 'B3', 'D4']), ('C2', ['C4', 'E4', 'G4'])]
    tune = [['E5', 'F5', 'G5', 'A5', 'G5', 'F5', 'E5', 'D5'], ['C5', 'D5', 'C5', 'Bb4', 'A4', 'G4', 'A4', 'B4'],
            ['B4', 'C5', 'D5', 'E5', 'D5', 'C5', 'B4', 'A4'], ['G4', 'A4', 'G4', 'F4', 'E4', 'D4', 'E4', 'C5']]
    notes = []
    for k, (b, ch) in enumerate(chords):
        notes.append(cf.Note(k * 4, 4, m(b)))
        notes += [cf.Note(k * 4, 4, m(p)) for p in ch]
        notes += [cf.Note(k * 4 + i * 0.5, 0.5, m(p)) for i, p in enumerate(tune[k])]
    assert names(notes, bars(4), fifths=0) == ['C', 'F', 'G', 'C']


def test_minor_key():
    """A minor: Am | Dm | E (with its G#) | Am — the raised 7th makes E major, the key is A minor."""
    chords = [('A2', ['A3', 'C4', 'E4']), ('D2', ['D3', 'F3', 'A3']), ('E2', ['E3', 'G#3', 'B3']), ('A2', ['A3', 'C4', 'E4'])]
    tune = [['E5', 'D5', 'C5', 'B4'], ['A4', 'D5', 'F5', 'E5'], ['E5', 'B4', 'G#4', 'B4'], ['A4', 'B4', 'C5', 'A4']]
    notes = []
    for k, (b, ch) in enumerate(chords):
        notes += [cf.Note(k * 4 + i, 1, m(b)) for i in range(4)]
        notes += [cf.Note(k * 4 + i, 1, m(p)) for i in (1, 2, 3) for p in ch]
        notes += [cf.Note(k * 4 + i, 1, m(p)) for i, p in enumerate(tune[k])]
    assert cf.find_key(notes, 0) == (A, 'minor')
    assert names(notes, bars(4), fifths=0) == ['Am', 'Dm', 'E', 'Am']


def test_three_four_waltz():
    """3/4: one window per bar; oom-pah-pah G | C | D7 | G (the 7th sits in the accompaniment)."""
    chords = [('G2', ['B3', 'D4']), ('C3', ['C4', 'E4', 'G4']), ('D3', ['C4', 'F#4', 'A3']), ('G2', ['B3', 'D4', 'G3'])]
    tune = [['D5', 'B4', 'G4'], ['E5', 'G5', 'E5'], ['F#5', 'E5', 'D5'], ['G4', 'B4', 'G4']]
    notes = []
    for k, (b, ch) in enumerate(chords):
        notes.append(cf.Note(k * 3, 1, m(b)))
        notes += [cf.Note(k * 3 + i, 1, m(p)) for i in (1, 2) for p in ch]
        notes += [cf.Note(k * 3 + i, 1, m(p)) for i, p in enumerate(tune[k])]
    bs = bars(4, 3, 4)
    assert [w[:2] for w in cf.windows(bs)] == [(0, 3), (3, 6), (6, 9), (9, 12)]
    assert names(notes, bs, fifths=1) == ['G', 'C', 'D7', 'G']


def test_seventh_only_when_the_accompaniment_plays_it():
    """G with an F only in the tune stays G; with F in the left hand it is G7."""
    base = [cf.Note(0, 4, m('G2')), cf.Note(0, 4, m('B3')), cf.Note(0, 4, m('D4'))]
    tune = [cf.Note(0, 2, m('G5')), cf.Note(2, 2, m('F5'))]
    assert names(base + tune, bars(1), 0) == ['G']
    assert names(base + tune + [cf.Note(0, 4, m('F3'))], bars(1), 0) == ['G7']


def test_windows_and_spelling():
    assert [w[:2] for w in cf.windows(bars(1))] == [(0, 2), (2, 4)]
    assert [w[:2] for w in cf.windows(bars(1, 6, 8))] == [(0, 3)]
    assert [w[:2] for w in cf.windows(bars(1, 12, 8))] == [(0, 3), (3, 6)]
    assert [w[:2] for w in cf.windows([cf.Bar(0, 1, 4, 4)])] == [(0, 1)]  # a pickup: one window
    assert cf.spell(10, -2) == 'Bb' and cf.spell(6, 3) == 'F#' and cf.spell(3, 5) == 'D#' and cf.spell(1, -4) == 'Db'


# ---------- MusicXML ----------

def note_xml(step, octave, dur, alter=0, staff=1, chord=False, typ='half'):
    return (f'<note>{"<chord/>" if chord else ""}<pitch><step>{step}</step>' + (f'<alter>{alter}</alter>' if alter else '') +
            f'<octave>{octave}</octave></pitch><duration>{dur}</duration><voice>{staff}</voice><type>{typ}</type><staff>{staff}</staff></note>')


def harmony(root, kind, bass=None, alter=0):
    return (f'<harmony><root><root-step>{root}</root-step>' + (f'<root-alter>{alter}</root-alter>' if alter else '') +
            f'</root><kind>{kind}</kind>' + (f'<bass><bass-step>{bass[0]}</bass-step>' + ('<bass-alter>1</bass-alter>' if bass[1:] == '#' else '') + '</bass>' if bass else '') +
            '<staff>1</staff></harmony>')


def walking_score():
    """2 bars of 4/4 in A, two staves: right hand A-C#-E chords, left hand A G# | F# E; old slash-chord symbols."""
    ms = []
    lh = [[('A', 3, 0), ('G', 3, 1)], [('F', 3, 1), ('E', 3, 0)]]
    olds = [[harmony('A', 'major'), harmony('A', 'major-seventh', 'G#')], [harmony('F', 'minor-seventh', alter=1), harmony('F', 'minor-seventh', 'E', 1)]]
    for k in range(2):
        rh = ''
        top = [('C', 5, 1), ('E', 5, 0), ('A', 5, 0)] if k == 0 else [('C', 5, 1), ('F', 5, 1), ('A', 5, 0)]
        for half in range(2):
            rh += '\n      ' + olds[k][half]
            for i, (s, o, a) in enumerate(top): rh += '\n      ' + note_xml(s, o, 2, a, 1, chord=i > 0)
        left = ''.join('\n      ' + note_xml(s, o, 2, a, 2) for s, o, a in lh[k])
        attrs = '<attributes><divisions>1</divisions><key><fifths>3</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>' if k == 0 else ''
        ms.append(f'    <measure number="{k + 1}">\n      {attrs}{rh}\n      <backup><duration>4</duration></backup>{left}\n    </measure>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n'
            '  <part id="P1">\n' + '\n'.join(ms) + '\n  </part>\n</score-partwise>\n').encode()


def strip_harmony(b): return re.sub(rb'\s+', b'', re.sub(rb'<harmony>.*?</harmony>', b'', b, flags=re.S))


def test_rechord_xml_swaps_only_the_symbols():
    data = walking_score()
    r = cf.rechord_xml(data)
    assert r.old == [(1, 'A'), (1, 'Amaj7/G#'), (2, 'F#m7'), (2, 'F#m7/E')]
    assert r.new == [(1, 'A'), (2, 'F#m')]
    assert strip_harmony(r.xml) == strip_harmony(data)          # every note exactly as it was
    from music21 import converter, harmony as h
    sc = converter.parseData(r.xml.decode(), format='musicxml')
    syms = [(float(cs.getOffsetInHierarchy(sc)), cs.figure) for cs in sc.recurse().getElementsByClass(h.ChordSymbol)]
    assert syms == [(0.0, 'A'), (4.0, 'F#m')]
    assert cf.rechord_xml(r.xml).xml == r.xml                    # stable: a second pass changes nothing


def test_rechord_xml_melody_only_uses_old_symbols_as_hints():
    """A lead sheet (tune alone): the old symbols stand in for the piano they were heard from."""
    body = (harmony('A', 'major') + note_xml('E', 5, 2) + harmony('A', 'major-seventh', 'G#') + note_xml('C', 5, 2, 1) +
            '</measure><measure number="2">' + harmony('F', 'minor-seventh', alter=1) + note_xml('F', 5, 2, 1) +
            harmony('F', 'minor-seventh', 'E', 1) + note_xml('A', 4, 2))
    data = ('<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>'
            '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>3</fifths></key>'
            '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>' + body + '</measure></part></score-partwise>').encode()
    r = cf.rechord_xml(data)
    assert r.new == [(1, 'A'), (2, 'F#m')]
    assert strip_harmony(r.xml) == strip_harmony(data)


# ---------- the pipeline hook ----------

def test_rechord_in_the_pipeline_and_the_old_flag(tmp_path, monkeypatch):
    src = tmp_path / 'song'
    src.mkdir()
    (src / 'score.musicxml').write_bytes(walking_score())
    out = ('original', src / 'score.musicxml', src / 'score.mid', None, {'key': 'A major'})
    monkeypatch.setenv('MEOWSIC_CHORDS', 'old')
    assert runners.rechord(out, tmp_path / 'work') == out
    monkeypatch.delenv('MEOWSIC_CHORDS')
    v, xml, mid, pdf, extra = runners.rechord(out, tmp_path / 'work')
    assert xml == tmp_path / 'work' / 'chords' / 'original.musicxml' and mid == out[2] and extra == out[4]
    assert cf.old_chords(xml.read_bytes()) == [(1, 'A'), (2, 'F#m')]
    assert (src / 'score.musicxml').read_bytes() == walking_score()  # the pipeline's own file is left alone


def test_arrange_guess_uses_the_new_finder(tmp_path, monkeypatch):
    from meowsic import arrange
    bare = re.sub(rb'\s*<harmony>.*?</harmony>', b'', walking_score(), flags=re.S)
    (tmp_path / 'bare.musicxml').write_bytes(bare)
    assert [s[4] for s in arrange.read(tmp_path / 'bare.musicxml').chords] == ['A', 'F#m']
    monkeypatch.setenv('MEOWSIC_CHORDS', 'old')
    assert arrange.read(tmp_path / 'bare.musicxml').chords  # the old guess is still there


# ---------- the one-time tidy ----------

def add_score(client, title, xml: bytes, **kw):
    return client.post('/api/items', json={'kind': 'score', 'title': title, 'version': 'original', 'tags': ['Original'],
                                           'musicxmlText': xml.decode(), **kw}).json()


def test_tidy_dry_run_then_real_run_keeps_history(client, data):
    one = add_score(client, 'Walk', walking_score(), source='YouTube')
    ai = add_score(client, 'AI song', walking_score(), source='Meowsic AI', ai=1)
    omr = add_score(client, 'Read', walking_score(), source='From the sheet “Read” (photo → score, beta)')
    f = data / 'items' / one['folder'] / one['musicxml']
    before = f.read_bytes()
    db_before = (data / 'meowsic.db').read_bytes()

    res = {r.id: r for r in chordtidy.tidy(data, dry_run=True, pdf=False)}
    assert res[one['id']].status == 'changed' and res[one['id']].files[0][2] == [(1, 'A'), (2, 'F#m')]
    assert res[ai['id']].status == 'skipped' and 'AI' in res[ai['id']].why
    assert res[omr['id']].status == 'skipped' and 'sheet' in res[omr['id']].why
    assert f.read_bytes() == before and not (data / 'history' / 'chords-retidy.jsonl').exists()
    assert not (data / 'items' / one['folder'] / '.history').exists()

    res = {r.id: r for r in chordtidy.tidy(data, dry_run=False, only=[one['id']], pdf=False)}
    assert list(res) == [one['id']]
    assert cf.old_chords(f.read_bytes()) == [(1, 'A'), (2, 'F#m')]
    assert strip_harmony(f.read_bytes()) == strip_harmony(before)
    kept = list((data / 'items' / one['folder'] / '.history').glob('chords-*'))
    assert len(kept) == 1 and kept[0].read_bytes() == before and kept[0].name.endswith(one['musicxml'])
    lines = [json.loads(x) for x in (data / 'history' / 'chords-retidy.jsonl').read_text().splitlines()]
    assert len(lines) == 1 and lines[0]['id'] == one['id'] and lines[0]['title'] == 'Walk' and lines[0]['file'] == one['musicxml']
    assert lines[0]['before_chords'] == ['1:A', '1:Amaj7/G#', '2:F#m7', '2:F#m7/E'] and lines[0]['after_chords'] == ['1:A', '2:F#m'] and lines[0]['at']
    # the AI score is untouched, and a second run has nothing left to do
    assert (data / 'items' / ai['folder'] / ai['musicxml']).read_bytes() == walking_score()
    assert chordtidy.tidy(data, dry_run=False, only=[one['id']], pdf=False)[0].status == 'unchanged'
    assert client.get(f'/api/items/{one["id"]}').json()['title'] == 'Walk'
    with sqlite3.connect(data / 'meowsic.db') as c:
        assert c.execute('SELECT COUNT(*) FROM item').fetchone()[0] == 3
    assert db_before  # the database is only read


def test_retidy_script_dry_run(client, data, capsys):
    import importlib.util
    one = add_score(client, 'Walk', walking_score(), source='YouTube')
    spec = importlib.util.spec_from_file_location('retidy', Path(__file__).parents[1] / 'scripts' / 'retidy_chords.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main(['--data', str(data), '--dry-run']) == 0
    out = capsys.readouterr().out
    assert 'DRY RUN' in out and 'old: 1: A Amaj7/G# | 2: F#m7 F#m7/E' in out and 'new: 1: A | 2: F#m' in out
    assert cf.old_chords((data / 'items' / one['folder'] / one['musicxml']).read_bytes())[1] == (1, 'Amaj7/G#')
