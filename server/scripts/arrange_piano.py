"""Voice + piano score (a vocal part and a two-staff piano part) -> a two-hand piano solo.

The vocal melody becomes the top voice of the right hand (each phrase an octave up when that fits the accompaniment
better), the right-hand accompaniment is thinned under it (notes that double the melody, sit above it or lie more than
`--span` under it are dropped or moved an octave; at most `--cap` notes sound at once), and the left hand stays as it
is. Chord symbols and markings of both parts are kept; singer cues ("NAME:") and lyrics go. Credits are left as the
input has them: saving it as a version (POST /api/items with fromItemId) adds "Arranged by Meowsic".

    server/.venv/bin/python server/scripts/arrange_piano.py IN.musicxml OUT.musicxml [--shift 29-30=12 ...] [--log log.json]

--shift BARS=SEMITONES forces the octave shift (0 or 12) of the melody phrase that runs over those bars (1-based,
as the log's "shift" keys print them); without it each phrase is judged on its own. Read-only on IN; writes OUT only.
Needs one <divisions> value for the whole file (a quarter note's length)."""
import argparse
import copy
import json
import re
import sys
import xml.etree.ElementTree as ET

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
ORDER = ['grace', 'cue', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'voice', 'type', 'dot',
         'accidental', 'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam', 'notations', 'lyric', 'play', 'listen']
CUE = r'^[A-Z][A-Z0-9 .,&\'-]*:$'  # singer cues: "NAME:", "ALL:"


# ---------- MusicXML helpers ----------

def midi(n):
    p = n.find('pitch')
    if p is None: return None
    return 12 * (int(p.findtext('octave')) + 1) + STEP[p.findtext('step')] + int(float(p.findtext('alter') or 0))


def shift_octave(n, k):
    o = n.find('pitch').find('octave'); o.text = str(int(o.text) + k)


def strip(n, tags):
    for c in list(n):
        if c.tag in tags: n.remove(c)


def reorder(n):
    kids = list(n)
    for c in kids: n.remove(c)
    kids.sort(key=lambda c: ORDER.index(c.tag) if c.tag in ORDER else 99)
    for c in kids: n.append(c)


class Ev:
    """One onset in one voice: a chord (or single note / rest)."""
    def __init__(self, on, dur, notes, voice, staff, graces=None):
        self.on, self.dur, self.notes, self.voice, self.staff = on, dur, notes, voice, staff
        self.graces = graces or []

    @property
    def rest(self): return self.notes[0].find('rest') is not None

    @property
    def end(self): return self.on + self.dur


def parse_measure(m):
    """-> (events: [Ev], others: [(t, element)], attrs: [(t, attributes)])"""
    t = 0; evs = []; others = []; attrs = []; pend_grace = {}; cur = None
    for e in m:
        if e.tag == 'backup': t -= int(e.findtext('duration'))
        elif e.tag == 'forward': t += int(e.findtext('duration'))
        elif e.tag == 'note':
            v = e.findtext('voice') or '1'; st = e.findtext('staff') or '1'
            if e.find('grace') is not None:
                pend_grace.setdefault((st, v), []).append(e); continue
            d = int(e.findtext('duration') or 0)
            if e.find('chord') is not None and cur is not None: cur.notes.append(e)
            else:
                cur = Ev(t, d, [e], v, st, pend_grace.pop((st, v), []))
                evs.append(cur); t += d
        elif e.tag == 'attributes': attrs.append((t, e))
        elif e.tag in ('harmony', 'direction'):
            off = e.find('offset')
            others.append((t + (int(off.text) if off is not None else 0), e))
        else: others.append((t, e))
    return evs, others, attrs


class Rests:
    """Rests in divisions `div` (a quarter), split on beats."""
    def __init__(self, div):
        self.div = div
        # (length in quarters x8, type, dotted): only the ones `div` can express
        self.types = [(div * k // 8, ty, dot) for k, ty, dot in [(32, 'whole', 0), (24, 'half', 1), (16, 'half', 0), (12, 'quarter', 1),
                      (8, 'quarter', 0), (6, 'eighth', 1), (4, 'eighth', 0), (2, '16th', 0), (1, '32nd', 0)] if div * k % 8 == 0]

    def el(self, dur, voice, staff, trip=None, measure=False):
        n = ET.Element('note')
        r = ET.SubElement(n, 'rest')
        if measure: r.set('measure', 'yes')
        ET.SubElement(n, 'duration').text = str(dur)
        ET.SubElement(n, 'voice').text = voice
        if not measure:
            if trip: ET.SubElement(n, 'type').text = trip
            else:
                for d, ty, dot in self.types:
                    if d == dur:
                        ET.SubElement(n, 'type').text = ty
                        if dot: ET.SubElement(n, 'dot')
                        break
                else: raise ValueError(f'odd rest {dur}')
            if trip:
                tm = ET.SubElement(n, 'time-modification')
                ET.SubElement(tm, 'actual-notes').text = '3'; ET.SubElement(tm, 'normal-notes').text = '2'
        ET.SubElement(n, 'staff').text = staff
        return n

    def fill(self, a, b, voice, staff, bar, whole_bar_ok=True):
        """Rests filling [a, b) of a bar `bar` long."""
        q = self.div
        if a == 0 and b == bar and whole_bar_ok: return [self.el(bar, voice, staff, measure=True)]
        out, t = [], a
        while t < b:
            for d, ty, dot in self.types:
                if dot or t + d > b: continue
                if d >= 2 * q and t % (2 * q): continue       # half-bar values on half-bar boundaries
                if q <= d < 2 * q and t % q: continue          # quarters on the beat
                if d < q and (t // q) != ((t + d - 1) // q): continue  # shorter ones inside a beat
                out.append(self.el(d, voice, staff)); t += d; break
            else:
                t3 = q // 3 if q % 3 == 0 else 0  # triplet rests
                if t3 and ((b - t) % t3 == 0 or (t % t3 == 0 and b - t >= t3)):
                    d = 2 * t3 if (t % q == 0 and b - t >= 2 * t3 and (b - t) % (2 * t3) == 0) else t3
                    out.append(self.el(d, voice, staff, trip='quarter' if d == 2 * t3 else 'eighth')); t += d
                else: raise ValueError(f'cannot rest {a}-{b} at {t}')
        return out


def key_alters(f):
    order, alt = 'FCGDAEB', {s: 0 for s in 'CDEFGAB'}
    for s in (order[:f] if f > 0 else order[::-1][:-f]): alt[s] = 1 if f > 0 else -1
    return alt


# ---------- the arrangement ----------

def pick_parts(root, vocal_id=None, piano_id=None):
    parts = root.findall('part')
    staves = {p.get('id'): max([int(x.text) for x in p.iter('staves')] or [1]) for p in parts}
    piano = next((p for p in parts if p.get('id') == piano_id), None) if piano_id else next((p for p in parts if staves[p.get('id')] == 2), None)
    vocal = next((p for p in parts if p.get('id') == vocal_id), None) if vocal_id else next((p for p in parts if p is not piano and staves[p.get('id')] == 1), None)
    if piano is None or vocal is None: sys.exit('Need a one-staff vocal part and a two-staff piano part (or --vocal / --piano part ids)')
    return vocal, piano


def arrange(text, cap=4, span=12, force=None, cue=CUE, vocal_id=None, piano_id=None):
    """MusicXML text -> (piano solo MusicXML text, log dict)."""
    force = force or {}
    cue_re = re.compile(cue) if cue else None
    root = ET.fromstring(text.encode('utf-8'))
    P1, P2 = pick_parts(root, vocal_id, piano_id)
    M1, M2 = P1.findall('measure'), P2.findall('measure')
    if len(M1) != len(M2): sys.exit(f'The vocal part has {len(M1)} bars, the piano part {len(M2)}')
    divs = {int(d.text) for d in root.iter('divisions')}
    if len(divs) != 1: sys.exit(f'Needs one <divisions> value for the whole file, found {sorted(divs) or "none"}')
    DIV = divs.pop()
    R = Rests(DIV)
    NB = len(M2)
    log = {'shift': {}, 'mel_raised': [], 'dropped': {}, 'moved': {}, 'cap': {}, 'second_voice': {}}

    # ---------- read: bars, their lengths and start times ----------
    bars, start, t0, blen = [], [], 0, 4 * DIV
    for bi in range(NB):
        e1, o1, a1 = parse_measure(M1[bi]); e2, o2, a2 = parse_measure(M2[bi])
        for _, a in a2:
            tm = a.find('time')
            if tm is not None and tm.findtext('beats'):
                blen = int(tm.findtext('beats')) * 4 * DIV // int(tm.findtext('beat-type'))
        L = blen
        if M2[bi].get('implicit') == 'yes':  # a pickup bar: as long as its notes
            L = max([e.end for e in e1 + e2] or [blen])
        bars.append(dict(e1=e1, o1=o1, a1=a1, e2=e2, o2=o2, a2=a2, len=L))
        start.append(t0); t0 += L

    def melody_of(evs):
        v1 = [e for e in evs if e.voice == '1']; v2 = [e for e in evs if e.voice == '2']
        if v2 and all(e.rest for e in v1) and any(not e.rest for e in v2): return v2, []
        return v1, v2

    class N:  # one note in absolute time
        def __init__(s, bar, ev, el, src):
            s.bar, s.ev, s.el, s.src = bar, ev, el, src
            s.on = start[bar] + ev.on; s.end = s.on + ev.dur; s.p = midi(el); s.p0 = s.p
            s.tie_start = any(t.get('type') == 'start' for t in el.findall('tie'))

    MEL, ACC, LH = [], [], []
    for bi, b in enumerate(bars):
        mel, sec = melody_of(b['e1'])
        b['mel'] = mel
        for ev in mel:
            if not ev.rest: MEL.append(N(bi, ev, ev.notes[0], 'mel'))
        for ev in sec:
            if not ev.rest:
                for el in ev.notes: ACC.append(N(bi, ev, el, 'duet'))
        for ev in b['e2']:
            if ev.rest: continue
            for el in ev.notes: (ACC if ev.staff == '1' else LH).append(N(bi, ev, el, 'rh' if ev.staff == '1' else 'lh'))

    # tie chains among RH notes (same pitch, next onset == end)
    by_start = {}
    for n in ACC:
        if n.src == 'rh': by_start.setdefault((n.on, n.p), []).append(n)
    chains, seen = [], set()
    for n in sorted(ACC, key=lambda x: x.on):
        if id(n) in seen: continue
        ch = [n]; seen.add(id(n))
        while ch[-1].tie_start and ch[-1].src == 'rh':
            nx = [x for x in by_start.get((ch[-1].end, ch[-1].p), []) if id(x) not in seen]
            if not nx: break
            ch.append(nx[0]); seen.add(id(nx[0]))
        chains.append(ch)

    # ---------- melody octave: per phrase (split at rests) ----------
    phrases, cur = [], []
    for b in bars:
        for ev in b['mel']:
            if ev.rest:
                if cur: phrases.append(cur); cur = []
            else: cur.append(next(n for n in MEL if n.ev is ev))
    if cur: phrases.append(cur)

    def overl(a0, a1, ms): return [m for m in ms if m.on < a1 and a0 < m.end]

    def judge_chain(ch, ms, lh):
        """-> ('keep', 0) | ('move', +-12) | ('drop', why)"""
        a0, a1, p = ch[0].on, ch[-1].end, ch[0].p
        O = overl(a0, a1, ms)
        if not O: return 'keep', 0
        if any(m.on == a0 and m.p % 12 == p % 12 for m in O): return 'drop', 'doubles the melody'
        if any(m.p == p for m in O): return 'drop', 'unison with the melody'

        def ok(q):
            if any(not (m.p - span <= q < m.p) for m in O): return False
            return not any(l.on < a1 and a0 < l.end and l.p >= q for l in lh)
        if ok(p): return 'keep', 0
        lone = len(ch[0].ev.notes) < 2 and ch[-1].end - ch[0].on < DIV
        for d in (() if lone else (-12,) if any(m.p < p for m in O) else (12,)):
            if ok(p + d) and not any(m.p % 12 == (p + d) % 12 and m.on == a0 for m in O): return 'move', d
        return 'drop', 'above the melody' if any(m.p < p for m in O) else 'more than an octave under the melody'

    def cost(phr, s):
        ids = {id(m) for m in phr}
        ms = []
        for m0 in MEL:
            if id(m0) in ids:
                m = copy.copy(m0); m.p = m0.p + s; ms.append(m)
        lo, hi = phr[0].on, phr[-1].end
        c = 0
        for ch in chains:
            if ch[0].on < hi and lo < ch[-1].end:
                k, w = judge_chain(ch, ms, LH)
                c += 1 if k == 'drop' and 'melody' in w and not w.startswith(('doubles', 'unison')) else 0
        return c

    for phr in phrases:
        key = f'{phr[0].bar + 1}-{phr[-1].bar + 1}'
        s = force.get(key)
        if s is None: s = 12 if cost(phr, 12) < cost(phr, 0) else 0
        for m in phr: m.p = m.p0 + s
        log['shift'][key] = s
    unused = sorted(set(force) - set(log['shift']))
    if unused: print(f'warning: --shift {", ".join(unused)} matches no melody phrase', file=sys.stderr)

    # a melody note at or under the left hand -> an octave up
    for m in MEL:
        if any(l.on < m.end and m.on < l.end and l.p >= m.p for l in LH):
            m.p += 12; log['mel_raised'].append(m.bar + 1)

    # ---------- accompaniment ----------
    keep = {}   # id(note) -> new pitch
    for ch in chains:
        k, w = judge_chain(ch, MEL, LH)
        b = ch[0].bar + 1
        if k == 'drop':
            log['second_voice' if ch[0].src == 'duet' else 'dropped'].setdefault(b, []).append(w)
            continue
        for n in ch: keep[id(n)] = n.p + (w if k == 'move' else 0)
        if k == 'move': log['moved'].setdefault(b, []).append(w)

    # duplicates (a duet line the piano already plays; moved notes landing on another)
    kept = [n for n in ACC if id(n) in keep]
    for n in sorted(kept, key=lambda x: (x.src == 'duet', x.on)):
        if id(n) not in keep: continue
        for o in kept:
            if o is n or id(o) not in keep: continue
            if keep[id(o)] == keep[id(n)] and o.on < n.end and n.on < o.end and (o.src == 'duet' or (o.on, o.src) > (n.on, n.src)):
                if o.src == 'duet' and n.src == 'duet': continue
                del keep[id(o)]
                if o.src == 'duet': log['second_voice'].setdefault(o.bar + 1, []).append('already played by the piano')

    # density cap
    for t in sorted({n.on for n in ACC if id(n) in keep} | {m.on for m in MEL}):
        sounding = [n for n in ACC if id(n) in keep and n.on <= t < n.end]
        mel = [m for m in MEL if m.on <= t < m.end]
        while len(sounding) + len(mel) > cap:
            struck = [n for n in sounding if n.on == t] or sounding
            lo = min(struck, key=lambda n: keep[id(n)])
            for x in next(c for c in chains if lo in c): keep.pop(id(x), None)  # its whole tie chain
            log['cap'][lo.bar + 1] = log['cap'].get(lo.bar + 1, 0) + 1
            sounding = [n for n in sounding if id(n) in keep]

    # ---------- write ----------
    pid = P2.get('id')
    name = next((sp.findtext('part-name') for sp in root.find('part-list') if sp.get('id') == pid), None) or 'Piano'
    for p in root.findall('part'): root.remove(p)
    pl = root.find('part-list')
    for sp in list(pl): pl.remove(sp)
    sp = ET.SubElement(pl, 'score-part', id='P1'); ET.SubElement(sp, 'part-name').text = name
    part = ET.SubElement(root, 'part', id='P1')

    key_at, fifths = {}, 0
    for bi in range(NB):
        for _, a in bars[bi]['a2']:
            k = a.find('key')
            if k is not None: fifths = int(k.findtext('fifths'))
        key_at[bi] = fifths

    def note_copy(el, voice, staff, pitch=None, chord=False):
        n = copy.deepcopy(el)
        strip(n, ('lyric', 'beam', 'stem', 'chord', 'staff', 'voice', 'accidental'))
        if pitch is not None and midi(n) is not None and pitch != midi(n): shift_octave(n, (pitch - midi(n)) // 12)
        nt = n.find('notations')
        if nt is not None and len(nt) == 0: n.remove(nt)
        if chord: ET.SubElement(n, 'chord')
        ET.SubElement(n, 'voice').text = voice
        ET.SubElement(n, 'staff').text = staff
        reorder(n)
        return n

    def write_voice(m, events, voice, staff, L, stem=None):
        """events: [(on, dur, [note elements already copied], graces)] sorted, non-overlapping."""
        t = 0; out = []
        for on, dur, els, gr in events:
            if on > t: out += R.fill(t, on, voice, staff, L, whole_bar_ok=(t == 0 and on == L))
            out += gr; out += els; t = on + dur
        if t < L: out += R.fill(t, L, voice, staff, L, whole_bar_ok=(t == 0))
        for n in out:
            if stem and n.find('rest') is None and n.find('chord') is None:
                ET.SubElement(n, 'stem').text = stem; reorder(n)
            m.append(n)
        return out

    def beam_voice(notes):
        """Beams per beat for 8ths and shorter (chord followers carry none)."""
        seq, t = [], 0
        for n in notes:
            if n.find('grace') is not None or n.find('chord') is not None: continue
            d = int(n.findtext('duration')); seq.append((t, d, n)); t += d
        groups, cur, beat = [], [], None
        for t, d, n in seq:
            ok = n.find('rest') is None and n.findtext('type') in ('eighth', '16th', '32nd')
            b = t // DIV
            if ok and (beat == b or not cur) and (not cur or cur[-1][0] + cur[-1][1] == t):
                cur.append((t, d, n)); beat = b
            else:
                if len(cur) > 1: groups.append(cur)
                cur = [(t, d, n)] if ok else []; beat = b
        if len(cur) > 1: groups.append(cur)
        short = ('16th', '32nd')
        for g in groups:
            for i, (_, _, n) in enumerate(g):
                ET.SubElement(n, 'beam', number='1').text = 'begin' if i == 0 else 'end' if i == len(g) - 1 else 'continue'
                if n.findtext('type') in short:
                    prev = i > 0 and g[i - 1][2].findtext('type') in short
                    nxt = i < len(g) - 1 and g[i + 1][2].findtext('type') in short
                    ET.SubElement(n, 'beam', number='2').text = 'continue' if prev and nxt else 'begin' if nxt else 'end' if prev else ('forward hook' if i == 0 else 'backward hook')
                reorder(n)

    def fix_accidentals(notes, f):
        alt = key_alters(f); state = {}
        for n in notes:
            p = n.find('pitch')
            if p is None: continue
            s, o, a = p.findtext('step'), p.findtext('octave'), int(float(p.findtext('alter') or 0))
            if a != state.get((s, o), alt[s]):
                ET.SubElement(n, 'accidental').text = {0: 'natural', 1: 'sharp', -1: 'flat', 2: 'double-sharp', -2: 'flat-flat'}[a]
                reorder(n)
            state[(s, o)] = a

    ALL_RH_OUT = []   # (abs on, abs end, midi, element) for the tie pass
    for bi in range(NB):
        b, L = bars[bi], bars[bi]['len']
        m = ET.SubElement(part, 'measure', number=M2[bi].get('number'))
        for k, v in M2[bi].attrib.items(): m.set(k, v)
        for t, a in b['a2']:
            if t == 0: m.append(copy.deepcopy(a))
        mel_here = [x for x in MEL if x.bar == bi]
        acc_here = [n for n in ACC if n.bar == bi]
        unchanged = not mel_here and all(id(n) in keep and keep[id(n)] == n.p for n in acc_here if n.src == 'rh')
        rh_written = []
        if unchanged:  # no melody here and nothing thinned: the RH as it was
            vos = sorted({e.voice for e in b['e2'] if e.staff == '1'})
            for vo in vos:
                evs = [(e.on, e.dur, [note_copy(x, vo, '1', chord=i > 0) for i, x in enumerate(e.notes)],
                        [note_copy(g, vo, '1') for g in e.graces]) for e in b['e2'] if e.staff == '1' and e.voice == vo and not e.rest]
                outs = write_voice(m, evs, vo, '1', L, stem=('up' if vo == '1' else 'down') if len(vos) > 1 else None)
                beam_voice(outs); rh_written.append(outs)
                ET.SubElement(ET.SubElement(m, 'backup'), 'duration').text = str(L)
        else:
            mevs = []
            for x in mel_here:
                gr = [note_copy(g, '1', '1', pitch=midi(g) + (x.p - x.p0)) for g in x.ev.graces]
                el = note_copy(x.el, '1', '1', pitch=x.p)
                for y in [*gr, el]:
                    for sl in y.iter('slur'): sl.set('number', '3')  # the melody's slurs apart from the accompaniment's
                mevs.append((x.ev.on, x.ev.dur, [el], gr))
            groups = {}  # kept accompaniment notes by their original event
            for n in acc_here:
                if id(n) in keep: groups.setdefault(id(n.ev), (n.ev, []))[1].append(n)
            voices = []   # [end, [events]]
            for ev, ns in sorted(groups.values(), key=lambda g: (g[0].on, -g[0].dur)):
                ns.sort(key=lambda n: keep[id(n)])
                for v in voices:
                    if v[0] <= ev.on: break
                else:
                    v = [0, []]; voices.append(v)
                v[0] = ev.end; v[1].append((ev, ns))
            outs = write_voice(m, mevs, '1', '1', L, stem='up' if voices else None)
            beam_voice(outs); rh_written.append(outs)
            ET.SubElement(ET.SubElement(m, 'backup'), 'duration').text = str(L)
            for k, (_, evl) in enumerate(voices):
                vo = str(2 + k)
                evs = []
                for ev, ns in evl:
                    els = [note_copy(n.el, vo, '1', pitch=keep[id(n)], chord=i > 0) for i, n in enumerate(ns)]
                    gr = [note_copy(g, vo, '1') for g in ev.graces]
                    if gr and any(keep[id(n)] != n.p for n in ns):
                        log.setdefault('graces_dropped', []).append((bi + 1, len(gr))); gr = []
                    evs.append((ev.on, ev.dur, els, gr))
                outs = write_voice(m, evs, vo, '1', L, stem='down')
                beam_voice(outs); rh_written.append(outs)
                ET.SubElement(ET.SubElement(m, 'backup'), 'duration').text = str(L)
        # accidentals over the RH as a whole, in time order
        flat = []
        for outs in rh_written:
            t = on = 0
            for n in outs:
                if n.find('chord') is None and n.find('grace') is None:
                    on = t; t += int(n.findtext('duration'))
                elif n.find('grace') is not None: on = t
                flat.append((on, n))
        fix_accidentals([n for _, n in sorted(flat, key=lambda x: x[0])], key_at[bi])
        for on, n in flat:
            if n.find('rest') is None and n.find('grace') is None:
                ALL_RH_OUT.append((start[bi] + on, start[bi] + on + int(n.findtext('duration')), midi(n), n))
        # left hand: as it was
        vos = sorted({e.voice for e in b['e2'] if e.staff == '2'})
        for vo in vos:
            evs = [(e.on, e.dur, [note_copy(x, vo, '2', chord=i > 0) for i, x in enumerate(e.notes)],
                    [note_copy(g, vo, '2') for g in e.graces]) for e in b['e2'] if e.staff == '2' and e.voice == vo and not e.rest]
            outs = write_voice(m, evs, vo, '2', L, stem=('up' if vo == vos[0] else 'down') if len(vos) > 1 else None)
            beam_voice(outs)
            ET.SubElement(ET.SubElement(m, 'backup'), 'duration').text = str(L)
        # chord symbols (vocal part first), tempo words, dynamics and other marks, at their time; no singer cues
        others = [(t, e) for t, e in b['o1'] if e.tag == 'harmony' or e.tag == 'direction' and not (
            cue_re and cue_re.match((e.findtext('.//words') or '').strip()))]
        others += [(t, e) for t, e in b['o2'] if e.tag in ('harmony', 'direction')]
        if m[-1].tag == 'backup': m.remove(m[-1])
        pos = 1 if len(m) and m[0].tag == 'attributes' else 0
        for t, e in sorted(others, key=lambda x: x[0]):
            e = copy.deepcopy(e)
            for o in e.findall('offset'): e.remove(o)
            if t:
                o = ET.Element('offset'); o.text = str(t)
                kids = list(e)
                stop = ('editorial', 'voice', 'staff') if e.tag == 'harmony' else ('staff', 'sound')
                e.insert(next((i for i, c in enumerate(kids) if c.tag in stop), len(kids)), o)
            if e.find('staff') is None: ET.SubElement(e, 'staff').text = '1'
            m.insert(pos, e); pos += 1
        for e in M2[bi].findall('barline'): m.append(copy.deepcopy(e))

    # ties: keep only the ones whose two notes are both there
    starts = {(a, p) for a, e, p, n in ALL_RH_OUT}
    ends = {(e, p) for a, e, p, n in ALL_RH_OUT}
    broken = 0
    for a, e, p, n in ALL_RH_OUT:
        for tie in list(n.findall('tie')):
            if ((e, p) in starts) if tie.get('type') == 'start' else ((a, p) in ends): continue
            n.remove(tie); broken += 1
            nt = n.find('notations')
            for td in list(nt.findall('tied')) if nt is not None else []:
                if td.get('type') == tie.get('type'): nt.remove(td)
            if nt is not None and len(nt) == 0: n.remove(nt)
    log['ties_removed'] = broken

    # slurs: drop unmatched ones per number
    open_ = {}
    for a, e, p, n in sorted(ALL_RH_OUT, key=lambda x: x[0]):
        for sl in n.iter('slur'):
            k = sl.get('number', '1')
            if sl.get('type') == 'start': open_[k] = sl
            elif sl.get('type') == 'stop':
                if k in open_: open_.pop(k)
                else: sl.set('type', 'DROP')
    for n in [x[3] for x in ALL_RH_OUT]:
        nt = n.find('notations')
        if nt is None: continue
        for sl in list(nt.findall('slur')):
            if sl.get('type') == 'DROP' or sl in open_.values(): nt.remove(sl)
        if len(nt) == 0: n.remove(nt)

    for n in root.iter('note'): strip(n, ('lyric',))
    ET.indent(root, space=' ')
    log['mel_notes'] = len(MEL)
    return text[:text.find('<score-partwise')] + ET.tostring(root, encoding='unicode') + '\n', log


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument('input', help='voice + piano MusicXML')
    ap.add_argument('output', help='piano solo MusicXML to write')
    ap.add_argument('--shift', action='append', default=[], metavar='BARS=SEMITONES',
                    help='force a melody phrase\'s octave shift, e.g. 29-30=12 (repeatable)')
    ap.add_argument('--cap', type=int, default=4, help='most RH notes sounding at once, melody included (4)')
    ap.add_argument('--span', type=int, default=12, help='semitones from the melody down to the lowest RH note (12)')
    ap.add_argument('--cue', default=CUE, help='regex of direction words to drop (singer cues); "" keeps all')
    ap.add_argument('--vocal', help='vocal part id (default: the first one-staff part)')
    ap.add_argument('--piano', help='piano part id (default: the first two-staff part)')
    ap.add_argument('--log', help='write the full log (JSON) here')
    a = ap.parse_args(argv)
    force = {}
    for s in a.shift:
        m = re.fullmatch(r'(\d+-\d+)=(-?\d+)', s.strip())
        if not m: ap.error(f'--shift {s!r}: use BARS=SEMITONES, e.g. 29-30=12')
        force[m[1]] = int(m[2])
    with open(a.input, encoding='utf-8') as f: text = f.read()
    out, log = arrange(text, a.cap, a.span, force, a.cue, a.vocal, a.piano)
    with open(a.output, 'w', encoding='utf-8') as f: f.write(out)
    if a.log:
        with open(a.log, 'w') as f: json.dump(log, f, indent=1)
    print(json.dumps({k: (v if not isinstance(v, dict) else {kk: (len(vv) if isinstance(vv, list) else vv) for kk, vv in v.items()}) for k, v in log.items()}))


if __name__ == '__main__':
    main()
