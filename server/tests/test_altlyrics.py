"""The alt edit (a bar replaced by another reading) keeps the bar's words BY TIME, not by note order
(barcheck.carry_lyrics): a fill note put in before the sung notes must not shift every syllable on."""
import xml.etree.ElementTree as ET

from meowsic import staffmove as sm

TYPES = {16: 'whole', 12: 'half', 8: 'half', 6: 'quarter', 4: 'quarter', 2: 'eighth', 1: '16th'}


def n(p, dur, words=(), voice=1, staff=1, chord=False, tie=None):
    """A note (p 'C4', or None for a rest) at 4 divisions a quarter; words: [(number, text, syllabic, extend?)]."""
    head = '<chord/>' if chord else ''
    body = '<rest/>' if p is None else f'<pitch><step>{p[0]}</step><octave>{p[1]}</octave></pitch>'
    ties = ''.join(f'<tie type="{k}"/>' for k in (tie or '').split() if k)
    tied = ''.join(f'<tied type="{k}"/>' for k in (tie or '').split() if k)
    ly = ''.join(f'<lyric number="{num}"><syllabic>{syl}</syllabic><text>{txt}</text>{"<extend/>" if ext else ""}</lyric>'
                 for num, txt, syl, *rest in words for ext in [rest[0] if rest else False])
    dots = '<dot/>' if dur in (6, 12) else ''
    return (f'<note>{head}{body}<duration>{dur}</duration>{ties}<voice>{voice}</voice><type>{TYPES[dur]}</type>{dots}'
            f'<staff>{staff}</staff>{"<notations>" + tied + "</notations>" if tied else ""}{ly}</note>')


def back(d=16): return f'<backup><duration>{d}</duration></backup>'


def score(bar2, staves=1):
    clef = '<clef number="1"><sign>G</sign><line>2</line></clef>' + ('<clef number="2"><sign>F</sign><line>4</line></clef>' if staves == 2 else '')
    m1 = (f'<measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats>'
          f'<beat-type>4</beat-type></time><staves>{staves}</staves>{clef}</attributes>' + n('C4', 16, [(1, 'zero', 'single')]) + '</measure>')
    m3 = '<measure number="3">' + n('C4', 16) + '</measure>'
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name>'
            f'</score-part></part-list><part id="P1">{m1}<measure number="2">{bar2}</measure>{m3}</part></score-partwise>')


def alt(text, bar2):
    out, _ = sm.edit(text, {'op': 'alt', 'bar': 2, 'measure': f'<measure number="2">{bar2}</measure>'})
    return out


def words(text, number='1'):
    """[(staff, voice, onset in quarters, pitch, text, syllabic, extend)] of bar 2, for one lyric line."""
    m = ET.fromstring(text.encode()).findall('part/measure')[1]
    out, t, last = [], 0, 0
    for e in m:
        if e.tag == 'backup': t -= int(e.findtext('duration')); continue
        if e.tag == 'forward': t += int(e.findtext('duration')); continue
        if e.tag != 'note': continue
        at = last if e.find('chord') is not None else t
        if e.find('chord') is None: last, t = t, t + int(e.findtext('duration'))
        for ly in e.findall('lyric'):
            if (ly.get('number') or '1') != number: continue
            p = None if e.find('pitch') is None else e.findtext('pitch/step') + e.findtext('pitch/octave')
            out.append((e.findtext('staff') or '1', e.findtext('voice') or '1', at / 4, p, ly.findtext('text'),
                        ly.findtext('syllabic'), ly.find('extend') is not None))
    return out


def texts(text, number='1'):
    return [(on, p, w) for _, _, on, p, w, _, _ in words(text, number)]


SUNG = n(None, 4) + n('E4', 4, [(1, 'Hap', 'begin')]) + n('F4', 4, [(1, 'py', 'end')]) + n('G4', 4, [(1, 'day', 'single', True)])


def test_fill_before_the_sung_notes_keeps_each_word_on_its_beat():
    out = alt(score(SUNG), n('B3', 4) + n('E4', 4) + n('F4', 4) + n('G4', 4))
    assert texts(out) == [(1.0, 'E4', 'Hap'), (2.0, 'F4', 'py'), (3.0, 'G4', 'day')]  # by order it was B3, E4, F4
    w = words(out)
    assert [x[5] for x in w] == ['begin', 'end', 'single'] and [x[6] for x in w] == [False, False, True]


def test_fill_notes_split_a_beat():
    out = alt(score(SUNG), n('B3', 2) + n('D4', 2) + n('E4', 2) + n('D4', 2) + n('F4', 4) + n('G4', 4))
    assert texts(out) == [(1.0, 'E4', 'Hap'), (2.0, 'F4', 'py'), (3.0, 'G4', 'day')]  # D4 at 1.5 gets none


def test_same_onsets_same_result_as_before():
    out = alt(score(SUNG), n(None, 4) + n('A4', 4) + n('B4', 4) + n('C5', 4))
    assert texts(out) == [(1.0, 'A4', 'Hap'), (2.0, 'B4', 'py'), (3.0, 'C5', 'day')]


def test_rhythm_change_keeping_the_onsets():
    bar = n('C4', 4, [(1, 'a', 'single')]) + n('D4', 4, [(1, 'b', 'single')]) + n('E4', 8, [(1, 'c', 'single')])
    out = alt(score(bar), n('C4', 2) + n('C4', 2) + n('D4', 4) + n('E4', 4) + n('E4', 4))
    assert texts(out) == [(0.0, 'C4', 'a'), (1.0, 'D4', 'b'), (2.0, 'E4', 'c')]  # the new notes at 0.5 and 3 get none


def test_notes_removed():
    bar = n('C4', 4, [(1, 'a', 'single')]) + n('D4', 4, [(1, 'b', 'single')]) + n('E4', 4, [(1, 'c', 'single')]) + n('F4', 4, [(1, 'd', 'single')])
    out = alt(score(bar), n('C4', 8) + n('E4', 8))
    # b and d fall inside notes that keep their own words: no note left for them
    assert texts(out) == [(0.0, 'C4', 'a'), (2.0, 'E4', 'c')]


def test_word_inside_a_longer_note_goes_on_it_when_free():
    bar = n(None, 4) + n('D4', 4, [(1, 'b', 'single')]) + n('E4', 8, [(1, 'c', 'single')])
    out = alt(score(bar), n('C4', 8) + n('E4', 8))
    assert texts(out) == [(0.0, 'C4', 'b'), (2.0, 'E4', 'c')]  # C4 sounds at beat 1 and has no word


def test_rest_over_a_word_moves_it_to_the_next_free_note():
    bar = n('C4', 4, [(1, 'a', 'single')]) + n('D4', 4) + n('E4', 4, [(1, 'c', 'single')]) + n(None, 4)
    out = alt(score(bar), n(None, 4) + n('D4', 4) + n('E4', 4) + n(None, 4))
    assert texts(out) == [(1.0, 'D4', 'a'), (2.0, 'E4', 'c')]


def test_multi_verse_lines_each_go_by_time():
    bar = (n(None, 4) + n('E4', 4, [(1, 'one', 'single'), (2, 'uno', 'single')]) + n('F4', 4, [(1, 'two', 'begin'), (2, 'dos', 'single')])
           + n('G4', 4, [(2, 'tres', 'single')]))  # verse 1 holds on F4; verse 2 has a word on G4 too
    out = alt(score(bar), n('B3', 4) + n('E4', 4) + n('F4', 4) + n('G4', 4))
    assert texts(out, '1') == [(1.0, 'E4', 'one'), (2.0, 'F4', 'two')]
    assert texts(out, '2') == [(1.0, 'E4', 'uno'), (2.0, 'F4', 'dos'), (3.0, 'G4', 'tres')]
    assert words(out, '1')[1][5] == 'begin'
    m = ET.fromstring(out.encode()).findall('part/measure')[1]
    e4 = [e for e in m.findall('note') if e.findtext('pitch/step') == 'E'][0]
    assert [ly.get('number') for ly in e4.findall('lyric')] == ['1', '2']


def test_chords_and_voices_keep_their_own_words():
    bar = (n('E4', 8, [(1, 'top', 'single')]) + n('G4', 8, chord=True) + n('F4', 8, [(1, 'next', 'single')])
           + back() + n('C4', 4, [(1, 'low', 'single')], voice=2) + n('C4', 12, voice=2))
    new = (n('B3', 4) + n('E4', 4) + n('G4', 4, chord=True) + n('F4', 8)
           + back() + n('A3', 4, voice=2) + n('C4', 12, voice=2))
    out = alt(score(bar), new)
    w = words(out)
    assert sorted((v, on, p, t) for _, v, on, p, t, _, _ in w) == [('1', 0.0, 'B3', 'top'), ('1', 2.0, 'F4', 'next'), ('2', 0.0, 'A3', 'low')]
    # the old way put voice 2's word on voice 1: no word ever crosses voices now
    m = ET.fromstring(out.encode()).findall('part/measure')[1]
    assert not any(e.find('lyric') is not None for e in m.findall('note') if e.find('chord') is not None)


def test_word_on_a_chord_member_lands_on_the_new_chord():
    bar = n('E4', 16) + n('G4', 16, [(1, 'hm', 'single')], chord=True)
    out = alt(score(bar), n('E4', 8) + n('C5', 8, chord=True) + n('F4', 8))
    assert texts(out) == [(0.0, 'E4', 'hm')]


def test_two_staves_keep_their_words():
    bar = n('E4', 16, [(1, 'up', 'single')]) + back() + n('C3', 16, [(1, 'down', 'single')], voice=5, staff=2)
    out = alt(score(bar, staves=2), n('B3', 4) + n('E4', 12) + back() + n('C3', 16, voice=5, staff=2))
    assert sorted((s, on, p, t) for s, _, on, p, t, _, _ in words(out)) == [('1', 0.0, 'B3', 'up'), ('2', 0.0, 'C3', 'down')]


def test_tied_notes():
    # old: E4 "lo" held on (extend) over a tie, then F4 "ve"
    bar = n(None, 4) + n('E4', 4, [(1, 'lo', 'begin', True)], tie='start') + n('E4', 4, tie='stop') + n('F4', 4, [(1, 've', 'end')])
    # new: a fill in the rest, the same tie; the tied-into note is not struck, so it never takes a word
    out = alt(score(bar), n('B3', 4) + n('E4', 4, tie='start') + n('E4', 4, tie='stop') + n('F4', 4))
    assert texts(out) == [(1.0, 'E4', 'lo'), (3.0, 'F4', 've')]
    assert words(out)[0][5:] == ('begin', True)
    # the tie written as one half note: same words
    out = alt(score(bar), n('B3', 4) + n('E4', 8) + n('F4', 4))
    assert texts(out) == [(1.0, 'E4', 'lo'), (3.0, 'F4', 've')]
    # a tie now over the beat where "ve" was: it goes on the chain's head only if that is free; here it is not
    out = alt(score(bar), n('B3', 4) + n('E4', 4, tie='start') + n('E4', 8, tie='stop'))
    assert texts(out) == [(1.0, 'E4', 'lo')]


def test_word_on_a_beat_that_a_new_tie_holds_over():
    bar = n('C4', 4, [(1, 'a', 'single')]) + n('D4', 4) + n('E4', 4, [(1, 'c', 'single')]) + n('F4', 4, [(1, 'd', 'single')])
    # C4 tied over beat 2 ... the D4 beat had no word; E4's "c" now sits on a tied-into note: it goes on its chain head
    out = alt(score(bar), n('B3', 4) + n('C4', 4, tie='start') + n('C4', 4, tie='stop') + n('F4', 4))
    assert texts(out) == [(0.0, 'B3', 'a'), (1.0, 'C4', 'c'), (3.0, 'F4', 'd')]


def test_new_notes_keep_their_own_words_when_the_old_bar_had_none():
    out = alt(score(n('C4', 16)), n('D4', 8, [(1, 'own', 'single')]) + n('E4', 8))
    assert texts(out) == [(0.0, 'D4', 'own')]
    out = alt(score(n('C4', 16, [(1, 'old', 'single')])), n('D4', 8, [(1, 'own', 'single')]) + n('E4', 8, [(1, 'x', 'single')]))
    assert texts(out) == [(0.0, 'D4', 'old')]  # the bar's words win; the reading's own go
