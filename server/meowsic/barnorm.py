"""Tidy one voice of one bar after an edit (Edit notes, staffmove.py): beams and rests the way engraved music has them.

normalize_bar(measure, staff, voice, time=(4, 4), div=None) — measure = a <measure> element (changed in place and
returned) or its XML text (a new text is returned). Only that staff / voice changes; pitches, onsets, what sounds,
lyrics, ties, chords, dynamics and the other voices stay as they are.

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


def _merge_rests(vo, time, div, bar_len):
    """Runs of plain rests written again (rest_plan). True when something changed."""
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
        if e.kind == 'rest' and _plain(e) and (not run or run[-1].end == e.on): run.append(e); continue
        flush(); run = []
        if e.kind == 'rest' and _plain(e): run = [e]; continue
        out.append(e)
    flush()
    vo.evs = out
    return changed


def normalize_bar(measure, staff, voice, time=(4, 4), div=None):
    """Beams and rests of one staff / voice of the bar, tidied (see the module doc)."""
    from .staffmove import _read_bar, _write_bar
    text = isinstance(measure, (str, bytes))
    m = ET.fromstring(measure) if text else measure
    if div is None:
        dv = m.findtext('attributes/divisions')
        div = Fr(int(float(dv))) if dv else Fr(1)
    div = Fr(div)
    staff, voice = str(staff), str(voice)
    voices, other, longest = _read_bar(m, div)
    vo = next((v for v in voices if v.staff == staff and v.num == voice), None)
    if vo is not None:
        L = bar_quarters(time)
        if vo.evs and Fr(vo.evs[-1].end) / div == L and _merge_rests(vo, time, div, L):
            _write_bar(m, voices, other, longest, div, Fr(1))  # nothing touched: _write_bar beams nothing itself
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


def tidy_score(root, fill=None):
    """Repeats that change nothing go, so the renderer draws no extra time signatures, keys or clefs mid-score:
    a <time> / <key> / <clef> / <divisions> / <staves> equal to the one in force, and <attributes> left empty.
    Real changes stay. fill = {(part index, bar index)}: in those bars a voice that ends early while another voice
    of the bar is full gets rests to the end (never stretched); a voice longer than its bar is only reported.
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
            if fill and (pi, bi) in fill and longest == L:
                short = [v for v in voices if v.evs and v.evs[-1].end < L]
                done = False
                for vo in short:
                    plan = rest_plan(Fr(vo.evs[-1].end) / div, bar_quarters(tsig), tsig)
                    if plan is None or any((q * div).denominator != 1 for _, q, *_ in plan): continue
                    for t, q, *bar in plan: vo.evs.append(Ev(t * div, q * div, [_rest_el(vo, q, div, bool(bar))], 'rest'))
                    st['filled'] += 1; done = True
                if done: _write_bar(m, voices, other, longest, div, Fr(1))
    return st


def tidy_text(text, fill=None):
    """(MusicXML text, stats): tidy_score on a file's text; the very same text when there was nothing to tidy."""
    from .staffmove import _head
    root = ET.fromstring(text.encode('utf-8'))
    st = tidy_score(root, fill)
    if not any(v for k, v in st.items() if k != 'overfull'): return text, st
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', st
