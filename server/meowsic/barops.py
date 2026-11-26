"""Bar and staff tools of Edit notes (the "Bar ▾" menu, web/js/views/editnotes.js): ops that edit_ex in
staffmove.py hands over here, so they get undo / redo, the preview, Save and the Activities row like any note edit.

Bars are 0-based (as notes() gives them); staves are 1-based (1 = the top staff of the edited part).
  {op:'clearbar', bar, staff}        that staff of that bar becomes one whole-bar rest (its notes, and lyrics on
                                     them, go; chord names stay, on a staff that still has a note at their time)
  {op:'addhand',  bar, staff}        a staff the bar has no voice on gets a whole-bar rest, so notes can be added
  {op:'insbar',   bar, after?}       an empty bar (whole rests on every staff of every part) before / after it
  {op:'delbar',   bar}               the bar goes from every part; what it set up (key, time, clef, tempo, the page
                                     layout) carries on into the next bar; a tie into it goes (counted)
  {op:'addstaff', at, clef}          a new staff at position `at` (1 = on top … staves+1 = at the bottom) with whole
                                     rests in every bar; clef 'treble' | 'bass'. A one-staff score becomes a grand
                                     staff; a piano score gets a third staff (a voice line on top for lyrics)
  {op:'delstaff', staff}             that staff and its notes go (the part keeps one staff at least)
Later bars renumber; the "bars to check" list follows its bars. Ties and slurs stay where their notes stay
(fix_ties / fix_slurs, as every edit). Returns (text, refs of the new rests, ties dropped).
"""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException

from .easerests import _beat, _put

OPS = ('clearbar', 'addhand', 'insbar', 'delbar', 'addstaff', 'delstaff')
ATTR_ORDER = ['footnote', 'level', 'divisions', 'key', 'time', 'staves', 'part-symbol', 'instruments', 'clef', 'staff-details',
              'transpose', 'for-part', 'directive', 'measure-style']
CLEFS = {'treble': ('G', '2'), 'bass': ('F', '4')}


def _int(x, what):
    try: return int(x)
    except (TypeError, ValueError): raise HTTPException(400, f'{what}: a number')


def staves(part):
    for a in part.iter('attributes'):
        s = (a.findtext('staves') or '').strip()
        if s.isdigit(): return int(s)
    return 1


def _states(part):
    """[(measure, divisions, (beats, beat-type))] in force at each bar."""
    out, div, tsig = [], Fr(1), (4, 4)
    for m in part.findall('measure'):
        for a in m.findall('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            tm = a.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        out.append((m, div, tsig))
    return out


def _bar_len(longest, div, tsig):
    return longest or Fr(4 * tsig[0], tsig[1]) * div


def _rest_voice(num, staff, L, div, tsig):
    from .staffmove import Voice, _rests
    vo = Voice(str(num), str(staff))
    vo.first, vo.touched = 10 ** 9, True
    vo.evs = _rests(Fr(0), L, div, _beat(tsig), L, vo.num, vo.staff)
    return vo


def _free_voice(part, staff, used=()):
    """A voice number for a new voice on that staff: MuseScore's 1–4 / 5–8 … when free in the part."""
    have = {(n.findtext('voice') or '1').strip() for n in part.iter('note')} | set(used)
    v = 4 * (int(staff) - 1) + 1
    while str(v) in have: v += 1
    return str(v)


def _staff_voice(part, staff):
    """The voice number most used on that staff (new rests join it), else a free one."""
    cnt = {}
    for n in part.iter('note'):
        if (n.findtext('staff') or '1').strip() == str(staff): v = (n.findtext('voice') or '1').strip(); cnt[v] = cnt.get(v, 0) + 1
    return max(cnt, key=cnt.get) if cnt else _free_voice(part, staff)


def _sort_voices(voices):
    voices.sort(key=lambda v: (int(v.staff), v.first))


def _starts(voices):
    """{staff: {onsets of notes}} in the bar (divisions)."""
    out = {}
    for v in voices:
        for e in v.evs:
            if e.kind == 'notes' and e.dur > 0: out.setdefault(v.staff, set()).add(e.on)
    return out


def _rehome_harmony(other, gone_staff, voices, nstaves):
    """Chord names on a staff that lost its notes: onto a staff with a note starting at their time."""
    st = _starts(voices)
    for t, _, e in other:
        if e.tag != 'harmony': continue
        s = (e.findtext('staff') or '1').strip()
        if s != gone_staff: continue
        to = next((k for k in sorted(st, key=int) if k != gone_staff and t in st[k]), None)
        if to is None: continue
        el = e.find('staff')
        if el is None: el = ET.SubElement(e, 'staff')
        el.text = to


def _mark_rests(voices, out):
    for v in voices:
        if v.touched: out.extend(n for e in v.evs if e.kind == 'rest' for n in e.notes)


# ---------- the ops ----------

def clear_bar(part, bi, staff, out):
    from .staffmove import _read_bar, _write_bar
    m, div, tsig = _states(part)[bi]
    voices, other, longest = _read_bar(m, div)
    L = _bar_len(longest, div, tsig)
    s = str(staff)
    mine = [v for v in voices if v.staff == s]
    if not mine: raise HTTPException(400, f'Bar {bi + 1} has nothing on that staff')
    keep = [v for v in voices if v.staff != s]
    vo = _rest_voice(min(mine, key=lambda v: (len(v.num), v.num)).num, s, L, div, tsig)
    vo.first = min(v.first for v in mine)
    voices = keep + [vo]
    _sort_voices(voices)
    _rehome_harmony(other, s, voices, staves(part))
    _write_bar(m, voices, other, L, div, _beat(tsig))
    _mark_rests(voices, out)


def fill_bar(part, bi, staff, out):
    from .staffmove import _read_bar, _write_bar
    if not 1 <= staff <= staves(part): raise HTTPException(400, 'This score has no such staff — add a staff first')
    m, div, tsig = _states(part)[bi]
    voices, other, longest = _read_bar(m, div)
    if any(v.staff == str(staff) for v in voices):
        out.extend(n for v in voices if v.staff == str(staff) for e in v.evs for n in e.notes)
        return
    L = _bar_len(longest, div, tsig)
    voices.append(_rest_voice(_staff_voice(part, staff), staff, L, div, tsig))
    _sort_voices(voices)
    _write_bar(m, voices, other, L, div, _beat(tsig))
    _mark_rests(voices, out)


def insert_bar(root, bi, after, out_part, out):
    """An empty bar at index bi (+1 after) in every part."""
    from .staffmove import _read_bar, _write_bar
    idx = bi + (1 if after else 0)
    for part in root.findall('part'):
        st = _states(part)
        ms = [x[0] for x in st]
        if not ms: continue
        k = min(idx, len(ms))
        # in force where the new bar goes: what the bar before it leaves (bar 1: what bar 1 sets up)
        _, div, tsig = st[max(0, k - 1)] if k else st[0]
        L = Fr(4 * tsig[0], tsig[1]) * div
        new = ET.Element('measure', number='0')
        n = staves(part)
        voices = [_rest_voice(_staff_voice(part, s) if n > 1 else _staff_voice(part, 1), s, L, div, tsig) for s in range(1, n + 1)]
        if n == 1:  # a one-staff part: no <staff> on its notes
            for v in voices:
                for e in v.evs:
                    for x in e.notes:
                        for y in x.findall('staff'): x.remove(y)
        _write_bar(new, voices, [], L, div, _beat(tsig))
        kids = list(part)
        if k < len(ms): part.insert(kids.index(ms[k]), new)
        else: part.insert(kids.index(ms[-1]) + 1, new)
        if k == 0:  # before the first bar: the set-up (divisions, key, time, clefs, page layout) moves into the new one
            first = ms[0]
            lead = []
            for e in first:
                if e.tag in ('note', 'backup', 'forward'): break
                if e.tag in ('print', 'attributes'): lead.append(e)
            for e in reversed(lead):
                first.remove(e); new.insert(0, e)
        if part is out_part: _mark_rests(voices, out)


def _first_attributes(m):
    """The bar's <attributes> before its first note (made when it has none)."""
    for i, e in enumerate(list(m)):
        if e.tag == 'attributes': return e
        if e.tag in ('note', 'backup', 'forward', 'direction', 'harmony'):
            a = ET.Element('attributes'); m.insert(i, a); return a
    a = ET.SubElement(m, 'attributes')
    return a


def _attr_put(a, el):
    k = ATTR_ORDER.index(el.tag) if el.tag in ATTR_ORDER else len(ATTR_ORDER)
    for i, c in enumerate(list(a)):
        if c.tag in ATTR_ORDER and ATTR_ORDER.index(c.tag) > k: a.insert(i, el); return
    a.append(el)


def _is_tempo(d):
    return d.tag == 'direction' and (d.find('sound[@tempo]') is not None or d.find('direction-type/metronome') is not None)


def delete_bar(root, bi):
    for part in root.findall('part'):
        ms = part.findall('measure')
        if bi >= len(ms): continue
        if len(ms) == 1: raise HTTPException(400, 'A score keeps one bar at least')
        m = ms[bi]
        nxt = ms[bi + 1] if bi + 1 < len(ms) else None
        if nxt is not None:
            carry = {}
            for a in m.findall('attributes'):
                for c in a: carry[(c.tag, c.get('number') or '')] = c
            if carry:
                na = _first_attributes(nxt)
                have = {(c.tag, c.get('number') or '') for c in na}
                for key, c in carry.items():
                    if key not in have: _attr_put(na, copy.deepcopy(c))
            pr = m.find('print')
            if pr is not None and nxt.find('print') is None: nxt.insert(0, copy.deepcopy(pr))
            if not any(_is_tempo(d) for d in nxt.findall('direction')):
                kids = list(nxt)
                at = next((i for i, e in enumerate(kids) if e.tag in ('note', 'backup', 'forward')), len(kids))
                for d in reversed([d for d in m.findall('direction') if _is_tempo(d)]): nxt.insert(at, copy.deepcopy(d))
        else:  # the last bar: its closing bar line goes to the bar before
            prev = ms[bi - 1]
            bl = [b for b in m.findall('barline') if (b.get('location') or 'right') == 'right']
            if bl and not any((b.get('location') or 'right') == 'right' for b in prev.findall('barline')): prev.append(copy.deepcopy(bl[0]))
        part.remove(m)


def _musescore_voices(part):
    """Do the voices follow MuseScore's habit (staff 1: voices 1–4, staff 2: 5–8 …)? Then they move with their staff."""
    for e in part.iter():
        if e.tag in ('note', 'forward') and e.find('voice') is not None:
            v, st = int((e.findtext('voice') or '1').strip() or 1), int((e.findtext('staff') or '1').strip() or 1)
            if not 4 * (st - 1) < v <= 4 * st: return False
    return True


def _remap_staff(part, fn):
    """Every staff number in the part through fn (old -> new); voices numbered per staff (MuseScore) move with it."""
    shift = _musescore_voices(part)
    for e in part.iter():
        if shift and e.tag in ('note', 'forward') and e.find('voice') is not None:
            st = int((e.findtext('staff') or '1').strip() or 1)
            e.find('voice').text = str(int(e.findtext('voice').strip() or 1) + 4 * (fn(st) - st))
        if e.tag in ('note', 'forward', 'direction', 'harmony', 'figured-bass'):
            s = e.find('staff')
            if s is None:
                # a note with no <staff> is on staff 1: say so; a chord name stays with those notes
                if e.tag == 'note': s = _put(e, ET.Element('staff'))
                elif e.tag == 'harmony' and fn(1) != 1: s = ET.SubElement(e, 'staff')
                else: continue
                s.text = '1'
            old = int((s.text or '1').strip() or 1)
            s.text = str(fn(old))
        elif e.tag in ('clef', 'staff-details', 'transpose', 'measure-style', 'staff-layout') and (e.get('number') or e.tag == 'clef'):
            e.set('number', str(fn(int(e.get('number') or 1))))


def add_staff(part, at, clef, out):
    from .staffmove import _read_bar, _write_bar
    n = staves(part)
    if not 1 <= at <= n + 1: raise HTTPException(400, f'at: 1 to {n + 1}')
    if clef not in CLEFS: raise HTTPException(400, "clef: 'treble' or 'bass'")
    _remap_staff(part, lambda s: s if s < at else s + 1)
    attrs = list(part.iter('attributes'))
    for a in attrs:
        s = a.find('staves')
        if s is not None: s.text = str(n + 1)
    st = _states(part)
    first = _first_attributes(st[0][0])
    if first.find('staves') is None: _attr_put(first, ET.Element('staves')); first.find('staves').text = str(n + 1)
    c = ET.Element('clef', number=str(at))
    ET.SubElement(c, 'sign').text, ET.SubElement(c, 'line').text = CLEFS[clef]
    _attr_put(first, c)
    clefs = sorted(first.findall('clef'), key=lambda x: int(x.get('number') or 1))
    for x in clefs: first.remove(x)
    for x in clefs: _attr_put(first, x)
    v = _free_voice(part, at)
    for m, div, tsig in st:
        voices, other, longest = _read_bar(m, div)
        L = _bar_len(longest, div, tsig)
        voices.append(_rest_voice(v, at, L, div, tsig))
        _sort_voices(voices)
        _write_bar(m, voices, other, L, div, _beat(tsig))
        _mark_rests(voices, out)


def del_staff(part, staff):
    from .staffmove import _read_bar, _write_bar
    n = staves(part)
    if n < 2: raise HTTPException(400, 'A score keeps one staff at least')
    if not 1 <= staff <= n: raise HTTPException(400, f'staff: 1 to {n}')
    s = str(staff)
    for m, div, tsig in _states(part):
        voices, other, longest = _read_bar(m, div)
        L = _bar_len(longest, div, tsig)
        keep = [v for v in voices if v.staff != s]
        _rehome_harmony(other, s, keep, n)
        other = [o for o in other if not (o[2].tag == 'direction' and (o[2].findtext('staff') or '').strip() == s and not _is_tempo(o[2]))]
        _write_bar(m, keep, other, L, div, _beat(tsig))
    for a in part.iter('attributes'):
        for c in [c for c in a if c.tag in ('clef', 'staff-details', 'transpose', 'measure-style') and (c.get('number') or '1') == s]: a.remove(c)
    _remap_staff(part, lambda x: x if x < staff else max(1, x - 1))
    for a in part.iter('attributes'):
        st = a.find('staves')
        if st is not None:
            if n - 1 > 1: st.text = str(n - 1)
            else: a.remove(st)
    if n - 1 == 1:  # one staff again: no numbers needed
        for e in part.iter():
            if e.tag in ('clef', 'staff-details', 'transpose', 'measure-style') and 'number' in e.attrib: del e.attrib['number']
    for pr in part.iter('print'):
        for sl in [x for x in pr.findall('staff-layout') if (x.get('number') or '1') == s]: pr.remove(sl)


def _renumber(root):
    for part in root.findall('part'):
        ms = part.findall('measure')
        k = 0 if ms and ms[0].get('implicit') == 'yes' and ms[0].get('number') == '0' else 1
        for m in ms:
            m.set('number', str(k)); k += 1


def _check_field(root, old_nums):
    """The bars still to check follow their bars (a deleted bar is no longer to check)."""
    for f in root.iter('miscellaneous-field'):
        if f.get('name') != 'meowsic-check-bars': continue
        f.text = ' '.join(str(x) for x in sorted({old_nums[b] for b in (f.text or '').split() if b in old_nums}, key=int))


def bar_op(text, op):
    from .staffmove import _has_tie, _head, _read_bar, _slur_mark, _tie_count, _timeline, edit_part, fix_slurs, fix_ties, ties_gone
    from .barnorm import tidy_score
    kind = op.get('op')
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    ms = part.findall('measure')
    bi = None
    if kind in ('clearbar', 'addhand', 'insbar', 'delbar'):
        bi = _int(op.get('bar'), 'bar')
        if not 0 <= bi < len(ms): raise HTTPException(400, f'No bar {bi + 1} in this score')
    parts = root.findall('part')
    gone_ids = {id(n) for n in ms[bi].iter('note')} if kind == 'delbar' else set()
    ties_before = sum(1 for x in _timeline(part) if id(x[0]) not in gone_ids and _has_tie(x[0], 'start'))
    snaps = [(p, _slur_mark(p)) for p in parts]
    if kind == 'delbar':  # slur ends in the deleted bar: put on the notes where it was
        off, t0, t1 = Fr(0), None, None
        for k, (m, div, tsig) in enumerate(_states(part)):
            longest = _read_bar(m, div)[2] / div
            if k == bi: t0, t1 = off, off + longest
            off += longest
        for p, snap in snaps:
            for key, (ty, st, t, el) in list(snap.items()):
                if t0 is None: break
                snap[key] = (ty, st, t0 if t0 <= t < t1 else t - (t1 - t0) if t >= t1 else t, el)
    old = {id(m): m.get('number') for m in ms}
    out = []
    fill = set()
    if kind == 'clearbar': clear_bar(part, bi, _int(op.get('staff'), 'staff'), out); fill.add((pk, bi))
    elif kind == 'addhand': fill_bar(part, bi, _int(op.get('staff'), 'staff'), out); fill.add((pk, bi))
    elif kind == 'insbar': insert_bar(root, bi, bool(op.get('after')), part, out)
    elif kind == 'delbar': delete_bar(root, bi)
    elif kind == 'addstaff': add_staff(part, _int(op.get('at', staves(part) + 1), 'at'), str(op.get('clef') or 'bass'), out)
    elif kind == 'delstaff': del_staff(part, _int(op.get('staff'), 'staff'))
    else: raise HTTPException(400, f'Unknown edit: {kind}')
    if kind in ('insbar', 'delbar'):
        _renumber(root)
        _check_field(root, {old[id(m)]: m.get('number') for m in part.findall('measure') if id(m) in old and old[id(m)]})
    tidy_score(root, fill)
    for p, snap in snaps: fix_slurs(p, snap)
    for p in parts:
        if p is not part: fix_ties(p)
    gone = ties_gone(ties_before, part, fix_ties(part))
    ET.indent(root, space='  ')
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', sorted({ref[id(e)] for e in out if id(e) in ref}), gone
