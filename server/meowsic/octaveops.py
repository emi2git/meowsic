"""Octave lines in Edit notes (Bar ▾ → 8va / 8vb, web/js/views/editnotes.js): a dashed "8va" / "8vb" (or "15ma" /
"15mb") line over bars of one staff, written as MusicXML <octave-shift> start / stop directions. staffmove.edit_ex
hands the op over (one undo step, preview, Save, Activities).

  {op:'ottava', staff, from_bar, to_bar, shift}  bars from_bar … to_bar (0-based) of that staff (1 = the top one)
                                  under a line: shift 8 (8va), -8 (8vb), 15 (15ma), -15 (15mb); 0 takes the line off
                                  those bars (a longer line keeps its other bars). Lines next to one of the same
                                  shift join.

Only the drawing changes. A MusicXML <pitch> is the sounding pitch, also under an octave shift (OSMD draws such notes
an octave lower / higher, music21 reads the line as non-transposing), so the notes are never touched: playback,
singing, Hands, chords and every other reader of <pitch> stay the same.
"""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

OPS = ('ottava',)
SHIFTS = {8: ('8', 'down'), -8: ('8', 'up'), 15: ('15', 'down'), -15: ('15', 'up')}  # 8va: written an octave lower ("down")
SEMIS = {8: 12, -8: -12, 15: 24, -15: -24, 0: 0}


def _dur(e): return Fr(int(float(e.findtext('duration') or 0)))


def _staff_of(d): return (d.findtext('staff') or '1').strip()


def spans(part):
    """The part's octave lines: [{staff, a, z, shift, els: [(measure, direction, direction-type)]}], bars 0-based
    and inclusive. A stop at the very start of a bar ends the line on the bar before; a line never stopped runs to
    the last bar; a stop with no start is left alone."""
    ms = part.findall('measure')
    out, open_ = [], {}
    for bi, m in enumerate(ms):
        t = Fr(0)
        for e in list(m):
            if e.tag == 'backup': t -= _dur(e); continue
            if e.tag == 'forward': t += _dur(e); continue
            if e.tag == 'note':
                if e.find('grace') is None and e.find('chord') is None: t += _dur(e)
                continue
            if e.tag != 'direction': continue
            st = _staff_of(e)
            for dt in e.findall('direction-type'):
                o = dt.find('octave-shift')
                if o is None: continue
                kind, size, num = o.get('type'), int(o.get('size') or 8), o.get('number') or '1'
                key = (st, num)
                if kind in ('up', 'down'):
                    if key in open_: out.append(open_.pop(key) | {'z': bi})
                    open_[key] = {'staff': int(st) if st.isdigit() else 1, 'a': bi, 'shift': (15 if size == 15 else 8) * (1 if kind == 'down' else -1),
                                  'els': [(m, e, dt)]}
                elif kind == 'stop' and key in open_:
                    sp = open_.pop(key)
                    sp['els'].append((m, e, dt))
                    out.append(sp | {'z': bi - 1 if t == 0 and bi > sp['a'] else bi})
    out.extend(sp | {'z': len(ms) - 1} for sp in open_.values())
    return sorted(out, key=lambda s: (s['staff'], s['a']))


def shift_at(part, bar, staff):
    """Semitones the notes of that bar and staff are drawn away from their pitch (8va: 12; none: 0)."""
    for s in spans(part):
        if s['staff'] == int(staff) and s['a'] <= bar <= s['z']: return SEMIS[s['shift']]
    return 0


def _direction(staff, shift, stop=False):
    size, kind = SHIFTS[shift]
    d = ET.Element('direction', placement='above' if shift > 0 else 'below')
    dt = ET.SubElement(d, 'direction-type')
    ET.SubElement(dt, 'octave-shift', type='stop' if stop else kind, size=size, number=str(staff))
    ET.SubElement(d, 'staff').text = str(staff)
    return d


def _put_start(m, d):
    """At the start of the bar (time 0): before its first note, <backup> or <forward>."""
    kids = list(m)
    i = next((k for k, e in enumerate(kids) if e.tag in ('note', 'backup', 'forward')), len(kids))
    m.insert(i, d)


def _put_stop(m, d, staff):
    """Right after the staff's note that ends last in the bar (and its chord), so the line covers all of it."""
    kids, t, last, best = list(m), Fr(0), Fr(0), None
    for k, e in enumerate(kids):
        if e.tag == 'backup': t -= _dur(e); continue
        if e.tag == 'forward': t += _dur(e); continue
        if e.tag != 'note' or e.find('grace') is not None: continue
        chord = e.find('chord') is not None
        on = last if chord else t
        if not chord: last, t = t, t + _dur(e)
        if (e.findtext('staff') or '1').strip() == str(staff) and (best is None or on + _dur(e) >= best[0]): best = (on + _dur(e), k)
    if best is None:
        right = next((k for k, e in enumerate(kids) if e.tag == 'barline' and (e.get('location') or 'right') == 'right'), len(kids))
        m.insert(right, d); return
    k = best[1]
    while k + 1 < len(kids) and kids[k + 1].tag == 'note' and kids[k + 1].find('chord') is not None: k += 1
    m.insert(list(m).index(kids[k]) + 1, d)


def _take(sp):
    for m, d, dt in sp['els']:
        d.remove(dt)
        if d.find('direction-type') is None and d in list(m): m.remove(d)


def set_ottava(root, part, staff, a, z, shift, info):
    from .staffmove import _staves
    ms = part.findall('measure')
    n_st = max(1, _staves(part))
    if not 1 <= staff <= n_st: raise HTTPException(400, f'No staff {staff} in this score')
    if not (0 <= a <= z < len(ms)): raise HTTPException(400, 'Pick bars of this score')
    if shift not in SHIFTS and shift != 0: raise HTTPException(400, 'shift: 8 (8va), -8 (8vb), 15, -15 or 0 (off)')
    mine = [s for s in spans(part) if s['staff'] == staff]
    # the lines this touches: those over the bars, and those next to them with the same shift (they join)
    hit = [s for s in mine if s['a'] <= z and s['z'] >= a or (shift and s['shift'] == shift and (s['z'] == a - 1 or s['a'] == z + 1))]
    if not shift and not any(s['a'] <= z and s['z'] >= a for s in hit): raise HTTPException(400, 'No octave line on those bars')
    was = {}
    for s in hit:
        for b in range(s['a'], s['z'] + 1): was[b] = s['shift']
        _take(s)
    for b in range(a, z + 1): was[b] = shift
    runs, cur = [], None
    for b in sorted(was):
        v = was[b]
        if cur and v == cur[2] and b == cur[1] + 1: cur[1] = b
        else:
            if cur and cur[2]: runs.append(cur)
            cur = [b, b, v]
    if cur and cur[2]: runs.append(cur)
    for b0, b1, v in runs:
        _put_start(ms[b0], _direction(staff, v))
        _put_stop(ms[b1], _direction(staff, v, stop=True), staff)
    name = {8: '8va', -8: '8vb', 15: '15ma', -15: '15mb'}
    span = f'bar {a + 1}' if a == z else f'bars {a + 1}–{z + 1}'
    info.setdefault('said', []).append(f'{name[shift]} over {span}' if shift else f'No octave line over {span}')


def ottava_op(text, op, info=None):
    from .staffmove import _head, edit_part
    info = {} if info is None else info
    root = ET.fromstring(text.encode('utf-8'))
    _, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    try:
        staff, a = int(op.get('staff') or 1), int(op.get('from_bar'))
        z, shift = int(op.get('to_bar', a)), int(op.get('shift') or 0)
    except (TypeError, ValueError): raise HTTPException(400, 'ottava: staff, from_bar, to_bar and shift are numbers')
    if z < a: a, z = z, a
    set_ottava(root, part, staff, a, z, shift, info)
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], 0
