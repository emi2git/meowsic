"""Tidy one voice of one bar after an edit (Edit notes, staffmove.py): beams and rests the way engraved music has them.

normalize_bar(measure, staff, voice, time=(4, 4), div=None, keep=None, info=None) — measure = a <measure> element
(changed in place and returned) or its XML text (a new text is returned). Only that staff / voice changes; pitches,
onsets, what sounds, lyrics, ties, chords, dynamics and the other voices stay as they are.
keep = ids of <note> elements the user just set (Edit notes: a rest or note given a length): they are never joined
with their neighbours nor spelled again, unless notationally wrong (a half rest over the middle of a 4/4 bar, a
quarter on the off-beat …): then they are split by the beat and info['split'] says so ([(onset, quarters, [pieces])]).
info['ties'] = tie starts added (+) / taken away (−) by the spelling below.

Notes spelled by the meter (a note, chord or tied chain of one voice inside the bar; what sounds never changes):
  a value is "in place" when it starts a span of the meter and stays inside it — the bar, a beam group (half bar
  in 4/4, dotted quarter in 6/8, half bar of 12/8), a beat — or lies inside one beat (16th–8th–16th, …):
  4/4 dotted half on beat 1 yes, half on beat 2 no; 6/8 dotted quarter per beat, quarter–eighth in a beat;
  a chain is written again as the longest values in place, in time order (the short piece first when it completes
  the beat, so it beams with its neighbours: half~8th from the and of 2 → 8th~half), and tied pieces merge back
  into one note when that one is in place (two tied quarters on beat 1 → a half);
  lyrics, articulations and a slur start stay on the first piece; a slur stop / fermata of the last goes on the
  last; ties into and out of the chain stay. Tuplets, grace-led pieces, hidden or cue notes are left alone.

Beams (8ths and shorter, beam on the chord's first note, number 1 = 8th level, 2 = 16th …):
  4/4  each half bar (beats 1–2, 3–4); per beat when that half has 16ths (or shorter) or tuplets
  2/4  the whole bar (two beats), per beat with 16ths;      2/2  per half note, per beat with 16ths
  3/4 and other x/4  per beat
  6/8, 9/8, 12/8  per dotted quarter;   3/8 the bar;  4/8 2+2;  5/8 3+2;  7/8 2+2+3 (eighths)
  never across a rest, a gap, a quarter-or-longer note or a group line; one note alone keeps its flag;
  old beams of the voice go.
Rests in a row (plain ones: no tuplet, nothing on them) are joined and written again as the largest rests that keep
the beats readable:
  the whole bar empty → one whole-bar rest (<rest measure="yes"/>);
  simple time: undotted values, each starting on a multiple of its own length (4/4: a half rest on beat 1 or 3,
    never over the middle; 3/4: a half rest on beats 1–2 only), never over a beam-group line in x/8 time;
  compound time (6/8 …): a dotted half on beat 1 (or 3 in 12/8), a dotted quarter per beat, a quarter only for the
    first two eighths of a beat, then eighths / 16ths on their own grid.
A bar whose voice is not exactly the time signature long (pickup, odd bar) keeps its rests; beams are still done.

tidy_score(root, fill) — the whole score after every edit: a time signature, key, clef, divisions or staves that
repeats the one in force goes (real changes stay), empty <attributes> go, and edited bars where a voice ends early
get rests to the end; a voice longer than its bar is reported, never stretched. Old scores:
scripts/tidy_scores.py (a dry run counts them).
"""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from .easerests import BEAMS, TYPES, _put

SIMPLE = [Fr(4), Fr(2), Fr(1), Fr(1, 2), Fr(1, 4), Fr(1, 8), Fr(1, 16)]
WRITTEN = {v: (t, dots) for v, t, dots in TYPES}


def bar_quarters(time):
    n, d = time
    return Fr(4 * n, d)


def compound(time):
    n, d = time
    return d >= 8 and n % 3 == 0 and n > 3


def beam_groups(time):
    """(group lines in quarters from the bar start, ending with the bar length; the sub-beat for 16ths / tuplets
    or None)."""
    n, d = time
    L = bar_quarters(time)
    unit = Fr(4, d)
    if compound(time): step, sub = 3 * unit, None
    elif d == 4 and n in (2, 4): step, sub = Fr(2), Fr(1)
    elif d == 4: step, sub = Fr(1), None
    elif d == 2: step, sub = Fr(2), Fr(1)
    elif d == 8:
        sizes = {1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 7: [2, 2, 3]}.get(n)
        if sizes:
            lines, t = [], Fr(0)
            for s in sizes: t += s * unit; lines.append(t)
            return lines, None
        step, sub = Fr(1), None
    else: step, sub = Fr(1), None
    lines, t = [], Fr(0)
    while t + step < L: t += step; lines.append(t)
    return lines + [L], sub


def _group_of(lines, t):
    for k, x in enumerate(lines):
        if t < x: return k
    return len(lines)


def beam_plan(events, time):
    """events: [(on, dur, type, rest, tuplet)] in quarters (gaps as rest=True). -> [[event index, …] per beam group]
    (only groups of two or more)."""
    lines, sub = beam_groups(time)
    split = set()  # groups that beam per beat
    if sub:
        for on, dur, ty, rest, tup in events:
            if not rest and BEAMS.get(ty, 0) and (BEAMS[ty] >= 2 or tup): split.add(_group_of(lines, on))
    out, cur, key = [], [], None
    for i, (on, dur, ty, rest, tup) in enumerate(events):
        g = _group_of(lines, on)
        k = (g, on // sub) if g in split else (g,)
        if rest or dur <= 0 or not BEAMS.get(ty, 0) or k != key or (cur and events[cur[-1]][0] + events[cur[-1]][1] != on):
            if len(cur) > 1: out.append(cur)
            cur, key = [], k
            if rest or dur <= 0 or not BEAMS.get(ty, 0): key = None; continue
        cur.append(i)
    if len(cur) > 1: out.append(cur)
    return out


def rest_plan(a, b, time, bar_len=None):
    """Rests for [a, b) quarters of a bar: [(on, quarters)], or [(0, bar, 'bar')] for a whole-bar rest; None when
    it cannot be written in plain values."""
    L = bar_len if bar_len is not None else bar_quarters(time)
    if a == 0 and b == L: return [(Fr(0), L, 'bar')]
    lines, _ = beam_groups(time)
    n, d = time
    out, t = [], Fr(a)
    if compound(time):
        u = Fr(4, d)
        cands = [(6 * u, 6 * u), (3 * u, 3 * u), (2 * u, 3 * u)] + [(u / 2 ** k, u / 2 ** k) for k in range(4)]
    else:
        cands = [(v, v) for v in SIMPLE if v < L or v == L]
    while t < b:
        for v, align in cands:
            if t + v > b or t % align or v not in WRITTEN: continue
            if d == 8 and not compound(time) and _group_of(lines, t) != _group_of(lines, t + v - Fr(1, 64)): continue
            out.append((t, v)); t += v; break
        else: return None
    return out


# ---------- on the XML ----------

def _beam_notes(evs, time, div):
    """evs: staffmove Ev list of the voice (divisions). Beams written again on its notes."""
    rows = []
    for e in evs:
        n = e.notes[0] if e.notes else None
        rest = e.kind != 'notes' or n is None
        rows.append((Fr(e.on) / div, Fr(e.dur) / div, '' if rest else (n.findtext('type') or '').strip(), rest,
                     n is not None and n.find('time-modification') is not None))
    for e in evs:
        for n in e.notes:
            for b in n.findall('beam'): n.remove(b)
    for g in beam_plan(rows, time):
        lv = [BEAMS[rows[i][2]] for i in g]
        for level in range(1, 5):
            for j, i in enumerate(g):
                if lv[j] < level: continue
                prev = j > 0 and lv[j - 1] >= level
                nxt = j < len(g) - 1 and lv[j + 1] >= level
                if not prev and not nxt:
                    if level == 1: continue
                    kind = 'backward hook' if j else 'forward hook'
                else: kind = 'begin' if not prev else 'end' if not nxt else 'continue'
                be = ET.Element('beam', number=str(level)); be.text = kind
                _put(evs[i].notes[0], be)


def _plain(e):
    if not e.plain_rest or e.graces or not e.notes: return False
    n = e.notes[0]
    return n.find("notations") is None and n.find("lyric") is None and n.get("print-object") != "no" and n.find("cue") is None


def _rest_el(vo, q, div, whole_bar=False):
    from .staffmove import _note_el
    n = _note_el(vo.num, vo.staff, q * div, ET.Element('rest', measure='yes') if whole_bar else ET.Element('rest'))
    if whole_bar:
        if q == 4: _put(n, ET.Element('type')).text = 'whole'
    else:
        ty, dots = WRITTEN[q]
        _put(n, ET.Element('type')).text = ty
        for _ in range(dots): _put(n, ET.Element('dot'))
    _put(n, ET.Element('staff')).text = vo.staff
    return n


def _merge_rests(vo, time, div, bar_len, keep=frozenset()):
    """Runs of plain rests written again (rest_plan); a kept rest (keep: ids) is a run of its own, never joined.
    True when something changed."""
    from .staffmove import Ev
    out, run, changed = [], [], False

    def flush():
        nonlocal changed
        if not run: return
        a, b = Fr(run[0].on) / div, Fr(run[-1].end) / div
        plan = rest_plan(a, b, time, bar_len)
        now = [(Fr(e.on) / div, Fr(e.dur) / div) for e in run]
        whole = run[0].notes[0].find('rest').get('measure') == 'yes'
        if plan is None or any((v * div).denominator != 1 for _, v, *_ in plan) or \
                ([(t, v) for t, v, *_ in plan] == now and (len(plan[0]) == 3) == whole):
            out.extend(run); return
        changed = True
        for t, v, *bar in plan:
            out.append(Ev(t * div, v * div, [_rest_el(vo, v, div, bool(bar))], 'rest'))

    for e in vo.evs:
        if e.kind == 'rest' and e.notes and id(e.notes[0]) in keep:
            flush(); run = []; out.append(e); continue
        if e.kind == 'rest' and _plain(e) and (not run or run[-1].end == e.on): run.append(e); continue
        flush(); run = []
        if e.kind == 'rest' and _plain(e): run = [e]; continue
        out.append(e)
    flush()
    vo.evs = out
    return changed


def beat_len(time):
    n, d = time
    if compound(time): return Fr(12, d)
    if d == 2: return Fr(2)
    return Fr(4, d)


def spans(time, L=None):
    """The spans of the meter a value may fill: [(start, end)] — the bar, beam groups, (12/8) half bars, beats."""
    L = bar_quarters(time) if L is None else L
    out = {(Fr(0), L)}
    lines, _ = beam_groups(time)
    a = Fr(0)
    for x in lines:
        if a < x <= L: out.add((a, x)); a = x
    if compound(time) and time[0] == 12: out |= {(Fr(0), L / 2), (L / 2, L)}
    b, t = beat_len(time), Fr(0)
    while t < L: out.add((t, min(L, t + b))); t += b
    return sorted(out)


def in_place(t, v, time, L=None):
    """Can one written value of v quarters stand at t (quarters from the bar start)? (see the module doc)"""
    if v not in WRITTEN: return False
    b = beat_len(time)
    for s, e in spans(time, L):
        if (s == t and t + v <= e) or (e - s <= b and s <= t and t + v <= e): return True
    return False


def note_plan(a, b, time, div, L=None):
    """[(on, quarters)] for [a, b): the longest value in place at each point, in time order; None when none fits."""
    out, t = [], Fr(a)
    vals = sorted(WRITTEN, reverse=True)
    while t < b:
        for v in vals:
            if t + v <= b and (v * div).denominator == 1 and in_place(t, v, time, L): out.append((t, v)); t += v; break
        else: return None
        if len(out) > 32: return None
    return out


def _extras(n):
    """Anything on a note besides its tie (notations other than <tied>, lyrics)."""
    nt = n.find('notations')
    return (nt is not None and any(c.tag != 'tied' for c in nt)) or n.find('lyric') is not None


def _spellable(e):
    if e.kind != 'notes' or e.dur <= 0 or not e.notes: return False
    return all(n.find('pitch') is not None and n.find('time-modification') is None and n.get('print-object') != 'no'
               and n.find('cue') is None and n.find('grace') is None for n in e.notes)


def _pitches(e):
    from .staffmove import _midi
    return sorted(_midi(n) or 0 for n in e.notes)


def _respell(vo, time, div, L, keep, info):
    """Notes and tied chains of the voice written again by the meter (module doc). True when something changed."""
    import copy
    from .staffmove import Ev, _has_tie, _add_tie, _drop_tie, _midi, _notations
    from .easerests import _set_len, _strip_for_continuation
    evs, out, i, changed = vo.evs, [], 0, False
    byp = lambda ns: sorted(ns, key=lambda n: _midi(n) or 0)
    while i < len(evs):
        e = evs[i]
        if not _spellable(e): out.append(e); i += 1; continue
        chain = [e]
        while i + len(chain) < len(evs):
            x, y = chain[-1], evs[i + len(chain)]
            if not (_spellable(y) and y.on == x.end and not y.graces and _pitches(y) == _pitches(x)
                    and all(_has_tie(n, 'start') for n in x.notes) and all(_has_tie(n, 'stop') for n in y.notes)): break
            chain.append(y)
        i += len(chain)
        now = [(Fr(c.on) / div, Fr(c.dur) / div) for c in chain]
        mid_ok = all(not any(_extras(n) for n in c.notes) for c in chain[1:-1]) and \
            (len(chain) == 1 or not any(n.find('lyric') is not None for n in chain[-1].notes))
        kept = any(id(n) in keep for c in chain for n in c.notes)
        if not mid_ok or (kept and all(in_place(t, v, time, L) for t, v in now)):
            out.extend(chain); continue
        plan = note_plan(now[0][0], now[-1][0] + now[-1][1], time, div, L)
        if plan is None or plan == now: out.extend(chain); continue
        if kept: info.setdefault('split', []).append((now[0][0], sum(v for _, v in now), [v for _, v in plan], 'note'))
        first, last = byp(chain[0].notes), byp(chain[-1].notes)
        tie_in = [_has_tie(n, 'stop') for n in first]
        tie_out = [_has_tie(n, 'start') for n in last]
        P = len(plan)
        groups = []
        for k in range(P):
            if k == 0: ns = chain[0].notes
            elif k == P - 1 and len(chain) > 1: ns = chain[-1].notes
            elif k < len(chain) - 1: ns = chain[k].notes
            else:
                ns = [copy.deepcopy(n) for n in chain[0].notes]
                for n in ns:
                    _strip_for_continuation(n)
                    for g in n.findall('stem'): n.remove(g)
                for n in ns:
                    if id(n) in keep: keep.discard(id(n))
            groups.append(ns)
        if P == 1 and len(chain) > 1:  # merged: the last piece's slur stop / fermata … go on the one note
            for a, b in zip(byp(groups[0]), last):
                nt = b.find('notations')
                if nt is None: continue
                for c in [c for c in nt if c.tag != 'tied']:
                    nt.remove(c); _notations(a).append(c)
        for k, ((t, v), ns) in enumerate(zip(plan, groups)):
            ty, dots = WRITTEN[v]
            for j, n in enumerate(byp(ns)):
                _set_len(n, v, ty, dots, div)
                _drop_tie(n, 'start'); _drop_tie(n, 'stop')
                if k > 0 or tie_in[j]: _add_tie(n, 'stop')
                if k < P - 1 or tie_out[j]: _add_tie(n, 'start')
            out.append(Ev(t * div, v * div, ns, 'notes', chain[0].graces if k == 0 else []))
        info['ties'] = info.get('ties', 0) + (P - len(chain)) * len(first)
        info['respelled'] = info.get('respelled', 0) + 1
        changed = True
    vo.evs = out
    return changed


def _split_kept_rests(vo, time, div, L, keep, info):
    """A kept rest that is notationally wrong is split by the beat (its pieces stay kept). True when one was."""
    from .staffmove import Ev
    from .easerests import _set_len
    out, changed = [], False
    for e in vo.evs:
        if e.kind != 'rest' or not e.notes or id(e.notes[0]) not in keep:
            out.append(e); continue
        a, q = Fr(e.on) / div, Fr(e.dur) / div
        if (a == 0 and q == L) or in_place(a, q, time, L):
            out.append(e); continue
        plan = rest_plan(a, a + q, time, L)
        if plan is None or any((v * div).denominator != 1 for _, v, *_ in plan): out.append(e); continue
        info.setdefault('split', []).append((a, q, [v for _, v, *_ in plan], 'rest'))
        for k, (t, v, *bar) in enumerate(plan):
            if k == 0:
                n = e.notes[0]
                ty, dots = WRITTEN[v]
                _set_len(n, v, ty, dots, div)
            else: n = _rest_el(vo, v, div, bool(bar))
            keep.add(id(n))
            out.append(Ev(t * div, v * div, [n], 'rest'))
        changed = True
    vo.evs = out
    return changed


def normalize_bar(measure, staff, voice, time=(4, 4), div=None, keep=None, info=None):
    """Beams, rests and note values of one staff / voice of the bar, tidied (see the module doc)."""
    from .staffmove import _read_bar, _write_bar
    text = isinstance(measure, (str, bytes))
    m = ET.fromstring(measure) if text else measure
    if div is None:
        dv = m.findtext('attributes/divisions')
        div = Fr(int(float(dv))) if dv else Fr(1)
    div = Fr(div)
    keep = keep if keep is not None else set()
    info = info if info is not None else {}
    staff, voice = str(staff), str(voice)
    voices, other, longest = _read_bar(m, div)
    vo = next((v for v in voices if v.staff == staff and v.num == voice), None)
    if vo is not None:
        L = bar_quarters(time)
        if vo.evs and Fr(vo.evs[-1].end) / div == L:
            ch = _split_kept_rests(vo, time, div, L, keep, info)
            ch = _merge_rests(vo, time, div, L, keep) or ch
            ch = _respell(vo, time, div, L, keep, info) or ch
            if ch: _write_bar(m, voices, other, longest, div, Fr(1))  # nothing touched: _write_bar beams nothing itself
        _beam_notes([e for e in vo.evs if e.dur > 0], time, div)
    if text:
        return ET.tostring(m, encoding='unicode')
    return m


# ---------- the whole score (after every edit; scripts/tidy_scores.py for old scores) ----------

def _key_of(e):
    return ((e.findtext('fifths') or '').strip(), (e.findtext('mode') or 'major').strip(),
            ''.join(f'{c.tag}{(c.text or "").strip()}' for c in e if c.tag not in ('fifths', 'mode', 'cancel')))


def _time_of(e):
    return (e.get('symbol') or '', e.get('print-object') or '', tuple((c.tag, (c.text or '').strip()) for c in e))


def _clef_of(e):
    return ((e.findtext('sign') or '').strip(), (e.findtext('line') or '').strip(), (e.findtext('clef-octave-change') or '0').strip())


READ = {'time': _time_of, 'key': _key_of, 'clef': _clef_of}
ATTR_ORDER = ['footnote', 'level', 'divisions', 'key', 'time', 'staves', 'part-symbol', 'instruments', 'clef',
              'staff-details', 'transpose', 'directive', 'measure-style']


def _sort_attrs(a):
    """<attributes> children in schema order."""
    kids = sorted(list(a), key=lambda c: ATTR_ORDER.index(c.tag) if c.tag in ATTR_ORDER else len(ATTR_ORDER))
    for c in list(a): a.remove(c)
    for c in kids: a.append(c)


def tidy_score(root, fill=None, whole=False):
    """Repeats that change nothing go, so the renderer draws no extra time signatures, keys or clefs mid-score:
    a <time> / <key> / <clef> / <divisions> / <staves> equal to the one in force, and <attributes> left empty.
    Real changes stay — a bar's own time signature and the one after it that puts the time back (Edit notes'
    "Change time for this bar") are real changes. fill = {(part index, bar index)}: in those bars a voice that ends
    early while another voice of the bar is full gets rests to the end (never stretched); whole=True: also when no
    voice is full (Edit notes' "Fill with rest" on a short bar). Edit notes no longer fills on its own: a bar left
    short is shown (staffmove.incomplete_bars) until it is fixed. A voice longer than its bar is only reported.
    Returns {'time', 'key', 'clef', 'other', 'attributes', 'filled': counts, 'overfull': [(part, bar number)]}."""
    from .staffmove import _read_bar, _write_bar, Ev
    st = {'time': 0, 'key': 0, 'clef': 0, 'other': 0, 'attributes': 0, 'filled': 0, 'overfull': []}
    for pi, part in enumerate(root.findall('part')):
        cur = {}  # in force: (tag, number) for time / key / clef, (tag,) for divisions / staves
        div, tsig = Fr(1), (4, 4)
        for bi, m in enumerate(part.findall('measure')):
            for a in m.findall('attributes'):
                for e in list(a):
                    if e.tag in READ: k, v, kind = (e.tag, e.get('number') or ('1' if e.tag == 'clef' else '')), READ[e.tag](e), e.tag
                    elif e.tag in ('divisions', 'staves'): k, v, kind = (e.tag,), (e.text or '').strip(), 'other'
                    else: continue
                    if cur.get(k) == v and e.get('print-object') != 'yes':
                        a.remove(e); st[kind] += 1
                    else: cur[k] = v
                dv = a.findtext('divisions')
                if dv: div = Fr(int(float(dv)))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
                if not len(a) and not a.attrib:
                    m.remove(a); st['attributes'] += 1
            L = bar_quarters(tsig) * div
            voices, other, longest = _read_bar(m, div)
            if any(v.evs and v.evs[-1].end > L for v in voices) and m.get('implicit') != 'yes':
                st['overfull'].append((pi, m.get('number')))
            if fill and (pi, bi) in fill and (longest == L or (whole and longest < L)):
                short = [v for v in voices if v.evs and v.evs[-1].end < L]
                done = False
                for vo in short:
                    plan = rest_plan(Fr(vo.evs[-1].end) / div, bar_quarters(tsig), tsig)
                    if plan is None or any((q * div).denominator != 1 for _, q, *_ in plan): continue
                    for t, q, *bar in plan: vo.evs.append(Ev(t * div, q * div, [_rest_el(vo, q, div, bool(bar))], 'rest'))
                    st['filled'] += 1; done = True
                if done: _write_bar(m, voices, other, L, div, Fr(1))
    return st


def tidy_text(text, fill=None):
    """(MusicXML text, stats): tidy_score on a file's text; the very same text when there was nothing to tidy."""
    from .staffmove import _head
    root = ET.fromstring(text.encode('utf-8'))
    st = tidy_score(root, fill)
    if not any(v for k, v in st.items() if k != 'overfull'): return text, st
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', st
