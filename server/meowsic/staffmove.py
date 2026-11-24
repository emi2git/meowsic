"""Edit notes (score ⋯ → "Edit notes…", web/js/views/editnotes.js; also Check bars, web/js/views/checkbars.js):
change notes — pitch, length, delete, add (edit(): one op each), take a bar from another reading of the sheet, mark
checked bars — and move notes between the hands — the upper
staff (1, right hand) and the lower staff (2, left hand) of the score's piano part (its first part with two staves).

move(text, refs, to) changes the <staff> of the chosen notes and rebuilds only the bars they are in:
  - a chord stays a chord: notes of one chord moved together stay one chord; a note landing at the same time and
    with the same length as a chord on the other staff joins that chord;
  - otherwise the notes go into a voice of the other staff where it rests at that time (the rest is split around
    them), or into a new voice of that staff (1–4 upper, 5–8 lower) filled with rests;
  - the notes left behind become rests; rests in a row are joined and written again per beat; a voice left with
    nothing but rests goes when its staff has another voice, else it becomes one whole-bar rest;
  so every voice of both staves still fills its bar. Clefs and pitches stay; beams of a changed voice are drawn
  again per beat; a moved note loses its stem direction (the renderer picks one).
Grace notes stay where they are (with the note they lead into when that note stays in its voice).
After every edit the edited staff / voice of each edited bar is tidied (barnorm.normalize_bar: beams by beat group,
rests joined into the largest rests that keep the beat) and so is the whole score (barnorm.tidy_score: no repeated
time signature / key / clef, edited bars full).

refs = indexes among the part's <note> elements (as notes() gives them). ops = [{op, refs, …}, …] applied in order
(the refs of an op are in the score as the ops before it left it).

POST /api/items/{id}/editnotes/preview  {ops} -> {xml, notes, moved, part, sha, changed}  (nothing saved)
POST /api/items/{id}/editnotes          {ops, mode: 'this'|'new', sha?} -> saved like Fit lyrics (lyricsedit.py):
     'this' keeps the file before in items/<folder>/.history/notes-<ms>-<name> + an Activities 'musicxml' step;
     'new' makes a new score in the same group, tagged "Hands moved" / "Notes edited" (Undo moves it to the Trash).
"""
import copy
import shutil
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import APIRouter, Body, Depends, HTTPException

from .autofill import fill_from_library, log_fill, recredit
from .db import folder_path, get_item, now_ms, uid, write_item
from .easerests import _beam, _beat, _put, fits, pieces
from .items import cfg, conn, item_dir, must_item
from .sheetversion import refresh_staves
from .undolog import _q, record_undo

router = APIRouter(prefix='/api')
TAG = 'Hands moved'      # a new version where notes only changed hands
TAG_EDIT = 'Notes edited'  # any other edit
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
TOP = {'1': 1, '2': 5}  # first voice number of each staff (MuseScore's habit)


def _head(text):
    i = text.find('<score-partwise')
    return text[:i] if i > 0 else '<?xml version="1.0" encoding="UTF-8"?>\n'


def _midi(n):
    p = n.find('pitch')
    if p is None: return None
    try: return 12 * (int(p.findtext('octave')) + 1) + STEP[p.findtext('step').strip()] + round(float(p.findtext('alter') or 0))
    except (TypeError, ValueError, KeyError, AttributeError): return None


def _st(n): return (n.findtext('staff') or '1').strip()
def _vo(n): return (n.findtext('voice') or '1').strip()
def _dur(n): return Fr(int(float(n.findtext('duration') or 0)))


def piano_part(root):
    """(index, part) of the first part with two staves, or (None, None)."""
    for k, p in enumerate(root.findall('part')):
        if any((a.findtext('staves') or '').strip() == '2' for a in p.iter('attributes')): return k, p
    return None, None


def notes(root):
    """The notes of the part you edit (edit_part): [{ref, bar, on, dur, staff, midi, voice, rest?}] (on / dur in
    quarters, on from the start of its bar; ref = index among the part's <note>s). Rests too (rest: True, midi
    None); no grace notes."""
    k, part, _ = edit_part(root)
    if part is None: return []
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    out, div = [], Fr(1)
    for bi, m in enumerate(part.findall('measure')):
        t, last = Fr(0), Fr(0)
        for e in m:
            if e.tag == 'attributes' and e.findtext('divisions'): div = Fr(int(float(e.findtext('divisions'))))
            elif e.tag == 'backup': t -= _dur(e) / div
            elif e.tag == 'forward': t += _dur(e) / div
            elif e.tag == 'note':
                if e.find('grace') is not None: continue
                d = _dur(e) / div
                chord = e.find('chord') is not None
                at = last if chord else t
                if not chord: last, t = t, t + d
                out.append({'ref': ref[id(e)], 'bar': bi, 'on': float(at), 'dur': float(d), 'staff': int(_st(e)), 'midi': _midi(e), 'voice': _vo(e),
                            **({'rest': True} if e.find('rest') is not None or e.find('pitch') is None else {})})
    return out


# ---------- one bar as voices of events ----------

class Ev:
    """One onset of a voice: a chord (one or more <note>s), a rest, or a gap (a <forward> inside the voice)."""
    def __init__(self, on, dur, notes=(), kind='notes', graces=()):
        self.on, self.dur, self.notes, self.kind, self.graces = on, dur, list(notes), kind, list(graces)

    @property
    def end(self): return self.on + self.dur
    @property
    def rest(self): return self.kind == 'rest'
    @property
    def plain_rest(self):  # a rest that can be joined / split (no tuplet, nothing on it)
        return self.rest and (not self.notes or self.notes[0].find('time-modification') is None)


class Voice:
    def __init__(self, num, staff):
        self.num, self.staff, self.evs, self.touched, self.first = num, staff, [], False, 0


def _read_bar(m, div):
    """(voices in the order they start, [(time, index, element)] of everything else, bar length) — in divisions."""
    voices, other, t, longest = {}, [], Fr(0), Fr(0)
    graces, last_ev = {}, None
    for idx, e in enumerate(list(m)):
        if e.tag == 'backup': t -= _dur(e); continue
        if e.tag == 'forward': t += _dur(e); longest = max(longest, t); continue
        if e.tag != 'note': other.append((t, idx, e)); continue
        v = (_vo(e), _st(e))
        if e.find('grace') is not None:
            graces.setdefault(v, []).append(e); continue
        if e.find('chord') is not None and last_ev is not None:
            last_ev.notes.append(e); continue
        d = _dur(e)
        vo = voices.get(v)
        if vo is None: vo = voices[v] = Voice(v[0], v[1]); vo.first = idx
        end = vo.evs[-1].end if vo.evs else Fr(0)
        if t > end: vo.evs.append(Ev(end, t - end, kind='gap'))
        ev = Ev(t, d, [e], 'rest' if e.find('rest') is not None else 'notes', graces.pop(v, []))
        vo.evs.append(ev)
        last_ev = ev
        t += d
        longest = max(longest, t)
    for v, g in graces.items():  # grace notes at the end of a bar (nothing after them): keep them in their voice
        if v in voices: voices[v].evs.append(Ev(voices[v].evs[-1].end, Fr(0), g, 'notes'))
        else: other.extend((t, 10 ** 6, x) for x in g)
    return list(voices.values()), other, longest


def _note_el(v, staff, d, rest=None):
    n = ET.Element('note')
    if rest is not None: n.append(rest)
    ET.SubElement(n, 'duration').text = str(int(d))
    ET.SubElement(n, 'voice').text = str(v)
    return n


def _rests(on, dur, div, beat, bar_len, voice, staff):
    """Rest events for [on, on+dur) (in divisions): the part of a beat first, then whole beats, then the rest,
    each in written values. A rest that is the whole bar: one bar rest."""
    if on == 0 and dur == bar_len:
        n = _note_el(voice, staff, dur, ET.Element('rest', measure='yes'))
        if bar_len / div == 4: _put(n, ET.Element('type')).text = 'whole'
        _put(n, ET.Element('staff')).text = staff
        return [Ev(on, dur, [n], 'rest')]
    bq, end, t, segs = beat * div, on + dur, on, []
    if t % bq:
        nxt = min(end, (t // bq + 1) * bq)
        segs.append((t, nxt - t)); t = nxt
    beats_end = t + ((end - t) // bq) * bq
    if beats_end > t: segs.append((t, beats_end - t)); t = beats_end
    if t < end: segs.append((t, end - t))
    out = []
    for a, d in segs:
        q = d / div
        if fits(q, div):
            for v, ty, dots in pieces(q):
                n = _note_el(voice, staff, v * div, ET.Element('rest'))
                _put(n, ET.Element('type')).text = ty
                for _ in range(dots): _put(n, ET.Element('dot'))
                _put(n, ET.Element('staff')).text = staff
                out.append(Ev(a, v * div, [n], 'rest')); a += v * div
        else:
            n = _note_el(voice, staff, d, ET.Element('rest'))
            _put(n, ET.Element('staff')).text = staff
            out.append(Ev(a, d, [n], 'rest'))
    return out


def _set_voice(n, v, staff):
    vo = n.find('voice')
    if vo is None: vo = _put(n, ET.Element('voice'))
    vo.text = str(v)
    s = n.find('staff')
    if s is None: s = _put(n, ET.Element('staff'))
    s.text = staff


def _as_chord(ns):
    """The notes as one chord: <chord/> on all but the first."""
    for k, n in enumerate(ns):
        for c in n.findall('chord'): n.remove(c)
        if k: _put(n, ET.Element('chord'))


def _normalize(vo, div, beat, bar_len):
    """Rests in a row joined and written again per beat."""
    out, run = [], None
    def flush():
        if run: out.extend(_rests(run[0], run[1], div, beat, bar_len, vo.num, vo.staff))
    for ev in vo.evs:
        if ev.plain_rest and not ev.graces:
            if run and run[0] + run[1] == ev.on: run = (run[0], run[1] + ev.dur)
            else: flush(); run = (ev.on, ev.dur)
            continue
        flush(); run = None
        out.append(ev)
    flush()
    vo.evs = out


def _fill(vo, on, dur):
    """Can the voice take a chord at [on, on+dur)? Yes when it only rests (plain rests) all that time."""
    end = on + dur
    ov = [ev for ev in vo.evs if ev.end > on and ev.on < end]
    return bool(ov) and all(ev.plain_rest and not ev.graces for ev in ov) and ov[0].on <= on and ov[-1].end >= end


def _put_in(vo, chord, div, beat, bar_len):
    """Put a chord into the voice where it rests (the rest is split around it)."""
    on, end = chord.on, chord.end
    res = []
    for ev in vo.evs:
        if ev.end <= on or ev.on >= end: res.append(ev); continue
        if ev.on < on: res.extend(_rests(ev.on, on - ev.on, div, beat, bar_len, vo.num, vo.staff))
        if ev.end > end: res.extend(_rests(end, ev.end - end, div, beat, bar_len, vo.num, vo.staff))
    res.append(chord)
    res.sort(key=lambda e: e.on)
    vo.evs = res
    for n in chord.notes: _set_voice(n, vo.num, vo.staff)
    vo.touched = True


def _strip_moved(n):
    for tag in ('stem', 'beam'):
        for e in n.findall(tag): n.remove(e)


def _write_bar(m, voices, other, bar_len, div, beat):
    """The bar again: everything else at its time while the first voice is written, then each voice after a
    <backup>. Right-hand bar lines go last."""
    right = [o for o in other if o[2].tag == 'barline' and (o[2].get('location') or 'right') == 'right']
    pend = sorted((o for o in other if o not in right), key=lambda o: (o[0], o[1]))
    kids, cur = [], Fr(0)
    for k, vo in enumerate(voices):
        if k and cur: b = ET.Element('backup'); ET.SubElement(b, 'duration').text = str(int(cur)); kids.append(b); cur = Fr(0)
        if vo.touched:
            _beam([(None, e.notes, Fr(e.on) / div, Fr(e.dur) / div) for e in vo.evs if e.kind != 'gap' and e.dur > 0], beat)
        for ev in vo.evs:
            if ev.on > cur:
                f = ET.Element('forward'); ET.SubElement(f, 'duration').text = str(int(ev.on - cur)); kids.append(f); cur = ev.on
            if k == 0:
                while pend and pend[0][0] <= ev.on: kids.append(pend.pop(0)[2])
            if ev.kind == 'gap':
                f = ET.Element('forward'); ET.SubElement(f, 'duration').text = str(int(ev.dur))
                ET.SubElement(f, 'voice').text = str(vo.num); ET.SubElement(f, 'staff').text = vo.staff
                kids.append(f)
            else:
                kids.extend(ev.graces); kids.extend(ev.notes)
            cur = ev.end
        if k == 0:
            for t, _, e in list(pend):
                if t > cur:
                    f = ET.Element('forward'); ET.SubElement(f, 'duration').text = str(int(t - cur)); kids.append(f); cur = t
                kids.append(e)
            pend = []
    kids.extend(e for _, _, e in pend)
    kids.extend(e for _, _, e in right)
    for c in list(m): m.remove(c)
    for c in kids: m.append(c)


FLATS = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B']
FLAT_ALT = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0]
SHARPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']
SHARP_ALT = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]
LENGTHS = {Fr(1, 4), Fr(3, 8), Fr(1, 2), Fr(3, 4), Fr(1), Fr(3, 2), Fr(2), Fr(3), Fr(4)}  # written lengths you can pick


def _set_pitch(n, midi, flats):
    """The note at this MIDI pitch (spelled with flats in a flat key, else sharps); its accidental and ties go."""
    midi = max(21, min(108, int(midi)))
    pc, octave = midi % 12, midi // 12 - 1
    step, alt = (FLATS[pc], FLAT_ALT[pc]) if flats else (SHARPS[pc], SHARP_ALT[pc])
    r = n.find('rest')
    if r is not None: n.remove(r)
    p = n.find('pitch')
    if p is None: p = _put(n, ET.Element('pitch'))
    for c in list(p): p.remove(c)
    ET.SubElement(p, 'step').text = step
    if alt: ET.SubElement(p, 'alter').text = str(alt)
    ET.SubElement(p, 'octave').text = str(octave)
    for tag in ('accidental', 'tie'):
        for e in n.findall(tag): n.remove(e)
    nt = n.find('notations')
    if nt is not None:
        for e in nt.findall('tied'): nt.remove(e)
        if not len(nt): n.remove(nt)


def _set_type(n, q, div):
    """Written value of q quarters (one note value, maybe dotted)."""
    (v, ty, dots), = pieces(q)
    n.find('duration').text = str(int(q * div))
    t = n.find('type')
    if t is None: t = _put(n, ET.Element('type'))
    t.text = ty
    for d in n.findall('dot'): n.remove(d)
    for _ in range(dots): _put(n, ET.Element('dot'))
    r = n.find('rest')
    if r is not None and r.get('measure'): del r.attrib['measure']


def edit_part(root):
    """(index, part, hands): the piano part (two staves: hands = True), else the first part."""
    k, part = piano_part(root)
    if part is not None: return k, part, True
    parts = root.findall('part')
    return (0, parts[0], False) if parts else (None, None, False)


def _take_out(voices, want, to=None):
    """Take the chosen notes out of their chords; a chord with nothing left becomes a rest of its length.
    Returns [(on, dur, [notes])]. to: notes already on that staff stay."""
    taken = []
    for vo in voices:
        for ev in list(vo.evs):
            if ev.kind != 'notes' or ev.dur == 0: continue
            go = [n for n in ev.notes if id(n) in want and (to is None or _st(n) != to)]
            if not go: continue
            stay = [n for n in ev.notes if n not in go]
            for n in go: _strip_moved(n)
            taken.append((ev.on, ev.dur, go))
            vo.touched = True
            if stay:
                ev.notes = stay; _as_chord(stay)
            else:
                tm = ev.notes[0].find('time-modification')
                r = _note_el(vo.num, vo.staff, ev.dur, ET.Element('rest'))
                if ev.notes[0].find('type') is not None: _put(r, copy.deepcopy(ev.notes[0].find('type')))
                for d in ev.notes[0].findall('dot'): _put(r, copy.deepcopy(d))
                if tm is not None: _put(r, copy.deepcopy(tm))
                _put(r, ET.Element('staff')).text = vo.staff
                vo.evs[vo.evs.index(ev)] = Ev(ev.on, ev.dur, [r], 'rest', ev.graces)
    return taken


def _place(voices, taken, to, div, beat, bar_len):
    """Put taken notes on staff `to`: joined to a chord of the same time and length, into a voice resting then,
    or a new voice. Returns the notes placed."""
    placed = []
    groups = {}
    for on, dur, ns in taken:
        tm = ns[0].find('time-modification')
        groups.setdefault((on, dur, None if tm is None else ET.tostring(tm)), []).extend(ns)
    for (on, dur, _), ns in sorted(groups.items(), key=lambda x: (x[0][0], -x[0][1])):
        ns.sort(key=lambda n: _midi(n) or 0)
        placed.extend(ns)
        dest = sorted([v for v in voices if v.staff == to], key=lambda v: (len(v.num), v.num))
        hit = None
        for vo in dest:
            for ev in vo.evs:
                if ev.kind == 'notes' and ev.on == on and ev.dur == dur and ev.notes and \
                        (ev.notes[0].find('time-modification') is None) == (ns[0].find('time-modification') is None):
                    hit = (vo, ev); break
            if hit: break
        if hit:
            vo, ev = hit
            for n in ns: _set_voice(n, vo.num, vo.staff)
            ev.notes = sorted(ev.notes + ns, key=lambda n: _midi(n) or 0)
            _as_chord(ev.notes)
            vo.touched = True
            continue
        _as_chord(ns)
        chord = Ev(on, dur, ns, 'notes')
        vo = next((v for v in dest if _fill(v, on, dur)), None)
        if vo is None:
            used = {v.num for v in voices}
            num = TOP[to]
            while str(num) in used: num += 1
            vo = Voice(str(num), to)
            vo.first = 10 ** 9
            vo.evs = _rests(Fr(0), bar_len, div, beat, bar_len, vo.num, to)
            voices.append(vo)
        _put_in(vo, chord, div, beat, bar_len)
    return placed


def _lengthen(voices, want, q, div, beat, bar_len):
    """Chords picked get q quarters: shorter = a rest after; longer = over what follows in the voice (rests, or
    notes: they are written over; one only partly covered leaves a rest for the rest of it)."""
    done = []
    d = q * div
    for vo in voices:
        for ev in list(vo.evs):
            if ev.kind != 'notes' or ev.dur == 0 or not any(id(n) in want for n in ev.notes): continue
            if ev.notes[0].find('time-modification') is not None: raise HTTPException(400, 'Notes in a triplet keep their length')
            if ev.on + d > bar_len: raise HTTPException(400, 'That length does not fit in the bar')
            end, new_end = ev.end, ev.on + d
            out = []
            for x in vo.evs:
                if x is ev or x.on < end or x.on >= new_end: out.append(x); continue
                # after the chord, inside its new length: written over (what sticks out stays as a rest)
                if x.end > new_end: out.extend(_rests(new_end, x.end - new_end, div, beat, bar_len, vo.num, vo.staff))
            if new_end < end: out.extend(_rests(new_end, end - new_end, div, beat, bar_len, vo.num, vo.staff))
            ev.dur = d
            for n in ev.notes:
                _set_type(n, q, div)
                for e in n.findall('tie'): n.remove(e)
                nt = n.find('notations')
                if nt is not None:
                    for e in nt.findall('tied'): nt.remove(e)
                    if not len(nt): n.remove(nt)
            out.sort(key=lambda e: e.on)
            vo.evs = out
            vo.touched = True
            done.extend(ev.notes)
    return done


def _key_flats(part):
    """{bar index: True when the key in force has flats}."""
    out, f = {}, False
    for bi, m in enumerate(part.findall('measure')):
        for k in m.iter('key'):
            try: f = int(k.findtext('fifths') or 0) < 0
            except ValueError: pass
        out[bi] = f
    return out


def unmark(text, bars):
    """Bars looked at: out of <miscellaneous-field name="meowsic-check-bars">, and their "⚠ check" marks gone."""
    root = ET.fromstring(text.encode('utf-8'))
    bars = {int(b) for b in bars or []}
    for f in root.iter('miscellaneous-field'):
        if f.get('name') != 'meowsic-check-bars': continue
        f.text = ' '.join(b for b in (f.text or '').split() if b.isdigit() and int(b) not in bars)
    for ident in root.iter('identification'):
        for misc in ident.findall('miscellaneous'):
            for f in [f for f in misc if f.get('name') == 'meowsic-check-bars' and not (f.text or '').strip()]: misc.remove(f)
            if not len(misc): ident.remove(misc)
    for part in root.findall('part'):
        for bi, m in enumerate(part.findall('measure'), 1):
            if bi not in bars: continue
            for d in [d for d in m.findall('direction') if any('check' in (w.text or '') and '⚠' in (w.text or '') for w in d.iter('words'))]:
                m.remove(d)
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n'


def check_bars(text):
    """The bars still to check (1-based), from the MusicXML."""
    root = ET.fromstring(text.encode('utf-8'))
    for f in root.iter('miscellaneous-field'):
        if f.get('name') == 'meowsic-check-bars': return sorted({int(b) for b in (f.text or '').split() if b.isdigit()})
    return []


def use_measure(text, bar, measure_xml):
    """Bar `bar` with another reading of it put in (Check bars' preview) — exactly as barcheck.py saves it (the bar
    keeps its chord names, words and marks), and no longer to check."""
    from .barcheck import apply_check
    try: bar = int(bar)
    except (TypeError, ValueError): raise HTTPException(400, 'bar: a bar number')
    root = ET.fromstring(text.encode('utf-8'))
    if not any(m.get('number') == str(bar) for m in root.iter('measure')): raise HTTPException(400, f'No bar {bar}')
    try: ET.fromstring(str(measure_xml).encode('utf-8'))
    except ET.ParseError: raise HTTPException(400, 'The other reading is not a MusicXML bar')
    return apply_check(text, bar, 'use', str(measure_xml))


def edit(text: str, op: dict) -> tuple[str, list]:
    """One editing step -> (new MusicXML, refs of the notes it touched, in the new score). op:
      {op:'move', refs, to: 1|2}      to the upper / lower staff of the piano part
      {op:'pitch', refs, by}          semitones up (+) / down (-)
      {op:'len', refs, q}             a written length in quarters (1/16 … whole, dotted too)
      {op:'delete', refs}             gone (a rest where nothing is left)
      {op:'add', refs, by?, midi?}    a note `by` semitones (default 4) above each picked note, in its chord; a
                                      picked rest becomes a note (`midi`, default the middle of its staff)
      {op:'unmark', bars}             bars looked at (no longer to check)
      {op:'alt', bar, measure}        that bar replaced by another reading (as barcheck.py does)
    Every voice of every bar still fills it."""
    kind = op.get('op') or ('move' if 'to' in op else None)
    if kind == 'unmark': return unmark(text, op.get('bars')), []
    if kind == 'alt': return use_measure(text, op.get('bar'), op.get('measure')), []
    if kind not in ('move', 'pitch', 'len', 'delete', 'add'): raise HTTPException(400, f'Unknown edit: {kind}')
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, hands = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    if kind == 'move' and not hands: raise HTTPException(400, 'This score has no piano part with two staves')
    all_notes = list(part.iter('note'))
    want, rests = set(), set()
    for r in op.get('refs') or []:
        try: r = int(r)
        except (TypeError, ValueError): raise HTTPException(400, f'Not a note: {r}')
        if not 0 <= r < len(all_notes): raise HTTPException(400, f'No note {r} in this score')
        n = all_notes[r]
        if n.find('grace') is not None: raise HTTPException(400, f'Note {r} is a grace note')
        if n.find('rest') is not None or n.find('pitch') is None:
            if kind == 'add': rests.add(id(n)); continue
            raise HTTPException(400, f'Note {r} is a rest')
        want.add(id(n))
    if not want and not rests: raise HTTPException(400, 'Pick some notes first')
    touched = []
    flats = _key_flats(part)
    bars = part.findall('measure')
    tidy = set()  # (bar index, staff, voice) edited: beams and rests tidied after (barnorm.py)
    if kind in ('pitch', 'add'):
        by = int(op.get('by', 4 if kind == 'add' else 0) or 0)
        div = Fr(1)
        for bi, m in enumerate(bars):
            for a in m.iter('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            kids = list(m)
            for i, n in enumerate(kids):
                if n.tag != 'note': continue
                if (id(n) in want or id(n) in rests): tidy.add((bi, _st(n), _vo(n)))
                if kind == 'pitch' and id(n) in want:
                    _set_pitch(n, _midi(n) + by, flats[bi] if by >= 0 else True)
                    touched.append(n)
                elif kind == 'add' and id(n) in rests:
                    q = _dur(n) / div
                    _set_pitch(n, int(op.get('midi') or (71 if _st(n) == '1' else 50)), flats[bi])
                    if (n.find('type') is None or n.findtext('type') == '') and len(pieces(q)) == 1: _set_type(n, q, div)
                    touched.append(n)
                elif kind == 'add' and id(n) in want:  # a note `by` above it, in its chord (after the chord's last note)
                    j = i
                    while j + 1 < len(kids) and kids[j + 1].tag == 'note' and kids[j + 1].find('chord') is not None: j += 1
                    new = copy.deepcopy(n)
                    for tag in ('lyric', 'beam', 'notations', 'stem', 'chord'):
                        for e in new.findall(tag): new.remove(e)
                    _put(new, ET.Element('chord'))
                    _set_pitch(new, _midi(n) + by, flats[bi])
                    m.insert(list(m).index(kids[j]) + 1, new)
                    touched.append(new)
    else:
        to = str(op.get('to', ''))
        if kind == 'move' and to not in ('1', '2'): raise HTTPException(400, 'to: 1 (upper staff) or 2 (lower staff)')
        q = None
        if kind == 'len':
            try: q = Fr(str(op.get('q')))
            except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, 'q: a length in quarters')
            if q not in LENGTHS: raise HTTPException(400, 'Pick a written length (1/16 to a whole note)')
        div, tsig = Fr(1), (4, 4)
        for m in bars:
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            if not any(id(n) in want and (kind != 'move' or _st(n) != to) for n in m.iter('note')): continue
            if kind == 'len' and (q * div).denominator != 1: raise HTTPException(400, 'That length is too short for this score')
            beat = _beat(tsig)
            voices, other, bar_len = _read_bar(m, div)
            bar_len = bar_len or Fr(4 * tsig[0], tsig[1]) * div
            if kind == 'len':
                touched += _lengthen(voices, want, q, div, beat, bar_len)
            else:
                taken = _take_out(voices, want, to if kind == 'move' else None)
                for vo in voices:
                    if vo.touched: _normalize(vo, div, beat, bar_len)
                if kind == 'move': touched += _place(voices, taken, to, div, beat, bar_len)
            for vo in voices:
                if vo.touched: _normalize(vo, div, beat, bar_len)
            # a voice with only rests goes when its staff has another voice (the lowest number stays)
            for vo in sorted(voices, key=lambda v: (len(v.num), v.num), reverse=True):
                if vo.touched and all(e.kind != 'notes' for e in vo.evs) and any(o is not vo and o.staff == vo.staff for o in voices):
                    voices.remove(vo)
            voices.sort(key=lambda v: (v.staff, v.first))  # upper staff first, then lower, each as the bar had them
            _write_bar(m, voices, other, bar_len, div, beat)
            tidy.update((bars.index(m), vo.staff, vo.num) for vo in voices if vo.touched)
    if tidy:
        from .barnorm import normalize_bar
        div, tsig = Fr(1), (4, 4)
        for bi, m in enumerate(bars):
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            for b, st, v in sorted(tidy):
                if b == bi: normalize_bar(m, st, v, tsig, div)
    from .barnorm import tidy_score
    tidy_score(root, {(pk, b) for b, _, _ in tidy})  # no repeated time / key / clef; edited bars full
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    return out, sorted(ref[id(e)] for e in touched if id(e) in ref)


def move(text: str, refs, to) -> tuple[str, list]:
    """(new MusicXML, refs of the moved notes in it). refs: note indexes in the piano part; to: 1 (upper) or 2 (lower)."""
    return edit(text, {'op': 'move', 'refs': refs, 'to': to})


def apply_ops(text, ops):
    moved = []
    if not isinstance(ops, list): raise HTTPException(400, 'ops: a list of edits')
    for op in ops:
        if not isinstance(op, dict): raise HTTPException(400, 'ops: a list of edits')
        text, moved = edit(text, op)
    return text, moved


# ---------- the endpoints ----------

def _xml_path(cf, it):
    if it['kind'] != 'score' or not it.get('musicxml'): raise HTTPException(400, 'Not a score with MusicXML')
    p = item_dir(cf, it) / it['musicxml']
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    return p


def _sha(text):
    from .lyricsedit import sha
    return sha(text)


@router.post('/items/{item_id}/editnotes/preview')
def preview(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    text = _xml_path(cf, it).read_text(encoding='utf-8')
    root = ET.fromstring(text.encode('utf-8'))
    k, part, hands = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    out, moved = apply_ops(text, body.get('ops') or [])
    from .barnorm import tidy_score
    over = [num for _, num in tidy_score(ET.fromstring(out.encode('utf-8')))['overfull']]
    return {'xml': out, 'notes': notes(ET.fromstring(out.encode('utf-8'))), 'moved': moved, 'part': k, 'hands': hands, 'overfull': over,
            'check': check_bars(out), 'sha': _sha(text), 'changed': bool(body.get('ops'))}


def keep(d, name):
    (d / '.history').mkdir(exist_ok=True)
    rel = f'.history/notes-{now_ms()}-{name}'
    n = 1
    while (d / rel).exists(): rel = f'.history/notes-{now_ms() + n}-{name}'; n += 1
    shutil.copyfile(d / name, d / rel)
    return rel


def _what(ops):
    """What the edits did, in words (the Activities row)."""
    s = lambda n: f'{n} note{"s" if n != 1 else ""}'
    cnt = {}
    for o in ops:
        k = o.get('op') or ('move' if 'to' in o else '')
        k = f'move{o.get("to")}' if k == 'move' else k
        cnt[k] = cnt.get(k, 0) + (len(o.get('bars') or []) if k == 'unmark' else 1 if k == 'alt' else len(o.get('refs') or []))
    words = {'move1': lambda n: f'{s(n)} to the right hand', 'move2': lambda n: f'{s(n)} to the left hand',
             'pitch': lambda n: f'{s(n)} higher / lower', 'len': lambda n: f'{s(n)} longer / shorter', 'delete': lambda n: f'{s(n)} deleted',
             'add': lambda n: f'{s(n)} added', 'unmark': lambda n: f'{n} bar{"s" if n != 1 else ""} checked',
             'alt': lambda n: f'{n} bar{"s" if n != 1 else ""} from the other reading'}
    return ', '.join(words[k](n) for k, n in cnt.items() if k in words and n) or 'no notes'


def _tag(ops):
    return TAG if all((o.get('op') or 'move') == 'move' for o in ops) else TAG_EDIT


@router.post('/items/{item_id}/editnotes')
def save(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    p = _xml_path(cf, it)
    text = p.read_text(encoding='utf-8')
    if body.get('sha') and body['sha'] != _sha(text):
        raise HTTPException(409, 'This score was changed since the editor opened it — close the editor and open it again')
    ops = body.get('ops') or []
    if not ops: raise HTTPException(422, 'Nothing was changed')
    out, _ = apply_ops(text, ops)
    what = _what(ops)
    if body.get('mode') == 'new':
        t = now_ms()
        new = {'id': uid('m'), 'kind': 'score', 'title': it['title'], 'artist': it.get('artist') or '',
               'tags': [*[x for x in it.get('tags', []) if x not in (TAG, TAG_EDIT)], _tag(ops)], 'createdAt': t, 'updatedAt': t, 'originAt': t,
               'version': it.get('version') or 'original', 'source': f'From the score {_q(it["title"])}, notes edited',
               'groupId': it.get('groupId') or uid('g'), 'key': it.get('key') or '', 'bpm': it.get('bpm'), 'ai': it.get('ai') or 0,
               'sourceUrl': it.get('sourceUrl') or ''}
        if not it.get('groupId'): c.execute('UPDATE score SET group_id=? WHERE item_id=?', (new['groupId'], it['id']))
        filled = fill_from_library(c, new)  # Album (and an empty Artist) from the library; never the key
        if filled.get('artist'): out = recredit(out, new['artist'])
        write_item(c, new, new=True)
        log_fill(c, [(new, filled)])
        d = folder_path(cf, new['folder'])
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{new["folder"]}.musicxml').write_text(out, encoding='utf-8')
        c.execute('UPDATE score SET musicxml=? WHERE item_id=?', (f'{new["folder"]}.musicxml', new['id']))
        refresh_staves(c, cf, new['id'])
        aid = record_undo(c, 'edit-notes', {'op': 'created', 'ids': [new['id']], 'titles': [new['title']]},
                          f'Edited notes: {it["title"]}', f'New score, {what} (the score it came from is untouched)')
        return {'ok': True, 'mode': 'new', 'item': get_item(c, new['id']), 'activity': aid}
    d = p.parent
    hist = keep(d, p.name)
    orig = it.get('musicxmlOriginal')
    if not orig:  # like note edits: the first change keeps the untouched file ("Revert")
        orig = f'{it["folder"]} (original).musicxml'
        if not (d / orig).exists(): shutil.copyfile(p, d / orig)
    p.write_text(out, encoding='utf-8')
    c.execute('UPDATE score SET musicxml=?, musicxml_original=? WHERE item_id=?', (p.name, orig, it['id']))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    refresh_staves(c, cf, it['id'])
    aid = record_undo(c, 'edit-notes', {'op': 'musicxml', 'id': it['id'], 'title': it['title'], 'file': p.name, 'before': hist,
                                        'beforeSha': _sha(text), 'afterSha': _sha(out), 'what': 'notes were edited'},
                      f'Edited notes: {it["title"]}', f'{what}; the score before is kept in {hist}')
    return {'ok': True, 'mode': 'this', 'item': get_item(c, it['id']), 'activity': aid, 'history': hist, 'sha': _sha(out), 'check': check_bars(out)}
