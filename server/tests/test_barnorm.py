"""barnorm.normalize_bar: beams by beat group (4/4, 3/4, 6/8, 2/4 …) and rests joined into the largest rests that keep
the beat — pitches, onsets and what sounds never change; lyrics, ties, chords and dynamics stay on their notes."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from meowsic import barnorm as bn
from meowsic import staffmove as sm

DIV = 8  # divisions per quarter (room for 32nds)
TY = {Fr(1, 8): ('32nd', 0), Fr(1, 4): ('16th', 0), Fr(3, 8): ('16th', 1), Fr(1, 2): ('eighth', 0), Fr(3, 4): ('eighth', 1),
      Fr(1): ('quarter', 0), Fr(3, 2): ('quarter', 1), Fr(2): ('half', 0), Fr(3): ('half', 1), Fr(4): ('whole', 0)}


def n(x, q, staff=1, voice=1, extra='', beam=''):
    """x: 'C5' | 'R' | 'C5+E5'; q quarters."""
    q = Fr(q)
    t, dots = TY[q]
    tail = f'<duration>{int(q * DIV)}</duration><voice>{voice}</voice><type>{t}</type>' + '<dot/>' * dots + f'<staff>{staff}</staff>{beam}'
    if x == 'R': return f'<note><rest/>{tail}</note>'
    out = ''
    for k, p in enumerate(x.split('+')):
        out += f'<note>{"<chord/>" if k else ""}<pitch><step>{p[0]}</step><octave>{p[-1]}</octave></pitch>{tail}{extra if not k else ""}</note>'
    return out


def bar(*notes, other=''):
    return f'<measure number="1"><attributes><divisions>{DIV}</divisions></attributes>{other}{"".join(notes)}</measure>'


def norm(m, time=(4, 4), staff=1, voice=1):
    return ET.fromstring(bn.normalize_bar(m, staff, voice, time))


def heads(m, staff='1'):
    """[(beam-1 text or '', midi or 'R', quarters)] per onset of the staff."""
    out = []
    for e in m.findall('note'):
        if e.find('chord') is not None or (e.findtext('staff') or '1') != staff: continue
        b = next((x.text for x in e.findall('beam') if x.get('number') == '1'), '')
        out.append((b, 'R' if e.find('rest') is not None else sm._midi(e), Fr(int(e.findtext('duration'))) / DIV))
    return out


def beams(m, staff='1'):
    return [b for b, _, _ in heads(m, staff)]


def rests(m, staff='1'):
    return [(q, e.find('rest').get('measure') == 'yes', e.findtext('type'), len(e.findall('dot')))
            for e in m.findall('note') if e.find('rest') is not None and (e.findtext('staff') or '1') == staff
            for q in [Fr(int(e.findtext('duration'))) / DIV]]


def sounds(m):
    """{(staff, onset, quarters, midi)} — what sounds."""
    root = ET.fromstring(f'<score-partwise><part id="P1">{ET.tostring(m, encoding="unicode")}</part></score-partwise>')
    return {(x['staff'], x['on'], x['dur'], x['midi']) for x in sm.notes(root) if not x.get('rest')}


E8 = lambda p: n(p, 0.5)
S16 = lambda p: n(p, 0.25)


# ---------- beams ----------

def test_44_eighths_beam_per_half_bar():
    m = norm(bar(*[E8(p) for p in ('C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6')]))
    assert beams(m) == ['begin', 'continue', 'continue', 'end'] * 2


def test_44_never_across_the_middle():
    # quarter, 8th 8th | 8th 8th quarter: the 8ths on beats 2 and 3 are in different halves
    m = norm(bar(n('C5', 1), E8('D5'), E8('E5'), E8('F5'), E8('G5'), n('A5', 1)))
    assert beams(m) == ['', 'begin', 'end', 'begin', 'end', '']


def test_44_sixteenths_beam_per_beat_in_that_half():
    m = norm(bar(S16('C5'), S16('D5'), E8('E5'), E8('F5'), E8('G5'), E8('A5'), E8('B5'), E8('C6'), E8('D6')))
    assert beams(m) == ['begin', 'continue', 'end', 'begin', 'end', 'begin', 'continue', 'continue', 'end']
    first = m.findall('note')[0]
    assert [(b.get('number'), b.text) for b in first.findall('beam')] == [('1', 'begin'), ('2', 'begin')]
    second = m.findall('note')[1]
    assert [(b.get('number'), b.text) for b in second.findall('beam')] == [('1', 'continue'), ('2', 'end')]


def test_44_rest_and_quarter_break_beams():
    m = norm(bar(E8('C5'), n('R', 0.5), E8('D5'), E8('E5'), E8('F5'), n('G5', 1), E8('A5')))
    assert beams(m) == ['', '', 'begin', 'end', '', '', '']


def test_44_dotted_eighth_sixteenth_hook():
    m = norm(bar(n('C5', 0.75), S16('D5'), n('E5', 1), n('F5', 2)))
    a, b = m.findall('note')[:2]
    assert [(x.get('number'), x.text) for x in a.findall('beam')] == [('1', 'begin')]
    assert [(x.get('number'), x.text) for x in b.findall('beam')] == [('1', 'end'), ('2', 'backward hook')]


def test_34_beams_per_beat():
    m = norm(bar(*[E8(p) for p in ('C5', 'D5', 'E5', 'F5', 'G5', 'A5')]), (3, 4))
    assert beams(m) == ['begin', 'end'] * 3


def test_68_beams_per_dotted_quarter():
    m = norm(bar(*[E8(p) for p in ('C5', 'D5', 'E5', 'F5', 'G5', 'A5')]), (6, 8))
    assert beams(m) == ['begin', 'continue', 'end'] * 2
    m = norm(bar(n('C5', 1), E8('D5'), S16('E5'), S16('F5'), E8('G5'), E8('A5')), (6, 8))
    assert beams(m) == ['', '', 'begin', 'continue', 'continue', 'end']


def test_24_bar_of_eighths_and_sixteenths():
    m = norm(bar(E8('C5'), E8('D5'), E8('E5'), E8('F5')), (2, 4))
    assert beams(m) == ['begin', 'continue', 'continue', 'end']
    m = norm(bar(E8('C5'), E8('D5'), S16('E5'), S16('F5'), E8('G5')), (2, 4))
    assert beams(m) == ['begin', 'end', 'begin', 'continue', 'end']


def test_stale_beams_go_and_chords_beam_on_their_first_note():
    stale = '<beam number="1">begin</beam>'
    m = norm(bar(n('C5', 1, beam=stale), n('D5', 1, beam='<beam number="1">end</beam>'), n('C5+E5', 0.5), n('D5+F5', 0.5), n('G5', 1)))
    ns = m.findall('note')
    assert not ns[0].findall('beam') and not ns[1].findall('beam')
    assert ns[2].findtext('beam') == 'begin' and ns[3].find('beam') is None and ns[4].findtext('beam') == 'end'


# ---------- rests ----------

def test_four_eighth_rests_on_the_half_bar_are_a_half_rest():
    m = norm(bar(n('C5', 1), n('D5', 1), *[n('R', 0.5)] * 4))
    assert rests(m) == [(Fr(2), False, 'half', 0)]
    m = norm(bar(*[n('R', 0.5)] * 4, n('C5', 2)))
    assert rests(m) == [(Fr(2), False, 'half', 0)]


def test_rests_keep_the_middle_of_a_44_bar():
    # beats 2-3 empty: quarter + quarter, not a half rest over the middle
    m = norm(bar(n('C5', 1), *[n('R', 0.5)] * 4, n('D5', 1)))
    assert rests(m) == [(Fr(1), False, 'quarter', 0)] * 2
    # off-beat: 8th rest then the beat
    m = norm(bar(E8('C5'), n('R', 0.25), n('R', 0.25), n('R', 0.5), n('R', 0.5), n('D5', 2)))
    assert rests(m) == [(Fr(1, 2), False, 'eighth', 0), (Fr(1), False, 'quarter', 0)]
    m = norm(bar(n('C5', 1), *[n('R', 1)] * 3))
    assert rests(m) == [(Fr(1), False, 'quarter', 0), (Fr(2), False, 'half', 0)]


def test_empty_bar_is_one_bar_rest():
    m = norm(bar(*[n('R', 0.5)] * 8))
    assert rests(m) == [(Fr(4), True, 'whole', 0)]
    m = norm(bar(*[n('R', 1)] * 3), (3, 4))
    assert [r[:2] for r in rests(m)] == [(Fr(3), True)]


def test_34_half_rest_on_beats_one_two_only():
    m = norm(bar(n('R', 1), n('R', 1), n('C5', 1)), (3, 4))
    assert rests(m) == [(Fr(2), False, 'half', 0)]
    m = norm(bar(n('C5', 1), n('R', 1), n('R', 1)), (3, 4))
    assert rests(m) == [(Fr(1), False, 'quarter', 0)] * 2


def test_68_dotted_rests_by_beat():
    m = norm(bar(n('C5', 1.5), *[n('R', 0.5)] * 3), (6, 8))
    assert rests(m) == [(Fr(3, 2), False, 'quarter', 1)]
    m = norm(bar(n('R', 0.5), n('R', 0.5), E8('C5'), n('D5', 1.5)), (6, 8))
    assert rests(m) == [(Fr(1), False, 'quarter', 0)]
    m = norm(bar(E8('C5'), n('R', 0.5), n('R', 0.5), n('D5', 1.5)), (6, 8))  # the last two eighths of a beat: two 8th rests
    assert rests(m) == [(Fr(1, 2), False, 'eighth', 0)] * 2
    m = norm(bar(n('R', 1.5), n('R', 1.5), n('C5', 3)), (12, 8))
    assert rests(m) == [(Fr(3), False, 'half', 1)]


def test_24_rests():
    m = norm(bar(n('C5', 0.5), n('R', 0.5), n('R', 0.5), n('R', 0.5)), (2, 4))
    assert rests(m) == [(Fr(1, 2), False, 'eighth', 0), (Fr(1), False, 'quarter', 0)]


def test_rest_with_a_fermata_and_other_voices_stay():
    ferm = '<notations><fermata/></notations>'
    m = bar(n('C5', 1), n('R', 1), f'<note><rest/><duration>{DIV}</duration><voice>1</voice><type>quarter</type><staff>1</staff>{ferm}</note>', n('R', 1),
            f'<backup><duration>{4 * DIV}</duration></backup>', *[n('R', 0.5, 2, 5)] * 8)
    out = norm(m)
    assert rests(out) == [(Fr(1), False, 'quarter', 0)] * 3  # the fermata rest keeps the others apart
    assert len(rests(out, '2')) == 8  # the left hand was not asked for


# ---------- what must not change ----------

def test_pitches_onsets_lyrics_ties_dynamics_stay():
    lyr = '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>'
    tie = '<notations><tied type="start"/></notations>'
    dyn = '<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff></direction>'
    m = bar(E8('C5'), n('R', 0.5), n('R', 0.5), n('D5', 0.5, extra=lyr), n('E5+G5', 0.5, extra=tie), E8('F5'), n('R', 1), other=dyn)
    m = m.replace('<duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff><notations><tied', '<duration>4</duration><tie type="start"/><voice>1</voice><type>eighth</type><staff>1</staff><notations><tied')
    before = ET.fromstring(m)
    out = norm(m)
    assert sounds(out) == sounds(before)
    d5 = next(e for e in out.findall('note') if sm._midi(e) == 74)
    assert d5.find('lyric/text').text == 'la'
    e5 = next(e for e in out.findall('note') if sm._midi(e) == 76)
    assert e5.find('tie').get('type') == 'start' and e5.find('notations/tied') is not None
    g5 = next(e for e in out.findall('note') if sm._midi(e) == 79)
    assert g5.find('chord') is not None
    assert out.find('direction/direction-type/dynamics/p') is not None
    # 8th rests on the off-beat of 1 and on 2: 8th + 8th (beat 2 starts on the second)
    assert rests(out) == [(Fr(1, 2), False, 'eighth', 0), (Fr(1, 2), False, 'eighth', 0), (Fr(1), False, 'quarter', 0)]
    assert beams(out) == ['', '', '', '', 'begin', 'end', '']


def test_pickup_bar_keeps_its_rests():
    m = norm(bar(n('R', 0.5), n('R', 0.5), n('C5', 1)))  # 2 quarters in a 4/4 song
    assert len(rests(m)) == 2


# ---------- in Edit notes (staffmove.edit) ----------

def piano(rh, lh, time=(4, 4)):
    L = int(Fr(4 * time[0], time[1]) * DIV)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
            f'<measure number="1"><attributes><divisions>{DIV}</divisions><time><beats>{time[0]}</beats><beat-type>{time[1]}</beat-type></time><staves>2</staves>'
            '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
            f'{"".join(rh)}<backup><duration>{L}</duration></backup>{"".join(lh)}</measure></part></score-partwise>')


def lh_notes(text):
    return [x for x in sm.notes(ET.fromstring(text.encode())) if x['staff'] == 2]


def test_edit_left_hand_eighths_get_beamed_and_rests_join():
    lh = [n(p, 0.5, 2, 5) for p in ('C3', 'D3', 'E3', 'F3', 'G3', 'A3', 'B3', 'C4')]
    x = piano([n('C5', 4)], lh)
    assert not ET.fromstring(x.encode()).find('part/measure').findall('note/beam')
    # one left-hand pitch changed → its bar's left-hand voice is beamed in half bars
    c3 = next(r['ref'] for r in lh_notes(x) if r['midi'] == 48)
    out, _ = sm.edit(x, {'op': 'pitch', 'refs': [c3], 'by': 1})
    m = ET.fromstring(out.encode()).find('part/measure')
    assert beams(m, '2') == ['begin', 'continue', 'continue', 'end'] * 2
    assert m.find('note').find('beam') is None  # the right hand was not touched
    # the last four deleted → one half rest
    last4 = [r['ref'] for r in lh_notes(out) if r['on'] >= 2]
    out2, _ = sm.edit(out, {'op': 'delete', 'refs': last4})
    m = ET.fromstring(out2.encode()).find('part/measure')
    assert rests(m, '2') == [(Fr(2), False, 'half', 0)]
    assert beams(m, '2')[:4] == ['begin', 'continue', 'continue', 'end']


def test_edit_add_on_a_rest_beams_with_the_neighbour():
    x = piano([n('C5', 4)], [n('C3', 0.5, 2, 5), n('R', 0.5, 2, 5), n('E3', 1, 2, 5), n('G3', 2, 2, 5)])
    rest = next(r['ref'] for r in lh_notes(x) if r.get('rest'))
    out, _ = sm.edit(x, {'op': 'add', 'refs': [rest], 'midi': 50})
    m = ET.fromstring(out.encode()).find('part/measure')
    assert beams(m, '2') == ['begin', 'end', '', '']


def test_edit_shorter_left_hand_note_rests_by_beat():
    x = piano([n('C5', 4)], [n('C3', 2, 2, 5), n('G3', 2, 2, 5)])
    c3 = next(r['ref'] for r in lh_notes(x) if r['midi'] == 48)
    out, _ = sm.edit(x, {'op': 'len', 'refs': [c3], 'q': 0.5})
    m = ET.fromstring(out.encode()).find('part/measure')
    assert rests(m, '2') == [(Fr(1, 2), False, 'eighth', 0), (Fr(1), False, 'quarter', 0)]
    assert [r['midi'] for r in lh_notes(out) if not r.get('rest')] == [48, 55]


# ---------- the whole score: no repeated time / key / clef ----------

ATT = lambda inner: f'<attributes>{inner}</attributes>'
T44, T34 = '<time><beats>4</beats><beat-type>4</beat-type></time>', '<time><beats>3</beats><beat-type>4</beat-type></time>'
KC, KG = '<key><fifths>0</fifths></key>', '<key><fifths>1</fifths><mode>major</mode></key>'
G, F = '<clef number="1"><sign>G</sign><line>2</line></clef>', '<clef number="2"><sign>F</sign><line>4</line></clef>'


def song(*bars):
    ms = ''.join(f'<measure number="{i + 1}">{b}</measure>' for i, b in enumerate(bars))
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list><part id="P1">{ms}</part></score-partwise>'


def whole(p='C5', q=4): return n(p, q)


def test_repeated_time_key_clef_go_real_changes_stay():
    x = song(ATT(f'<divisions>{DIV}</divisions>{KC}{T44}<staves>1</staves>{G}') + whole(),
             ATT(f'{T44}') + whole(),                                  # 4/4 again: goes (and its empty attributes)
             ATT(f'<divisions>{DIV}</divisions>{KC}{T44}{G}') + whole(),  # all repeats: the attributes go
             ATT(T34) + whole('C5', 3),                                # a real change: stays
             ATT(f'{T34}{KG}') + whole('C5', 3),                       # 3/4 again goes, the new key stays
             ATT(f'{KG}{T44}') + whole())                              # key repeat goes, back to 4/4 stays
    out, st = bn.tidy_text(x)
    assert (st['time'], st['key'], st['clef'], st['other'], st['attributes']) == (3, 2, 1, 1, 2)
    ms = ET.fromstring(out.encode()).findall('part/measure')
    assert [len(m.findall('attributes/time')) for m in ms] == [1, 0, 0, 1, 0, 1]
    assert [len(m.findall('attributes/key')) for m in ms] == [1, 0, 0, 0, 1, 0]
    assert [len(m.findall('attributes')) for m in ms] == [1, 0, 0, 1, 1, 1]
    assert sounds(ms[0]) == sounds(ET.fromstring(x.encode()).findall('part/measure')[0])


def test_nothing_to_tidy_gives_the_same_text():
    x = song(ATT(f'<divisions>{DIV}</divisions>{KC}{T44}{G}') + whole(), whole())
    out, st = bn.tidy_text(x)
    assert out == x and not st['overfull']


def test_a_clef_change_and_back_both_stay():
    x = song(ATT(f'<divisions>{DIV}</divisions>{T44}<staves>2</staves>{G}{F}') + whole(),
             ATT('<clef number="2"><sign>G</sign><line>2</line></clef>') + whole(),
             ATT(F) + whole(), ATT(F) + whole())
    out, st = bn.tidy_text(x)
    assert st['clef'] == 1
    assert [len(m.findall('attributes/clef')) for m in ET.fromstring(out.encode()).findall('part/measure')] == [2, 1, 1, 0]


def test_short_voice_in_an_edited_bar_gets_rests_overfull_is_reported():
    short = song(ATT(f'<divisions>{DIV}</divisions>{T44}') + n('C5', 1) + n('D5', 1) + f'<backup><duration>{2 * DIV}</duration></backup>' + n('C3', 4, 1, 2))
    out, st = bn.tidy_text(short, fill={(0, 0)})
    m = ET.fromstring(out.encode()).find('part/measure')
    v1 = [Fr(int(e.findtext('duration'))) / DIV for e in m.findall('note') if e.findtext('voice') == '1']
    assert st['filled'] == 1 and v1 == [1, 1, 2] and rests(m) == [(Fr(2), False, 'half', 0)]
    out, st = bn.tidy_text(short)  # not an edited bar: left alone
    assert st['filled'] == 0
    over = song(ATT(f'<divisions>{DIV}</divisions>{T44}') + whole() + n('D5', 1))
    out, st = bn.tidy_text(over)
    assert st['overfull'] == [(0, '1')] and out == over  # never stretched or cut


def test_edit_drops_a_repeated_time_signature():
    x = piano([n('C5', 4)], [n('C3', 4, 2, 5)])
    x = x.replace('</measure></part>', f'</measure><measure number="2">{ATT(T44 + G)}{n("D5", 4)}<backup><duration>{4 * DIV}</duration></backup>{n("D3", 4, 2, 5)}</measure></part>')
    c5 = next(r['ref'] for r in sm.notes(ET.fromstring(x.encode())) if r['midi'] == 72)
    out, _ = sm.edit(x, {'op': 'pitch', 'refs': [c5], 'by': 2})
    ms = ET.fromstring(out.encode()).findall('part/measure')
    assert len(ms[0].findall('attributes/time')) == 1 and not ms[1].findall('attributes')
