"""Octave lines in Edit notes (Bar ▾ → 8va / 8vb, web/js/views/editnotes.js): a dashed "8va" / "8vb" (or "15ma" /
"15mb") line over notes of one staff, written as MusicXML <octave-shift> start / stop directions. staffmove.edit_ex
hands the op over (one undo step, preview, Save, Activities).

  {op:'ottava', staff, from_bar, to_bar, shift, from_beat?, to_beat?}
                                  bars from_bar … to_bar (0-based) of that staff (1 = the top one) under a line:
                                  shift 8 (8va), -8 (8vb), 15 (15ma), -15 (15mb); 0 takes the line off there (a
                                  longer line keeps the rest). from_beat (1-based, in the bar's beat unit, e.g. 2.5)
                                  starts the line in from_bar at the staff's first note from that beat on; to_beat
                                  stops it in to_bar before the notes from that beat on (to_beat 4: up to, not
                                  including, beat 4). Without them: whole bars. Lines that touch one of the same
                                  shift join.

A line runs from a place (bar, quarters from the bar's start) up to another (exclusive); the end of a bar is the start
of the next. The start direction goes right before the staff's first note at or after its place; the stop right after
the staff's last note that starts before its end (and that note's chord): OSMD ends a line on the note before the stop.

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
NAME = {8: '8va', -8: '8vb', 15: '15ma', -15: '15mb'}
EPS = Fr(1, 1000)


def _dur(e): return Fr(int(float(e.findtext('duration') or 0)))


def _staff_of(d): return (d.findtext('staff') or '1').strip()


def _walk(part):
    """Per bar: (measure, [(element, time in quarters there, onset of a note)], the bar's length in quarters (where
    its longest voice ends)). A chord note's onset is its chord's; a grace note's the next note's."""
    out, div = [], Fr(1)
    for m in part.findall('measure'):
        t, last, rows, end = Fr(0), Fr(0), [], Fr(0)
        for e in list(m):
            if e.tag == 'attributes' and e.findtext('divisions'): div = Fr(int(float(e.findtext('divisions'))))
            if e.tag == 'backup': t -= _dur(e) / div
            elif e.tag == 'forward': t += _dur(e) / div; end = max(end, t)
            elif e.tag == 'note':
                if e.find('grace') is not None: rows.append((e, t, t))
                elif e.find('chord') is not None: rows.append((e, t, last))
                else: rows.append((e, t, t)); last, t = t, t + _dur(e) / div; end = max(end, t)
                continue
            rows.append((e, t, None))
        out.append((m, rows, end))
    return out


def _norm(pos, lens):
    b, q = pos
    if b < len(lens) and lens[b] and q >= lens[b]: return (b + 1, Fr(0))
    return (b, q)


def spans(part):
    """The part's octave lines: [{staff, a, z, start, end, shift, els: [(measure, direction, direction-type)]}].
    a / z: the first / last bar (0-based) it covers; start / end: (bar, quarters) places, end exclusive. A stop at
    the very start of a bar ends the line on the bar before; a line never stopped runs to the last bar; a stop with
    no start is left alone."""
    w = _walk(part)
    lens = [x[2] for x in w]
    out, open_ = [], {}

    def close(sp, end):
        end = max(end, sp['start'])
        z = end[0] if end[1] > 0 else end[0] - 1
        out.append(sp | {'end': end, 'z': max(sp['a'], min(z, len(w) - 1))})
    for bi, (m, rows, _) in enumerate(w):
        for e, t, _ in rows:
            if e.tag != 'direction': continue
            st = _staff_of(e)
            for dt in e.findall('direction-type'):
                o = dt.find('octave-shift')
                if o is None: continue
                kind, size, num = o.get('type'), int(o.get('size') or 8), o.get('number') or '1'
                key = (st, num)
                if kind in ('up', 'down'):
                    here = _norm((bi, t), lens)
                    if key in open_: close(open_.pop(key), here)
                    open_[key] = {'staff': int(st) if st.isdigit() else 1, 'a': min(here[0], len(w) - 1), 'start': here,
                                  'shift': (15 if size == 15 else 8) * (1 if kind == 'down' else -1), 'els': [(m, e, dt)]}
                elif kind == 'stop' and key in open_:
                    sp = open_.pop(key)
                    sp['els'].append((m, e, dt))
                    close(sp, (bi, Fr(0)) if t == 0 and bi > sp['a'] else _norm((bi, t), lens))
    for sp in open_.values(): close(sp, (len(w), Fr(0)))
    return sorted(out, key=lambda s: (s['staff'], s['start']))


def shift_at(part, bar, staff, el=None):
    """Semitones the notes of that bar and staff are drawn away from their pitch (8va: 12; none: 0); with el (a
    <note> of the bar) at that note's place, else wherever the bar has a line."""
    on = next((o for e, _, o in _walk(part)[bar][1] if e is el), None) if el is not None else None
    for s in spans(part):
        if s['staff'] != int(staff): continue
        if (s['a'] <= bar <= s['z']) if on is None else (s['start'] <= (bar, on) < s['end']): return SEMIS[s['shift']]
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


def _after(m, e, d):
    """Right after the note e and the rest of its chord."""
    kids = list(m)
    k = kids.index(e)
    while k + 1 < len(kids) and kids[k + 1].tag == 'note' and kids[k + 1].find('chord') is not None: k += 1
    m.insert(k + 1, d)


def _put_stop(m, d, staff):
    """Right after the staff's note that ends last in the bar (and its chord), so the line covers all of it."""
    kids, t, last, best = list(m), Fr(0), Fr(0), None
    for e in kids:
        if e.tag == 'backup': t -= _dur(e); continue
        if e.tag == 'forward': t += _dur(e); continue
        if e.tag != 'note' or e.find('grace') is not None: continue
        chord = e.find('chord') is not None
        on = last if chord else t
        if not chord: last, t = t, t + _dur(e)
        if _staff_of(e) == str(staff) and (best is None or on + _dur(e) >= best[0]): best = (on + _dur(e), e)
    if best is None:
        right = next((k for k, e in enumerate(kids) if e.tag == 'barline' and (e.get('location') or 'right') == 'right'), len(kids))
        m.insert(right, d); return
    _after(m, best[1], d)


def _mine(rows, staff):
    return [(e, on) for e, _, on in rows if e.tag == 'note' and e.find('chord') is None and _staff_of(e) == str(staff)]


def _put_start_at(m, rows, q, d, staff):
    """Before the staff's first note (a grace note before it too) at or after q. False: none there."""
    e = next((e for e, on in _mine(rows, staff) if on >= q - EPS), None)
    if e is None: return False
    m.insert(list(m).index(e), d)
    return True


def _put_stop_at(m, rows, q, d, staff):
    """After the staff's note that starts last before q (the last written of those). False: none there."""
    best = None
    for e, on in _mine(rows, staff):
        if e.find('grace') is None and on < q - EPS and (best is None or on >= best[0]): best = (on, e)
    if best is None: return False
    _after(m, best[1], d)
    return True


def _take(sp):
    for m, d, dt in sp['els']:
        d.remove(dt)
        if d.find('direction-type') is None and d in list(m): m.remove(d)


def _beat_types(part):
    out, bt = [], 4
    for m in part.findall('measure'):
        x = m.find('attributes/time/beat-type')
        if x is not None and (x.text or '').strip().isdigit(): bt = int(x.text)
        out.append(bt)
    return out


def _q(beat, bt):
    """1-based beat → quarters from the bar's start."""
    return (Fr(str(round(float(beat), 6))).limit_denominator(960) - 1) * Fr(4, bt)


def _beat(q, bt):
    b = q / Fr(4, bt) + 1
    return f'{int(b)}' if b.denominator == 1 else f'{float(b):g}'


def set_ottava(root, part, staff, a, z, shift, info, from_beat=None, to_beat=None):
    from .staffmove import _staves
    ms = part.findall('measure')
    n_st = max(1, _staves(part))
    if not 1 <= staff <= n_st: raise HTTPException(400, f'No staff {staff} in this score')
    if not (0 <= a <= z < len(ms)): raise HTTPException(400, 'Pick bars of this score')
    if shift not in SHIFTS and shift != 0: raise HTTPException(400, 'shift: 8 (8va), -8 (8vb), 15, -15 or 0 (off)')
    lens, bts = [x[2] for x in _walk(part)], _beat_types(part)
    qa = _q(from_beat, bts[a]) if from_beat is not None else Fr(0)
    qz = _q(to_beat, bts[z]) if to_beat is not None else None
    if qa < 0 or qz is not None and qz < 0: raise HTTPException(400, 'Beats start at 1')
    A = _norm((a, qa), lens)
    Z = (z + 1, Fr(0)) if qz is None else _norm((z, qz), lens)
    if not A < Z: raise HTTPException(400, 'The line would cover no notes: pick where it starts and stops')
    over = lambda s: s['start'] < Z and s['end'] > A
    # the lines this touches: those over the place, and those right next to it with the same shift (they join)
    hit = [s for s in spans(part) if s['staff'] == staff and (over(s) or shift and s['shift'] == shift and (s['end'] == A or s['start'] == Z))]
    if not shift and not any(over(s) for s in hit): raise HTTPException(400, 'No octave line there')
    segs = []
    for s in hit:
        if s['start'] < A: segs.append([s['start'], min(s['end'], A), s['shift']])
        if s['end'] > Z: segs.append([max(s['start'], Z), s['end'], s['shift']])
        _take(s)
    if shift: segs.append([A, Z, shift])
    segs.sort(key=lambda x: x[0])
    runs = []
    for s in segs:
        if runs and runs[-1][2] == s[2] and runs[-1][1] >= s[0]: runs[-1][1] = max(runs[-1][1], s[1])
        else: runs.append(s)
    for (b0, q0), (b1, q1), v in runs:
        if q0:
            m, rows, _ = _walk(part)[b0]
            if not _put_start_at(m, rows, q0, _direction(staff, v), staff): b0, q0 = b0 + 1, Fr(0)  # no note left there
            if (b0, q0) >= (b1, q1) or b0 >= len(ms): continue
        if not q0: _put_start(ms[b0], _direction(staff, v))
        stop = _direction(staff, v, stop=True)
        if q1:
            m, rows, _ = _walk(part)[b1]
            if _put_stop_at(m, rows, q1, stop, staff): continue
        _put_stop(ms[b1 - 1], stop, staff)
    span = f'bar {a + 1}' if a == z else f'bars {a + 1}–{z + 1}'
    if A[1]: span += f', from beat {_beat(A[1], bts[A[0]])}'
    if Z[1]: span += f', before beat {_beat(Z[1], bts[Z[0]])}' + (f' of bar {Z[0] + 1}' if a != z else '')
    info.setdefault('said', []).append(f'{NAME[shift]} over {span}' if shift else f'No octave line over {span}')


def ottava_op(text, op, info=None):
    from .staffmove import _head, edit_part
    info = {} if info is None else info
    root = ET.fromstring(text.encode('utf-8'))
    _, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    try:
        staff, a = int(op.get('staff') or 1), int(op.get('from_bar'))
        z, shift = int(op.get('to_bar', a)), int(op.get('shift') or 0)
        fb = None if op.get('from_beat') in (None, '') else float(op['from_beat'])
        tb = None if op.get('to_beat') in (None, '') else float(op['to_beat'])
    except (TypeError, ValueError): raise HTTPException(400, 'ottava: staff, from_bar, to_bar, from_beat, to_beat and shift are numbers')
    if z < a: a, z, fb, tb = z, a, None, None
    set_ottava(root, part, staff, a, z, shift, info, fb, tb)
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], 0
