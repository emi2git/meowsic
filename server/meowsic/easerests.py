"""Ease rests: the rest-merging step of Smooth… (smoothrhythm.py, which has the API and the panel).

A score transcribed from audio is full of short rests: every note the player let go of a little early. Easing:
  1. rests in a row (same voice) become one rest;
  2. a short rest right after a note is merged into it (the note gets longer, tied over when its new length is not
     one written value); Strong also fills a short rest at the start of a bar by tying the note before over the bar line;
  3. what is left is written in plain values (a rest that cannot be one value is split).
Light: rests up to an eighth note go; Strong: up to a quarter note (in the bar's beat unit for 6/8 etc. too).
Every voice keeps its length, so every bar stays full (= its time signature; see ~/git/scripts/omr-fix-bars.py).
Voices with tuplets or grace notes in the way are left alone; beams of a changed voice are drawn again per beat;
a lengthened note loses its staccato (it was only short because of the recording).

"""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

LIMIT = {'light': Fr(1, 2), 'strong': Fr(1)}  # quarters: the longest rest that goes
TYPES = [(Fr(4), 'whole', 0), (Fr(3), 'half', 1), (Fr(2), 'half', 0), (Fr(3, 2), 'quarter', 1), (Fr(1), 'quarter', 0),
         (Fr(3, 4), 'eighth', 1), (Fr(1, 2), 'eighth', 0), (Fr(3, 8), '16th', 1), (Fr(1, 4), '16th', 0),
         (Fr(3, 16), '32nd', 1), (Fr(1, 8), '32nd', 0), (Fr(1, 16), '64th', 0)]
BEAMS = {'eighth': 1, '16th': 2, '32nd': 3, '64th': 4}
# MusicXML <note> child order (what we add has to go in the right place)
ORDER = ['grace', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'voice', 'type', 'dot', 'accidental',
         'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam', 'notations', 'lyric', 'play', 'listen']


def _head(text):
    i = text.find('<score-partwise')
    return text[:i] if i > 0 else '<?xml version="1.0" encoding="UTF-8"?>\n'


def count_rests(root):
    return sum(1 for n in root.iter('note') if n.find('rest') is not None)


def _put(note, el):
    """Insert el into note at its schema place."""
    k = ORDER.index(el.tag) if el.tag in ORDER else len(ORDER)
    for i, c in enumerate(list(note)):
        if c.tag in ORDER and ORDER.index(c.tag) > k:
            note.insert(i, el)
            return el
    note.append(el)
    return el


def fits(q: Fr, div: Fr) -> bool:
    """Can q quarters be written in whole divisions, as plain values?"""
    return all((v * div).denominator == 1 for v, _, _ in pieces(q))


def pieces(q: Fr):
    """A length in quarters as written values, longest first (greedy)."""
    out = []
    while q > 0:
        for v, t, dots in TYPES:
            if v <= q:
                out.append((v, t, dots)); q -= v; break
        else:
            out.append((q, '64th', 0)); q = Fr(0)
    return out


def _set_len(note, v, t, dots, div):
    note.find('duration').text = str(int(v * div))
    ty = note.find('type')
    if ty is None: ty = _put(note, ET.Element('type'))
    ty.text = t
    for d in note.findall('dot'): note.remove(d)
    for _ in range(dots): _put(note, ET.Element('dot'))
    r = note.find('rest')
    if r is not None and 'measure' in r.attrib: del r.attrib['measure']


def _tie(note, kind):
    """Add a tie start / stop (and its <tied>) unless it is there."""
    if any(t.get('type') == kind for t in note.findall('tie')): return
    t = ET.Element('tie', type=kind)
    ties = note.findall('tie')
    if ties: note.insert(list(note).index(ties[-1]) + 1, t)
    else: _put(note, t)
    nt = note.find('notations')
    if nt is None: nt = _put(note, ET.Element('notations'))
    nt.insert(0, ET.Element('tied', type=kind))


def _untie(note, kind):
    for t in note.findall('tie'):
        if t.get('type') == kind: note.remove(t)
    nt = note.find('notations')
    if nt is not None:
        for t in nt.findall('tied'):
            if t.get('type') == kind: nt.remove(t)


def _no_staccato(note):
    nt = note.find('notations')
    if nt is None: return
    for a in nt.findall('articulations'):
        for s in a.findall('staccato') + a.findall('staccatissimo'): a.remove(s)
        if not len(a): nt.remove(a)
    if not len(nt): note.remove(nt)


def _strip_for_continuation(note):
    """A tied-on copy: no lyrics, articulations, fermatas or accidentals of its own."""
    for tag in ('lyric', 'accidental', 'beam'):
        for e in note.findall(tag): note.remove(e)
    nt = note.find('notations')
    if nt is not None:
        for e in list(nt):
            if e.tag not in ('tied',): nt.remove(e)
        if not len(nt): note.remove(nt)


class Ev:
    """One onset of a voice: a note / chord (several <note>s) or a rest, with what stands before it (harmony, …)."""
    def __init__(self, notes, q, extra):
        self.notes, self.q, self.extra = notes, q, extra

    @property
    def rest(self): return self.notes[0].find('rest') is not None


def _runs(meas, div):
    """The measure as [run | other element]: a run = consecutive <note>s of one voice (no backup/forward in between)."""
    out, run, extra = [], None, []
    for el in list(meas):
        if el.tag == 'note':
            v = (el.findtext('voice') or '1', el.findtext('staff') or '1')
            if el.find('chord') is not None and run and run['evs']:
                run['evs'][-1].notes.append(el); continue
            if run is None or run['voice'] != v:
                if run: out.append(run)
                run = {'voice': v, 'evs': [], 'ok': True}
            if el.find('grace') is not None or el.find('time-modification') is not None or el.find('cue') is not None:
                run['ok'] = False
            d = Fr(int(float(el.findtext('duration') or 0)), 1) / div
            run['evs'].append(Ev([el], d, extra)); extra = []
        elif el.tag in ('backup', 'forward', 'attributes', 'barline'):
            if run: out.append(run); run = None
            out.extend(extra); extra = []
            out.append(el)
        else:  # harmony, direction, print, sound…: travels with the next onset
            extra.append(el)
    if run: out.append(run)
    out.extend(extra)
    return out


def _beat(meas_time):
    beats, bt = meas_time
    return Fr(3, 2) if bt == 8 and beats % 3 == 0 and beats > 3 else Fr(4, bt)


def _write_run(run, div, beat):
    """The run's events as <note> elements (lengths split into written values, tied; beams again per beat).
    A split note: the first piece keeps its tie-stop, the last its tie-start (from the note as it was)."""
    els, t, out = [], Fr(0), []
    for ev in run['evs']:
        ps = pieces(ev.q)
        if not getattr(ev, 'touched', False):
            out.append((ev.extra, ev.notes, t, ev.q)); ev.last_notes = ev.notes; t += ev.q; continue
        orig = [copy.deepcopy(n) for n in ev.notes]
        for k, (v, ty, dots) in enumerate(ps):
            last = k == len(ps) - 1
            if k == 0: ns = ev.notes
            else:
                ns = [copy.deepcopy(n) for n in orig]
                for n in ns: _strip_for_continuation(n)
            for n in ns:
                _set_len(n, v, ty, dots, div)
                if not ev.rest:
                    if k: _untie(n, 'stop'); _tie(n, 'stop')
                    if not last: _untie(n, 'start'); _tie(n, 'start')
            out.append((ev.extra if k == 0 else [], ns, t, v)); t += v
            ev.last_notes = ns
    for extra, ns, _, _ in out: els.extend(extra); els.extend(ns)
    _beam(out, beat)
    return els


def _beam(out, beat):
    """Beams again, per beat: consecutive notes of an eighth or shorter (rests break them)."""
    groups, cur, cb = [], [], None
    for _, ns, t, _q in out:
        n = ns[0]
        lvl = BEAMS.get(n.findtext('type') or '', 0)
        b = t // beat
        if n.find('rest') is not None or not lvl or b != cb:
            if cur: groups.append(cur)
            cur = []
            cb = b
            if n.find('rest') is not None or not lvl: continue
        cur.append((ns, lvl))
    if cur: groups.append(cur)
    for _, ns, _, _ in out:
        for n in ns:
            for e in n.findall('beam'): n.remove(e)
    for g in groups:
        if len(g) < 2: continue
        for level in range(1, 5):
            for i, (ns, lvl) in enumerate(g):
                if lvl < level: continue
                prev = i > 0 and g[i - 1][1] >= level
                nxt = i < len(g) - 1 and g[i + 1][1] >= level
                if not prev and not nxt:
                    if level == 1: continue
                    kind = 'backward hook' if i else 'forward hook'
                else: kind = 'begin' if not prev else 'end' if not nxt else 'continue'
                b = ET.Element('beam', number=str(level)); b.text = kind
                _put(ns[0], b)  # beams on the chord's first note (OSMD / MuseScore read them there)


def ease(text: str, strength: str = 'light', firm: bool = False):
    """(new MusicXML text, rests before, rests after). firm (Simple Piano, smoothrhythm.py): Strong, and every rest
    shorter than half the bar goes (only real silences stay)."""
    if firm: strength = 'strong'

    if strength not in LIMIT: raise ValueError(strength)
    lim = LIMIT[strength]
    root = ET.fromstring(text.encode('utf-8'))
    before = count_rests(root)
    for part in root.findall('part'):
        div, tsig = Fr(1), (4, 4)
        last_of = {}  # voice -> the last event of the bar before (for Strong's tie over the bar line)
        for meas in part.findall('measure'):
            a = meas.find('attributes')
            if a is not None:
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').isdigit(): tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            beat = _beat(tsig)
            lim_q = lim * (beat if beat == Fr(3, 2) else 1)
            if firm: lim_q = max(lim_q, Fr(4 * tsig[0], tsig[1]) / 2 - Fr(1, 64))
            items = _runs(meas, div)
            changed = False
            new_last = {}
            for r in items:
                if not isinstance(r, dict): continue
                evs = r['evs']
                if not r['ok'] or not evs:
                    new_last[r['voice']] = None; continue
                # 1. rests in a row -> one
                merged = []
                for ev in evs:
                    if ev.rest and merged and merged[-1].rest and fits(merged[-1].q + ev.q, div):
                        p = merged[-1]; p.q += ev.q; p.extra = p.extra + ev.extra; p.touched = True; changed = True
                        continue
                    merged.append(ev)
                # 2. a short rest after a note -> the note
                out = []
                for ev in merged:
                    if ev.rest and ev.q <= lim_q and out and not out[-1].rest and fits(out[-1].q + ev.q, div):
                        p = out[-1]; p.q += ev.q; p.touched = True; p.extra_after = getattr(p, 'extra_after', []) + ev.extra
                        for n in p.notes: _no_staccato(n)
                        changed = True
                        continue
                    out.append(ev)
                # Strong: a short rest opening the bar -> the note before, tied over the bar line
                prev = last_of.get(r['voice'])
                if (strength == 'strong' and len(out) > 1 and out[0].rest and out[0].q <= lim_q and prev is not None and not prev.rest
                        and all(n.find('pitch') is not None for n in prev.notes)):
                    pn = getattr(prev, 'last_notes', prev.notes)
                    ns = [copy.deepcopy(n) for n in pn]
                    for k, n in enumerate(ns):
                        _strip_for_continuation(n); _untie(n, 'start'); _untie(n, 'stop'); _tie(n, 'stop')
                        for e in n.findall('chord'): n.remove(e)
                        if k: _put(n, ET.Element('chord'))
                    for n in pn: _tie(n, 'start'); _no_staccato(n)
                    ev = Ev(ns, out[0].q, out[0].extra); ev.touched = True
                    out[0] = ev
                    changed = True
                r['evs'] = out
                new_last[r['voice']] = out[-1] if out else None
            last_of = {**last_of, **new_last}
            if not changed: continue
            # rebuild the measure
            kids = []
            for r in items:
                if isinstance(r, dict):
                    # harmonies of a rest merged into a note go before the next onset (or the run's end)
                    pend = []
                    for ev in r['evs']:
                        ev.extra = pend + ev.extra; pend = getattr(ev, 'extra_after', [])
                    kids.extend(_write_run(r, div, beat) if any(getattr(e, 'touched', False) for e in r['evs']) else
                                [x for e in r['evs'] for x in (*e.extra, *e.notes)])
                    kids.extend(pend)
                else: kids.append(r)
            for c in list(meas): meas.remove(c)
            for c in kids: meas.append(c)
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    return out, before, count_rests(root)


# ---------- checks (also used by the tests) ----------

def bar_lengths(text):
    """[(measure number, {voice: quarters}, quarters the time signature asks)] — every voice should fill its bar."""
    root = ET.fromstring(text.encode('utf-8'))
    out = []
    for part in root.findall('part'):
        div, tsig = Fr(1), (4, 4)
        for meas in part.findall('measure'):
            a = meas.find('attributes')
            if a is not None:
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None: tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type')))
            vs = {}
            for n in meas.findall('note'):
                if n.find('chord') is not None or n.find('grace') is not None: continue
                k = (n.findtext('staff') or '1', n.findtext('voice') or '1')
                vs[k] = vs.get(k, Fr(0)) + Fr(int(float(n.findtext('duration') or 0))) / div
            out.append((meas.get('number'), vs, Fr(4 * tsig[0], tsig[1])))
    return out
