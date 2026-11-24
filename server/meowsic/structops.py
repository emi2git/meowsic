"""Bar structure tools of Edit notes (Bar ▾, web/js/views/editnotes.js): a pickup, key and time changes, repeat bar
lines and 1st / 2nd endings. staffmove.edit_ex hands these ops over (one undo step each, preview, Save, Activities).
Every part of the score changes alike; bars are 0-based.

  {op:'pickup', beats}            the first bar becomes a pickup of `beats` beats (of the time signature): its last
                                  beats stay, what is before them goes (said); 0 = a full first bar again (rests in
                                  front). A pickup is never "incomplete" (staffmove.incomplete_bars).
  {op:'keysig', bar, fifths}      the key from this bar on (−7 … 7: flats … sharps); pitches stay, accidentals are
                                  written again where the new key needs them (rangeops.tidy_accidentals)
  {op:'timesig', bar, beats, beatType}  the time from this bar on, up to the next time change: the music is barred
                                  again — notes over the new bar lines are tied, the last bar is filled with rests
  {op:'repeat', bar, kind}        kind 'start' (a repeat sign at the start of the bar) / 'end' (at its end; `times`,
                                  default 2): on / off
  {op:'ending', bars: [b0, b1], number}  a volta bracket ("1." / "2." / "1, 2.") over those bars, on / off; ending 1
                                  gets an end repeat on its last bar when it has none
Playback follows the repeats and endings (web/js/musicxml.js playOrder, the same as play_order here); a sung
voice too (singscore.read: verse 1 on the first time through, verse 2 on the second …).
"""
import copy
import math
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

try:
    from fastapi import HTTPException
except ImportError:  # sing/sing.py reads scores (singscore -> unroll) in SoulX-Singer's venv, which has no fastapi
    class HTTPException(Exception):
        def __init__(self, status_code, detail=''):
            super().__init__(detail); self.status_code, self.detail = status_code, detail

OPS = ('pickup', 'keysig', 'timesig', 'repeat', 'ending')


def _int(x, what):
    try: return int(x)
    except (TypeError, ValueError): raise HTTPException(400, f'{what}: a number')


def _bar(root, op):
    ms = root.find('part').findall('measure')
    b = _int(op.get('bar'), 'bar')
    if not 0 <= b < len(ms): raise HTTPException(400, f'No bar {b + 1} in this score')
    return b


# ---------- pickup ----------

def _pickup_part(part, P_q, info):
    """The part's first bar as a pickup of P_q quarters (None / full length: a full bar)."""
    from .barops import _states, staves as n_staves, _rest_voice
    from .easerests import _beat
    from .staffmove import Ev, _read_bar, _rests, _write_bar
    m, div, tsig = _states(part)[0]
    L = Fr(4 * tsig[0], tsig[1]) * div
    voices, other, longest = _read_bar(m, div)
    P = L if P_q is None else Fr(P_q) * div
    if P.denominator != 1 or P <= 0 or P > L: raise HTTPException(400, 'A pickup is shorter than the bar')
    beat = _beat(tsig)
    cur = longest or L
    shift = P - cur  # < 0: the start goes, > 0: rests in front
    dropped = 0
    for vo in voices:
        new = []
        for ev in vo.evs:
            on, end = ev.on + shift, ev.end + shift
            if end <= 0 and ev.dur > 0:
                if ev.kind == 'notes': dropped += 1
                continue
            if on < 0:
                if ev.kind == 'notes': dropped += 1
                if ev.kind != 'gap': new.extend(_rests(Fr(0), end, div, beat, P, vo.num, vo.staff))
                continue
            ev.on = on
            new.append(ev)
        if new and new[0].on > 0: new = _rests(Fr(0), new[0].on, div, beat, P, vo.num, vo.staff) + new
        end = max((e.end for e in new), default=Fr(0))
        if end < P: new += _rests(end, P - end, div, beat, P, vo.num, vo.staff)
        vo.evs = sorted(new, key=lambda e: e.on)
        vo.touched = True
    have = {v.staff for v in voices}
    n = n_staves(part)
    for s in range(1, n + 1):
        if str(s) not in have and n > 1:
            from .barops import _staff_voice
            voices.append(_rest_voice(_staff_voice(part, s), s, P, div, tsig))
    other = [(max(Fr(0), t + shift) if e.tag in ('harmony', 'direction') else t, i, e) for t, i, e in other]
    voices.sort(key=lambda v: (int(v.staff), v.first))
    _write_bar(m, voices, other, P, div, beat)
    if P < L: m.set('implicit', 'yes'); m.set('number', '0')
    else:
        m.attrib.pop('implicit', None)
    info['dropped'] = max(info.get('dropped', 0), dropped)
    return [(0, v.staff, v.num) for v in voices]


# ---------- key ----------

def _first_attrs(m):
    from .barops import _first_attributes
    return _first_attributes(m)


def _set_key(root, bi, fifths):
    from .barops import _attr_put
    for part in root.findall('part'):
        ms = part.findall('measure')
        if bi >= len(ms): continue
        a = _first_attrs(ms[bi])
        for k in a.findall('key'): a.remove(k)
        k = ET.Element('key'); ET.SubElement(k, 'fifths').text = str(fifths)
        _attr_put(a, k)


# ---------- time (barred again) ----------

def _own_time(m):
    return any(a.find('time') is not None for a in m.findall('attributes'))


def _rebar_part(part, k, tsig_new, tidy, pi, edit_pi):
    from .barops import _states, staves as n_staves, _rest_voice
    from .easerests import _beat
    from .staffmove import Voice, _read_bar, _split_ev, _write_bar, _put_time
    st = _states(part)
    ms = [x[0] for x in st]
    n = len(ms)
    start = k
    if k == 0 and (ms[0].get('implicit') == 'yes' or (n > 1 and _read_bar(ms[0], st[0][1])[2] < Fr(4 * st[0][2][0], st[0][2][1]) * st[0][1])):
        t = ET.Element('time'); ET.SubElement(t, 'beats').text = str(tsig_new[0]); ET.SubElement(t, 'beat-type').text = str(tsig_new[1])
        _put_time(ms[0], t)
        start = 1
        if n == 1: return 0
    end = next((j for j in range(start + 1, n) if _own_time(ms[j])), n)
    div = st[start][1]
    if any(st[j][1] != div for j in range(start, end)): raise HTTPException(400, 'These bars change their divisions: the time cannot be changed here')
    Ln = Fr(4 * tsig_new[0], tsig_new[1]) * div
    if Ln.denominator != 1: raise HTTPException(400, 'That time signature cannot be written in this score')
    beat = _beat(tsig_new)
    keys, evs, others, off = [], {}, [], Fr(0)
    last_right = None
    for j in range(start, end):
        m, _, ts = st[j]
        voices, other, longest = _read_bar(m, div)
        Lo = max(longest, Fr(4 * ts[0], ts[1]) * div)
        for vo in sorted(voices, key=lambda v: v.first):
            key = (vo.staff, vo.num)
            if key not in evs: keys.append(key); evs[key] = []
            for e in vo.evs:
                if e.kind == 'gap': continue
                evs[key].append((off + e.on, e))
        for t, i, e in other:
            if e.tag == 'barline':
                loc = e.get('location') or 'right'
                if loc == 'right':
                    if j == end - 1: last_right = e
                    else: others.append((off + Lo, 'right', e))
                else: others.append((off, 'left', e))
                continue
            if j != start and e.tag == 'attributes':
                for tm in e.findall('time'): e.remove(tm)
            if j != start and e.tag == 'print': continue  # the old line / page breaks go with the old bars
            others.append((off + t, i, e))
        off += Lo
    T = off
    nb = max(1, math.ceil(T / Ln))
    per = {j: {key: [] for key in keys} for j in range(nb)}
    for key in keys:
        for a, e in evs[key]:
            segs, t, left = [], a, e.dur
            if e.dur == 0:
                j = min(nb - 1, int(a // Ln)); e.on = a - j * Ln; per[j][key].append(e); continue
            while left > 0:
                j = int(t // Ln); o = j * Ln
                d = min(left, o + Ln - t)
                segs.append((j, t - o, d)); t += d; left -= d
            if len(segs) == 1: e.on = segs[0][1]; per[segs[0][0]][key].append(e); continue
            if e.notes and e.notes[0].find('time-modification') is not None: raise HTTPException(400, 'A triplet would cross a new bar line')
            for j, x in _split_ev(e, segs, div): per[j][key].append(x)
    new_ms = []
    nst = n_staves(part)
    from .barops import _staff_voice
    for j in range(nb):
        m = ET.Element('measure', number='0')
        voices = []
        for r, key in enumerate(keys):
            ev_l = sorted(per[j][key], key=lambda e: e.on)
            if not ev_l: continue
            vo = Voice(key[1], key[0]); vo.first = r; vo.touched = True
            from .staffmove import _rests
            out, t = [], Fr(0)
            for e in ev_l:
                if e.on > t: out += _rests(t, e.on - t, div, beat, Ln, vo.num, vo.staff)
                out.append(e); t = max(t, e.end)
            if t < Ln: out += _rests(t, Ln - t, div, beat, Ln, vo.num, vo.staff)
            vo.evs = out
            voices.append(vo)
        have = {v.staff for v in voices}
        for s in range(1, nst + 1):
            if str(s) not in have:
                vo = _rest_voice(_staff_voice(part, s), s, Ln, div, tsig_new)
                if nst == 1:
                    for e in vo.evs:
                        for x in e.notes:
                            for y in x.findall('staff'): x.remove(y)
                voices.append(vo)
        voices.sort(key=lambda v: (int(v.staff), v.first))
        oth = []
        for t, i, e in others:
            if i == 'right':
                if t == (j + 1) * Ln: oth.append((Ln, 10 ** 6, e))
                continue
            if i == 'left':
                if t == j * Ln: oth.append((Fr(0), -1, e))
                continue
            if j * Ln <= t < (j + 1) * Ln or (j == nb - 1 and t >= (j + 1) * Ln): oth.append((min(t - j * Ln, Ln), i, e))
        if j == nb - 1 and last_right is not None: oth.append((Ln, 10 ** 6, last_right))
        _write_bar(m, voices, oth, Ln, div, beat)
        if pi == edit_pi: tidy.update((start + j, v.staff, v.num) for v in voices)
        new_ms.append(m)
    t = ET.Element('time'); ET.SubElement(t, 'beats').text = str(tsig_new[0]); ET.SubElement(t, 'beat-type').text = str(tsig_new[1])
    _put_time(new_ms[0], t)
    kids = list(part)
    at = kids.index(ms[start])
    for m in ms[start:end]: part.remove(m)
    for x, m in enumerate(new_ms): part.insert(at + x, m)
    return nb - (end - start)


# ---------- repeats and endings ----------

BAR_ORDER = ['bar-style', 'footnote', 'level', 'wavy-line', 'segno', 'coda', 'fermata', 'ending', 'repeat']


def _barline(m, loc, make=True):
    for b in m.findall('barline'):
        if (b.get('location') or 'right') == loc: return b
    if not make: return None
    b = ET.Element('barline', location=loc)
    if loc == 'left':
        kids = list(m)
        at = next((i for i, e in enumerate(kids) if e.tag not in ('print', 'attributes')), len(kids))
        m.insert(at, b)
    else: m.append(b)
    return b


def _bl_put(b, el):
    k = BAR_ORDER.index(el.tag)
    for i, c in enumerate(list(b)):
        if c.tag in BAR_ORDER and BAR_ORDER.index(c.tag) > k: b.insert(i, el); return el
    b.append(el); return el


def _bl_tidy(m, b, last=False):
    """The bar line's style follows what it has (a repeat: heavy-light / light-heavy); one left with nothing on it
    goes (the score's last bar keeps its final bar line)."""
    rep = b.find('repeat')
    st = b.find('bar-style')
    if rep is not None:
        if st is None: st = _bl_put(b, ET.Element('bar-style'))
        st.text = 'heavy-light' if rep.get('direction') == 'forward' else 'light-heavy'
        return
    rest = [c for c in b if c.tag != 'bar-style']
    if rest: return
    if last and (b.get('location') or 'right') == 'right':
        if st is None: st = _bl_put(b, ET.Element('bar-style'))
        st.text = 'light-heavy'
        return
    if st is None or st.text in ('heavy-light', 'light-heavy', 'regular'): m.remove(b)


def _set_repeat(root, bi, kind, times=None):
    on = None
    for part in root.findall('part'):
        ms = part.findall('measure')
        if bi >= len(ms): continue
        m = ms[bi]
        loc = 'left' if kind == 'start' else 'right'
        b = _barline(m, loc)
        rep = b.find('repeat')
        if on is None: on = rep is None
        if on:
            if rep is None: rep = _bl_put(b, ET.Element('repeat'))
            rep.set('direction', 'forward' if kind == 'start' else 'backward')
            if kind == 'end' and times and int(times) > 2: rep.set('times', str(int(times)))
        elif rep is not None: b.remove(rep)
        _bl_tidy(m, b, bi == len(ms) - 1)
    return on


def endings(part):
    """[(first bar, last bar, numbers)] of the volta brackets in the part."""
    out, cur = [], None
    for bi, m in enumerate(part.findall('measure')):
        for b in m.findall('barline'):
            e = b.find('ending')
            if e is None: continue
            if e.get('type') == 'start': cur = (bi, tuple(_numbers(e.get('number'))))
            elif e.get('type') in ('stop', 'discontinue') and cur is not None:
                out.append((cur[0], bi, cur[1])); cur = None
    if cur is not None: out.append((cur[0], len(part.findall('measure')) - 1, cur[1]))
    return out


def _numbers(s):
    out = []
    for x in (s or '1').replace(' ', '').replace('.', '').split(','):
        if '-' in x:
            a, b = x.split('-', 1)
            if a.isdigit() and b.isdigit(): out.extend(range(int(a), int(b) + 1))
        elif x.isdigit(): out.append(int(x))
    return out or [1]


def _set_ending(root, b0, b1, number, info):
    nums = _numbers(number)
    text = ', '.join(str(x) for x in nums)
    on = None
    for part in root.findall('part'):
        ms = part.findall('measure')
        if b1 >= len(ms): continue
        have = [e for e in endings(part) if not (e[1] < b0 or e[0] > b1)]
        if on is None: on = not any(e[0] == b0 and e[1] == b1 for e in have)
        for a, z, _ in have:  # a bracket over these bars goes (and is put again when adding)
            for bb in (a, z):
                for bl in ms[bb].findall('barline'):
                    for e in bl.findall('ending'): bl.remove(e)
                    _bl_tidy(ms[bb], bl, bb == len(ms) - 1)
        if not on: continue
        s = _barline(ms[b0], 'left')
        e = ET.Element('ending', number=text, type='start'); e.text = f'{text}.'
        _bl_put(s, e)
        z = _barline(ms[b1], 'right')
        _bl_put(z, ET.Element('ending', number=text, type='stop' if 1 in nums else 'discontinue'))
        if 1 in nums and z.find('repeat') is None:
            _bl_put(z, ET.Element('repeat', direction='backward'))
            _bl_tidy(ms[b1], z)
            info['repeatAdded'] = True
    return on


# ---------- what plays when ----------

def bar_marks(part):
    """[{start, end, times, ending: numbers | None}] per bar: what the repeats and endings say."""
    ms = part.findall('measure')
    out = [{'start': False, 'end': False, 'times': 2, 'ending': None} for _ in ms]
    for bi, m in enumerate(ms):
        for b in m.findall('barline'):
            r = b.find('repeat')
            if r is None: continue
            if r.get('direction') == 'forward': out[bi]['start'] = True
            else:
                out[bi]['end'] = True
                try: out[bi]['times'] = max(2, int(r.get('times') or 2))
                except ValueError: pass
    for a, z, nums in endings(part):
        for bi in range(a, z + 1): out[bi]['ending'] = (a, z, nums)
    return out


def play_order(part):
    """[(bar index, pass)]: the bars as they are played, through the repeats (times) and the endings — the same rules
    as web/js/musicxml.js playOrder."""
    marks = bar_marks(part)
    brackets = sorted({mk['ending'] for mk in marks if mk['ending']})
    out, i, rep_start, pass_, count, guard = [], 0, 0, 1, {}, 0
    n = len(marks)
    while i < n and guard < 10000:
        guard += 1
        mk = marks[i]
        if mk['start'] and i != rep_start: rep_start, pass_ = i, 1
        e = mk['ending']
        if e and e[0] == i and pass_ not in e[2]:
            chain, k = [e], brackets.index(e)
            while k + 1 < len(brackets) and brackets[k + 1][0] == chain[-1][1] + 1: chain.append(brackets[k + 1]); k += 1
            nxt = next((c for c in chain[1:] if pass_ in c[2]), None)
            if nxt is None: i = chain[-1][1] + 1; rep_start, pass_ = i, 1  # no ending for this time through
            else: i = nxt[0]
            continue
        out.append((i, pass_))
        if mk['end']:
            c = count.get(i, 0)
            if c < mk['times'] - 1:
                count[i] = c + 1; pass_ += 1; i = rep_start; continue
            count[i] = 0
            if not e: rep_start, pass_ = i + 1, 1
        if e and e[1] == i and not mk['end']:
            k = brackets.index(e)
            if not (k + 1 < len(brackets) and brackets[k + 1][0] == i + 1): rep_start, pass_ = i + 1, 1
        i += 1
    return out


def has_repeats(part):
    return any(mk['start'] or mk['end'] or mk['ending'] for mk in bar_marks(part))


def unroll(root, verses=True):
    """The score as it is played: bars copied in play order (every part); on the k-th time through a bar its notes
    sing verse k (when it has one, else verse 1) — the lyric numbered 1. Repeat signs and brackets go."""
    parts = root.findall('part')
    if not parts: return root
    order = play_order(parts[0])
    for part in parts:
        ms = part.findall('measure')
        for m in ms: part.remove(m)
        for k, (bi, p) in enumerate(order):
            if bi >= len(ms): continue
            m = copy.deepcopy(ms[bi])
            m.set('number', str(k + 1))
            if k: m.attrib.pop('implicit', None)
            for b in list(m.findall('barline')):
                for x in b.findall('repeat') + b.findall('ending'): b.remove(x)
                if not len(b): m.remove(b)
            if verses:
                for n in m.iter('note'):
                    ls = n.findall('lyric')
                    if len(ls) < 2: continue
                    pick = next((l for l in ls if (l.get('number') or '1') == str(p)), None)
                    if pick is None: pick = next((l for l in ls if (l.get('number') or '1') == '1'), ls[0])
                    for l in ls:
                        if l is not pick: n.remove(l)
                    pick.set('number', '1')
            part.append(m)
    return root


# ---------- the op ----------

def struct_op(text, op, info=None):
    from .barnorm import normalize_bar, tidy_score
    from .barops import _renumber
    from .staffmove import _head, _slur_mark, _tie_count, edit_part, fix_slurs, fix_ties
    from .rangeops import tidy_accidentals
    info = {} if info is None else info
    kind = op.get('op')
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    parts = root.findall('part')
    ties_before = _tie_count(part)
    snaps = [(p, _slur_mark(p)) for p in parts]
    tidy, acc = set(), None
    if kind == 'pickup':
        beats = op.get('beats')
        tm = part.find('measure/attributes/time')
        ts = (int(tm.findtext('beats')), int(tm.findtext('beat-type'))) if tm is not None else (4, 4)
        try: b = Fr(str(beats))
        except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, 'beats: how many beats the pickup has')
        if b < 0 or b > ts[0]: raise HTTPException(400, f'A pickup has 1 to {ts[0] - 1} beats')
        q = None if b in (0, ts[0]) else b * Fr(4, ts[1])
        for pi, p in enumerate(parts):
            t = _pickup_part(p, q, info)
            if p is part: tidy.update(t)
        if info.get('dropped'): info.setdefault('said', []).append(
            f'{info["dropped"]} note{"s" if info["dropped"] != 1 else ""} before the pickup went — Undo brings {"them" if info["dropped"] != 1 else "it"} back')
        _renumber(root)
    elif kind == 'keysig':
        bi = _bar(root, op)
        f = _int(op.get('fifths'), 'fifths')
        if not -7 <= f <= 7: raise HTTPException(400, 'fifths: −7 (7 flats) to 7 (7 sharps)')
        _set_key(root, bi, f)
        acc = set(range(bi, len(part.findall('measure'))))
    elif kind == 'timesig':
        bi = _bar(root, op)
        beats, bt = _int(op.get('beats'), 'beats'), _int(op.get('beatType', 4), 'beatType')
        if not 1 <= beats <= 32 or bt not in (1, 2, 4, 8, 16, 32): raise HTTPException(400, 'A time signature like 3/4 or 6/8')
        added = 0
        for pi, p in enumerate(parts):
            a = _rebar_part(p, bi, (beats, bt), tidy, pi, pk)
            if p is part: added = a
        _renumber(root)
        if added: info.setdefault('said', []).append(f'Barred again in {beats}/{bt}: {abs(added)} bar{"s" if abs(added) != 1 else ""} {"more" if added > 0 else "fewer"}')
    elif kind == 'repeat':
        bi = _bar(root, op)
        k = op.get('kind')
        if k not in ('start', 'end'): raise HTTPException(400, "kind: 'start' or 'end'")
        _set_repeat(root, bi, k, op.get('times'))
    elif kind == 'ending':
        bs = op.get('bars') or [op.get('bar'), op.get('bar')]
        b0, b1 = sorted(_int(x, 'bars') for x in bs[:2])
        n = len(part.findall('measure'))
        if not (0 <= b0 and b1 < n): raise HTTPException(400, 'No such bars')
        _set_ending(root, b0, b1, str(op.get('number') or '1'), info)
        if info.pop('repeatAdded', False): info.setdefault('said', []).append(f'An end repeat was put at the end of bar {b1 + 1}, where ending 1 goes back')
    else: raise HTTPException(400, f'Unknown edit: {kind}')
    if tidy:
        div, tsig = Fr(1), (4, 4)
        for bi, m in enumerate(part.findall('measure')):
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            for b, st, v in sorted(tidy):
                if b == bi: normalize_bar(m, st, v, tsig, div, keep=set(), info={})
    tidy_score(root)
    for p, snap in snaps: fix_slurs(p, snap)
    for p in parts: fix_ties(p)
    if acc is not None or tidy:
        for p in parts: tidy_accidentals(p, acc if acc is not None else {b for b, _, _ in tidy})
    gone = max(0, ties_before - _tie_count(part))
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], gone
