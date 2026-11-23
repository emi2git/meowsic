"""Smooth rests + rhythm: the slider of the Simple piano menu (simplepiano.py), 0 (as is) to 100 (smoothest).

A score heard from a recording is full of near-misses: a note held 7/8 of a bar and the next one 1/8, a tiny rest
where the player let go early, a note tied to a 16th, a stray quintuplet. Smoothing writes what was meant; the higher
the level the bigger the rests that go and the coarser the grid:
  1. rests in a row become one; a note followed by a short rest during which no other note starts, in any voice or
     hand, simply lasts through it (15/16 + a 1/16 rest -> a whole note); when another note starts in the rest it
     stays. From level 60 up Ease rests (easerests.py) also takes short rests while the other hand plays (Light,
     then Strong at 75: over the bar line too), and from 90 up every rest shorter than half the bar (the left hand
     holds its notes instead of note-rest-note);
  2. (60 up) a short note tied over the bar line into the same pitch (an early onset) starts on the downbeat;
  3. tied notes of one pitch inside a bar become one note (written again in plain values);
  4. the onsets of each voice move to a simple grid when a simple rhythm is close: every boundary between two
     events may snap to the beat / eighth / 16th within a tolerance (growing with the level), and a small search (dynamic
     programming per voice and bar) picks the cheapest rhythm — cost = how far notes move + how odd the values are
     (double dots, ties, 16ths, values that are no written value) + weak onsets (+ syncopations). 7/8 + 1/8 -> 6/8 + 2/8;
  5. tuplets: a real triplet group (3:2, starting and ending on the eighth grid) is kept as it is; any other
     tuplet (5:4, a lone triplet note…) is written straight.
Notes are never dropped (only a rest, or a tied-on bit at the start of a bar, may shrink to nothing), pitches and
lyrics stay, every voice keeps its length so every bar stays full, ties are written again where a value is split.

The Simple piano menu (simplepiano.py) runs it with its slider, next to its other settings.
"""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from . import easerests as er
from .easerests import Ev, _beat, _head, _no_staccato, _put, _tie, _untie, _write_run, pieces

INF = float('inf')
PLAIN = {Fr(4), Fr(3), Fr(2), Fr(3, 2), Fr(1), Fr(1, 2)}   # values that read at a glance
FINE = {Fr(3, 4), Fr(1, 4)}                               # dotted eighth, 16th
WRITTEN = {v for v, _, _ in er.TYPES}


def params(level) -> dict:
    """What a slider level (0–100) does. grids: snap positions (quarters; 'beat' = the bar's beat); tol: the
    furthest a boundary moves; w: cost of moving it (per quarter); drop: the longest rest the grid may swallow;
    sync: cost of a syncopation; silent: the longest rest a note lasts through when nothing else starts in it;
    ease: Ease rests strength (None / light / strong / firm); antic: the longest tied-over-the-bar anticipation moved."""
    f = max(0, min(100, int(level))) / 100
    return dict(
        grids=('beat', Fr(1, 2), Fr(1, 4)),
        tol=Fr(1, 8) if f < .2 else Fr(1, 4) if f < .5 else Fr(1, 2) if f < .9 else Fr(1),
        w=6 - 5 * f,
        drop=Fr(1, 8) if f < .3 else Fr(1, 2) if f < .7 else Fr(1),
        sync=.8 * f,
        silent=Fr(1, 4) if f < .25 else Fr(1, 2) if f < .5 else Fr(1) if f < .75 else Fr(2),
        ease=None if f < .6 else 'light' if f < .75 else 'strong' if f < .9 else 'firm',
        antic=Fr(0) if f < .6 else Fr(1, 2) if f < .85 else Fr(1),
    )


# ---------- costs ----------

def value_cost(L: Fr) -> float:
    """How odd a length looks written out (greedy pieces, tied)."""
    if L <= 0: return INF
    ps = pieces(L)
    c = 0.0
    for v, _, _ in ps:
        c += 0 if v in PLAIN else 0.5 if v in FINE else 2.0 if v in WRITTEN else 3.0
    if ps and sum((v for v, _, _ in ps), Fr(0)) != L: c += 3.0   # not writable at all (e.g. 1/5)
    return c + 1.5 * (len(ps) - 1)


def onset_cost(pos: Fr, beat: Fr) -> float:
    if pos % beat == 0: return 0.0
    if pos % Fr(1, 2) == 0: return 0.4
    if pos % Fr(1, 4) == 0: return 1.0
    if pos % Fr(1, 6) == 0: return 1.0
    return 2.0


def _writable(L: Fr, div: Fr) -> bool:
    return L > 0 and (L * 8).denominator == 1 and (L * div).denominator == 1


# ---------- reading a measure ----------

def _pitches(ev):
    return tuple((n.findtext('pitch/step'), n.findtext('pitch/alter') or '0', n.findtext('pitch/octave')) for n in ev.notes)


def _ties(ev, kind):
    return any(t.get('type') == kind for n in ev.notes for t in n.findall('tie'))


def _runs(meas, div):
    """[run dict | other element]; run = consecutive <note>s of one voice, with its start (quarters into the bar).
    Grace notes travel with the next onset like harmonies do."""
    out, run, extra, t = [], None, [], Fr(0)
    for el in list(meas):
        if el.tag == 'note':
            if el.find('grace') is not None: extra.append(el); continue
            v = (el.findtext('voice') or '1', el.findtext('staff') or '1')
            if el.find('chord') is not None and run and run['evs']:
                run['evs'][-1].notes.append(el); continue
            if run is None or run['voice'] != v:
                if run: out.append(run)
                run = {'voice': v, 'evs': [], 'ok': True, 'start': t}
            if el.find('cue') is not None: run['ok'] = False
            d = Fr(int(float(el.findtext('duration') or 0))) / div
            ev = Ev([el], d, extra); extra = []
            ev.tup = el.find('time-modification') is not None
            run['evs'].append(ev)
            t += d
        else:
            if el.tag in ('backup', 'forward', 'attributes', 'barline'):
                if run: out.append(run); run = None
                out.extend(extra); extra = []
                out.append(el)
                d = Fr(int(float(el.findtext('duration') or 0))) / div
                if el.tag == 'backup': t -= d
                elif el.tag == 'forward': t += d
            else:
                extra.append(el)
    if run: out.append(run)
    out.extend(extra)
    return out


def _real_triplets(evs, start):
    """Indexes of events in real triplet groups: a stretch of 3:2 notes that starts and ends on the eighth grid
    with every onset on the triplet-16th grid. Other tuplet notes are 'odd' (written straight)."""
    keep, i, t = set(), 0, start
    pos = []
    for e in evs: pos.append(t); t += e.q
    while i < len(evs):
        if not evs[i].tup: i += 1; continue
        j = i
        ratio = lambda e: (e.notes[0].findtext('time-modification/actual-notes'), e.notes[0].findtext('time-modification/normal-notes'))
        while j < len(evs) and evs[j].tup and ratio(evs[j]) == ratio(evs[i]): j += 1
        seg = range(i, j)
        a, b = pos[i], pos[j - 1] + evs[j - 1].q
        ok = all(n.findtext('time-modification/actual-notes') == '3' and n.findtext('time-modification/normal-notes') == '2'
                 for k in seg for n in evs[k].notes)
        ok = ok and (a * 2).denominator == 1 and (b * 2).denominator == 1 and j - i >= 2 and all((pos[k] * 6).denominator == 1 for k in seg)
        if ok: keep.update(seg)
        i = j
    return keep


def _unpack(ev):
    """A tuplet note written straight: no time-modification, no tuplet bracket."""
    for n in ev.notes:
        for e in n.findall('time-modification'): n.remove(e)
        nt = n.find('notations')
        if nt is not None:
            for e in nt.findall('tuplet'): nt.remove(e)
            if not len(nt): n.remove(nt)


def _merge_ties(evs):
    """Tied notes of the same pitch(es) in a row → one event (nothing of its own on the second: no harmony, no lyric)."""
    out = []
    for ev in evs:
        p = out[-1] if out else None
        if (p is not None and not p.rest and not ev.rest and not p.tup and not ev.tup and _pitches(p) == _pitches(ev)
                and _ties(p, 'start') and _ties(ev, 'stop') and not ev.extra and not any(n.find('lyric') is not None for n in ev.notes)):
            had_start = _ties(ev, 'start')
            for n in p.notes:
                _untie(n, 'start')
                if had_start: _tie(n, 'start')
            p.q += ev.q; p.touched = True; p.merged = True
            continue
        out.append(ev)
    return out


# ---------- the search ----------

def _plan(evs, start, div, beat, m, keep, tie_in_first):
    """New boundaries for one run, or None (leave it). Units: single events, or a real triplet group (fixed)."""
    units, i = [], 0
    while i < len(evs):
        if i in keep:
            j = i
            while j in keep and j < len(evs): j += 1
            units.append((i, j, True)); i = j
        else:
            units.append((i, i + 1, False)); i += 1
    xs = [start]
    for a, b, _ in units: xs.append(xs[-1] + sum((evs[k].q for k in range(a, b)), Fr(0)))
    end = xs[-1]
    fixed = {0, len(units)}
    for k, (a, b, blk) in enumerate(units):
        if blk: fixed |= {k, k + 1}

    def cands(k):
        x = xs[k]
        if k in fixed: return [x]
        cs = {x}
        for g in m['grids']:
            g = beat if g == 'beat' else g
            for c in ((x // g) * g, -((-x) // g) * g):
                if abs(c - x) <= m['tol'] and start <= c <= end and (c * div).denominator == 1: cs.add(c)
        return sorted(cs)

    def ucost(k, a, b):
        ua, ub, blk = units[k]
        L = b - a
        if L < 0: return INF
        e = evs[ua]
        if blk: return onset_cost(a - 0, beat)
        if L == 0:
            dropable = e.rest or (k == 0 and tie_in_first)
            return 0.3 if dropable and e.q <= m['drop'] else INF
        changed = (a, b) != (xs[k], xs[k + 1]) or e.tup or getattr(e, 'touched', False)
        if changed and not _writable(L, div): return INF
        c = value_cost(L) + onset_cost(a, beat) * (0.5 if e.rest else 1)
        if not e.rest and m['sync'] and a % beat and (a // beat + 1) * beat < b: c += m['sync']
        return c

    # dynamic programming over the boundaries
    C = [cands(k) for k in range(len(xs))]
    best = [{C[0][0]: (0.0, None)}]
    for k in range(1, len(xs)):
        row = {}
        for c in C[k]:
            mv = m['w'] * float(abs(c - xs[k]))
            opt = min(((pc + ucost(k - 1, p, c) + mv, p) for p, (pc, _) in best[-1].items()), key=lambda z: z[0])
            if opt[0] < INF: row[c] = opt
        if not row: return None
        best.append(row)
    if end not in best[-1]: return None
    ys = [end]
    for k in range(len(xs) - 1, 0, -1): ys.append(best[k][ys[-1]][1])
    ys.reverse()
    return units, xs, ys


def _hold_through(evs, start, div, m, others):
    """A short rest after a note, with no other note starting in it (others: onsets of the other voices) -> the note."""
    out, t = [], start
    for ev in evs:
        p = out[-1] if out else None
        if ev.rest and p is not None and p.rest and not p.tup and not ev.tup and _writable(p.q + ev.q, div):
            p.q += ev.q; p.touched = True; p.extra_after = getattr(p, 'extra_after', []) + ev.extra
            t += ev.q
            continue
        if (ev.rest and p is not None and not p.rest and not p.tup and not ev.tup and ev.q <= m['silent']
                and not any(t <= o < t + ev.q for o in others) and _writable(p.q + ev.q, div)):
            p.q += ev.q; p.touched = True; p.extra_after = getattr(p, 'extra_after', []) + ev.extra
            for n in p.notes: _no_staccato(n)
            t += ev.q
            continue
        out.append(ev); t += ev.q
    return out


def _smooth_run(r, div, beat, m, prev_last, others=()):
    """Smooth one run in place (r['evs'] replaced). True when anything changed."""
    evs = r['evs']
    changed = False
    n0 = len(evs)
    evs = _hold_through(evs, r['start'], div, m, others)
    evs = _merge_ties(evs)
    changed |= len(evs) != n0
    keep = _real_triplets(evs, r['start'])
    tie_in = bool(evs) and not evs[0].rest and _ties(evs[0], 'stop') and prev_last is not None
    plan = _plan(evs, r['start'], div, beat, m, keep, tie_in)
    if plan is None:
        if not changed: return False
        r['evs'] = evs
        return True
    units, xs, ys = plan
    out, carry = [], []
    for k, (a, b, blk) in enumerate(units):
        if blk:
            for i in range(a, b):
                e = evs[i]; e.extra = carry + e.extra; carry = []; out.append(e)
            continue
        e = evs[a]
        L = ys[k + 1] - ys[k]
        if L == 0:  # a rest, or the tied-on bit at the start of the bar, goes
            carry += e.extra
            if not e.rest:  # only the tied-on bit opening the bar (tie_in): the note before ends at the bar line
                for n in prev_last: _untie(n, 'start')
            changed = True
            continue
        e.extra = carry + e.extra; carry = []
        if e.tup: _unpack(e); e.touched = True; e.tup = False; changed = True
        if L != e.q:
            if L > e.q and not e.rest:
                for n in e.notes: _no_staccato(n)
            e.q = L; e.touched = True; changed = True
        out.append(e)
    if carry: out[-1].extra_after = getattr(out[-1], 'extra_after', []) + carry
    r['evs'] = out
    return changed


def _attrs(meas, div, tsig):
    a = meas.find('attributes')
    if a is not None:
        if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
        tm = a.find('time')
        if tm is not None and (tm.findtext('beats') or '').isdecimal():
            tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
    return div, tsig


def _rebuild(meas, items, div, beat):
    """The measure again from its runs (changed runs written anew, the rest as they were)."""
    kids = []
    for r in items:
        if not isinstance(r, dict): kids.append(r); continue
        if r.get('changed'):
            pend = []
            for ev in r['evs']:
                ev.extra = pend + ev.extra; pend = getattr(ev, 'extra_after', [])
            kids.extend(_write_run(r, div, beat)); kids.extend(pend)
        else:
            kids.extend(x for e in r['evs'] for x in (*e.extra, *e.notes))
    for c in list(meas): meas.remove(c)
    for c in kids: meas.append(c)


def _anticipations(part, lim):
    """A short note tied over the bar line into the same pitch (an early onset, as a recording has it) starts on the
    downbeat instead: the note before lasts through it; its lyric and chord symbol move with it."""
    ms = part.findall('measure')
    div, tsig, info = Fr(1), (4, 4), []
    for meas in ms:
        div, tsig = _attrs(meas, div, tsig)
        info.append((div, _beat(tsig)))
    for k in range(len(ms) - 1):
        div, beat = info[k]
        items = _runs(ms[k], div)
        last = {}
        for r in items:
            if isinstance(r, dict): last[r['voice']] = r
        first = {}
        for r in _runs(ms[k + 1], info[k + 1][0]):
            if isinstance(r, dict) and r['voice'] not in first: first[r['voice']] = r
        changed = False
        for v, r in last.items():
            n = first.get(v)
            if not r['ok'] or len(r['evs']) < 2 or n is None or not n['ok'] or not n['evs'] or n['start'] != 0: continue
            e, p, f = r['evs'][-1], r['evs'][-2], n['evs'][0]
            if (e.rest or p.rest or f.rest or e.tup or p.tup or f.tup or e.q > lim or not _ties(e, 'start') or _ties(p, 'start')
                    or not _ties(f, 'stop') or _pitches(e) != _pitches(f) or not _writable(p.q + e.q, div)): continue
            for i, nn in enumerate(f.notes):
                _untie(nn, 'stop')
                if i < len(e.notes):
                    for ly in e.notes[i].findall('lyric'): _put(nn, ly)
            at = list(ms[k + 1]).index((f.extra or f.notes)[0])
            for x in reversed(e.extra): ms[k + 1].insert(at, x)
            for nn in p.notes: _no_staccato(nn)
            p.q += e.q; p.touched = True
            r['evs'].pop(); r['changed'] = True; changed = True
        if changed: _rebuild(ms[k], items, div, beat)


def smooth(text: str, level: int = 60):
    """(new MusicXML text, stats before, stats after). Level 0 gives the text back as it is."""
    before = stats(text)
    if int(level) <= 0: return text, before, before
    m = params(level)
    if m['ease'] == 'firm': text, _, _ = er.ease(text, firm=True)
    elif m['ease']: text, _, _ = er.ease(text, m['ease'])
    root = ET.fromstring(text.encode('utf-8'))
    if m['antic']:
        for part in root.findall('part'): _anticipations(part, m['antic'])
    heard = _onsets(root)  # measure index -> [(part, voice, onset)]
    for pi, part in enumerate(root.findall('part')):
        div, tsig = Fr(1), (4, 4)
        last = {}  # voice -> written notes ending the bar before
        for mi, meas in enumerate(part.findall('measure')):
            here = heard.get(mi, [])
            div, tsig = _attrs(meas, div, tsig)
            beat = _beat(tsig)
            items = _runs(meas, div)
            changed, new_last = False, {}
            for r in items:
                if not isinstance(r, dict): continue
                others = [o for p_, v_, o in here if (p_, v_) != (pi, r['voice'])]
                if r['ok'] and r['evs'] and _smooth_run(r, div, beat, m, last.get(r['voice']), others):
                    r['changed'] = True; changed = True
            if changed: _rebuild(meas, items, div, beat)
            for r in items:
                if isinstance(r, dict) and r['evs']:
                    e = r['evs'][-1]
                    new_last[r['voice']] = None if e.rest else getattr(e, 'last_notes', e.notes)
            last = new_last
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    return out, before, stats(out)


def _onsets(root):
    """{measure index: [(part index, voice, onset in quarters)]} of every note struck (not rests, not tied-on)."""
    out = {}
    for pi, part in enumerate(root.findall('part')):
        div = Fr(1)
        for mi, meas in enumerate(part.findall('measure')):
            d = meas.findtext('attributes/divisions')
            if d: div = Fr(int(float(d)))
            t, lst = Fr(0), out.setdefault(mi, [])
            for el in meas:
                if el.tag == 'note':
                    if el.find('grace') is not None or el.find('chord') is not None: continue
                    q = Fr(int(float(el.findtext('duration') or 0))) / div
                    if el.find('rest') is None and not any(x.get('type') == 'stop' for x in el.findall('tie')):
                        lst.append((pi, (el.findtext('voice') or '1', el.findtext('staff') or '1'), t))
                    t += q
                elif el.tag == 'backup': t -= Fr(int(float(el.findtext('duration') or 0))) / div
                elif el.tag == 'forward': t += Fr(int(float(el.findtext('duration') or 0))) / div
    return out


# ---------- counting (the job message, tests, the report) ----------

def stats(text: str) -> dict:
    """rests, notes (onsets), odd (written values that are no plain value: double dots, 32nds, non-3:2 tuplets,
    lengths no single value writes), tiny (shorter than a 16th), tied (tie starts), split (tied chains whose total
    is not one plain / dotted value — the 7/8 + 1/8 kind), tuplets (tuplet notes)."""
    root = ET.fromstring(text.encode('utf-8'))
    s = dict(rests=0, notes=0, odd=0, tiny=0, tied=0, split=0, tuplets=0)
    div = Fr(1)
    for part in root.findall('part'):
        chains = {}
        for meas in part.findall('measure'):
            d = meas.findtext('attributes/divisions')
            if d: div = Fr(int(float(d)))
            for n in meas.findall('note'):
                if n.find('chord') is not None or n.find('grace') is not None: continue
                q = Fr(int(float(n.findtext('duration') or 0))) / div
                tm = n.find('time-modification')
                if tm is not None: s['tuplets'] += 1
                if n.find('rest') is not None: s['rests'] += 1
                else: s['notes'] += 1
                if q < Fr(1, 4) and tm is None: s['tiny'] += 1
                odd = len(n.findall('dot')) > 1 or (tm is not None and (tm.findtext('actual-notes'), tm.findtext('normal-notes')) != ('3', '2'))
                odd = odd or (tm is None and q not in (PLAIN | FINE))
                s['odd'] += odd
                k = (n.findtext('staff') or '1', n.findtext('voice') or '1')
                ty = {t.get('type') for t in n.findall('tie')}
                if 'start' in ty: s['tied'] += 1
                if n.find('rest') is None:
                    if 'stop' in ty and k in chains: chains[k] += q
                    else: chains[k] = q
                    if 'start' not in ty:
                        tot = chains.pop(k)
                        if 'stop' in ty and tot not in PLAIN | {Fr(6), Fr(8)}: s['split'] += 1
    return s
