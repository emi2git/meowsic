"""Smooth… (smoothrhythm.py): a 0–100 slider; odd values snap to a simple grid (7/8 + 1/8 → 6/8 + 2/8), a note lasts
through a short rest when nothing else starts in it (15/16 + 1/16 → a whole note), rests in a row become one, odd
tuplets go straight while real triplets stay, every bar stays full, ties right, pitches never change.
The menu around it and the API: test_simplepiano.py."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest

from meowsic import easerests as er
from meowsic import smoothrhythm as sr
from test_easerests import full, ties_ok, voice

DIV = 240  # 32nds, triplets and quintuplets fit


def n(x, q, staff=1, tm=None, tie=None, lyric=None):
    """One <note>: x 'C4' | 'R'; q in quarters (any length — written values don't matter to the smoother)."""
    q = Fr(q)
    body = '<rest/>' if x == 'R' else f'<pitch><step>{x[0]}</step><octave>{x[-1]}</octave></pitch>'
    ties = ''.join(f'<tie type="{t}"/>' for t in (tie or []))
    mod = f'<time-modification><actual-notes>{tm[0]}</actual-notes><normal-notes>{tm[1]}</normal-notes></time-modification>' if tm else ''
    tied = ''.join(f'<tied type="{t}"/>' for t in (tie or []))
    nots = f'<notations>{tied}</notations>' if tied else ''
    ly = f'<lyric number="1"><syllabic>single</syllabic><text>{lyric}</text></lyric>' if lyric else ''
    return (f'<note>{body}<duration>{int(q * DIV)}</duration>{ties}<voice>{staff}</voice><type>quarter</type>{mod}'
            f'<staff>{staff}</staff>{nots}{ly}</note>')


def score(rh, lh=None, beats=4):
    ms = []
    for i, b in enumerate(rh):
        x = f'<measure number="{i + 1}">'
        if i == 0: x += f'<attributes><divisions>{DIV}</divisions><time><beats>{beats}</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>'
        x += ''.join(b)
        if lh: x += f'<backup><duration>{beats * DIV}</duration></backup>' + ''.join(lh[i])
        ms.append(x + '</measure>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{"".join(ms)}</part></score-partwise>')


def v(text, bar=0, staff='1'):
    """[(pitch | 'R', quarters, ties)] of one staff in one bar."""
    m = ET.fromstring(text.encode()).findall('part/measure')[bar]
    out = []
    for e in m.findall('note'):
        if (e.findtext('staff') or '1') != staff or e.find('chord') is not None: continue
        p = 'R' if e.find('rest') is not None else e.findtext('pitch/step') + e.findtext('pitch/octave')
        out.append((p, Fr(int(e.findtext('duration')), DIV), tuple(sorted(t.get('type') for t in e.findall('tie')))))
    return out


def tune(text):
    """Per staff: the pitches struck, ties merged (what must never change)."""
    out = {}
    for m in ET.fromstring(text.encode()).iter('measure'):
        for e in m.findall('note'):
            if e.find('rest') is not None or e.find('chord') is not None: continue
            if any(t.get('type') == 'stop' for t in e.findall('tie')): continue
            out.setdefault(e.findtext('staff'), []).append(e.findtext('pitch/step') + e.findtext('pitch/octave'))
    return out


def merged(text, bar=0, staff='1'):
    """Like v() but tied pieces added up: [(pitch | 'R', quarters)]."""
    out = []
    for p, q, ties in v(text, bar, staff):
        if 'stop' in ties and out and out[-1][0] == p: out[-1][1] += q
        else: out.append([p, q])
    return [tuple(x) for x in out]


def ok(x, out):
    assert full(out) and ties_ok(out) and tune(out) == tune(x)


@pytest.mark.parametrize('level', [20, 60, 100])
def test_seven_eighths_plus_one_eighth(level):
    """A note 7/8 of the bar + one 1/8 → 6/8 + 2/8 (from level 60), or as is when the level is low."""
    x = score([[n('C5', Fr(7, 2)), n('D5', Fr(1, 2))]], [[n('C3', 4, 2)]])
    out, a, b = sr.smooth(x, level)
    ok(x, out)
    if level >= 60:
        assert merged(out) == [('C5', 3), ('D5', 1)]
        assert b['split'] < a['split'] or b['odd'] < a['odd'] or b['tied'] <= a['tied']
    else:
        assert merged(out) == [('C5', Fr(7, 2)), ('D5', Fr(1, 2))]


@pytest.mark.parametrize('level', [1, 30, 100])
def test_note_lasts_through_a_silent_rest(level):
    """15/16 + a 1/16 rest, nothing else starts in the rest → one whole note (any level above 0)."""
    x = score([[n('E5', Fr(15, 4)), n('R', Fr(1, 4))]], [[n('C3', 2, 2), n('G2', 2, 2)]])
    out, a, b = sr.smooth(x, level)
    ok(x, out)
    assert v(out) == [('E5', 4, ())] and b['rests'] == a['rests'] - 1


def test_rest_stays_when_another_note_starts_in_it():
    """The left hand plays during the right hand's rest: the rest stays (low / mid levels), snapped to the grid."""
    x = score([[n('E5', Fr(3, 2)), n('R', Fr(1, 2)), n('F5', 2)]], [[n('C3', Fr(7, 4), 2), n('G2', Fr(9, 4), 2)]])
    for level in (20, 50):
        out, a, b = sr.smooth(x, level)
        ok(x, out)
        assert ('R', Fr(1, 2)) in merged(out)
    out, *_ = sr.smooth(x, 10)
    assert merged(out, 0, '2') == [('C3', Fr(7, 4)), ('G2', Fr(9, 4))]     # level 10: only moves up to a 32nd
    out, *_ = sr.smooth(x, 60)
    assert merged(out, 0, '2') == [('C3', 2), ('G2', 2)]                      # level 60: onto the beat


def test_tiny_rests_and_rests_in_a_row():
    x = score([[n('C5', Fr(1, 1)), n('R', Fr(1, 8)), n('R', Fr(1, 8)), n('D5', Fr(3, 4)), n('E5', 2)]], [[n('C3', 4, 2)]])
    out, a, b = sr.smooth(x, 40)
    ok(x, out)
    assert b['rests'] == 0 and merged(out) == [('C5', 1), ('D5', 1), ('E5', 2)]   # the rests went, D5 onto the beat


def test_rests_everywhere_get_fewer_with_the_level():
    rh = [[n('C5', Fr(3, 4)), n('R', Fr(1, 4)), n('D5', Fr(3, 4)), n('R', Fr(1, 4)), n('E5', Fr(1, 2)), n('R', Fr(3, 2))]] * 2
    lh = [[n('C3', 1, 2), n('R', 1, 2), n('G2', Fr(3, 4), 2), n('R', Fr(5, 4), 2)]] * 2
    x = score(rh, lh)
    counts = []
    for level in (0, 20, 40, 60, 85, 100):
        out, a, b = sr.smooth(x, level)
        ok(x, out)
        counts.append(b['rests'])
    assert counts[0] == 10 and counts == sorted(counts, reverse=True) and counts[-1] < 4


def test_left_hand_holds_at_the_top():
    x = score([[n('C5', 1), n('D5', 1), n('E5', 1), n('F5', 1)]], [[n('C3', 1, 2), n('R', 1, 2), n('G2', 1, 2), n('R', 1, 2)]])
    out, a, b = sr.smooth(x, 30)
    assert merged(out, 0, '2') == [('C3', 1), ('R', 1), ('G2', 1), ('R', 1)]   # the right hand plays in those rests
    out, a, b = sr.smooth(x, 90)
    ok(x, out)
    assert merged(out, 0, '2') == [('C3', 2), ('G2', 2)]


def test_odd_tuplets_go_straight_real_triplets_stay():
    five = [n(p + '4', Fr(2, 5), tm=(5, 4)) for p in 'CDEFG']           # 5:4 eighths filling a half
    trip = [n(p + '5', Fr(1, 3), tm=(3, 2)) for p in 'ABC']             # a real eighth triplet
    x = score([[*five, *trip, n('D5', 1)]], [[n('C3', 4, 2)]])
    out, a, b = sr.smooth(x, 60)
    ok(x, out)
    rh = v(out)
    notes = ET.fromstring(out.encode()).findall('part/measure/note')
    mods = [e.findtext('time-modification/actual-notes') for e in notes if (e.findtext('staff') or '1') == '1']
    assert '5' not in mods and mods.count('3') == 3                    # the triplet kept, the quintuplet straight
    assert sum(q for _, q in merged(out)[:5]) == 2 and all((q * 4).denominator == 1 for _, q in merged(out)[:5])
    assert a['tuplets'] == 8 and b['tuplets'] == 3


def test_anticipation_over_the_bar_line_moves_to_the_downbeat():
    x = score([[n('C5', 2), n('D5', Fr(3, 2)), n('E5', Fr(1, 2), tie=['start'], lyric='home')],
               [n('E5', 3, tie=['stop']), n('F5', 1)]], [[n('C3', 4, 2)], [n('G2', 4, 2)]])
    out, a, b = sr.smooth(x, 70)
    ok(x, out)
    assert merged(out, 0) == [('C5', 2), ('D5', 2)] and merged(out, 1)[0] == ('E5', 3)
    first = ET.fromstring(out.encode()).findall('part/measure')[1].find('note')
    assert first.findtext('lyric/text') == 'home' and first.find('tie') is None
    out, *_ = sr.smooth(x, 40)                                          # not yet at 40
    assert merged(out, 0)[-1] == ('E5', Fr(1, 2))


def test_level_zero_and_bounds():
    x = score([[n('C5', Fr(7, 2)), n('R', Fr(1, 2))]])
    assert sr.smooth(x, 0)[0] == x
    for level in range(0, 101, 5):
        out, *_ = sr.smooth(x, level)
        ok(x, out)


def test_ndp_like_bar_keeps_harmony_and_lyrics():
    h = '<harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>'
    x = score([[n('G4', Fr(7, 4), lyric='we'), n('R', Fr(1, 4)), h + n('B4', Fr(3, 2), lyric='are'), n('R', Fr(1, 2))]], [[n('G2', 4, 2)]])
    out, *_ = sr.smooth(x, 80)
    ok(x, out)
    assert out.count('<harmony>') == 1 and [e.text for e in ET.fromstring(out.encode()).iter('text')] == ['we', 'are']
    kids = [e.tag for e in ET.fromstring(out.encode()).find('part/measure')]
    assert kids.index('harmony') < [i for i, k in enumerate(kids) if k == 'note'][-2]
