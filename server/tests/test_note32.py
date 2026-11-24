"""32nd notes and rests in Edit notes: op 'len' with q 1/8 (and a dotted 32nd, 3/16) works in any score — a score
counted in coarse <divisions> (2 per quarter) gets a finer unit first (divisions.py), with every duration, backup
and forward scaled so nothing moves. The bar is tidied with 32nd rests and beams (level 3), copy / paste of 32nds
into a coarse score, a short bar's time signature in 32nds, and the timing (on / dur) of everything else unchanged."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from meowsic import staffmove as sm
from meowsic import rangeops as ro
from meowsic.divisions import fit_divisions, fit_text


def coarse(rh, lh, div=2, time=(4, 4)):
    """A one-bar piano score in `div` divisions per quarter. rh / lh: [(step+octave | 'R', quarters, type)]."""
    def notes(xs, staff):
        out = ''
        for p, q, ty in xs:
            d = int(Fr(q) * div)
            if p == 'R': out += f'<note><rest/><duration>{d}</duration><voice>{staff}</voice><type>{ty}</type><staff>{staff}</staff></note>'
            else: out += (f'<note><pitch><step>{p[0]}</step><octave>{p[-1]}</octave></pitch><duration>{d}</duration>'
                          f'<voice>{staff}</voice><type>{ty}</type><staff>{staff}</staff></note>')
        return out
    L = int(Fr(4 * time[0], time[1]) * div)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
            f'<measure number="1"><attributes><divisions>{div}</divisions><time><beats>{time[0]}</beats><beat-type>{time[1]}</beat-type></time><staves>2</staves>'
            '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
            f'<direction placement="above"><direction-type><words>x</words></direction-type><offset>{div}</offset></direction>'
            f'{notes(rh, 1)}<backup><duration>{L}</duration></backup>{notes(lh, 2)}</measure></part></score-partwise>')


X = coarse([('C5', 1, 'quarter'), ('D5', 1, 'quarter'), ('E5', 2, 'half')], [('C3', 4, 'whole')])


def ns(t): return sm.notes(ET.fromstring(t.encode()))


def staff(t, s):
    return [('R' if x.get('rest') else x['midi'], Fr(x['on']).limit_denominator(256), Fr(x['dur']).limit_denominator(256))
            for x in sorted(ns(t), key=lambda x: (x['on'], x['midi'] or 0)) if x['staff'] == s]


def ref(t, s, midi):
    return next(x['ref'] for x in ns(t) if x['staff'] == s and x['midi'] == midi)


def div_of(t): return int(ET.fromstring(t.encode()).findtext('.//divisions'))


def run(t, op):
    info = {}
    out, touched, _ = sm.edit_ex(t, op, info)
    return out, touched, info


def full(t):
    for s in (1, 2): assert sum(d for _, _, d in staff(t, s)) == 4, staff(t, s)
    return True


def test_fit_divisions_scales_everything_and_moves_nothing():
    r = ET.fromstring(X.encode())
    before = [(x['staff'], x['midi'], x['on'], x['dur']) for x in sm.notes(r)]
    assert fit_divisions(r, [Fr(1, 8)]) == 4
    assert r.findtext('.//divisions') == '8' and r.findtext('.//backup/duration') == '32' and r.findtext('.//offset') == '8'
    assert [(x['staff'], x['midi'], x['on'], x['dur']) for x in sm.notes(r)] == before
    assert fit_divisions(r, [Fr(1, 8), Fr(1, 4)]) == 1  # fine enough already
    assert fit_text(X, [Fr(3, 16)])[1] == 8 and fit_text(X, [1])[1] == 1


def test_a_note_made_a_32nd_in_a_coarse_score_leaves_32nd_16th_8th_rests():
    out, touched, _ = run(X, {'op': 'len', 'refs': [ref(X, 1, 72)], 'q': 0.125})
    assert div_of(out) >= 8
    assert staff(out, 1) == [(72, 0, Fr(1, 8)), ('R', Fr(1, 8), Fr(1, 8)), ('R', Fr(1, 4), Fr(1, 4)), ('R', Fr(1, 2), Fr(1, 2)),
                             (74, 1, 1), (76, 2, 2)] and full(out)
    assert staff(out, 2) == staff(X, 2)
    m = ET.fromstring(out.encode()).find('part/measure')
    types = [e.findtext('type') for e in m.findall('note') if e.findtext('staff') == '1']
    assert types == ['32nd', '32nd', '16th', 'eighth', 'quarter', 'half']
    assert [x['ref'] for x in ns(out) if x['ref'] in touched] == [ref(out, 1, 72)]


def test_dotted_32nd_and_a_32nd_rest():
    out, _, _ = run(X, {'op': 'len', 'refs': [ref(X, 1, 72)], 'q': 0.1875})
    assert div_of(out) % 16 == 0
    assert staff(out, 1)[0] == (72, 0, Fr(3, 16)) and full(out)
    m = ET.fromstring(out.encode()).find('part/measure')
    first = m.find('note')
    assert first.findtext('type') == '32nd' and len(first.findall('dot')) == 1
    # a rest made a 32nd: the rest of the beat is a rest after it
    y = coarse([('R', 1, 'quarter'), ('D5', 1, 'quarter'), ('E5', 2, 'half')], [('C3', 4, 'whole')])
    r = next(x['ref'] for x in ns(y) if x['staff'] == 1 and x.get('rest'))
    out, _, _ = run(y, {'op': 'len', 'refs': [r], 'q': 0.125})
    assert staff(out, 1)[0] == ('R', 0, Fr(1, 8)) and sum(d for p, _, d in staff(out, 1) if p == 'R') == 1 and full(out)


def test_four_32nds_beam_together_with_three_beam_levels():
    t = X  # C5 → a 32nd, then each rest after it a 32nd and a note (as typed: 1, then a letter)
    out, _, _ = run(t, {'op': 'len', 'refs': [ref(t, 1, 72)], 'q': 0.125})
    for midi in (74, 76, 77):
        r = next(x['ref'] for x in sorted(ns(out), key=lambda x: x['on']) if x['staff'] == 1 and x.get('rest'))
        out, _, _ = run(out, {'op': 'len', 'refs': [r], 'q': 0.125})
        out, _, _ = run(out, {'op': 'set', 'refs': [r], 'midis': [midi]})
    assert [p for p, _, _ in staff(out, 1)[:4]] == [72, 74, 76, 77] and all(d == Fr(1, 8) for _, _, d in staff(out, 1)[:4])
    full(out)
    m = ET.fromstring(out.encode()).find('part/measure')
    first4 = [e for e in m.findall('note') if e.findtext('staff') == '1'][:4]
    for level in ('1', '2', '3'):
        assert [next((b.text for b in e.findall('beam') if b.get('number') == level), '') for e in first4] == ['begin', 'continue', 'continue', 'end']


def test_paste_32nds_into_a_coarse_score_raises_its_divisions():
    fine, _, _ = run(X, {'op': 'len', 'refs': [ref(X, 1, 72)], 'q': 0.125})
    clip = ro.clip_of(fine, [0, 0], [0, 1], [1, 1])  # beat 1 of the right hand: a 32nd and its rests
    y = coarse([('G4', 2, 'half'), ('A4', 2, 'half')], [('C3', 4, 'whole')])
    out, _, _ = run(y, {'op': 'paste', 'at': [0, 2], 'staff': 1, 'clip': clip})
    assert div_of(out) >= 8
    s = staff(out, 1)
    assert s[0] == (67, 0, 2) and (72, 2, Fr(1, 8)) in s and full(out)


def two_bars():
    root = ET.fromstring(X.encode())
    part = root.find('part')
    m2 = ET.fromstring(ET.tostring(part.find('measure')))
    m2.set('number', '2')
    m2.remove(m2.find('attributes')); m2.remove(m2.find('direction'))
    part.append(m2)
    return sm._head(X) + ET.tostring(root, encoding='unicode')


def test_a_bar_left_a_32nd_short_says_so_and_gets_its_own_time():
    t = two_bars()
    c2 = [x['ref'] for x in ns(t) if x['staff'] == 1 and x['midi'] == 72][1]
    out, _, _ = run(t, {'op': 'len', 'refs': [c2], 'q': 0.125})
    r = next(x['ref'] for x in sorted(ns(out), key=lambda x: x['on']) if x['staff'] == 1 and x.get('rest') and x['bar'] == 1)
    out, _, _ = run(out, {'op': 'restdel', 'refs': [r], 'how': 'close'})
    bad = sm.incomplete_bars(ET.fromstring(out.encode()))
    assert [(b['bar'], b['words']) for b in bad] == [(2, '3.875 of 4 beats')]
    assert sm._time_for(Fr(31, 8)) == (31, 32)
    out, _, _ = run(out, {'op': 'fillbar', 'bar': 1})  # Fill with rest: a 32nd rest closes it
    s2 = [x for x in ns(out) if x['staff'] == 1 and x['bar'] == 1]
    assert sum(Fr(x['dur']).limit_denominator(256) for x in s2) == 4 and any(x.get('rest') and abs(x['dur'] - 0.125) < 1e-9 for x in s2)
    assert not sm.incomplete_bars(ET.fromstring(out.encode()))


def test_a_32nd_dragged_one_32nd_later_and_32nds_in_six_eight():
    out, _, _ = run(X, {'op': 'len', 'refs': [ref(X, 1, 72)], 'q': 0.125})
    out, _, _ = run(out, {'op': 'shift', 'refs': [ref(out, 1, 72)], 'bar': 0, 'on': 0.125})
    s = staff(out, 1)
    assert s[:2] == [('R', 0, Fr(1, 8)), (72, Fr(1, 8), Fr(1, 8))] and full(out)
    # 6/8: a 32nd on the first eighth; the rest of the first dotted-quarter group in rests, the second group stays
    y = coarse([('C5', 1.5, 'quarter'), ('D5', 1.5, 'quarter')], [('C3', 3, 'half')], time=(6, 8))
    y = y.replace('<type>quarter</type>', '<type>quarter</type><dot/>').replace('<type>half</type>', '<type>half</type><dot/>')
    out, _, _ = run(y, {'op': 'len', 'refs': [ref(y, 1, 72)], 'q': 0.125})
    s = staff(out, 1)
    assert s[0] == (72, 0, Fr(1, 8)) and sum(d for _, _, d in s) == 3 and s[-1] == (74, Fr(3, 2), Fr(3, 2))
