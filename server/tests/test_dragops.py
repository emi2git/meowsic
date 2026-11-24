"""Drag a note (dragops.shift_op via staffmove.edit_ex): onto rests in the same / the next bar, with a pitch change,
a swap with a note of the same length, refused over another note or past the bar line; bars stay full; a slur goes
with its note."""
import pytest
from fastapi import HTTPException

from meowsic import staffmove as sm
from test_staffmove import ev, full, music, refs, score
from test_tieslur import slurs, with_slur

# bar 1: C5 D5 rest rest | bar 2: E5 F5 G5-half; left hand whole notes
RH = [[ev('C5', 1), ev('D5', 1), ev('R', 2)], [ev('E5', 1), ev('F5', 1), ev('G5', 2)]]
LH = [[ev('C3', 4, 2)], [ev('G3', 4, 2)]]
X = score(RH, LH)


def shift(text, ref, bar, on, by=0):
    out, moved, _ = sm.edit_ex(text, {'op': 'shift', 'refs': [ref], 'bar': bar, 'on': on, 'by': by})
    return out, moved


def test_onto_a_rest_in_the_same_bar():
    d5 = refs(X, lambda n: n['midi'] == 74)[0]
    out, moved = shift(X, d5, 0, 3)
    m = music(out)
    assert (0, 1, 3.0, 1.0, 74) in m and not any(x[4] == 74 and x[2] == 1.0 for x in m)
    assert full(out) and len(moved) == 1


def test_into_the_bar_before_with_a_pitch_change():
    e5 = refs(X, lambda n: n['midi'] == 76)[0]
    out, _ = shift(X, e5, 0, 2, by=-1)  # E5 → E♭5 on beat 3 of bar 1
    m = music(out)
    assert (0, 1, 2.0, 1.0, 75) in m and not any(x[0] == 1 and x[4] == 76 for x in m)
    assert full(out)


def test_same_place_is_a_pitch_change():
    c5 = refs(X, lambda n: n['midi'] == 72)[0]
    out, _ = shift(X, c5, 0, 0, by=2)
    assert (0, 1, 0.0, 1.0, 74) in music(out) and full(out)


def test_swap_with_a_note_of_the_same_length():
    c5 = refs(X, lambda n: n['midi'] == 72)[0]
    out, _ = shift(X, c5, 0, 1)
    m = music(out)
    assert (0, 1, 1.0, 1.0, 72) in m and (0, 1, 0.0, 1.0, 74) in m and full(out)


def test_refused_over_a_note_or_past_the_bar():
    c5 = refs(X, lambda n: n['midi'] == 72)[0]
    with pytest.raises(HTTPException, match='note is there'): shift(X, c5, 1, 2)  # over the G5 half note
    g5 = refs(X, lambda n: n['midi'] == 79)[0]
    with pytest.raises(HTTPException, match='does not fit'): shift(X, g5, 0, 3)


def test_a_slur_goes_with_its_note():
    rh = [[with_slur(ev('C5', 1), 'start'), with_slur(ev('D5', 1), 'stop'), ev('R', 2)], RH[1]]
    x = score(rh, LH)
    d5 = refs(x, lambda n: n['midi'] == 74)[0]
    out, _ = shift(x, d5, 0, 3)
    assert slurs(out) == [(72, 74)] and full(out)


def test_unslur_at_start_takes_only_that_slur():
    # two slurs: C5-D5 and D5-E5 (the second starts where the first stops)
    d5 = ev('D5', 1).replace('</note>', '<notations><slur type="stop" number="1"/><slur type="start" number="2"/></notations></note>')
    e5 = ev('E5', 1).replace('</note>', '<notations><slur type="stop" number="2"/></notations></note>')
    rh = [[with_slur(ev('C5', 1), 'start'), d5, e5, ev('R', 1)], RH[1]]
    x = score(rh, LH)
    assert sorted(slurs(x)) == [(72, 74), (74, 76)]
    r = refs(x, lambda n: n['midi'] == 74)[0]
    out, _, _ = sm.edit_ex(x, {'op': 'unslur', 'refs': [r], 'at': 'start'})
    assert slurs(out) == [(72, 74)]
