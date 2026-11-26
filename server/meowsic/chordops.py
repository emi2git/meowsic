"""Chord symbols in Edit notes (web/js/views/editnotes.js): write / change / take away a chord name, and "Realize to
left hand" — the left hand written from the chord names. staffmove.edit_ex hands these ops over (one undo step each).

  {op:'chord', bar, on, text, part?} the chord name at that beat of the bar (above the top staff): text '' takes it
                                      away; a name not in the chord grammar (chordname.parse, omr.py's) is refused.
                                      It goes into the part that already holds chord names, else the top part (a
                                      voice / violin + piano score: above the melody, not the piano); `part` (1-based
                                      number or part id) picks one
  {op:'movechords', from, to}         every chord name of part `from` moved to part `to` (1-based numbers or ids) at
                                      the same bar and beat; one already there at that beat is replaced. The repair
                                      for chords written into the wrong part
  {op:'realize', start, end, pattern} the lowest staff over the window (rangeops: [bar, on] … [bar, on]; none: the
                                      whole score) written again from the chord names in force there — pattern
                                      'block' (the chord held), 'root5' (root, fifth on every other beat) or 'broken'
                                      (root–fifth–tenth–fifth in eighths). Each chord lasts to the next one; N.C. and
                                      time before the first chord rest. A one-staff score gets a bass staff first.
"""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

from . import chordname

OPS = ('chord', 'realize', 'movechords')
PATTERNS = ('block', 'root5', 'broken')


def _pick_part(root, which):
    """A part by 1-based number or by id."""
    parts = root.findall('part')
    if isinstance(which, str) and not which.strip().isdigit():
        hit = [p for p in parts if p.get('id') == which]
        if not hit: raise HTTPException(400, f'No part {which} in this score')
        return hit[0]
    try: k = int(which)
    except (TypeError, ValueError): raise HTTPException(400, 'part: a part number (1 = the top part) or a part id')
    if not 1 <= k <= len(parts): raise HTTPException(400, f'No part {k} in this score')
    return parts[k - 1]


def chord_part(root, which=None):
    """The part chord names go in: `which` when given, else the first part that has any <harmony>, else the top
    part (part 1)."""
    if which not in (None, ''): return _pick_part(root, which)
    parts = root.findall('part')
    return next((p for p in parts if p.find('measure/harmony') is not None), parts[0] if parts else None)


def move_chords(src, dst, info):
    """Every <harmony> of part src moved into part dst at the same bar and time (its <offset> folded in); one in
    dst at that time is replaced. -> number moved."""
    from .rangeops import geometry
    from .staffmove import _read_bar, _write_bar
    from .easerests import _beat
    if src is dst: raise HTTPException(400, 'from and to are the same part')
    gs, gd = geometry(src), geometry(dst)
    staffed = any(n.find('staff') is not None for n in dst.iter('note'))
    moved = replaced = 0
    for bi, a in enumerate(gs):
        sv, so, sl = _read_bar(a.m, a.div)
        hs = [o for o in so if o[2].tag == 'harmony']
        if not hs: continue
        if bi >= len(gd): raise HTTPException(400, f'Part {dst.get("id")} has no bar {bi + 1}')
        b = gd[bi]
        dv, do, dl = _read_bar(b.m, b.div)
        for o in hs:
            h = o[2]
            off = h.find('offset')
            q = (Fr(o[0]) + (Fr(int(float(off.text or 0))) if off is not None else 0)) / a.div
            t = q * b.div
            if t.denominator != 1 or not 0 <= q < b.L:
                raise HTTPException(400, f'Bar {bi + 1}: that chord time is not in part {dst.get("id")}')
            if off is not None: h.remove(off)
            for st in h.findall('staff'): h.remove(st)
            if staffed: ET.SubElement(h, 'staff').text = '1'
            old = [x for x in do if x[2].tag == 'harmony' and x[0] == t]
            replaced += len(old)
            do = [x for x in do if x not in old] + [(t, -1, h)]
            so = [x for x in so if x is not o]
            moved += 1
        _write_bar(a.m, sv, so, max(sl, a.L * a.div), a.div, _beat(a.tsig))
        _write_bar(b.m, dv, do, max(dl, b.L * b.div), b.div, _beat(b.tsig))
    if not moved: raise HTTPException(400, f'Part {src.get("id")} has no chord names to move')
    info['moved'], info['replaced'] = moved, replaced
    return moved


def _set_chord(root, part, bi, on, text, info):
    from .rangeops import geometry
    from .staffmove import _read_bar, _write_bar
    from .easerests import _beat
    bars = geometry(part)
    if not 0 <= bi < len(bars): raise HTTPException(400, f'No bar {bi + 1} in this score')
    g = bars[bi]
    t = on * g.div
    if t.denominator != 1 or not 0 <= on < g.L: raise HTTPException(400, 'That beat is not in the bar')
    name = None
    if (text or '').strip():
        name = chordname.parse(text)
        if not name: raise HTTPException(400, f'“{text.strip()}” is not a chord name (like C, Am7, F/A, Bb7sus4, N.C.)')
    voices, other, longest = _read_bar(g.m, g.div)
    old = [o for o in other if o[2].tag == 'harmony' and o[0] == t]
    staff = None
    if old:
        st = old[0][2].find('staff')
        staff = st.text if st is not None else None
    elif any(n.find('staff') is not None for n in g.m.iter('note')): staff = '1'
    other = [o for o in other if o not in old]
    if name: other.append((t, -1, chordname.harmony(name, staff)))
    elif not old: raise HTTPException(400, 'No chord name there to take away')
    L = max(longest, g.L * g.div)
    _write_bar(g.m, voices, other, L, g.div, _beat(g.tsig))
    info['chord'] = name or ''
    return name


def chords_in(part):
    """[(time from the start in quarters, chord name)] of the part, in order."""
    from .rangeops import geometry
    from .staffmove import _read_bar
    out = []
    for g in geometry(part):
        for t, _, e in _read_bar(g.m, g.div)[1]:
            if e.tag != 'harmony': continue
            off = Fr(int(float(e.findtext('offset') or 0)))
            out.append((g.start + (Fr(t) + off) / g.div, chordname.name_of(e)))
    return sorted(out, key=lambda x: x[0])


def _note_xml(midi, flats):
    from .staffmove import FLAT_ALT, FLATS, SHARP_ALT, SHARPS
    pc, octave = midi % 12, midi // 12 - 1
    step, alt = (FLATS[pc], FLAT_ALT[pc]) if flats else (SHARPS[pc], SHARP_ALT[pc])
    return (f'<note><pitch><step>{step}</step>' + (f'<alter>{alt}</alter>' if alt else '') + f'<octave>{octave}</octave></pitch>'
            '<duration>0</duration><voice>1</voice><type>quarter</type></note>')


def _chord_xml(midis, flats):
    out = []
    for k, m in enumerate(sorted(midis)):
        x = _note_xml(m, flats)
        out.append(x.replace('<note>', '<note><chord/>') if k else x)
    return out


def voicing(name):
    """(bass, up to three chord tones close above it) as MIDI notes for a left hand: the root (or the slash bass)
    between F2 and E3."""
    t = chordname.tones(name)
    if t is None: return None
    root, iv, bass = t
    low = 41 + ((bass - 41) % 12)  # F2 … E3
    r = 41 + ((root - 41) % 12)
    pcs = [i % 12 for i in iv if i % 12 and i % 12 != (bass - root) % 12] + ([0] if bass != root else [])  # the bass not twice
    order = sorted(pcs, key=lambda i: {3: 0, 4: 0, 10: 1, 11: 1, 9: 1, 6: 2, 7: 2, 8: 2}.get(i, 3))[:3]
    up = sorted({(r + i) if (r + i) > low else (r + i + 12) for i in order})
    return low, up


def _pattern(name, a, b, beat, pattern, flats):
    """[(on, dur, [note xml])] for chord `name` over [a, b) (quarters from the window start)."""
    v = voicing(name)
    if v is None: return []
    low, up = v
    if pattern == 'block':
        return [(a, b - a, _chord_xml([low] + up, flats))]
    fifth = next((x for x in up if (x - low) % 12 in (6, 7, 8)), low + 7)
    third = next((x for x in up if (x - low) % 12 in (3, 4, 2, 5)), up[0] if up else low + 12)
    seq, step = ([low, fifth], beat) if pattern == 'root5' else ([low, fifth, third + 12 if third + 12 - low <= 24 else third, fifth], Fr(1, 2))
    out, t, k = [], a, 0
    while t < b:
        d = min(step, b - t)
        out.append((t, d, _chord_xml([seq[k % len(seq)]], flats))); t += d; k += 1
    return out


def realize(root, part, start, end, pattern, info):
    from .barops import add_staff, staves as n_staves
    from .rangeops import geometry, overwrite, pos
    from .easerests import _beat
    from .noteset import _fifths
    if pattern not in PATTERNS: raise HTTPException(400, 'pattern: block, root5 or broken')
    if n_staves(part) == 1:
        add_staff(part, 2, 'bass', [])
        info.setdefault('said', []).append('A left-hand staff was added for it')
    bars = geometry(part)
    A = pos(bars, start) if start is not None else Fr(0)
    B = pos(bars, end) if end is not None else bars[-1].end
    if B <= A: raise HTTPException(400, 'Pick the bars to realize')
    cs = chords_in(part) or chords_in(chord_part(root))  # a voice + piano score: the names sit on the melody
    if not any(A - 1e-9 <= t < B for t, _ in cs) and not any(t < A for t, _ in cs): raise HTTPException(400, 'No chord names there to realize')
    lh = n_staves(part)
    fifths = _fifths(part)
    evs = []
    # the chord in force at A, then each change; every stretch cut at the bar lines (the beat is the bar's)
    spans = []
    cur = next((n for t, n in reversed(cs) if t <= A), None)
    t0 = A
    for t, n in [(t, n) for t, n in cs if A < t < B] + [(B, None)]:
        if cur and t > t0: spans.append((t0, t, cur))
        cur, t0 = n, t
    for a, b, name in spans:
        for k, g in enumerate(bars):
            lo, hi = max(a, g.start), min(b, g.end)
            if hi <= lo: continue
            bt = _beat(g.tsig)
            flats = fifths.get(k, 0) < 0 or (fifths.get(k, 0) == 0 and 'b' in name[1:2])
            for on, d, xs in _pattern(name, lo - A, hi - A, bt, pattern, flats):
                evs.append({'on': str(on), 'dur': str(d), 'notes': xs, 'graces': []})
    clip = {'len': str(B - A), 'staves': 1, 'voices': [{'staff': 0, 'voice': 0, 'evs': evs}], 'harmony': []}
    # chord names stay: overwrite only takes those of the staves it writes, and they are on the top staff
    keep = [(h, h.find('staff')) for h in part.iter('harmony')]
    for h, st in keep:
        if st is not None and st.text == str(lh): st.text = '1'
    info['realized'] = len(spans)
    return overwrite(root, part, A, B, {0: lh}, clip, info)


def chord_op(text, op, info=None):
    from .barnorm import normalize_bar, tidy_score
    from .rangeops import q_of, tidy_accidentals
    from .staffmove import _head, _slur_mark, _tie_count, edit_part, fix_slurs, fix_ties, ties_gone
    info = {} if info is None else info
    kind = op.get('op')
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    ties_before = _tie_count(part)
    touched, tidy = [], set()
    if kind == 'movechords':
        move_chords(_pick_part(root, op.get('from')), _pick_part(root, op.get('to')), info)
        snap = None
    elif kind == 'chord':
        try: bi = int(op.get('bar'))
        except (TypeError, ValueError): raise HTTPException(400, 'bar: a bar number')
        _set_chord(root, chord_part(root, op.get('part')), bi, q_of(op.get('on') or 0), op.get('text'), info)
        snap = None
    else:
        touched, tidy, _ = realize(root, part, op.get('start'), op.get('end'), op.get('pattern') or 'block', info)
        snap = info.pop('snap', None)
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
    if snap is not None: fix_slurs(part, snap)
    dropped = fix_ties(part)
    if tidy: tidy_accidentals(part, {b for b, _, _ in tidy})
    gone = ties_gone(ties_before, part, dropped)
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    return out, sorted({ref[id(e)] for e in touched if id(e) in ref}), gone
