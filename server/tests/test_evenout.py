"""Even out (Edit notes op 'even', evenops.py): 2+ notes / rests one after the other in one voice become one length
each with the same total — dotted 8th + 16th (both orders) → two 8ths, dotted quarter + 8th → two quarters, quarter + 8th → two dotted 8ths, rests
too, 16ths in a score counted in 8ths (finer divisions). Pitches, lyrics, ties into / out of the group and slurs stay;
not one after the other, two staves, one note, already equal or a triplet-only split: refused."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm

TY = {Fr(4): ('whole', 0), Fr(3): ('half', 1), Fr(2): ('half', 0), Fr(3, 2): ('quarter', 1), Fr(1): ('quarter', 0), Fr(3, 4): ('eighth', 1),
      Fr(1, 2): ('eighth', 0), Fr(3, 8): ('16th', 1), Fr(1, 4): ('16th', 0)}


def score(rh, lh=(('C3', 4),), div=4):
    """One bar of 4/4 piano. rh / lh: [(pitch | 'R', quarters, extras)] extras: 'tie>' 'tie<' 'lyr' 'sl(' 'sl)'."""
    def notes(xs, staff):
        out = ''
        for x in xs:
            p, q, ex = x[0], Fr(x[1]), (x[2] if len(x) > 2 else '')
            ty, dots = TY[q]
            body = '<rest/>' if p == 'R' else f'<pitch><step>{p[0]}</step><octave>{p[-1]}</octave></pitch>'
            ties = ('<tie type="stop"/>' if 'tie<' in ex else '') + ('<tie type="start"/>' if 'tie>' in ex else '')
            nt = ('<tied type="stop"/>' if 'tie<' in ex else '') + ('<tied type="start"/>' if 'tie>' in ex else '') \
                + ('<slur type="start" number="1"/>' if 'sl(' in ex else '') + ('<slur type="stop" number="1"/>' if 'sl)' in ex else '')
            out += (f'<note>{body}<duration>{int(q * div)}</duration>{ties}<voice>{staff}</voice><type>{ty}</type>{"<dot/>" * dots}'
                    f'<staff>{staff}</staff>{f"<notations>{nt}</notations>" if nt else ""}'
                    f'{"<lyric number=\"1\"><syllabic>single</syllabic><text>la</text></lyric>" if "lyr" in ex else ""}</note>')
        return out
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
            f'<measure number="1"><attributes><divisions>{div}</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
            '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
            f'{notes(rh, 1)}<backup><duration>{16 * div // 4}</duration></backup>{notes(lh, 2)}</measure>'
            f'<measure number="2">{notes([("G4", 4, "tie<" if any("tie>" in (x[2] if len(x) > 2 else "") for x in rh[-1:]) else "")], 1)}'
            f'<backup><duration>{16 * div // 4}</duration></backup>{notes([("C3", 4)], 2)}</measure></part></score-partwise>')


def ns(t): return sm.notes(ET.fromstring(t.encode()))


def rh(t, bar=0):
    return [('R' if x.get('rest') else x['midi'], Fr(x['on']).limit_denominator(256), Fr(x['dur']).limit_denominator(256))
            for x in ns(t) if x['staff'] == 1 and x['bar'] == bar]


def refs(t, *ons, bar=0):
    return [x['ref'] for x in ns(t) if x['staff'] == 1 and x['bar'] == bar and Fr(x['on']).limit_denominator(256) in [Fr(o) for o in ons]]


def even(t, rs):
    info = {}
    out, touched, gone = sm.edit_ex(t, {'op': 'even', 'refs': rs}, info)
    return out, touched, gone


def full(t):
    for s in (1, 2):
        for b in (0, 1):
            assert sum(Fr(x['dur']).limit_denominator(256) for x in ns(t) if x['staff'] == s and x['bar'] == b) == 4
    return True


def test_dotted_eighth_and_16th_become_two_eighths():
    t = score([('E5', '3/4'), ('F5', '1/4'), ('G5', 1), ('A5', 2)])
    out, touched, gone = even(t, refs(t, 0, '3/4'))
    assert rh(out)[:2] == [(76, 0, Fr(1, 2)), (77, Fr(1, 2), Fr(1, 2))]
    assert rh(out)[2:] == rh(t)[2:] and full(out) and len(touched) == 2 and gone == 0
    assert '<dot' not in ET.tostring(ET.fromstring(out.encode()).findall('.//measure')[0]).decode()


def test_scotch_snap_reversed_order():
    t = score([('E5', '1/4'), ('F5', '3/4'), ('G5', 1), ('A5', 2)])
    out, _, _ = even(t, refs(t, 0, '1/4'))
    assert rh(out)[:2] == [(76, 0, Fr(1, 2)), (77, Fr(1, 2), Fr(1, 2))] and full(out)


def test_dotted_quarter_and_eighth_become_two_quarters_and_quarter_eighth_two_dotted_eighths():
    t = score([('E5', '3/2'), ('F5', '1/2'), ('A5', 2)])
    out, _, _ = even(t, refs(t, 0, '3/2'))
    assert rh(out)[:2] == [(76, 0, 1), (77, 1, 1)] and full(out)
    t = score([('E5', 1), ('F5', '1/2'), ('G5', '1/2'), ('A5', 2)])
    out, _, _ = even(t, refs(t, 0, 1))
    # two dotted 8ths: the second may be written tied over beat 2 by the meter; it still sounds 3/4 from 3/4
    f5 = [(on, d) for m, on, d in rh(out) if m == 77]
    assert rh(out)[0] == (76, 0, Fr(3, 4)) and f5[0][0] == Fr(3, 4) and sum(d for _, d in f5) == Fr(3, 4) and full(out)


def test_rests_and_three_quarters_and_finer_divisions():
    t = score([('R', '3/4'), ('F5', '1/4'), ('G5', 1), ('A5', 2)])
    out, _, _ = even(t, refs(t, 0, '3/4'))
    assert rh(out)[:2] == [('R', 0, Fr(1, 2)), (77, Fr(1, 2), Fr(1, 2))] and full(out)
    t = score([('E5', '1/2'), ('F5', 1), ('G5', '3/2'), ('A5', 1)])  # 1/2 + 1 + 3/2 = 3 → three quarters
    out, _, _ = even(t, refs(t, 0, '1/2', '3/2'))
    assert [(m, on, d) for m, on, d in rh(out)][:3] == [(76, 0, 1), (77, 1, 1), (79, 2, 1)] and full(out)
    t = score([('E5', '1/2'), ('F5', '1/2'), ('G5', 3)], div=2)  # 8ths in a score counted in 8ths: 1/2 + 1/2 is equal already
    with pytest.raises(HTTPException, match='already'): even(t, refs(t, 0, '1/2'))
    t = score([('E5', 1), ('F5', '1/2'), ('G5', '1/2'), ('A5', 2)], div=2)  # → dotted 8ths need 16ths: divisions made finer
    out, _, _ = even(t, refs(t, 0, 1))
    assert int(ET.fromstring(out.encode()).findtext('.//divisions')) % 4 == 0 and rh(out)[0] == (76, 0, Fr(3, 4)) and full(out)


def test_pitches_ties_lyrics_slurs_kept():
    t = score([('C5', 2), ('E5', '3/2', 'lyr sl('), ('G4', '1/2', 'lyr sl) tie>')])
    out, _, gone = even(t, refs(t, 2, '7/2'))
    assert gone == 0 and full(out)
    root = ET.fromstring(out.encode())
    m1 = root.findall('.//measure')[0]
    rhn = [n for n in m1.findall('note') if n.findtext('staff') == '1']
    assert sum(len(n.findall('lyric')) for n in rhn) == 2
    assert any(n.find('notations/slur[@type="start"]') is not None for n in rhn) and any(n.find('notations/slur[@type="stop"]') is not None for n in rhn)
    last = [n for n in rhn if n.find('pitch') is not None and n.findtext('pitch/step') == 'G'][-1]
    assert last.find('tie[@type="start"]') is not None  # the tie out to bar 2 stays
    assert sorted({m for m, _, _ in rh(out)}) == [67, 72, 76]


def test_refusals():
    t = score([('E5', '3/4'), ('F5', '1/4'), ('G5', 1), ('A5', 2)])
    with pytest.raises(HTTPException, match='2 or more'): even(t, refs(t, 0))
    with pytest.raises(HTTPException, match='one after the other'): even(t, refs(t, 0, 1))
    lh = next(x['ref'] for x in ns(t) if x['staff'] == 2 and x['bar'] == 0)
    with pytest.raises(HTTPException, match='one hand'): even(t, refs(t, 0) + [lh])
    with pytest.raises(HTTPException, match='one bar'): even(t, refs(t, 2) + refs(t, 0, bar=1))
    t = score([('E5', '1/2'), ('F5', '1/4'), ('G5', '1/4'), ('A5', 3)])  # 3 notes over a quarter: a triplet
    with pytest.raises(HTTPException, match='triplet'): even(t, refs(t, 0, '1/2', '3/4'))


def test_through_apply_ops_is_one_step():
    t = score([('E5', '3/4'), ('F5', '1/4'), ('G5', 1), ('A5', 2)])
    out, moved = sm.apply_ops(t, [{'op': 'even', 'refs': refs(t, 0, '3/4')}])
    assert rh(out)[:2] == [(76, 0, Fr(1, 2)), (77, Fr(1, 2), Fr(1, 2))] and len(moved) == 2
    assert sm._what([{'op': 'even', 'refs': [1, 2]}]) == '2 notes evened out'
