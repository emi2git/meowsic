"""Range tools of Edit notes (web/js/views/editnotes.js): copy / cut / paste, Repeat, enharmonic respelling and
accidentals. staffmove.edit_ex hands these ops over (one undo step each, the preview, Save, Activities like every edit).

A window = a stretch of the edited part: start / end = [bar (0-based), on (quarters from that bar's start)], end
exclusive ([bars, 0] = the end of the score), over staves s0..s1 (1-based, both in).

clip_of(text, start, end, staves) -> a clip (JSON): what sounds in the window, every voice of each staff, with its
  notes as MusicXML (lyrics, slurs, ties, articulations come along; ties and slurs leaving the window are dropped),
  and its chord names. {len, staves, voices: [{staff, voice, evs: [{on, dur, notes: [xml], graces: [xml]}]}],
  harmony: [{on, staff, xml}]} (on / dur / len in quarters, as fractions "3/2").
  {op:'clear', start, end, staves}     the window becomes rests (Cut: the client copies first); chord names in it go
  {op:'paste', at, staff, clip}        the clip written over what is there from `at` ([bar, on]) on `staff` down
                                       (clip staff 1 → staff, 2 → staff + 1 …; staves the part lacks are left out),
                                       bars added at the end when it runs past; notes over a bar line are tied;
                                       a note cut by the window keeps its part before it, the part after is a rest.
                                       Repeat = paste of the selection right after itself.
  {op:'respell', refs}                 each note's next spelling of the same pitch (C♯ → D♭ → B𝄪 → C♯; tied notes go
                                       along)
  {op:'accidental', refs, alter}       ♯ / ♭ / ♮ on the note's letter (alter 1 / -1 / 0): the pitch changes
  {op:'courtesy', refs}                a courtesy accidental (in brackets) on / off
After each: the bars tidied (barnorm), accidentals written where the bar needs them and redundant ones taken away
(tidy_accidentals; courtesy ones stay), ties and slurs checked (fix_ties / fix_slurs).
"""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

OPS = ('clear', 'paste', 'respell', 'accidental', 'courtesy')
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
SHARP_ORDER, FLAT_ORDER = 'FCGDAEB', 'BEADGCF'
ACC = {2: 'double-sharp', 1: 'sharp', 0: 'natural', -1: 'flat', -2: 'flat-flat'}
ACC_ALTER = {v: k for k, v in ACC.items()} | {'sharp-sharp': 2}


def q_of(x):
    """A time in quarters from the client (float / "3/2" / int) as an exact fraction."""
    try: return Fr(str(x)).limit_denominator(960)
    except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, f'Not a time: {x}')


class Bar:
    def __init__(self, m, div, tsig, start, L):
        self.m, self.div, self.tsig, self.start, self.L = m, div, tsig, start, L

    @property
    def end(self): return self.start + self.L


def geometry(part):
    """[Bar] of the part: where each bar starts and how long it is, in quarters (a short first bar = a pickup; an
    over-full bar counts as long as it is)."""
    from .staffmove import _read_bar
    out, div, tsig, t = [], Fr(1), (4, 4), Fr(0)
    for bi, m in enumerate(part.findall('measure')):
        for a in m.findall('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            tm = a.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        longest = _read_bar(m, div)[2] / div
        L = Fr(4 * tsig[0], tsig[1])
        if (bi == 0 or m.get('implicit') == 'yes') and 0 < longest < L: L = longest
        elif longest > L: L = longest
        out.append(Bar(m, div, tsig, t, L)); t += L
    return out


def pos(bars, where):
    """[bar, on] -> quarters from the start of the part."""
    try: b, on = int(where[0]), q_of(where[1])
    except (TypeError, ValueError, IndexError, KeyError): raise HTTPException(400, 'A place: [bar, beat]')
    if b == len(bars) and on == 0: return bars[-1].end if bars else Fr(0)
    if not 0 <= b < len(bars): raise HTTPException(400, f'No bar {b + 1} in this score')
    return bars[b].start + max(Fr(0), on)


def _staff_range(part, staves):
    from .barops import staves as n_staves
    n = n_staves(part)
    if not staves: return 1, n
    try: xs = [int(x) for x in staves]
    except (TypeError, ValueError): raise HTTPException(400, 'staves: [first, last]')
    return max(1, min(xs)), min(n, max(xs))


def _part(text):
    from .staffmove import edit_part
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    return root, pk, part


def _staff_of(e):
    return int((e.findtext('staff') or '1').strip() or 1)


# ---------- copy ----------

def _clean_arcs(evs_by_voice):
    """Ties and slurs that leave the clip go (their other end is not in it)."""
    from .staffmove import _drop_tie, _has_tie, _midi
    for evs in evs_by_voice:
        for i, (on, d, ns, gr) in enumerate(evs):
            nxt = evs[i + 1] if i + 1 < len(evs) else None
            prv = evs[i - 1] if i else None
            for n in ns:
                mi = _midi(n)
                if _has_tie(n, 'start') and not (nxt and nxt[0] == on + d and any(_midi(x) == mi and _has_tie(x, 'stop') for x in nxt[2])):
                    _drop_tie(n, 'start')
                if _has_tie(n, 'stop') and not (prv and prv[0] + prv[1] == on and any(_midi(x) == mi for x in prv[2])):
                    _drop_tie(n, 'stop')
    slurs = []
    for evs in evs_by_voice:
        for on, d, ns, gr in evs:
            for n in ns:
                for s in n.findall('notations/slur'): slurs.append((on, 0 if s.get('type') == 'stop' else 1, n, s))
    slurs.sort(key=lambda x: (x[0], x[1]))
    open_, keep = {}, set()
    for on, _, n, s in slurs:
        num = s.get('number') or '1'
        if s.get('type') == 'start': open_[num] = s
        elif s.get('type') == 'stop' and num in open_: keep.add(id(open_.pop(num))); keep.add(id(s))
    for on, _, n, s in slurs:
        if id(s) in keep or s.get('type') not in ('start', 'stop'): continue
        nt = n.find('notations'); nt.remove(s)
        if not len(nt) and not nt.attrib: n.remove(nt)


def clip_of(text, start, end, staves=None):
    from .staffmove import _read_bar
    root, pk, part = _part(text)
    bars = geometry(part)
    A, B = pos(bars, start), pos(bars, end)
    if B <= A: raise HTTPException(400, 'Pick some notes to copy')
    s0, s1 = _staff_range(part, staves)
    order, vmap, evs, harm = {}, {}, {}, []
    for g in bars:
        if g.end <= A or g.start >= B: continue
        a, b = max(A, g.start) - g.start, min(B, g.end) - g.start
        voices, other, _ = _read_bar(g.m, g.div)
        for vo in sorted(voices, key=lambda v: v.first):
            st = int(vo.staff)
            if not s0 <= st <= s1: continue
            key = (vo.staff, vo.num)
            if key not in vmap:
                vmap[key] = (st - s0, order.get(st, 0)); order[st] = order.get(st, 0) + 1
            for ev in vo.evs:
                if ev.kind != 'notes' or not ev.notes: continue
                on, e_ = Fr(ev.on) / g.div, Fr(ev.end) / g.div
                if ev.dur == 0:
                    if not a <= on < b: continue
                elif e_ <= a or on >= b: continue
                lo, hi = max(on, a), min(e_, b)
                tup = any(n.find('time-modification') is not None for n in ev.notes)
                if tup and (lo, hi) != (on, e_): continue  # part of a triplet: a rest in the clip
                ns = [copy.deepcopy(n) for n in ev.notes]
                for n in ns:
                    for t in ('beam', 'stem'):
                        for x in n.findall(t): n.remove(x)
                if lo > on:
                    from .staffmove import _drop_tie
                    for n in ns: _drop_tie(n, 'stop')
                if hi < e_:
                    from .staffmove import _drop_tie
                    for n in ns: _drop_tie(n, 'start')
                gr = [copy.deepcopy(x) for x in ev.graces] if lo == on else []
                evs.setdefault(vmap[key], []).append((g.start + lo - A, hi - lo, ns, gr))
        for t, _, e in other:
            if e.tag != 'harmony': continue
            hs = _staff_of(e)
            if s0 <= hs <= s1 and a <= Fr(t) / g.div < b:
                harm.append({'on': str(g.start + Fr(t) / g.div - A), 'staff': hs - s0, 'xml': ET.tostring(e, encoding='unicode')})
    for k in evs: evs[k].sort(key=lambda x: x[0])
    _clean_arcs(list(evs.values()))
    voices = [{'staff': k, 'voice': j, 'evs': [{'on': str(on), 'dur': str(d), 'notes': [ET.tostring(n, encoding='unicode') for n in ns],
                                                 'graces': [ET.tostring(x, encoding='unicode') for x in gr]} for on, d, ns, gr in v]}
              for (k, j), v in sorted(evs.items())]
    nn = sum(len(e['notes']) for v in voices for e in v['evs'])
    first = next((k for k, g in enumerate(bars) if g.end > A), 0)
    last = next((k for k in range(len(bars) - 1, -1, -1) if bars[k].start < B), first)
    return {'len': str(B - A), 'staves': s1 - s0 + 1, 'voices': voices, 'harmony': harm, 'notes': nn, 'bars': last - first + 1,
            'whole': A == bars[first].start and B == bars[last].end}


# ---------- write over a window (paste / clear) ----------

def _ensure_bars(root, part, upto):
    """Empty bars at the end of the score (every part) until it lasts `upto` quarters. Returns how many."""
    from .barops import _renumber, insert_bar
    n = 0
    while True:
        bars = geometry(part)
        if bars[-1].end >= upto or n > 400: return n
        insert_bar(root, len(bars) - 1, True, part, [])
        n += 1
        _renumber(root)


def _head_piece(ev, keep, div, beat, L, vo):
    """What is left of ev when only its first `keep` divisions stay (a note: shortened, no tie out)."""
    from .easerests import fits
    from .staffmove import Ev, _drop_tie, _rests, _split_ev
    if ev.kind == 'gap': return [Ev(ev.on, keep, [], 'gap')]
    tup = any(n.find('time-modification') is not None for n in ev.notes)
    if ev.kind == 'rest' or tup or not fits(Fr(keep) / div, div):
        return _rests(ev.on, keep, div, beat, L, vo.num, vo.staff)
    out = [x for _, x in _split_ev(ev, [(0, ev.on, keep)], div)]
    for n in out[-1].notes: _drop_tie(n, 'start')
    return out


def _clip_events(clip, bars, T, targets):
    """{(bar index, staff, clip voice): [Ev]}: the clip's notes at their places from T, split (tied) at bar lines."""
    from .easerests import pieces
    from .staffmove import Ev, _set_type, _split_ev
    per, added = {}, 0
    for cv in clip.get('voices') or []:
        ts = targets.get(int(cv.get('staff', 0)))
        if ts is None: continue
        j = int(cv.get('voice', 0))
        for rec in cv.get('evs') or []:
            try: ns = [ET.fromstring(x) for x in rec.get('notes') or []]; gr = [ET.fromstring(x) for x in rec.get('graces') or []]
            except ET.ParseError: raise HTTPException(400, 'The copied notes could not be read')
            if not ns: continue
            on, d = T + q_of(rec['on']), q_of(rec['dur'])
            segs = []
            for k, g in enumerate(bars):
                if d == 0:
                    if g.start <= on < g.end: segs.append((k, (on - g.start) * g.div, Fr(0))); break
                    continue
                lo, hi = max(on, g.start), min(on + d, g.end)
                if hi > lo: segs.append((k, (lo - g.start) * g.div, (hi - lo) * g.div))
            if not segs: continue
            div = bars[segs[0][0]].div
            if any(bars[k].div != div for k, _, _ in segs) or any(Fr(x).denominator != 1 or Fr(y).denominator != 1 for _, x, y in segs):
                raise HTTPException(400, 'Those notes are too short to be written in this score')
            tup = any(n.find('time-modification') is not None for n in ns)
            if tup and len(segs) > 1: raise HTTPException(400, 'A triplet would cross the bar line there')
            ev = Ev(segs[0][1], d * div, ns, 'notes', gr)
            if len(segs) == 1 and (tup or d == 0 or len(pieces(d)) == 1):
                if tup or d == 0:
                    for n in ns: n.find('duration').text = str(int(d * div)) if n.find('duration') is not None else '0'
                else:
                    for n in ns: _set_type(n, d, div)
                per.setdefault((segs[0][0], ts, j), []).append(ev)
                continue
            got = _split_ev(ev, segs, div)
            added += (len(got) - 1) * len(ns)
            for k, x in got: per.setdefault((k, ts, j), []).append(x)
    return per, added


def overwrite(root, part, A, B, staves_, clip=None, info=None):
    """The window [A, B) (quarters) on the staves written over: with the clip's notes (paste: staves_ = {clip staff:
    staff}) or rests (clip None: staves_ = the staves). Returns (notes written, {(bar, staff, voice)} to tidy, ties
    added)."""
    from .barops import _free_voice, _rest_voice, staves as n_staves
    from .easerests import _beat
    from .staffmove import _drop_tie, _has_tie, _normalize, _read_bar, _rests, _set_voice, _slur_spans, _timeline, _unslur, _write_bar
    info = {} if info is None else info
    targets = staves_ if isinstance(staves_, dict) else {k: s for k, s in enumerate(staves_)}
    tstaves = set(targets.values())
    one = n_staves(part) == 1
    bars = geometry(part)
    per, added = _clip_events(clip, bars, A, targets) if clip else ({}, 0)
    need = {}
    for (k, ts, j) in per: need[ts] = max(need.get(ts, 1), j + 1)
    for cv in (clip or {}).get('voices') or []:
        ts = targets.get(int(cv.get('staff', 0)))
        if ts is not None: need[ts] = max(need.get(ts, 1), int(cv.get('voice', 0)) + 1)
    # slurs with an end on a note written over go (both ends); ties into the window from before it go
    gone = set()
    for k, g in enumerate(bars):
        if g.start > B or g.end < A: continue
        a, b = (max(A, g.start) - g.start) * g.div, (min(B, g.end) - g.start) * g.div
        for vo in _read_bar(g.m, g.div)[0]:
            if int(vo.staff) not in tstaves: continue
            for ev in vo.evs:
                if ev.kind != 'notes': continue
                if g.end > A and g.start < B and a <= ev.on < b: gone.update(id(n) for n in ev.notes)
                if g.start + Fr(ev.end) / g.div == A:
                    for n in ev.notes: _drop_tie(n, 'start')
    for num, x, y, sx, sy in _slur_spans(_timeline(part)):
        if id(x[0]) in gone or id(y[0]) in gone: _unslur([(x[0], sx), (y[0], sy)])
    from .staffmove import _slur_mark
    info['snap'] = _slur_mark(part)  # after: slurs whose end note is cut short move to the note left (fix_slurs)
    written, tidy = [], set()
    for k, g in enumerate(bars):
        if g.end <= A or g.start >= B: continue
        div, beat = g.div, _beat(g.tsig)
        a, b = (max(A, g.start) - g.start) * div, (min(B, g.end) - g.start) * div
        L = g.L * div
        voices, other, longest = _read_bar(g.m, div)
        used = {v.num for v in voices}
        for ts in sorted(tstaves):
            mine = sorted([v for v in voices if v.staff == str(ts)], key=lambda v: v.first)
            want = need.get(ts, 1) if clip else len(mine)
            while len(mine) < want:
                vo = _rest_voice(_free_voice(part, ts, used), ts, L, div, g.tsig)
                used.add(vo.num); voices.append(vo); mine.append(vo)
            for j, vo in enumerate(mine):
                new = []
                for ev in vo.evs:
                    if ev.dur == 0:
                        if not a <= ev.on < b: new.append(ev)
                        continue
                    if ev.end <= a or ev.on >= b: new.append(ev); continue
                    if ev.on < a: new.extend(_head_piece(ev, a - ev.on, div, beat, L, vo))
                    if ev.end > b:
                        if ev.kind == 'gap':
                            from .staffmove import Ev
                            new.append(Ev(b, ev.end - b, [], 'gap'))
                        else: new.extend(_rests(b, ev.end - b, div, beat, L, vo.num, vo.staff))
                content = sorted(per.get((k, ts, j), []), key=lambda e: e.on)
                for e in content:
                    for n in e.notes + e.graces:
                        _set_voice(n, vo.num, vo.staff)
                        if one:
                            for s in n.findall('staff'): n.remove(s)
                    written.extend(e.notes)
                new.extend(content)
                t = a
                for e in content:
                    if e.on > t: new.extend(_rests(t, e.on - t, div, beat, L, vo.num, vo.staff))
                    t = max(t, e.end)
                if t < b: new.extend(_rests(t, b - t, div, beat, L, vo.num, vo.staff))
                if one:
                    for e in new:
                        for n in e.notes:
                            for s in n.findall('staff'): n.remove(s)
                vo.evs = sorted(new, key=lambda e: (e.on, e.dur > 0))
                vo.touched = True
                _normalize(vo, div, beat, L)
                tidy.add((k, vo.staff, vo.num))
            # a voice left with nothing but rests goes when its staff has another voice
            for vo in sorted(mine, key=lambda v: (len(v.num), v.num), reverse=True):
                if all(e.kind != 'notes' for e in vo.evs) and sum(1 for o in voices if o.staff == vo.staff) > 1:
                    voices.remove(vo); tidy.discard((k, vo.staff, vo.num))
        # chord names: those in the window on these staves go; the clip's come in
        keep_other = []
        for o in other:
            if o[2].tag == 'harmony' and _staff_of(o[2]) in tstaves and a <= o[0] < b: continue
            keep_other.append(o)
        for h in (clip or {}).get('harmony') or []:
            ts = targets.get(int(h.get('staff', 0)))
            if ts is None: continue
            t = A + q_of(h['on'])
            if not g.start <= t < g.end: continue
            try: el = ET.fromstring(h['xml'])
            except ET.ParseError: continue
            st = el.find('staff')
            if ts != 1 or st is not None:
                if st is None: st = ET.SubElement(el, 'staff')
                st.text = str(ts)
            if one and el.find('staff') is not None and ts == 1: el.remove(el.find('staff'))
            keep_other.append(((t - g.start) * div, 10 ** 5, el))
        voices.sort(key=lambda v: (int(v.staff), v.first))
        _write_bar(g.m, voices, keep_other, L, div, beat)
    return written, tidy, added


# ---------- spelling ----------

def spellings(midi):
    """Every way to write this pitch with up to two sharps / flats: [(step, alter, octave)], plain ones first."""
    out = []
    for step, pc in STEP.items():
        for alt in (0, 1, -1, 2, -2):
            v = midi - pc - alt
            if v % 12 == 0: out.append((step, alt, v // 12 - 1))
    out.sort(key=lambda s: (abs(s[1]) > 1, abs(s[1]), -s[1]))
    return out


def _spelling(n):
    p = n.find('pitch')
    return (p.findtext('step').strip(), int(round(float(p.findtext('alter') or 0))), int(p.findtext('octave')))


def _write_pitch(n, step, alt, octave):
    p = n.find('pitch')
    for c in list(p): p.remove(c)
    ET.SubElement(p, 'step').text = step
    if alt: ET.SubElement(p, 'alter').text = str(alt)
    ET.SubElement(p, 'octave').text = str(octave)


def key_alters(fifths):
    out = {s: 0 for s in STEP}
    for s in (SHARP_ORDER[:fifths] if fifths > 0 else FLAT_ORDER[:-fifths]): out[s] = 1 if fifths > 0 else -1
    return out


def tidy_accidentals(part, which=None):
    """Accidentals as a reader needs them in each bar (which: bar indexes; None = every bar): written where the key
    and the notes before it in the bar do not give the pitch, taken away where they do (a courtesy accidental —
    cautionary / in brackets — stays). A note tied over from before shows none. Returns how many changed."""
    from .easerests import _put
    from .staffmove import _has_tie
    fifths, changed, div = 0, 0, Fr(1)
    for bi, m in enumerate(part.findall('measure')):
        for k in m.iter('key'):
            try: fifths = int(k.findtext('fifths') or 0)
            except ValueError: pass
        if which is not None and bi not in which: continue
        ka = key_alters(fifths)
        rows, t, last = [], Fr(0), Fr(0)
        for e in m:
            if e.tag == 'attributes' and e.findtext('divisions'): div = Fr(int(float(e.findtext('divisions'))))
            elif e.tag == 'backup': t -= Fr(int(float(e.findtext('duration') or 0)))
            elif e.tag == 'forward': t += Fr(int(float(e.findtext('duration') or 0)))
            elif e.tag == 'note':
                gr = e.find('grace') is not None
                d = Fr(0) if gr else Fr(int(float(e.findtext('duration') or 0)))
                at = last if e.find('chord') is not None else t
                if e.find('chord') is None: last, t = t, t + d
                if e.find('pitch') is not None: rows.append((at, 0 if gr else 1, len(rows), e))
        state = {}
        for at, _, _, n in sorted(rows, key=lambda r: r[:3]):
            step, alt, octave = _spelling(n)
            st = (n.findtext('staff') or '1').strip()
            have = n.find('accidental')
            courtesy = have is not None and (have.get('cautionary') == 'yes' or have.get('parentheses') == 'yes' or have.get('editorial') == 'yes')
            implied = state.get((st, step, octave), ka[step])
            tied = _has_tie(n, 'stop')
            if courtesy:
                if have.text != ACC[max(-2, min(2, alt))]: have.text = ACC[max(-2, min(2, alt))]; changed += 1
            elif tied or alt == implied:
                if have is not None: n.remove(have); changed += 1
            else:
                want = ACC[max(-2, min(2, alt))]
                if have is None: have = _put(n, ET.Element('accidental')); changed += 1
                elif have.text != want: changed += 1
                have.text = want
            if not tied: state[(st, step, octave)] = alt
    return changed


# ---------- the op ----------

def _notes_of(part, refs, rests_ok=False):
    all_notes = list(part.iter('note'))
    out = []
    for r in refs or []:
        try: r = int(r)
        except (TypeError, ValueError): raise HTTPException(400, f'Not a note: {r}')
        if not 0 <= r < len(all_notes): raise HTTPException(400, f'No note {r} in this score')
        n = all_notes[r]
        if n.find('pitch') is None:
            if rests_ok: continue
            continue
        out.append(n)
    if not out: raise HTTPException(400, 'Pick some notes first')
    return out


def range_op(text, op, info=None):
    from .barnorm import normalize_bar, tidy_score
    from .staffmove import _head, _midi, _slur_mark, _tie_chain, _tie_count, fix_slurs, fix_ties, ties_gone
    from .barops import staves as n_staves
    info = {} if info is None else info
    kind = op.get('op')
    root, pk, part = _part(text)
    ties_before = _tie_count(part)
    touched, tidy, added, acc_bars = [], set(), 0, set()
    bar_of = {id(n): k for k, m in enumerate(part.findall('measure')) for n in m.iter('note')}
    if kind in ('respell', 'accidental', 'courtesy'):
        picked = _notes_of(part, op.get('refs'))
        ids = {id(n) for n in picked}
        chain = _tie_chain(part, ids)
        by_id = {id(n): n for n in part.iter('note')}
        if kind == 'respell':
            for n in picked:
                cur = _spelling(n)
                opts = spellings(_midi(n))
                nxt = opts[(opts.index(cur) + 1) % len(opts)] if cur in opts else opts[0]
                todo = [n] + [by_id[i] for i in _tie_chain(part, {id(n)}) if i != id(n) and i in by_id]
                for x in todo:
                    if _midi(x) == _midi(n): _write_pitch(x, *nxt)
        elif kind == 'accidental':
            try: alt = int(op.get('alter'))
            except (TypeError, ValueError): raise HTTPException(400, 'alter: 1 (sharp), -1 (flat) or 0 (natural)')
            if alt not in (-2, -1, 0, 1, 2): raise HTTPException(400, 'alter: 1 (sharp), -1 (flat) or 0 (natural)')
            for n in [by_id[i] for i in chain if i in by_id and by_id[i].find('pitch') is not None]:
                step, _, octave = _spelling(n)
                _write_pitch(n, step, alt, octave)
                a = n.find('accidental')
                if a is not None and a.get('cautionary') != 'yes' and a.get('parentheses') != 'yes': n.remove(a)
        else:
            from .easerests import _put
            on = not all((n.find('accidental') is not None and n.find('accidental').get('parentheses') == 'yes') for n in picked)
            for n in picked:
                a = n.find('accidental')
                if on:
                    if a is None: a = _put(n, ET.Element('accidental'))
                    a.set('cautionary', 'yes'); a.set('parentheses', 'yes')
                elif a is not None: n.remove(a)
        touched = picked
        acc_bars = {bar_of[i] for i in chain if i in bar_of}
        tidy_accidentals(part, acc_bars)
        dropped = fix_ties(part)
    else:
        bars = geometry(part)
        snap = None
        if kind == 'clear':
            A, B = pos(bars, op.get('start')), pos(bars, op.get('end'))
            if B <= A: raise HTTPException(400, 'Pick some notes first')
            s0, s1 = _staff_range(part, op.get('staves'))
            touched, tidy, added = overwrite(root, part, A, B, list(range(s0, s1 + 1)), None, info)
            touched = []
        else:
            clip = op.get('clip')
            if not isinstance(clip, dict) or not clip.get('len'): raise HTTPException(400, 'Nothing copied yet: copy some notes first')
            A = pos(bars, op.get('at'))
            Lc = q_of(clip['len'])
            # notes finer than this score's <divisions> (32nds into a score of 16ths): a finer unit first
            from .divisions import fit_divisions
            qs = [A, Lc] + [q_of(r[k]) for cv in clip.get('voices') or [] for r in cv.get('evs') or [] for k in ('on', 'dur') if r.get(k) is not None]
            if fit_divisions(root, qs) != 1: bars = geometry(part)
            try: s = int(op.get('staff') or 1)
            except (TypeError, ValueError): raise HTTPException(400, 'staff: a staff number')
            n = n_staves(part)
            if not 1 <= s <= n: raise HTTPException(400, f'staff: 1 to {n}')
            k = int(clip.get('staves') or 1)
            targets = {i: s + i for i in range(k) if s + i <= n}
            if len(targets) < k: info.setdefault('said', []).append(
                f'{k - len(targets)} of the copied staves had no staff below to go to: left out')
            more = _ensure_bars(root, part, A + Lc)
            if more: info.setdefault('said', []).append(f'{more} bar{"s" if more != 1 else ""} added at the end for it')
            touched, tidy, added = overwrite(root, part, A, A + Lc, targets, clip, info)
        bars = part.findall('measure')
        nb = {}
        div, tsig = Fr(1), (4, 4)
        for bi, m in enumerate(bars):
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            for b, st, v in sorted(tidy):
                if b == bi: normalize_bar(m, st, v, tsig, div, keep=set(), info=nb)
        added += nb.get('ties', 0)
        tidy_score(root)
        fix_slurs(part, info.pop('snap'))
        dropped = fix_ties(part)
        tidy_accidentals(part, {b for b, _, _ in tidy})
    gone = ties_gone(ties_before + added, part, dropped)
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    return out, sorted({ref[id(e)] for e in touched if id(e) in ref}), gone
