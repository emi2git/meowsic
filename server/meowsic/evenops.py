"""Even out in Edit notes (web/js/views/editnotes.js: the "=" button / key Q): staffmove.edit_ex hands this op over
(one undo step, the preview, Save, Activities like every edit).

  {op:'even', refs}   the picked notes / chords / rests — 2 or more, one after the other in one voice of one staff,
                      inside one bar — get one length each, the same total: dotted 8th + 16th (or 16th + dotted 8th)
                      → two 8ths, dotted quarter + 8th → two quarters, quarter + 8th → two dotted 8ths …
                      Any note of a chord picks the chord. Refused (400, a short sentence the editor toasts): one
                      thing picked, not one after the other, two voices / staves / bars, a triplet in it, or a length
                      that is no plain or dotted note (3 notes over a quarter would need a triplet: Edit notes writes
                      no tuplets). Already equal: refused too ("already the same length").
Pitches, lyrics, slurs, grace notes and the ties into / out of the group stay on their notes; a <divisions> too
coarse for the new length is made finer first (divisions.py). After it the bar is tidied (barnorm: beams, rests;
the new lengths are kept unless notationally wrong), ties and slurs checked (fix_ties / fix_slurs)."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

OPS = ('even',)


def _group(sm, part, want):
    """(bar index, voice, [events]) of the picked notes, checked; raises 400 otherwise."""
    from .dragops import _ctx
    bars = part.findall('measure')
    ctx = _ctx(bars)
    hit = [k for k, m in enumerate(bars) if any(id(n) in want for n in m.iter('note'))]
    if len(hit) != 1: raise HTTPException(400, 'Even out works inside one bar: pick notes of one bar')
    b = hit[0]
    div, _ = ctx[b]
    voices, _, _ = sm._read_bar(bars[b], div)
    found = [(vo, i) for vo in voices for i, e in enumerate(vo.evs) if e.kind != 'gap' and e.dur and any(id(n) in want for n in e.notes)]
    if len({id(vo) for vo, _ in found}) != 1: raise HTTPException(400, 'Even out works in one voice of one staff: pick notes of one hand')
    vo = found[0][0]
    idx = [i for _, i in found]
    if len(idx) < 2: raise HTTPException(400, 'Pick 2 or more notes one after the other to even them out')
    if idx != list(range(idx[0], idx[-1] + 1)) or any(vo.evs[i].on != vo.evs[i - 1].end for i in idx[1:]):
        raise HTTPException(400, 'Pick notes one after the other (nothing between them) to even them out')
    evs = [vo.evs[i] for i in idx]
    if any(e.notes[0].find('time-modification') is not None for e in evs): raise HTTPException(400, 'Notes in a triplet keep their length')
    return b, vo, evs, ctx


def even_op(text, op, info=None):
    from . import staffmove as sm
    from .barnorm import normalize_bar, tidy_score
    from .divisions import fit_divisions
    from .easerests import TYPES, _beat
    info = {} if info is None else info
    root = ET.fromstring(text.encode('utf-8'))
    _, part, _ = sm.edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    all_notes = list(part.iter('note'))
    want = set()
    for r in op.get('refs') or []:
        try: r = int(r)
        except (TypeError, ValueError): raise HTTPException(400, f'Not a note: {r}')
        if not 0 <= r < len(all_notes): raise HTTPException(400, f'No note {r} in this score')
        if all_notes[r].find('grace') is not None: raise HTTPException(400, f'Note {r} is a grace note')
        want.add(id(all_notes[r]))
    if not want: raise HTTPException(400, 'Pick 2 or more notes one after the other to even them out')
    b, vo, evs, ctx = _group(sm, part, want)
    div = ctx[b][0]
    total = sum(Fr(e.dur) for e in evs) / div  # quarters
    q = total / len(evs)
    if all(Fr(e.dur) / div == q for e in evs): raise HTTPException(400, 'These notes are already the same length')
    if q not in {v for v, _, _ in TYPES}:
        raise HTTPException(400, f'{len(evs)} equal notes there would need a triplet (tuplets are not in Edit notes yet)')
    if fit_divisions(root, [q]) != 1:  # a 16th-based score evening into 32nds: finer divisions, then read again
        b, vo, evs, ctx = _group(sm, part, want)
        div = ctx[b][0]
    tsig = ctx[b][1]
    bars = part.findall('measure')
    m = bars[b]
    ties_before = sm._tie_count(part)
    snap = sm._slur_mark(part)
    voices, other, bar_len = sm._read_bar(m, div)
    bar_len = bar_len or Fr(4 * tsig[0], tsig[1]) * div
    # the same events again (read fresh: _write_bar needs this bar's voices)
    ids = {id(e.notes[0]) for e in evs}
    vo = next(v for v in voices if any(e.notes and id(e.notes[0]) in ids for e in v.evs))
    group = [e for e in vo.evs if e.notes and id(e.notes[0]) in ids]
    t, d = group[0].on, q * div
    touched, keep = [], set()
    for e in group:
        e.on, e.dur = t, d
        for n in e.notes: sm._set_type(n, q, div)
        t += d
        touched.extend(e.notes); keep.update(id(n) for n in e.notes)
    vo.touched = True
    voices.sort(key=lambda v: (v.staff, v.first))
    sm._write_bar(m, voices, other, bar_len, div, _beat(tsig))
    nb = {}
    normalize_bar(m, vo.staff, vo.num, tsig, div, keep=keep, info=nb)
    for a, qq, ps, what in nb.get('split', []):
        info.setdefault('said', []).append(
            f'Bar {b + 1}: a {sm.value_name(qq)} {what} on beat {sm._beat_no(a, tsig)} is written as '
            + ' + '.join(sm.value_name(x) for x in ps) + (' rests' if what == 'rest' else ' (tied)') + ' to keep the beat readable')
    tidy_score(root)
    sm.fix_slurs(part, snap)
    sm.fix_ties(part)
    gone = max(0, ties_before + nb.get('ties', 0) - sm._tie_count(part))
    ET.indent(root, space='  ')
    out = sm._head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(x): i for i, x in enumerate(part.iter('note'))}
    return out, sorted(ref[id(n)] for n in touched if id(n) in ref), gone
