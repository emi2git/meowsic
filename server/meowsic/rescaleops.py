"""Tempo marks and note values written at the wrong scale (a score made from a video can write a stretch at double
or half the note values, with a tempo mark of 267 or 71 to make it sound right). staffmove.edit_ex hands these ops
over, so each is one Edit notes step: preview, Save, the Activities row and its 24 h Undo. Bars are 0-based.

  {op:'tempo', bar, bpm}             the tempo at the start of that bar: the metronome mark (quarter = bpm, or the
                                     mark's own beat unit) and <sound tempo>, in every part that has one there; a bar
                                     with none gets one in the edit part. bpm null: the bar's tempo marks go
                                     (a word like "Allegro" on the same direction stays; only the number goes).
  {op:'rescale', from, to, factor}   bars from … to (inclusive) of every part, every staff and voice: each note and
                                     rest (and the place of every chord name, dynamic, word) times factor, then barred
                                     again at the time signature in force there. factor 0.5: two bars become one;
                                     2: each bar becomes two. Notes over a new bar line are split into tied notes; lyrics
                                     stay on their notes (on the first of tied pieces); beams and rests are written
                                     again per beat (barnorm); ties are checked after (fix_ties).
                                     Refused when the range can't be barred again cleanly: a bar in it that is not full
                                     (or a pickup), a time or divisions change inside it, a triplet that would cross a
                                     new bar line, a value finer than a 1024th or longer than a maxima.
                                     An odd number of bars with factor 0.5: the last new bar is half music, so it is
                                     filled up with rests (said in the preview) — the stretch keeps its sound and every
                                     bar stays full; delete or fill that rest after if it should not be there.
                                     Repeat bar lines inside the stretch stay only where they land on a new bar line.
"""
import copy
import math
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

OPS = ('tempo', 'rescale')
TYPES = ['1024th', '512th', '256th', '128th', '64th', '32nd', '16th', 'eighth', 'quarter', 'half', 'whole', 'breve', 'long', 'maxima']
UNIT_Q = {'16th': Fr(1, 4), 'eighth': Fr(1, 2), 'quarter': Fr(1), 'half': Fr(2), 'whole': Fr(4)}


def _int(x, what):
    try: return int(x)
    except (TypeError, ValueError): raise HTTPException(400, f'{what}: a bar number')


def factor_of(x):
    try: f = Fr(str(x))
    except (TypeError, ValueError, ZeroDivisionError): f = None
    if f not in (Fr(1, 2), Fr(2)): raise HTTPException(400, 'factor: 0.5 (halve the note values) or 2 (double them)')
    return f


# ---------- tempo ----------

def _is_tempo(d):
    return d.tag == 'direction' and (d.find('sound[@tempo]') is not None or d.find('direction-type/metronome') is not None)


def _unit_q(metro):
    u = UNIT_Q.get((metro.findtext('beat-unit') or 'quarter').strip(), Fr(1))
    return u * Fr(3, 2) if metro.find('beat-unit-dot') is not None else u


def _fmt(x):
    x = Fr(x).limit_denominator(100)
    return str(int(x)) if x.denominator == 1 else f'{float(x):g}'


def _set_tempo_el(d, bpm):
    for metro in d.iter('metronome'):
        pm = metro.find('per-minute')
        if pm is None: pm = ET.SubElement(metro, 'per-minute')
        pm.text = _fmt(Fr(bpm) / _unit_q(metro))
    s = d.find('sound')
    if s is None: s = ET.SubElement(d, 'sound')
    s.set('tempo', _fmt(bpm))


def _drop_tempo_el(m, d):
    for dt in d.findall('direction-type'):
        for metro in dt.findall('metronome'): dt.remove(metro)
        if len(dt) == 0: d.remove(dt)
    for s in d.findall('sound'):
        s.attrib.pop('tempo', None)
        if not s.attrib and len(s) == 0: d.remove(s)
    if d.find('direction-type') is None and d.find('sound') is None: m.remove(d)


def tempo_marks(part, bi):
    """The tempo elements of bar bi: [(measure, element)] — directions with a metronome or <sound tempo>, and bare
    <sound tempo> elements."""
    ms = part.findall('measure')
    if not 0 <= bi < len(ms): return []
    m = ms[bi]
    return [(m, e) for e in m if _is_tempo(e) or (e.tag == 'sound' and e.get('tempo'))]


def _tempo(root, part, bi, bpm, info):
    marks = [x for p in root.findall('part') for x in tempo_marks(p, bi)]
    if bpm is None:
        if not marks: raise HTTPException(400, f'Bar {bi + 1} has no tempo mark')
        for m, e in marks:
            if e.tag == 'sound':
                e.attrib.pop('tempo', None)
                if not e.attrib and len(e) == 0: m.remove(e)
            else: _drop_tempo_el(m, e)
        info.setdefault('said', []).append(f'The tempo mark in bar {bi + 1} is gone')
        return
    try: bpm = Fr(str(bpm))
    except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, 'bpm: a tempo (quarters a minute), or null to remove it')
    if not 10 <= bpm <= 500: raise HTTPException(400, 'bpm: 10 to 500 quarters a minute')
    was = None
    for m, e in marks:
        if e.tag == 'sound': was = was or e.get('tempo'); e.set('tempo', _fmt(bpm))
        else:
            s = e.find('sound')
            was = was or (s.get('tempo') if s is not None else None)
            _set_tempo_el(e, bpm)
    if not marks:  # a new mark at the start of the bar, after its attributes / print / bar line
        m = part.findall('measure')[bi]
        d = ET.Element('direction', placement='above')
        metro = ET.SubElement(ET.SubElement(d, 'direction-type'), 'metronome', parentheses='no')
        ET.SubElement(metro, 'beat-unit').text = 'quarter'
        ET.SubElement(metro, 'per-minute').text = _fmt(bpm)
        if any((a.findtext('staves') or '1').strip() not in ('', '1') for a in part.iter('attributes')): ET.SubElement(d, 'staff').text = '1'
        ET.SubElement(d, 'sound', tempo=_fmt(bpm))
        kids = list(m)
        at = next((i for i, c in enumerate(kids) if c.tag not in ('attributes', 'print', 'barline')), len(kids))
        m.insert(at, d)
    info.setdefault('said', []).append(f'Bar {bi + 1}: tempo {_fmt(bpm)}' + (f' (was {was})' if was and was != _fmt(bpm) else ''))


# ---------- rescale ----------

def _scale_type(n, f, where):
    t = n.find('type')
    if t is not None and (t.text or '').strip() in TYPES:
        i = TYPES.index(t.text.strip()) + (1 if f > 1 else -1)
        if not 0 <= i < len(TYPES): raise HTTPException(400, f'{where}: a note value that can\'t be made {"longer" if f > 1 else "shorter"}')
        t.text = TYPES[i]
    tm = n.find('time-modification')
    if tm is not None:
        nt = tm.find('normal-type')
        if nt is not None and (nt.text or '').strip() in TYPES:
            i = TYPES.index(nt.text.strip()) + (1 if f > 1 else -1)
            if 0 <= i < len(TYPES): nt.text = TYPES[i]


def _scale_note(n, f, div, where):
    from .easerests import pieces
    from .staffmove import _set_type
    d = n.find('duration')
    if d is not None:
        v = Fr(int(float(d.text or 0))) * f
        if v.denominator != 1: raise HTTPException(400, f'{where}: this length can\'t be halved in this score')
        d.text = str(int(v))
    r = n.find('rest')
    if r is not None and r.get('measure'):  # a whole-bar rest: written as the value it is now
        del r.attrib['measure']
        q = Fr(int(d.text)) / div
        if len(pieces(q)) == 1: _set_type(n, q, div)
        else:
            for t in n.findall('type'): n.remove(t)
        return
    _scale_type(n, f, where)


def _scale_offset(e, f):
    o = e.find('offset')
    if o is not None and (o.text or '').strip():
        o.text = str(int(Fr(int(float(o.text))) * f))


def _range_qs(parts, a, b):
    """Every length in the stretch, in quarters (so fit_divisions can make halving exact)."""
    from .barops import _states
    qs = set()
    for p in parts:
        for m, div, _ in _states(p)[a:b + 1]:
            for e in m.iter():
                if e.tag in ('duration', 'offset') and (e.text or '').strip():
                    try: qs.add(Fr(int(float(e.text))) / div / 2)
                    except ValueError: pass
    return qs


def _check_part(part, a, b, pi):
    from .barops import _states
    from .staffmove import _read_bar
    st = _states(part)
    if b >= len(st): raise HTTPException(400, f'No bar {b + 1} in this score')
    div, ts = st[a][1], st[a][2]
    L = Fr(4 * ts[0], ts[1]) * div
    for j in range(a, b + 1):
        m, d, t = st[j]
        if d != div: raise HTTPException(400, f'Bar {j + 1} changes its divisions: these bars can\'t be barred again')
        if t != ts: raise HTTPException(400, f'Bar {j + 1} changes the time to {t[0]}/{t[1]}: rescale the bars before and after it apart')
        if m.get('implicit') == 'yes': raise HTTPException(400, f'Bar {j + 1} is a pickup: start the stretch after it')
        voices, _, longest = _read_bar(m, div)
        if any(e.kind == 'notes' for v in voices for e in v.evs) or longest:
            if longest != L: raise HTTPException(400, f'Bar {j + 1}{f" (part {pi + 1})" if pi else ""} is not full ({float(longest / div):g} of {float(L / div):g} quarters): fill it or fix its time first')
            for v in voices:
                end = v.evs[-1].end if v.evs else Fr(0)
                if end > L: raise HTTPException(400, f'Bar {j + 1} is over-full: fix it first')
    return div, ts, L


def _rescale_part(part, a, b, f, tidy, is_edit, said):
    """Bars a … b of the part rescaled by f and barred again; returns (new bar count, {old index: new index})."""
    from .barops import _states, staves as n_staves, _rest_voice, _staff_voice
    from .easerests import _beat
    from .staffmove import Voice, _read_bar, _rests, _split_ev, _write_bar
    div, ts, L = _check_part(part, a, b, 0)
    st = _states(part)
    ms = [x[0] for x in st]
    beat = _beat(ts)
    keys, evs, others, off = [], {}, [], Fr(0)
    last_right, dropped_lines = None, 0
    for j in range(a, b + 1):
        m = ms[j]
        where = f'Bar {j + 1}'
        voices, other, _ = _read_bar(m, div)
        for vo in sorted(voices, key=lambda v: v.first):
            key = (vo.staff, vo.num)
            if key not in evs: keys.append(key); evs[key] = []
            for e in vo.evs:
                if e.kind == 'gap': continue  # a <forward> inside the voice: rests fill it when the bar is written
                for n in e.notes: _scale_note(n, f, div, where)
                for g in e.graces: _scale_type(g, f, where)
                e.dur = e.dur * f
                evs[key].append(((off + e.on) * f, e))
        for t, i, e in other:
            T0 = (off + t) * f
            if e.tag == 'barline':
                loc = e.get('location') or 'right'
                if loc == 'right':
                    if j == b: last_right = e
                    else: others.append(((off + L) * f, 'right', e))
                elif j == a: others.append((Fr(0), 'left', e))
                else: others.append((T0, 'left', e))
                continue
            if j != a and e.tag == 'attributes':
                for tm in e.findall('time'): e.remove(tm)
                if len(e) == 0: continue
            if j != a and e.tag == 'print': continue  # the old line / page breaks go with the old bars
            if e.tag in ('harmony', 'direction', 'figured-bass'): _scale_offset(e, f)
            if e.tag == 'note': _scale_type(e, f, where)  # a grace note left at a bar's end
            others.append((T0, i, e))
        off += L
    T = off * f
    nb = max(1, math.ceil(T / L))
    if T % L and is_edit:
        said.append(f'Bars {a + 1}–{b + 1} are an odd number of bars: the last new bar ends with {float((nb * L - T) / div):g} quarters of rest')
    per = {j: {key: [] for key in keys} for j in range(nb)}
    for key in keys:
        for at, e in evs[key]:
            if e.dur == 0:
                j = min(nb - 1, int(at // L)); e.on = at - j * L; per[j][key].append(e); continue
            segs, t, left = [], at, e.dur
            while left > 0:
                j = int(t // L); o = j * L
                d = min(left, o + L - t)
                segs.append((j, t - o, d)); t += d; left -= d
            if len(segs) == 1: e.on = segs[0][1]; per[segs[0][0]][key].append(e); continue
            if e.notes and e.notes[0].find('time-modification') is not None:
                raise HTTPException(400, 'A triplet (tuplet) would cross a new bar line: these bars can\'t be rescaled')
            for j, x in _split_ev(e, segs, div): per[j][key].append(x)
    new_ms = []
    nst = n_staves(part)
    for j in range(nb):
        m = ET.Element('measure', number='0')
        voices = []
        for r, key in enumerate(keys):
            ev_l = sorted(per[j][key], key=lambda e: e.on)
            if not ev_l: continue
            vo = Voice(key[1], key[0]); vo.first = r; vo.touched = True
            out, t = [], Fr(0)
            for e in ev_l:
                if e.on > t: out += _rests(t, e.on - t, div, beat, L, vo.num, vo.staff)
                out.append(e); t = max(t, e.end)
            if t < L: out += _rests(t, L - t, div, beat, L, vo.num, vo.staff)
            vo.evs = out
            voices.append(vo)
        have = {v.staff for v in voices}
        for s in range(1, nst + 1):
            if str(s) not in have:
                vo = _rest_voice(_staff_voice(part, s), s, L, div, ts)
                if nst == 1:
                    for e in vo.evs:
                        for x in e.notes:
                            for y in x.findall('staff'): x.remove(y)
                voices.append(vo)
        voices.sort(key=lambda v: (int(v.staff), v.first))
        oth = []
        for t, i, e in others:
            if i == 'right':
                if t == (j + 1) * L: oth.append((L, 10 ** 6, e))
                elif j == 0: dropped_lines += 1  # counted once
                continue
            if i == 'left':
                if t == j * L: oth.append((Fr(0), -1, e))
                elif j == 0: dropped_lines += 1
                continue
            if j * L <= t < (j + 1) * L or (j == nb - 1 and t >= (j + 1) * L): oth.append((min(t - j * L, L), i, e))
        if j == nb - 1 and last_right is not None: oth.append((L, 10 ** 6, last_right))
        _write_bar(m, voices, oth, L, div, beat)
        if is_edit: tidy.update((a + j, v.staff, v.num) for v in voices)
        new_ms.append(m)
    if dropped_lines and is_edit:
        said.append(f'{dropped_lines} bar line mark{"s" if dropped_lines != 1 else ""} (repeat / double bar) inside the stretch went: '
                    'they no longer fall on a bar line')
    kids = list(part)
    at = kids.index(ms[a])
    for m in ms[a:b + 1]: part.remove(m)
    for x, m in enumerate(new_ms): part.insert(at + x, m)
    return nb, {j: a + min(nb - 1, int((j - a) * f)) for j in range(a, b + 1)}


def _rescale(root, part, a, b, f, tidy, info):
    from .barops import _check_field, _renumber
    from .divisions import fit_divisions
    parts = root.findall('part')
    if not 0 <= a <= b: raise HTTPException(400, 'from / to: the first and last bar (0-based, from ≤ to)')
    for pi, p in enumerate(parts): _check_part(p, a, b, pi)
    if f < 1: fit_divisions(root, _range_qs(parts, a, b))  # a 16th in a score counted in 16ths: a finer unit first
    n_old = len(part.findall('measure'))
    old_num = [m.get('number') for m in part.findall('measure')]
    said, nb, where = [], None, {}
    for p in parts:
        k, w = _rescale_part(p, a, b, f, tidy, p is part, said)
        if p is part: nb, where = k, w
    d = nb - (b - a + 1)
    _renumber(root)
    new_num = [m.get('number') for m in part.findall('measure')]
    idx = {j: (j if j < a else where[j] if j <= b else j + d) for j in range(n_old)}
    if any(f_.get('name') == 'meowsic-check-bars' for f_ in root.iter('miscellaneous-field')):
        _check_field(root, {old_num[j]: new_num[idx[j]] for j in range(n_old)})
    marks = tempo_marks(part, a)
    tempo = next((s.get('tempo') for _, e in marks for s in ([e] if e.tag == 'sound' else e.findall('sound')) if s.get('tempo')), None)
    info.setdefault('said', []).append(
        f'Bars {a + 1}–{b + 1}: note values {"halved" if f < 1 else "doubled"}, now bars {a + 1}–{a + nb} ({nb} bar{"s" if nb != 1 else ""})'
        + (f'; the tempo mark there ({tempo}) stays — change it with Tempo' if tempo else ''))
    info['said'].extend(said)
    return a, a + nb - 1


def rescale_op(text: str, op: dict, info=None):
    from .barnorm import normalize_bar, tidy_score
    from .rangeops import tidy_accidentals
    from .staffmove import _head, _slur_mark, _tie_count, edit_part, fix_slurs, fix_ties, ties_gone
    info = {} if info is None else info
    kind = op.get('op')
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    n = len(part.findall('measure'))
    parts = root.findall('part')
    if kind == 'tempo':
        bi = _int(op.get('bar'), 'bar')
        if not 0 <= bi < n: raise HTTPException(400, f'No bar {bi + 1} in this score')
        _tempo(root, part, bi, op.get('bpm'), info)
        ET.indent(root, space='  ')
        return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], 0
    if kind != 'rescale': raise HTTPException(400, f'Unknown edit: {kind}')
    a, b = _int(op.get('from'), 'from'), _int(op.get('to'), 'to')
    if not (0 <= a <= b < n): raise HTTPException(400, f'from / to: bars 0 … {n - 1} (0-based), from ≤ to')
    f = factor_of(op.get('factor'))
    ties_before = _tie_count(part)
    snaps = [(p, _slur_mark(p)) for p in parts]
    tidy = set()
    a0, a1 = _rescale(root, part, a, b, f, tidy, info)
    div, tsig = Fr(1), (4, 4)
    for bi, m in enumerate(part.findall('measure')):
        for at in m.findall('attributes'):
            if at.findtext('divisions'): div = Fr(int(float(at.findtext('divisions'))))
            tm = at.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        for bb, st, v in sorted(tidy):
            if bb == bi: normalize_bar(m, st, v, tsig, div, keep=set(), info={})
    tidy_score(root)
    for p, snap in snaps: fix_slurs(p, snap)
    dropped = fix_ties(part)
    for p in parts:
        if p is not part: fix_ties(p)
    for p in parts: tidy_accidentals(p, set(range(a0, a1 + 2)))
    # ties made at the new bar lines are new: count them in, so only ties that really went are reported
    added = sum(1 for m in part.findall('measure')[a0:a1 + 1] for nn in m.iter('note') for t in nn.findall('tie') if t.get('type') == 'start')
    gone = ties_gone(max(ties_before, added), part, dropped)
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], gone
