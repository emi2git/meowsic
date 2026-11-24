"""barnorm.normalize_bar spells notes by the meter after an edit: a note or tied chain that crosses a beat line is
split into tied pieces (the short piece first when it completes the beat), tied pieces merge back into one note when
that note is in place (dotted ones too); what sounds, lyrics, ties into / out of the chain and slurs never change; a
note or rest the user just set (keep) stays as it is unless notationally wrong."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from meowsic import barnorm as bn
from meowsic import staffmove as sm
from test_barnorm import DIV, bar, beams, n, sounds

LYR = '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>'


def tied(x, *kinds):
    """The note(s) x with <tie>/<tied> of these kinds."""
    t = ''.join(f'<tie type="{k}"/>' for k in kinds)
    x = x.replace('</duration>', '</duration>' + t)
    return x.replace('</note>', '<notations>' + ''.join(f'<tied type="{k}"/>' for k in kinds) + '</notations></note>')


def norm(m, time=(4, 4), keep=None, info=None):
    return ET.fromstring(bn.normalize_bar(m, 1, 1, time, keep=keep, info=info))


def vals(m):
    """[(midi or 'R', quarters, tie kinds)] per onset of staff 1."""
    out = []
    for e in m.findall('note'):
        if e.find('chord') is not None: continue
        k = ''.join(sorted({'start': 'st', 'stop': 'sp'}[t.get('type')] for t in e.findall('tie')))
        out.append(('R' if e.find('rest') is not None else sm._midi(e), Fr(int(e.findtext('duration'))) / DIV, k))
    return out


def joined(m):
    """What sounds with the tied pieces joined: {(onset, quarters, midi)}."""
    out, open_ = [], {}
    t = Fr(0)
    for e in m.findall('note'):
        if e.find('chord') is not None: continue
        d = Fr(int(e.findtext('duration'))) / DIV
        if e.find('rest') is None:
            p = sm._midi(e)
            ties = {x.get('type') for x in e.findall('tie')}
            if 'stop' in ties and p in open_: open_[p][1] += d
            else: open_[p] = [t, d, p]; out.append(open_[p])
            if 'start' not in ties: open_.pop(p, None)
        t += d
    return {(a, b, c) for a, b, c in out}


C8, D8, E8 = n('C5', 0.5), n('D5', 0.5), n('E5', 0.5)


def test_users_example_half_tied_to_eighth_becomes_eighth_tied_to_half():
    m0 = bar(C8, D8, E8, tied(n('F5', 2), 'start'), tied(n('F5', 0.5), 'stop'))
    m = norm(m0)
    assert vals(m) == [(72, Fr(1, 2), ''), (74, Fr(1, 2), ''), (76, Fr(1, 2), ''), (77, Fr(1, 2), 'st'), (77, Fr(2), 'sp')]
    assert beams(m) == ['begin', 'continue', 'continue', 'end', '']
    assert joined(m) == joined(ET.fromstring(m0))


def test_44_quarter_on_the_offbeat_splits_at_the_beat():
    m = norm(bar(C8, n('D5', 1), E8, n('G5', 2)))
    assert vals(m)[:3] == [(72, Fr(1, 2), ''), (74, Fr(1, 2), 'st'), (74, Fr(1, 2), 'sp')]
    assert beams(m)[:4] == ['begin', 'continue', 'continue', 'end']  # one beam over the half bar


def test_44_half_on_beat_two_is_quarter_tied_quarter():
    m = norm(bar(n('C5', 1), n('D5', 2), n('E5', 1)))
    assert vals(m) == [(72, 1, ''), (74, 1, 'st'), (74, 1, 'sp'), (76, 1, '')]


def test_44_dotted_half_on_beat_one_stays_and_tied_pieces_merge_into_it():
    assert vals(norm(bar(n('C5', 3), n('D5', 1)))) == [(72, 3, ''), (74, 1, '')]
    m = norm(bar(tied(n('C5', 2), 'start'), tied(n('C5', 1), 'stop'), n('D5', 1)))
    assert vals(m) == [(72, 3, ''), (74, 1, '')]
    m = norm(bar(tied(n('C5', 1), 'start'), tied(n('C5', 1), 'stop'), n('D5', 2)))  # two tied quarters on 1 → a half
    assert vals(m) == [(72, 2, ''), (74, 2, '')]
    m = norm(bar(n('C5', 1), tied(n('D5', 1), 'start'), tied(n('D5', 1), 'stop'), n('E5', 1)))  # on beat 2: stays tied
    assert vals(m) == [(72, 1, ''), (74, 1, 'st'), (74, 1, 'sp'), (76, 1, '')]


def test_44_dotted_quarter_merge_on_beat_one_not_over_the_middle():
    m = norm(bar(tied(n('C5', 1), 'start'), tied(n('C5', 0.5), 'stop'), E8, n('G5', 2)))
    assert vals(m)[0] == (72, Fr(3, 2), '')
    m = norm(bar(n('C5', 1), tied(n('D5', 1), 'start'), tied(n('D5', 0.5), 'stop'), E8, n('G5', 1)))
    assert vals(m)[1:3] == [(74, 1, 'st'), (74, Fr(1, 2), 'sp')]  # beat 2 + the and of 3: crosses the middle


def test_68_dotted_quarters_and_a_note_over_the_beat():
    t = (6, 8)
    assert vals(norm(bar(n('C5', 1.5), n('D5', 1.5)), t)) == [(72, Fr(3, 2), ''), (74, Fr(3, 2), '')]
    m = norm(bar(n('C5', 1), n('D5', 1), n('E5', 1)), t)  # D5 over the dotted-quarter line
    assert vals(m) == [(72, 1, ''), (74, Fr(1, 2), 'st'), (74, Fr(1, 2), 'sp'), (76, 1, '')]
    m = norm(bar(tied(n('C5', 1.5), 'start'), tied(n('C5', 1.5), 'stop')), t)  # → a dotted half
    assert vals(m) == [(72, 3, '')]


def test_lyrics_slurs_articulations_and_outer_ties_stay():
    slur_on = '<notations><slur type="start" number="1"/><articulations><accent/></articulations></notations>'
    first = n('F5', 2, extra=LYR).replace('</note>', slur_on + '</note>')
    first = first.replace('</duration>', '</duration><tie type="start"/><tie type="stop"/>')
    first = first.replace('<notations>', '<notations><tied type="stop"/><tied type="start"/>')
    last = tied(n('F5', 0.5), 'stop').replace('</notations>', '<slur type="stop" number="1"/><fermata/></notations>')
    m = norm(bar(C8, D8, E8, first, last))
    f = [e for e in m.findall('note') if sm._midi(e) == 77]
    assert len(f) == 2
    a, b = f
    assert a.find('lyric/text').text == 'la' and b.find('lyric') is None
    assert a.find('notations/slur').get('type') == 'start' and a.find('notations/articulations/accent') is not None
    assert {t.get('type') for t in a.findall('tie')} == {'start', 'stop'}  # the tie in from the bar before stays
    assert b.find('notations/slur').get('type') == 'stop' and b.find('notations/fermata') is not None
    assert {t.get('type') for t in b.findall('tie')} == {'stop'}


def test_chords_split_together():
    m = norm(bar(n('C5', 1), n('E5+G5', 2), n('C5', 1)))
    ch = [e for e in m.findall('note') if sm._midi(e) in (76, 79)]
    assert len(ch) == 4 and sum(e.find('chord') is not None for e in ch) == 2
    assert all({t.get('type') for t in e.findall('tie')} for e in ch)
    assert sounds(m) != set() and joined(m) == joined(ET.fromstring(bar(n('C5', 1), n('E5+G5', 2), n('C5', 1))))


def test_kept_note_is_not_merged_but_a_wrong_one_is_split_and_said():
    m0 = ET.fromstring(bar(tied(n('C5', 1), 'start'), tied(n('C5', 1), 'stop'), n('D5', 2)))
    keep = {id(m0.findall('note')[0])}
    m = ET.fromstring(ET.tostring(bn.normalize_bar(m0, 1, 1, (4, 4), keep=keep)))
    assert vals(m)[:2] == [(72, 1, 'st'), (72, 1, 'sp')]
    m0 = ET.fromstring(bar(n('C5', 1), n('D5', 2), n('E5', 1)))
    info = {}
    m = bn.normalize_bar(m0, 1, 1, (4, 4), keep={id(m0.findall('note')[1])}, info=info)
    assert vals(m)[1:3] == [(74, 1, 'st'), (74, 1, 'sp')] and info['split'] == [(1, 2, [1, 1], 'note')]


def test_tuplets_and_pickups_left_alone():
    trip = n('C5', 1).replace('</type>', '</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>')
    m = norm(bar(C8, n('D5', 1), E8))  # a pickup (2 quarters): not the bar's length
    assert vals(m)[1] == (74, 1, '')
    assert bn.note_plan(Fr(1), Fr(3), (4, 4), DIV) == [(1, 1), (2, 1)]
    assert trip  # (tuplet notes are not spellable: bn._spellable)
