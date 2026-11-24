"""Edit notes keeps ties and slurs (staffmove.fix_ties / fix_slurs): pitch, length, delete, move and the bar tidying
(barnorm.normalize_bar / tidy_score) never drop them; a tie goes only when its notes no longer meet (and the preview
says so); a slur whose end note is deleted moves to the neighbouring note. The tie / slur / unslur ops.

Real scores (optional): MEOWSIC_REAL_SCORES = a folder of read-only copies of library scores (e.g. Baby Mine
m-otc4w7b.musicxml, Home NDP m-b6xs990.musicxml); each is edited inside its tied passages (with slurs added there
first) and must keep every tie, slur, lyric and chord symbol."""
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi import HTTPException

from meowsic import barnorm
from meowsic import staffmove as sm
from test_staffmove import ev, full, score

SL = lambda kind, num=1: f'<notations><slur type="{kind}" number="{num}"/></notations>'


def tie_ev(x, q, kinds, staff=1):
    """A note with <tie>/<tied> of these kinds ('start', 'stop')."""
    n = ev(x, q, staff)
    t = ''.join(f'<tie type="{k}"/>' for k in kinds)
    n = n.replace('<voice>', t + '<voice>', 1)
    return n.replace('</note>', '<notations>' + ''.join(f'<tied type="{k}"/>' for k in kinds) + '</notations></note>')


def with_slur(n, kind):
    return n.replace('</note>', SL(kind) + '</note>')


# bar 1: C5 (slur start) D5 E5-half (tie →) | bar 2: E5 (← tie) F5 G5-half (slur stop)
RH = [[with_slur(ev('C5', 1), 'start'), ev('D5', 1), tie_ev('E5', 2, ['start'])],
      [tie_ev('E5', 1, ['stop']), ev('F5', 1), with_slur(ev('G5', 2), 'stop')]]
LH = [[ev('C3', 4, 2)], [ev('G3', 4, 2)]]
X = score(RH, LH)


def root(t): return ET.fromstring(t.encode())
def ns(t): return sm.notes(root(t))
def ref(t, bar, midi, staff=1): return next(n['ref'] for n in ns(t) if n['bar'] == bar and n['midi'] == midi and n['staff'] == staff and not n.get('rest'))


def ties(t):
    """[(bar, midi, kinds)] of every note with a tie."""
    out = []
    for n in sm.edit_part(root(t))[1].iter('note'):
        k = sorted({e.get('type') for e in n.findall('tie')} | {e.get('type') for e in n.findall('notations/tied')})
        if k: out.append((sm._midi(n), k))
    return out


def slurs(t):
    """[(start midi, stop midi)] of the slurs, matched by number in time order."""
    part = sm.edit_part(root(t))[1]
    return [(sm._midi(a[0]), sm._midi(b[0])) for _, a, b, _, _ in sm._slur_spans(sm._timeline(part))]


def test_the_fixture():
    assert slurs(X) == [(72, 79)] and ties(X) == [(76, ['start']), (76, ['stop'])]
    m = {(n['bar'], n['midi']): n for n in ns(X)}
    assert m[(0, 74)].get('slur') and m[(0, 76)].get('tie') and not m[(1, 76)].get('tie') and m[(1, 77)].get('slur')
    assert not m[(0, 48)].get('slur')


def test_pitch_inside_a_slur_keeps_it():
    out, _ = sm.edit(X, {'op': 'pitch', 'refs': [ref(X, 0, 74)], 'by': 1})
    assert slurs(out) == [(72, 79)] and full(out)


def test_pitch_on_a_tied_note_moves_its_partner_too_and_keeps_the_tie():
    out, moved, gone = sm.edit_ex(X, {'op': 'pitch', 'refs': [ref(X, 1, 76)], 'by': -1})
    assert ties(out) == [(75, ['start']), (75, ['stop'])] and gone == 0 and len(moved) == 2


def test_pitch_on_a_slur_end_keeps_the_slur():
    out, _ = sm.edit(X, {'op': 'pitch', 'refs': [ref(X, 0, 72)], 'by': 12})
    out, _ = sm.edit(out, {'op': 'pitch', 'refs': [ref(out, 1, 79)], 'by': -2})
    assert slurs(out) == [(84, 77)]


def test_length_change_keeps_the_slur():
    out, _ = sm.edit(X, {'op': 'len', 'refs': [ref(X, 1, 79)], 'q': 1})  # the slur's stop note gets shorter
    assert slurs(out) == [(72, 79)] and full(out)
    out, _ = sm.edit(X, {'op': 'len', 'refs': [ref(X, 0, 72)], 'q': 2})  # the start note writes over D5
    assert slurs(out) == [(72, 79)] and full(out) and ties(out) == ties(X)


def test_a_tie_whose_notes_no_longer_meet_goes_and_says_so():
    out, _, gone = sm.edit_ex(X, {'op': 'len', 'refs': [ref(X, 0, 76)], 'q': 1})
    assert ties(out) == [] and gone == 1 and slurs(out) == [(72, 79)]


def test_deleting_a_slur_end_moves_it_to_the_neighbour():
    out, _ = sm.edit(X, {'op': 'delete', 'refs': [ref(X, 1, 79)]})
    assert slurs(out) == [(72, 77)] and full(out)
    out, _ = sm.edit(X, {'op': 'delete', 'refs': [ref(X, 0, 72)]})
    assert slurs(out) == [(74, 79)] and full(out)


def test_moving_hands_keeps_ties_and_slurs():
    out, _ = sm.edit(X, {'op': 'move', 'refs': [ref(X, 0, 74)], 'to': 2})
    assert slurs(out) == [(72, 79)] and ties(out) == ties(X) and full(out)
    out, _, gone = sm.edit_ex(X, {'op': 'move', 'refs': [ref(X, 0, 76)], 'to': 2})  # a tie across the hands still sounds as one
    assert gone == 0 and len(ties(out)) == 2


def test_normalize_and_tidy_keep_both():
    r = root(X)
    part = sm.edit_part(r)[1]
    for m in part.findall('measure'):
        for st, v in (('1', '1'), ('2', '5')): barnorm.normalize_bar(m, st, v, (4, 4), 4)
    barnorm.tidy_score(r, {(0, 0), (0, 1)})
    t = ET.tostring(r, encoding='unicode')
    assert slurs(t) == [(72, 79)] and ties(t) == ties(X)


def test_tie_op_on_and_off_and_refused_for_another_pitch():
    y = score([[ev('C5', 2), ev('C5', 2)], [ev('D5', 4)]], LH)
    out, moved = sm.edit(y, {'op': 'tie', 'refs': [ns(y)[0]['ref']]})
    assert ties(out) == [(72, ['start']), (72, ['stop'])] and len(moved) == 2
    off, _ = sm.edit(out, {'op': 'tie', 'refs': [ns(out)[0]['ref']]})
    assert ties(off) == []
    with pytest.raises(HTTPException) as e: sm.edit(y, {'op': 'tie', 'refs': [ref(y, 0, 72) + 1]})  # 2nd C5 → D5
    assert 'Slur' in e.value.detail


def test_slur_op_add_one_to_next_and_remove():
    y = score([[ev('C5', 1), ev('D5', 1), ev('E5', 1), ev('F5', 1)], [ev('G5', 4)]], LH)
    out, _ = sm.edit(y, {'op': 'slur', 'refs': [ref(y, 0, 72), ref(y, 0, 74), ref(y, 0, 77)]})
    assert slurs(out) == [(72, 77)]
    assert all(n.get('slur') for n in ns(out) if n['staff'] == 1 and n['bar'] == 0) and not any(n.get('slur') for n in ns(out) if n['bar'] == 1)
    out2, _ = sm.edit(out, {'op': 'slur', 'refs': [ref(y, 0, 77)], 'next': True})  # over the bar line, number 2
    assert sorted(slurs(out2)) == [(72, 77), (77, 79)]
    gone, _ = sm.edit(out, {'op': 'unslur', 'refs': [ref(out, 0, 74)]})
    assert slurs(gone) == []
    with pytest.raises(HTTPException): sm.edit(y, {'op': 'slur', 'refs': [ref(y, 0, 72)]})
    with pytest.raises(HTTPException): sm.edit(y, {'op': 'unslur', 'refs': [ref(y, 0, 72)]})


def test_api_preview_tells_when_a_tie_went(client):
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Tied', 'musicxmlText': X}).json()
    p = client.post(f'/api/items/{it["id"]}/editnotes/preview', json={'ops': [{'op': 'len', 'refs': [ref(X, 0, 76)], 'q': 1}]}).json()
    assert p['tiesGone'] == 1
    p = client.post(f'/api/items/{it["id"]}/editnotes/preview', json={'ops': [{'op': 'pitch', 'refs': [ref(X, 0, 74)], 'by': 1}]}).json()
    assert p['tiesGone'] == 0 and slurs(p['xml']) == [(72, 79)]
    j = client.post(f'/api/items/{it["id"]}/editnotes', json={'ops': [{'op': 'pitch', 'refs': [ref(X, 0, 74)], 'by': 1}], 'mode': 'this'}).json()
    saved = client.get(f'/api/items/{it["id"]}/musicxml').text
    assert j['ok'] and slurs(saved) == [(72, 79)] and len(ties(saved)) == 2


# ---------- real scores (read-only copies) ----------
REAL = Path(os.environ.get('MEOWSIC_REAL_SCORES', '/nonexistent'))
FILES = sorted(REAL.glob('*.musicxml')) if REAL.is_dir() else []


def counts(t):
    return {'ties': len(re.findall(r'<tied type="start"', t)), 'tiestops': len(re.findall(r'<tied type="stop"', t)),
            'slurs': len(re.findall(r'<slur\b[^>]*type="start"', t)), 'lyrics': len(re.findall(r'<lyric\b', t)),
            'chords': len(re.findall(r'<harmony\b', t))}


def add_slurs(t, k=4):
    """Slurs over the first k tied pairs (from the note before the tie to its stop note), as an editor would."""
    r = root(t)
    part = sm.edit_part(r)[1]
    tl = [x for x in sm._timeline(part) if not x[6]]
    done = 0
    for i, x in enumerate(tl):
        if done >= k: break
        if i and sm._has_tie(x[0], 'start') and tl[i - 1][1] == x[1] and tl[i - 1][3] < x[3]:
            nxt = sm._partner_index(sm._timeline(part))(x)
            if nxt is None: continue
            sm._notations(tl[i - 1][0]).append(ET.Element('slur', type='start', number='3'))
            sm._notations(nxt[0]).append(ET.Element('slur', type='stop', number='3'))
            done += 1
    return sm._head(t) + ET.tostring(r, encoding='unicode') + '\n'


@pytest.mark.skipif(not FILES, reason='MEOWSIC_REAL_SCORES not set')
@pytest.mark.parametrize('path', FILES, ids=[p.stem for p in FILES])
def test_real_score_edits_keep_ties_slurs_lyrics_chords(path, capsys):
    t0 = add_slurs(path.read_text(encoding='utf-8'))
    c0 = counts(t0)
    assert c0['ties'] and c0['slurs']
    n0 = ns(t0)
    tied = [n for n in n0 if n.get('tie')]
    slurred = [n for n in n0 if n.get('slur') and not n.get('tie')]
    hands = sm.edit_part(root(t0))[2]
    ops = [{'op': 'pitch', 'refs': [tied[0]['ref']], 'by': 2},       # a tied note: its partner goes with it
           {'op': 'pitch', 'refs': [slurred[0]['ref']], 'by': -1}]   # inside a slur
    text = t0
    for op in ops:
        text, _, gone = sm.edit_ex(text, op)
        assert gone == 0, op
    c1 = counts(text)
    assert c1 == c0, (c0, c1)
    # a length that keeps the next note where it was (same length again) and a move / delete inside a slur
    k = next(n for n in ns(text) if n.get('slur') and not n.get('tie') and n['dur'] in (0.5, 1, 2))
    text, _, gone = sm.edit_ex(text, {'op': 'len', 'refs': [k['ref']], 'q': k['dur']})
    assert gone == 0 and counts(text) == c0
    if hands:
        k = next(n for n in ns(text) if n.get('slur') and not n.get('tie') and n['staff'] == 1)
        text, _, gone = sm.edit_ex(text, {'op': 'move', 'refs': [k['ref']], 'to': 2})
        assert gone == 0 and counts(text) == c0
    k = next(n for n in ns(text) if n.get('slur') and not n.get('tie') and not any(m.get('tie') for m in ns(text) if m['bar'] == n['bar'] and m['on'] == n['on']))
    own = len(list(sm.edit_part(root(text))[1].iter('note'))[k['ref']].findall('lyric'))
    text, _, gone = sm.edit_ex(text, {'op': 'delete', 'refs': [k['ref']]})
    c2 = counts(text)
    assert gone == 0 and c2['ties'] == c0['ties'] and c2['slurs'] == c0['slurs'] and c2['chords'] == c0['chords']
    assert c2['lyrics'] == c0['lyrics'] - own  # only the deleted note's own syllables go with it
    # the bar tidying over the whole score
    r = root(text)
    barnorm.tidy_score(r, {(0, b) for b in range(len(sm.edit_part(r)[1].findall('measure')))})
    c3 = counts(ET.tostring(r, encoding='unicode'))
    assert c3 == c2
    with capsys.disabled(): print(f'\n  {path.stem}: before {c0}  after {c3}')
