"""Drag a note in Edit notes (web/js/views/editnotes.js, Mac: press a notehead and drag it): staffmove.edit_ex hands
this op over (one undo step, the preview, Save, Activities like every edit).

  {op:'shift', refs, bar, on, by?}   the picked notes (one chord of one voice: the whole chord or some of its notes)
                                     go to bar `bar` (0-based), `on` quarters from its start ("3/2" or 1.5), on their
                                     staff; `by` semitones up / down too. They take the place of rests there (a voice
                                     of that staff resting all that time, the same voice first) and leave a rest
                                     behind. Onto a chord of the same length in that voice (the whole chord dragged):
                                     the two swap. Anything else there: refused (nothing is written over).
After it the bars are tidied (barnorm), accidentals written where the bar needs them, ties and slurs checked
(fix_ties / fix_slurs: a slur moves with its note; a tie stays only while its two notes still meet on one pitch)."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

OPS = ('shift',)


def _ctx(bars):
    """[(divisions, time signature)] in force in each bar."""
    out, div, tsig = [], Fr(1), (4, 4)
    for m in bars:
        for a in m.findall('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            tm = a.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        out.append((div, tsig))
    return out


def shift_op(text, op, info=None):
    from . import staffmove as sm
    from .barnorm import normalize_bar, tidy_score
    from .easerests import _beat
    from .rangeops import tidy_accidentals
    info = {} if info is None else info
    root = ET.fromstring(text.encode('utf-8'))
    _, part, _ = sm.edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    all_notes = list(part.iter('note'))
    picked = []
    for r in op.get('refs') or []:
        try: r = int(r)
        except (TypeError, ValueError): raise HTTPException(400, f'Not a note: {r}')
        if not 0 <= r < len(all_notes): raise HTTPException(400, f'No note {r} in this score')
        n = all_notes[r]
        if n.find('grace') is not None or n.find('pitch') is None: raise HTTPException(400, 'Drag a note (not a rest)')
        picked.append(n)
    if not picked: raise HTTPException(400, 'Pick a note first')
    bars = part.findall('measure')
    ctx = _ctx(bars)
    try: tb = int(op.get('bar'))
    except (TypeError, ValueError): raise HTTPException(400, 'bar: a bar number (0-based)')
    if not 0 <= tb < len(bars): raise HTTPException(400, 'That bar is not in the score')
    try: tq = Fr(str(op.get('on', 0)))
    except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, 'on: quarters from the start of the bar')
    try: by = int(op.get('by') or 0)
    except (TypeError, ValueError): raise HTTPException(400, 'by: semitones')
    want = {id(n) for n in picked}
    sb = next((k for k, m in enumerate(bars) if any(id(n) in want for n in m.iter('note'))), None)
    if any(not any(x is n for x in bars[sb].iter('note')) for n in picked): raise HTTPException(400, 'Drag the notes of one chord at a time')
    ties_before = sm._tie_count(part)
    snap = sm._slur_mark(part)
    flats = sm._key_flats(part)

    def read(b):
        div, tsig = ctx[b]
        voices, other, bar_len = sm._read_bar(bars[b], div)
        return {'voices': voices, 'other': other, 'len': bar_len or Fr(4 * tsig[0], tsig[1]) * div, 'div': div, 'beat': _beat(tsig)}
    src = read(sb)
    ev = next((e for vo in src['voices'] for e in vo.evs if e.kind == 'notes' and e.dur and any(id(n) in want for n in e.notes)), None)
    if ev is None or not all(any(x is n for x in ev.notes) for n in picked): raise HTTPException(400, 'Drag the notes of one chord at a time')
    if ev.notes[0].find('time-modification') is not None: raise HTTPException(400, 'Notes in a triplet stay where they are')
    svo = next(vo for vo in src['voices'] if ev in vo.evs)
    whole = len(picked) == len(ev.notes)
    s_on = ev.on
    q = ev.dur / src['div']  # its length in quarters
    if by:
        for n in picked: sm._set_pitch(n, sm._midi(n) + by, flats[tb] if by >= 0 else True, ties=True)
    if tb == sb and tq * src['div'] == ev.on:  # no time moved: the pitch only
        tgt = src
    else:
        tgt = src if tb == sb else read(tb)
    div, bl = tgt['div'], tgt['len']
    t, d = tq * div, q * div
    if t.denominator != 1 or d.denominator != 1 or t < 0: raise HTTPException(400, 'That place is too fine for this score')
    if t + d > bl: raise HTTPException(400, f'It does not fit there: bar {tb + 1} ends first')
    moved_time = not (tgt is src and t == s_on)
    if moved_time:
        staff = svo.staff
        sm._take_out(src['voices'], want)
        for n in picked:
            for e in n.findall('chord'): n.remove(e)
            du = n.find('duration')
            if du is not None: du.text = str(int(d))
        dest = sorted([v for v in tgt['voices'] if v.staff == staff], key=lambda v: (v.num != svo.num, len(v.num), v.num))
        vo = next((v for v in dest if sm._fill(v, t, d)), None)
        if vo is None:  # a chord of the same length there, in the dragged notes' voice: swap them
            hit = next(((v, e) for v in dest if v.num == svo.num for e in v.evs
                        if e.kind == 'notes' and e.on == t and e.dur == d and e.notes and e.notes[0].find('time-modification') is None), None)
            if not (hit and whole): raise HTTPException(400, 'A note is there already: drag onto rests, or onto a note of the same length to swap them')
            v2, e2 = hit
            others = list(e2.notes)
            sm._take_out(tgt['voices'], {id(n) for n in others})
            for n in others:
                du = n.find('duration')
                if du is not None: du.text = str(int(ev.dur))
            sm._as_chord(others)
            back = next((v for v in src['voices'] if v.num == svo.num and v.staff == staff), svo)
            if not sm._fill(back, s_on, ev.dur): raise HTTPException(400, 'Those two notes cannot swap')
            sm._put_in(back, sm.Ev(s_on, ev.dur, others, 'notes'), src['div'], src['beat'], src['len'])
            vo = v2
        picked.sort(key=lambda n: sm._midi(n) or 0)
        sm._as_chord(picked)
        sm._put_in(vo, sm.Ev(t, d, picked, 'notes'), div, tgt['beat'], bl)
    tidy = set()
    for b, g in ([(sb, src)] if tgt is src else [(sb, src), (tb, tgt)]):
        if not moved_time:
            tidy.add((b, svo.staff, svo.num)); continue
        for vo in g['voices']:
            if vo.touched: sm._normalize(vo, g['div'], g['beat'], g['len'])
        for vo in sorted(g['voices'], key=lambda v: (len(v.num), v.num), reverse=True):
            if vo.touched and all(e.kind != 'notes' for e in vo.evs) and any(o is not vo and o.staff == vo.staff for o in g['voices']):
                g['voices'].remove(vo)
        g['voices'].sort(key=lambda v: (v.staff, v.first))
        sm._write_bar(bars[b], g['voices'], g['other'], g['len'], g['div'], g['beat'])
        tidy.update((b, vo.staff, vo.num) for vo in g['voices'] if vo.touched)
    nb = {}
    for b, st, v in sorted(tidy): normalize_bar(bars[b], st, v, ctx[b][1], ctx[b][0], keep={id(n) for n in picked}, info=nb)
    tidy_score(root)
    sm.fix_slurs(part, snap)
    dropped = sm.fix_ties(part)
    tidy_accidentals(part, {b for b, _, _ in tidy})
    gone = sm.ties_gone(ties_before + nb.get('ties', 0), part, dropped)
    ET.indent(root, space='  ')
    out = sm._head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    return out, sorted(ref[id(n)] for n in picked if id(n) in ref), gone
