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
rests joined into the largest rests that keep the beat, notes spelled by the meter; the rest / note the user just set
is kept as set unless notationally wrong) and so is the whole score (barnorm.tidy_score: no repeated time signature /
key / clef). A bar left short or over-full (Remove rest …) is never filled on its own: incomplete_bars reports it
(the preview / save answer `incomplete`; web/js/incomplete.js shows it on the score) until Fill with rest
(op fillbar) or Change time for this bar (op bartime) fixes it.

refs = indexes among the part's <note> elements (as notes() gives them). ops = [{op, refs, …}, …] applied in order
(the refs of an op are in the score as the ops before it left it).

POST /api/items/{id}/editnotes/preview  {ops} -> {xml, notes, moved, part, sha, changed}  (nothing saved)
     (with sha: the ops replay on the score as the editor opened it — editsafe.py keeps that copy)
POST /api/items/{id}/editnotes          {ops, mode: 'this'|'new', sha?, session?, xml?} -> saved like Fit lyrics (lyricsedit.py):
     'this' keeps the file before in items/<folder>/.history/notes-<ms>-<name> + an Activities 'musicxml' step;
     'new' makes a new score in the same group, tagged "Hands moved" / "Notes edited" (Undo moves it to the Trash).
     Never a dead-end 409: the score changed since the editor opened it (sha) -> the ops are merged onto the file
     now (editsafe.rebase); what can't merge is kept with the full edit as a new version "<title> (my edits)".
     The edit session's draft (editsafe.py) goes once saved.
"""
import copy
import hashlib
import json
import re
import shutil
import threading
from collections import OrderedDict
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from .autofill import fill_from_library, log_fill, recredit
from .db import folder_path, get_item, now_ms, uid, write_item
from .easerests import _beam, _beat, _put, fits, pieces
from .items import cfg, conn, item_dir, must_item
from .sheetversion import refresh_staves
from .undolog import _q, record_undo
from . import editsafe

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
    """(index, part) of the first part with two staves or more (a grand staff, or voice + piano), or (None, None)."""
    for k, p in enumerate(root.findall('part')):
        if any((a.findtext('staves') or '').strip() not in ('', '0', '1') for a in p.iter('attributes')): return k, p
    return None, None


def notes(root):
    """The notes of the part you edit (edit_part): [{ref, bar, on, dur, staff, midi, voice, rest?, tie?, slur?, fill?}]
    (fill: a rest follows it (its tied notes) straight away in its voice, for "Fill next rest"; on / dur in
    quarters, on from the start of its bar; ref = index among the part's <note>s). Rests too (rest: True, midi
    None); no grace notes."""
    k, part, _ = edit_part(root)
    if part is None: return []
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    tl = _timeline(part)
    spans = [(a[1], a[3], b[3]) for _, a, b, _, _ in _slur_spans(tl)]
    where = {id(x[0]): x for x in tl}

    def marks(e):  # tie: tied to the next note; slur: under a slur
        x = where.get(id(e))
        if x is None or x[6]: return {}
        o = {}
        if _has_tie(e, 'start'): o['tie'] = True
        if any(st == x[1] and a <= x[3] <= b for st, a, b in spans): o['slur'] = True
        return o
    out, div = [], Fr(1)
    for bi, m in enumerate(part.findall('measure')):
        t, last = Fr(0), Fr(0)
        fill = {}
        for vo in _read_bar(m, Fr(1))[0]: fill.update(fill_info(vo.evs))
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
                            **({'rest': True} if e.find('rest') is not None or e.find('pitch') is None else {}), **marks(e),
                            **({'fill': True} if id(e) in fill else {})})
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
        return self.rest and (not self.notes or (self.notes[0].find('time-modification') is None and self.notes[0].find('notations') is None))


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


def _normalize(vo, div, beat, bar_len, keep=frozenset()):
    """Rests in a row joined and written again per beat (a rest the user just set — keep: ids — stays as it is)."""
    out, run = [], None
    def flush():
        if run: out.extend(_rests(run[0], run[1], div, beat, bar_len, vo.num, vo.staff))
    for ev in vo.evs:
        if ev.plain_rest and not ev.graces and not (ev.notes and id(ev.notes[0]) in keep):
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
            if k == 0:  # a chord name inside a long note / rest: step back to its time, then on again
                for o in [o for o in pend if o[2].tag == 'harmony' and ev.on < o[0] < cur]:
                    pend.remove(o)
                    b = ET.Element('backup'); ET.SubElement(b, 'duration').text = str(int(cur - o[0])); kids.append(b)
                    kids.append(o[2])
                    f = ET.Element('forward'); ET.SubElement(f, 'duration').text = str(int(cur - o[0])); kids.append(f)
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
LENGTHS = {Fr(1, 8), Fr(3, 16), Fr(1, 4), Fr(3, 8), Fr(1, 2), Fr(3, 4), Fr(1), Fr(3, 2), Fr(2), Fr(3), Fr(4)}  # written lengths you can pick


def _set_pitch(n, midi, flats, ties=False):
    """The note at this MIDI pitch (spelled with flats in a flat key, else sharps); its accidental goes, and its
    ties unless ties=True (fix_ties checks them after the edit)."""
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
    for e in n.findall('accidental'): n.remove(e)
    if ties: return
    for e in n.findall('tie'): n.remove(e)
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


def _staves(part):
    from .barops import staves
    return staves(part)


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
            num = TOP.get(to, 4 * (int(to) - 1) + 1)
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
            for n in ev.notes: _set_type(n, q, div)  # ties stay; fix_ties drops one whose notes no longer meet
            out.sort(key=lambda e: e.on)
            vo.evs = out
            vo.touched = True
            done.extend(ev.notes)
    return done


VALUE_NAME = {Fr(4): 'whole', Fr(3): 'dotted half', Fr(2): 'half', Fr(3, 2): 'dotted quarter', Fr(1): 'quarter',
              Fr(3, 4): 'dotted 8th', Fr(1, 2): '8th', Fr(3, 8): 'dotted 16th', Fr(1, 4): '16th', Fr(3, 16): 'dotted 32nd', Fr(1, 8): '32nd'}


def value_name(q):
    q = Fr(q)
    return VALUE_NAME.get(q) or f'{float(q):g}-beat'


def _beat_no(on_q, tsig):
    b = on_q / Fr(4, tsig[1]) + 1
    return f'{int(b)}' if b.denominator == 1 else f'{float(b):g}'


def pitch_name(n):
    p = n.find('pitch')
    if p is None: return 'rest'
    alt = int(float(p.findtext('alter') or 0))
    return f'{p.findtext("step")}{"♯" * alt if alt > 0 else "♭" * -alt}{p.findtext("octave")}'


def _as_tied(vo, ev, on, total, div, tie_in=None, tie_out=None):
    """The chord ev written from `on` for `total` divisions: ev itself as the first piece (longest written values
    first; barnorm spells them by the meter after), tied copies for the rest. Its tie into it stays only when it
    still starts where it did; its tie out stays on the last piece. Returns [Ev] and the tie starts added."""
    qs = [v for v, _, _ in pieces(Fr(total) / div)]
    tie_in = {id(n): _has_tie(n, 'stop') and on == ev.on for n in ev.notes} if tie_in is None else {id(n): tie_in for n in ev.notes}
    tie_out = {id(n): _has_tie(n, 'start') for n in ev.notes} if tie_out is None else {id(n): tie_out for n in ev.notes}
    out, t, base = [], on, ev.notes
    for k, q in enumerate(qs):
        if k == 0: ns = base
        else:
            ns = [copy.deepcopy(n) for n in base]
            for n in ns:
                for tag in ('lyric', 'accidental', 'beam', 'stem'):
                    for e in n.findall(tag): n.remove(e)
                nt = n.find('notations')
                if nt is not None:
                    for c in [c for c in nt if c.tag != 'tied']: nt.remove(c)
        for j, n in enumerate(ns):
            src = base[j]
            _set_type(n, q, div)
            _drop_tie(n, 'start'); _drop_tie(n, 'stop')
            if k > 0 or tie_in[id(src)]: _add_tie(n, 'stop')
            if k < len(qs) - 1 or tie_out[id(src)]: _add_tie(n, 'start')
        out.append(Ev(t, q * div, ns, 'notes', ev.graces if k == 0 else []))
        t += q * div
    return out, (len(qs) - 1) * len(ev.notes)


def _relen_rest(vo, ev, q, div, beat, bar_len, tsig, pull, took):
    """A rest picked gets q quarters. Shorter: the time freed is a rest after it (pull: the rest of the voice comes
    earlier, the rest goes at its end). Longer: it takes the time from what follows in the voice — rests, then
    notes (a note only partly covered keeps its end, shortened; one covered goes; took gets each). Returns the
    tie starts added."""
    if ev.notes[0].find('time-modification') is not None: raise HTTPException(400, 'Rests in a triplet keep their length')
    d = q * div
    if ev.on + d > bar_len:
        room = (bar_len - ev.on) / div
        raise HTTPException(400, f'Too long for the bar: a {value_name(q)} rest from beat {_beat_no(ev.on / div, tsig)} '
                                 f'runs past the bar line — there is room for a {value_name(room)} rest there')
    end, new_end, added = ev.end, ev.on + d, 0
    if new_end < end:
        freed = end - new_end
        if pull:
            vend = max(x.end for x in vo.evs)
            for x in vo.evs:
                if x is not ev and x.on >= end: x.on -= freed
            tail = _rests(vend - freed, freed, div, beat, bar_len, vo.num, vo.staff)
        else: tail = _rests(new_end, freed, div, beat, bar_len, vo.num, vo.staff)
        vo.evs = sorted(vo.evs + tail, key=lambda e: e.on)
    elif new_end > end:
        out = []
        for x in vo.evs:
            if x is ev or x.on < end or x.on >= new_end: out.append(x); continue
            if x.end <= new_end:  # covered: goes
                if x.kind == 'notes' and x.dur > 0:
                    took.append({'notes': x.notes, 'was': Fr(x.dur) / div, 'now': Fr(0), 'on': Fr(x.on) / div,
                                 'lyrics': sum(len(n.findall('lyric')) for n in x.notes)})
                continue
            rem = x.end - new_end
            if x.kind == 'rest': out.extend(_rests(new_end, rem, div, beat, bar_len, vo.num, vo.staff)); continue
            if x.kind == 'gap': x.on, x.dur = new_end, rem; out.append(x); continue
            if x.dur == 0 or x.notes[0].find('time-modification') is not None or not fits(rem / div, div):
                took.append({'notes': x.notes, 'was': Fr(x.dur) / div, 'now': Fr(0), 'on': Fr(x.on) / div,
                             'lyrics': sum(len(n.findall('lyric')) for n in x.notes)})
                out.extend(_rests(new_end, rem, div, beat, bar_len, vo.num, vo.staff)); continue
            took.append({'notes': x.notes, 'was': Fr(x.dur) / div, 'now': rem / div, 'on': Fr(x.on) / div, 'lyrics': 0})
            evs, n_add = _as_tied(vo, x, new_end, rem, div, tie_in=False)
            out.extend(evs); added += n_add
        vo.evs = sorted(out, key=lambda e: e.on)
    ev.dur = d
    _set_type(ev.notes[0], q, div)
    vo.touched = True
    return added


def fill_info(evs):
    """{id(note): True} for each chord whose tied chain (inside the bar) is followed straight away by a rest."""
    out = {}
    for i, e in enumerate(evs):
        if e.kind != 'notes' or e.dur == 0: continue
        j = _chain_end(evs, i)
        if j + 1 < len(evs) and evs[j + 1].kind == 'rest' and evs[j + 1].on == evs[j].end:
            for n in e.notes: out[id(n)] = True
    return out


def _chain_end(evs, i):
    """Index of the last event of the tied chain starting at evs[i] (same pitches, tied, back to back)."""
    pit = lambda e: sorted(_midi(n) or 0 for n in e.notes)
    j = i
    while j + 1 < len(evs):
        x, y = evs[j], evs[j + 1]
        if not (y.kind == 'notes' and y.dur > 0 and y.on == x.end and pit(y) == pit(x)
                and all(_has_tie(n, 'start') for n in x.notes) and all(_has_tie(n, 'stop') for n in y.notes)): break
        j += 1
    return j


def _fill_next(vo, ev, div):
    """The chord ev (with the notes tied on from it in the bar) takes in the one rest right after it. Never a note.
    Returns the tie starts added (+) / taken away (−)."""
    i = vo.evs.index(ev)
    j = _chain_end(vo.evs, i)
    nxt = vo.evs[j + 1] if j + 1 < len(vo.evs) else None
    if nxt is None or nxt.on != vo.evs[j].end:
        raise HTTPException(400, 'No rest after this note: it lasts to the end of the bar')
    if nxt.kind != 'rest': raise HTTPException(400, 'No rest after this note to fill')
    if ev.notes[0].find('time-modification') is not None: raise HTTPException(400, 'Notes in a triplet keep their length')
    total = nxt.end - ev.on
    if not fits(total / div, div): raise HTTPException(400, 'That length cannot be written in this score')
    chain = vo.evs[i:j + 1]
    byp = lambda ns: sorted(ns, key=lambda n: _midi(n) or 0)
    tail = lambda n: [c for c in (n.find('notations') if n.find('notations') is not None else [])
                      if c.tag == 'fermata' or (c.tag == 'slur' and c.get('type') == 'stop')]
    marks = {} if len(chain) == 1 else {k: tail(n) for k, n in enumerate(byp(chain[-1].notes))}
    evs, added = _as_tied(vo, ev, ev.on, total, div, tie_out=False)
    for k, cs in marks.items():  # the old last piece's slur stop / fermata: on the new last piece
        tgt = byp(evs[-1].notes)[k]
        for c in cs: _notations(tgt).append(c)
    vo.evs = vo.evs[:i] + evs + vo.evs[j + 2:]
    vo.touched = True
    return added - (len(chain) - 1) * len(ev.notes)


def _close_gap(vo, ev, div, beat, bar_len):
    """Remove rest: what follows it in the voice comes earlier by its length. The bar is left short (never filled
    on its own: incomplete_bars shows it, with Fill with rest / Change time for this bar)."""
    if ev.notes[0].find('time-modification') is not None: raise HTTPException(400, 'Rests in a triplet stay')
    after = [x for x in vo.evs if x is not ev and x.on >= ev.end]
    if not any(x.kind == 'notes' and x.dur for x in after):
        raise HTTPException(400, 'Nothing after this rest in its bar to move up')
    for x in after: x.on -= ev.dur
    vo.evs = [x for x in vo.evs if x is not ev]
    vo.touched = True


def _fill_from_before(vo, ev, div):
    """Remove rest: the note (tied chain) right before it takes its time (Fill next rest from that note)."""
    i = vo.evs.index(ev)
    if i == 0 or vo.evs[i - 1].kind != 'notes' or not vo.evs[i - 1].dur or vo.evs[i - 1].end != ev.on:
        raise HTTPException(400, 'No note right before this rest to fill it')
    j = i - 1
    while j > 0 and vo.evs[j - 1].kind == 'notes' and _chain_end(vo.evs, j - 1) >= i - 1: j -= 1
    first = vo.evs[j]
    return first, _fill_next(vo, first, div)


def _split_ev(ev, segs, div):
    """ev (a chord or rest) written as tied pieces over segs = [(bar key, local onset, length)] (divisions): the
    first piece is ev itself (lyrics, marks), the others copies with nothing but the tie; the tie into ev stays on
    the first piece, its tie out on the last. Returns [(bar key, Ev)]."""
    lens = [(k, on + sum(v * div for v, _, _ in pieces(Fr(d) / div)[:p]), v * div)
            for k, on, d in segs for p, (v, _, _) in enumerate(pieces(Fr(d) / div))]
    if ev.kind == 'gap': return [(k, Ev(on, d, [], 'gap')) for k, on, d in lens]
    if ev.kind == 'rest':
        out = []
        for i, (k, on, d) in enumerate(lens):
            n = ev.notes[0] if i == 0 else copy.deepcopy(ev.notes[0])
            _set_type(n, Fr(d) / div, div)
            out.append((k, Ev(on, d, [n], 'rest')))
        return out
    tie_in = [_has_tie(n, 'stop') for n in ev.notes]
    tie_out = [_has_tie(n, 'start') for n in ev.notes]
    out = []
    for i, (k, on, d) in enumerate(lens):
        if i == 0: ns = ev.notes
        else:
            ns = [copy.deepcopy(n) for n in ev.notes]
            for n in ns:
                for tag in ('lyric', 'accidental', 'beam', 'stem'):
                    for e in n.findall(tag): n.remove(e)
                nt = n.find('notations')
                if nt is not None:
                    for c in [c for c in nt if c.tag != 'tied']: nt.remove(c)
        for j, n in enumerate(ns):
            _set_type(n, Fr(d) / div, div)
            _drop_tie(n, 'start'); _drop_tie(n, 'stop')
            if i > 0 or tie_in[j]: _add_tie(n, 'stop')
            if i < len(lens) - 1 or tie_out[j]: _add_tie(n, 'start')
        out.append((k, Ev(on, d, ns, 'notes', ev.graces if i == 0 else [])))
    return out


def _ripple(part, rest_el):
    """Remove rest + pull notes from the next bars: in the rest's staff / voice, everything after it comes earlier
    by its length across the bar lines (notes over a bar line tied), up to the last bar the voice has in a row; that
    bar ends with the rest's time as a rest. Returns ({bar index}, staff, voice, tie starts added)."""
    bars = part.findall('measure')
    div, tsig, info = Fr(1), (4, 4), []
    for m in bars:
        for a in m.findall('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            tm = a.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        info.append((div, tsig))
    bi = next(k for k, m in enumerate(bars) if any(n is rest_el for n in m.iter('note')))
    st, vn = _st(rest_el), _vo(rest_el)
    rows, off, evs = [], Fr(0), []
    for k in range(bi, len(bars)):
        dv, ts = info[k]
        if dv != info[bi][0]: break
        voices, other, longest = _read_bar(bars[k], dv)
        vo = next((v for v in voices if v.staff == st and v.num == vn), None)
        if vo is None: break
        L = Fr(4 * ts[0], ts[1]) * dv
        rows.append((k, voices, other, vo, off, L, ts))
        evs += [(off + e.on, e) for e in vo.evs]
        off += L
    div = info[bi][0]
    rest = next(e for _, e in evs if e.notes and e.notes[0] is rest_el)
    r_on = next(a for a, e in evs if e is rest)
    if len(rows) < 2: raise HTTPException(400, 'No bar after this one to pull notes from')
    flat, end = [], off
    for a, e in evs:
        if e is rest: continue
        flat.append((a - rest.dur if a > r_on else a, e))
    flat.append((end - rest.dur, Ev(Fr(0), rest.dur, [rest_el], 'rest')))
    per = {k: [] for k, *_ in rows}
    added = 0
    for a, e in flat:
        segs, t, left = [], a, e.dur
        for k, _, _, _, o, L, _ in rows:
            if left <= 0: break
            if t >= o + L or t < o: continue
            d = min(left, o + L - t)
            segs.append((k, t - o, d)); t += d; left -= d
        if len(segs) > 1 and e.notes and e.notes[0].find('time-modification') is not None:
            raise HTTPException(400, 'A triplet would cross the bar line')
        if e.kind == 'rest' and len(segs) == 1 and len(pieces(Fr(segs[0][2]) / div)) == 1:
            e.on = segs[0][1]; per[segs[0][0]].append(e); continue
        if e.kind == 'notes' and len(segs) == 1 and segs[0][2] == e.dur:
            e.on = segs[0][1]; per[segs[0][0]].append(e); continue
        if any(not fits(Fr(d) / div, div) for _, _, d in segs): raise HTTPException(400, 'Those lengths cannot be written across the bar line')
        got = _split_ev(e, segs, div)
        if e.kind == 'notes': added += (len(got) - 1) * len(e.notes)
        for k, x in got: per[k].append(x)
    for k, voices, other, vo, o, L, ts in rows:
        vo.evs = sorted(per[k], key=lambda x: x.on)
        vo.touched = True
        _normalize(vo, div, _beat(ts), L)
        voices.sort(key=lambda v: (v.staff, v.first))
        _write_bar(bars[k], voices, other, L, div, _beat(ts))
    return {k for k, *_ in rows}, st, vn, added


def delete_bar(root, bi):
    """The bar bi goes from every part (barops.delete_bar: key, time, clef, tempo and layout go on to the next bar;
    the closing bar line stays); the bars after it are numbered again. Edits use bar_op (ties, slurs, bars to check)."""
    from .barops import _renumber, delete_bar as _delete
    parts = root.findall('part')
    if not parts or not 0 <= bi < len(parts[0].findall('measure')): raise HTTPException(400, 'No such bar')
    _delete(root, bi)
    _renumber(root)


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
    return _check_of(ET.fromstring(text.encode('utf-8')))


def _check_of(root):
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


# ---------- ties and slurs (kept through every edit) ----------
# A tie joins a note to the next note of the same pitch that starts where it ends (same staff, else any staff);
# after every edit the ties are checked again: one whose pitches or times no longer meet is dropped (the editor
# says so). A slur hangs on its start and stop notes; when one of them goes (deleted, written over), it moves to
# the nearest note left on that staff (start: the next one, stop: the one before).

def _timeline(part):
    """[(note, staff, voice, on, end, midi, rest)] for every non-grace <note> of the part, times in quarters
    from the start of the part."""
    out, div, off = [], Fr(1), Fr(0)
    for m in part.findall('measure'):
        fast = _timeline_bar(m, div, off, out)  # whole numbers of divisions: no Fraction per note (the usual case)
        if fast is not None:
            div, longest = fast
            off += longest
            continue
        t = last = longest = Fr(0)
        for e in m:
            if e.tag == 'attributes' and e.findtext('divisions'): div = Fr(int(float(e.findtext('divisions'))))
            elif e.tag == 'backup': t -= _dur(e) / div
            elif e.tag == 'forward': t += _dur(e) / div; longest = max(longest, t)
            elif e.tag == 'note':
                if e.find('grace') is not None: continue
                d = _dur(e) / div
                chord = e.find('chord') is not None
                at = last if chord else t
                if not chord: last, t = t, t + d
                longest = max(longest, t)
                rest = e.find('rest') is not None or e.find('pitch') is None
                out.append((e, _st(e), _vo(e), off + at, off + at + d, None if rest else _midi(e), rest))
        off += longest
    return out


def _timeline_bar(m, div, off, out):
    """_timeline for one bar in whole divisions -> (divisions, bar length in quarters), the entries appended to out;
    None (out untouched) when <divisions> changes after the bar's first note or a duration is not a whole number."""
    rows, t = [], 0
    last = longest = 0
    seen = False
    for e in m:
        tag = e.tag
        if tag == 'note':
            if e.find('grace') is not None: continue
            seen = True
            dt = e.findtext('duration') or 0
            try: d = int(dt)
            except ValueError: return None
            chord = e.find('chord') is not None
            at = last if chord else t
            if not chord: last, t = t, t + d
            if t > longest: longest = t
            rest = e.find('rest') is not None or e.find('pitch') is None
            rows.append((e, at, d, rest))
        elif tag == 'backup' or tag == 'forward':
            try: d = int(e.findtext('duration') or 0)
            except ValueError: return None
            if tag == 'backup': t -= d
            else:
                t += d
                if t > longest: longest = t
        elif tag == 'attributes' and e.findtext('divisions'):
            if seen or t: return None
            div = Fr(int(float(e.findtext('divisions'))))
    cache = {}
    def q(x):
        v = cache.get(x)
        if v is None: v = cache[x] = off + Fr(x) / div
        return v
    for e, at, d, rest in rows:
        out.append((e, _st(e), _vo(e), q(at), q(at + d), None if rest else _midi(e), rest))
    return div, Fr(longest) / div


def _has_tie(n, kind):
    return any(x.get('type') == kind for x in n.findall('tie')) or any(x.get('type') == kind for x in n.findall('notations/tied'))


def _drop_tie(n, kind):
    for x in [x for x in n.findall('tie') if x.get('type') == kind]: n.remove(x)
    nt = n.find('notations')
    if nt is not None:
        for x in [x for x in nt.findall('tied') if x.get('type') == kind]: nt.remove(x)
        if not len(nt) and not nt.attrib: n.remove(nt)


def _notations(n):
    nt = n.find('notations')
    return nt if nt is not None else _put(n, ET.Element('notations'))


def _add_tie(n, kind):
    if not any(x.get('type') == kind for x in n.findall('tie')): _put(n, ET.Element('tie', type=kind))
    nt = _notations(n)
    if not any(x.get('type') == kind for x in nt.findall('tied')): nt.append(ET.Element('tied', type=kind))


def _partner_index(tl):
    """A function: entry -> the next same-pitch note starting where it ends (same staff first), or None."""
    by_staff, by_time = {}, {}
    for x in tl:
        if x[6] or x[5] is None: continue
        by_staff.setdefault((x[1], x[3], x[5]), x); by_time.setdefault((x[3], x[5]), x)
    def nxt(x):
        if x[6] or x[5] is None: return None
        return by_staff.get((x[1], x[4], x[5])) or by_time.get((x[4], x[5]))
    return nxt


def _tie_count(part): return sum(_has_tie(x[0], 'start') for x in _timeline(part))


_JUMP_WORDS = re.compile(r'\bD\.\s*[SC]\.|\bD\s?[SC]\b|dal\s+segno|da\s+capo|to\s+coda', re.I)


def _jumps(part):
    """(source bars, target bars): bars ending in a jump (D.S., D.C., To Coda, a backward repeat) and bars a jump
    lands on (the first bar, a segno, a coda, a forward repeat), as measure indexes."""
    src, tgt = set(), {0}
    for k, m in enumerate(part.iter('measure')):
        for snd in m.iter('sound'):
            if any(snd.get(a) for a in ('dalsegno', 'dacapo', 'tocoda')): src.add(k)
            if snd.get('segno') or snd.get('coda'): tgt.add(k)
        if any(_JUMP_WORDS.search(w.text or '') for w in m.iter('words')): src.add(k)
        if m.find('.//segno') is not None or m.find('.//coda') is not None: tgt.add(k)
        for r in m.findall('barline/repeat'):
            (src if r.get('direction') == 'backward' else tgt).add(k)
    return src, tgt


def _jump_ties(part, tl):
    """{id(start note): stop entry} for ties over a jump: a tie start on a note ending its bar where the bar jumps
    (D.S. ...) and a same-pitch tie stop on a note starting a bar the jump lands on (a segno ...)."""
    src, tgt = _jumps(part)
    if not src: return {}
    bar = {id(n): k for k, m in enumerate(part.iter('measure')) for n in m.iter('note')}
    lo, hi = {}, {}
    for x in tl:
        k = bar.get(id(x[0]))
        lo[k] = min(lo.get(k, x[3]), x[3]); hi[k] = max(hi.get(k, x[4]), x[4])
    stops = {}
    for x in tl:
        k = bar.get(id(x[0]))
        if k in tgt and x[3] == lo[k] and x[5] is not None and _has_tie(x[0], 'stop'): stops.setdefault(x[5], []).append(x)
    out = {}
    for x in tl:
        k = bar.get(id(x[0]))
        if k in src and x[4] == hi[k] and x[5] is not None and _has_tie(x[0], 'start') and stops.get(x[5]):
            st = stops[x[5]]
            out[id(x[0])] = next((y for y in st if y[1] == x[1]), st[0])  # same staff first
    return out


def fix_ties(part):
    """Every tie start joined to its partner (a stop added there when missing); a start with no partner and a stop
    with no start go. A tie over a jump (a start ending a D.S. / D.C. / To Coda / repeat bar, its stop at the segno,
    coda or repeat start, same pitch) is kept as it is. Returns how many ties went: the starts or the stops dropped,
    whichever are more (a stop can go while its start finds another partner)."""
    tl = _timeline(part)
    nxt = _partner_index(tl)
    jump = _jump_ties(part, tl)
    ok, gone, stops = set(), 0, 0
    for x in tl:
        if not _has_tie(x[0], 'start'): continue
        p = nxt(x)
        j = jump.get(id(x[0]))
        if j is not None:
            ok.add(id(j[0]))
            if p is None or p[0] is x[0] or not _has_tie(p[0], 'stop'): continue  # the tie goes over the jump only
        if p is None or p[0] is x[0]: _drop_tie(x[0], 'start'); gone += 1; continue
        _add_tie(p[0], 'stop'); ok.add(id(p[0]))
    for x in tl:
        if _has_tie(x[0], 'stop') and id(x[0]) not in ok: _drop_tie(x[0], 'stop'); stops += 1
    return max(gone, stops)


def ties_gone(before, part, dropped):
    """tiesGone for the preview: tie starts fewer than before, or the tie marks fix_ties dropped (a stop can go while
    its start finds another partner), whichever is more."""
    return max(0, before - _tie_count(part), dropped)


def _tie_chain(part, want):
    """want (ids) with every note tied to them (both ways), so a pitch change keeps the tie."""
    tl = _timeline(part)
    nxt = _partner_index(tl)
    fwd, back = {}, {}
    for x in tl:
        if _has_tie(x[0], 'start'):
            p = nxt(x)
            if p is not None and _has_tie(p[0], 'stop'): fwd[id(x[0])] = p[0]; back[id(p[0])] = x[0]
    out, todo = set(want), list(want)
    while todo:
        k = todo.pop()
        for n in (fwd.get(k), back.get(k)):
            if n is not None and id(n) not in out: out.add(id(n)); todo.append(id(n))
    return out


def _slur_mark(part):
    """Each slur gets a temporary id: {id: (type, staff, on, copy)}."""
    snap = {}
    for x in _timeline(part):
        for s in x[0].findall('notations/slur'):
            k = str(len(snap)); s.set('msid', k)
            c = copy.deepcopy(s); del c.attrib['msid']
            snap[k] = (s.get('type'), x[1], x[3], c)
    return snap


def _slur_spans(tl):
    """[(number, start entry, stop entry, start el, stop el)]: slurs matched by number in time order."""
    ev = []
    for x in tl:
        for s in x[0].findall('notations/slur'):
            if s.get('type') in ('start', 'stop'): ev.append((x[3], 0 if s.get('type') == 'stop' else 1, x, s))
    ev.sort(key=lambda e: (e[0], e[1]))
    open_, out = {}, []
    for _, _, x, s in ev:
        num = s.get('number') or '1'
        if s.get('type') == 'start': open_[num] = (x, s)
        elif num in open_:
            a, sa = open_.pop(num)
            out.append((num, a, x, sa, s))
    return out


def _unslur(pairs):
    for n, s in pairs:
        nt = n.find('notations')
        if nt is None or s not in list(nt): continue
        nt.remove(s)
        if not len(nt) and not nt.attrib: n.remove(nt)


def fix_slurs(part, snap):
    """Slurs whose start / stop note went: put on the nearest note left on that staff; a slur left on one chord
    goes; the temporary ids go."""
    tl = _timeline(part)
    have = {s.get('msid') for x in tl for s in x[0].findall('notations/slur')}
    notes_ = [x for x in tl if not x[6]]
    for k, (kind, staff, t, el) in snap.items():
        if k in have: continue
        same = [x for x in notes_ if x[1] == staff] or notes_
        if not same: continue
        if kind == 'start':
            after = [x for x in same if x[3] >= t]
            tgt = min(after, key=lambda x: x[3]) if after else max(same, key=lambda x: x[3])
        else:
            before = [x for x in same if x[3] <= t]
            tgt = max(before, key=lambda x: x[3]) if before else min(same, key=lambda x: x[3])
        _notations(tgt[0]).append(el)
    for x in tl:
        for s in x[0].findall('notations/slur'): s.attrib.pop('msid', None)
    for num, a, b, sa, sb in _slur_spans(_timeline(part)):
        if a[3] == b[3]: _unslur([(a[0], sa), (b[0], sb)])  # start and stop on one chord: no slur left


def _slur_op(part, want, on, nxt_note=False, start_only=False):
    """Add a slur over the picked notes (first to last; one note + nxt_note: to the next note on its staff), or
    take away every slur over a picked note. Returns the notes it touched."""
    tl = _timeline(part)
    picked = [x for x in tl if id(x[0]) in want and not x[6]]
    if not on:
        hit = []
        for num, a, b, sa, sb in _slur_spans(tl):
            if any(p[0] is a[0] for p in picked) if start_only else any(p[1] in (a[1], b[1]) and a[3] <= p[3] <= b[3] for p in picked):
                _unslur([(a[0], sa), (b[0], sb)]); hit += [a[0], b[0]]
        if not hit: raise HTTPException(400, 'Those notes have no slur')
        return hit
    if nxt_note and len({p[3] for p in picked}) == 1:
        p = picked[0]
        after = [x for x in tl if not x[6] and x[1] == p[1] and x[3] >= p[4]]
        if not after: raise HTTPException(400, 'No note after it to slur to')
        picked.append(min(after, key=lambda x: x[3]))
    if len({p[3] for p in picked}) < 2: raise HTTPException(400, 'Pick two or more notes for a slur (Shift-click or drag a box)')
    a = min(picked, key=lambda x: (x[3], -(x[5] or 0)))
    b = max(picked, key=lambda x: (x[3], x[5] or 0))
    used = {num for num, s, e, _, _ in _slur_spans(tl) if s[3] <= b[3] and e[3] >= a[3]}
    num = next(str(k) for k in range(1, 9) if str(k) not in used)
    _notations(a[0]).append(ET.Element('slur', type='start', number=num, placement='above' if a[1] == '1' else 'below'))
    _notations(b[0]).append(ET.Element('slur', type='stop', number=num))
    return [a[0], b[0]]


def _tie_op(part, want):
    """Toggle a tie from each picked note to the next note of the same pitch."""
    tl = _timeline(part)
    nxt = _partner_index(tl)
    done = []
    for x in tl:
        if id(x[0]) not in want or x[6]: continue
        if _has_tie(x[0], 'start'):
            _drop_tie(x[0], 'start'); done.append(x[0]); continue
        p = nxt(x)
        if p is None:
            raise HTTPException(400, 'The next note is not the same pitch: a tie joins two notes of one pitch. Use Slur for different notes.')
        _add_tie(x[0], 'start'); _add_tie(p[0], 'stop'); done += [x[0], p[0]]
    return done


def edit(text: str, op: dict) -> tuple[str, list]:
    """One editing step -> (new MusicXML, refs of the notes it touched, in the new score). op:
      {op:'move', refs, to: 1|2}      to the upper / lower staff of the piano part
      {op:'pitch', refs, by}          semitones up (+) / down (-)
      {op:'len', refs, q, pull?}      a written length in quarters (1/32 … whole, dotted too), notes or rests;
                                      a rest made shorter leaves a rest after it (pull: the notes after it come
                                      earlier instead); made longer it takes the time of what follows (rests,
                                      notes: shortened or gone — preview's `took`); too long for the bar: refused
      {op:'fill', refs}               each picked note takes in the one rest right after it (never a note)
      {op:'restdel', refs, how}       a rest removed: how 'close' (default: what follows comes earlier, the bar is
                                      left short — incomplete_bars), 'fill' (the note before takes its time) or
                                      'ripple' (close + the next bars' notes pulled earlier over the bar lines)
      {op:'delbar', bar}              bar (0-based) deleted from every part (a whole-bar rest's "Delete this bar")
      {op:'fillbar', bar}             a short bar: rests to its end (every voice)
      {op:'bartime', bar}             a short / long bar gets a time signature of its own length (3/4, 2/4, 5/8 …);
                                      the next bar gets the time back, so only that bar changes
      {op:'delete', refs}             gone (a rest where nothing is left)
      {op:'add', refs, by?, midi?}    a note `by` semitones (default 4) above each picked note, in its chord; a
                                      picked rest becomes a note (`midi`, default the middle of its staff)
      {op:'unmark', bars}             bars looked at (no longer to check)
      {op:'alt', bar, measure}        that bar replaced by another reading (as barcheck.py does)
      {op:'tie', refs}                a tie from each picked note to the next one of its pitch (tied already: off)
      {op:'slur', refs, next?}        a slur from the first picked note to the last (one note + next: to the next)
      {op:'unslur', refs, at?}        every slur over a picked note goes (at 'start': only the slurs starting on it —
                                      a slur clicked on the score)
      {op:'set', refs, midis}         the picked note / chord / rest takes exactly these pitches (noteset.py)
      {op:'shift', refs, bar, on, by?} the picked notes dragged to another beat (onto rests; swap with a chord of
                                      the same length) and `by` semitones (dragops.py)
      {op:'even', refs}               2+ notes / rests one after the other in one voice: one length each, the same
                                      total (dotted 8th + 16th → two 8ths); no plain / dotted value: refused (evenops.py)
      {op:'ottava', staff, from_bar, to_bar, shift, from_beat?, to_beat?}  an 8va (8) / 8vb (-8) / 15ma / 15mb line over those bars of a
                                      staff (from_beat / to_beat: from / before a beat inside the bar), 0: off (octaveops.py); the pitches stay (MusicXML pitch = what sounds)
      {op:'unpedal', staff?}          every pedal mark ("Ped." / *) off, or only on that staff (pedalops.py)
    Every voice of every bar still fills it. Ties and slurs stay (fix_ties / fix_slurs)."""
    out, touched, _ = edit_ex(text, op)
    return out, touched


def edit_ex(text: str, op: dict, info=None):
    """edit() -> (text, touched refs, how many ties went because their notes no longer meet). info (a dict) gets
    took: [{bar, beat, what, was, now, lyrics}] notes a longer rest took time from (now 0: gone), tookRefs: the
    shortened ones in the new score, said: [words] when a length picked was written another way by the meter."""
    info = {} if info is None else info
    kind = op.get('op') or ('move' if 'to' in op else None)
    if kind == 'unmark': return unmark(text, op.get('bars')), [], 0
    if kind == 'alt': return use_measure(text, op.get('bar'), op.get('measure')), [], 0
    if kind == 'lyrics':  # Lyrics mode (lyricmode.js): only <lyric> elements change
        from .lyricsedit import set_lyrics
        return set_lyrics(text, op), [], 0
    from .barops import OPS as BAR_OPS, bar_op
    if kind in BAR_OPS: return bar_op(text, op)  # Bar ▾: clear / add a hand in a bar, insert / delete bars, add / remove staves
    from .rangeops import OPS as RANGE_OPS, range_op
    if kind in RANGE_OPS: return range_op(text, op, info)  # copy / cut / paste / Repeat, respelling, accidentals
    from .structops import OPS as STRUCT_OPS, struct_op
    if kind in STRUCT_OPS: return struct_op(text, op, info)  # pickup, key / time from here, repeats, endings
    from .chordops import OPS as CHORD_OPS, chord_op
    if kind in CHORD_OPS: return chord_op(text, op, info)  # chord names, Realize to left hand
    if kind == 'ottava':  # an 8va / 8vb line over bars of a staff: only the drawing changes (octaveops.py)
        from .octaveops import ottava_op
        return ottava_op(text, op, info)
    if kind == 'unpedal':  # every pedal mark off (pedalops.py)
        from .pedalops import unpedal_op
        return unpedal_op(text, op, info)
    if kind == 'shift':  # a note dragged to another beat (dragops.py)
        from .dragops import shift_op
        return shift_op(text, op, info)
    if kind == 'even':  # picked notes made one length each, the same total (evenops.py)
        from .evenops import even_op
        return even_op(text, op, info)
    if kind in ('fillbar', 'bartime'): return _bar_op(text, kind, op, info), [], 0
    if kind not in ('move', 'pitch', 'len', 'fill', 'restdel', 'delete', 'add', 'tie', 'slur', 'unslur', 'set'): raise HTTPException(400, f'Unknown edit: {kind}')
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
            if kind in ('add', 'len', 'restdel', 'set'): rests.add(id(n)); continue
            raise HTTPException(400, 'No rest after this note to fill' if kind == 'fill' else f'Note {r} is a rest')
        if kind == 'restdel': raise HTTPException(400, 'Pick a rest to remove')
        want.add(id(n))
    if not want and not rests: raise HTTPException(400, 'Pick some notes first')
    how = op.get('how') or 'close'
    if kind == 'restdel' and how not in ('close', 'fill', 'ripple'): raise HTTPException(400, 'how: close, fill or ripple')
    ties_before = _tie_count(part)
    if kind in ('tie', 'slur', 'unslur'):
        touched = _tie_op(part, want) if kind == 'tie' else _slur_op(part, want, kind == 'slur', bool(op.get('next')), op.get('at') == 'start')
        fix_ties(part)
        ET.indent(root, space='  ')
        ref = {id(e): i for i, e in enumerate(part.iter('note'))}
        return _head(text) + ET.tostring(root, encoding='unicode') + '\n', sorted({ref[id(e)] for e in touched if id(e) in ref}), 0
    if kind == 'pitch': want = _tie_chain(part, want)  # a tied note and its partners change together
    if kind == 'delete':  # one note written as tied pieces in its bar (the meter's spelling) goes as a whole
        bar_of = {id(n): k for k, m in enumerate(part.findall('measure')) for n in m.iter('note')}
        bars_picked = {bar_of[i] for i in want}
        want = {i for i in _tie_chain(part, want) if bar_of.get(i) in bars_picked}
    snap = _slur_mark(part)
    touched = []
    flats = _key_flats(part)
    bars = part.findall('measure')
    tidy = set()  # (bar index, staff, voice) edited: beams and rests tidied after (barnorm.py)
    keep = set()  # what the user just set: barnorm never joins / spells it again (unless notationally wrong)
    took, added = [], 0
    if kind == 'restdel' and how == 'ripple':
        if len(rests) != 1: raise HTTPException(400, 'Pull notes from the next bar: one rest at a time')
        el = next(n for n in all_notes if id(n) in rests)
        done, st, vn, added = _ripple(part, el)
        tidy.update((b, st, vn) for b in done)
    elif kind == 'set':
        from .noteset import set_op
        touched, tidy = set_op(part, want, rests, op.get('midis'))
    elif kind in ('pitch', 'add'):
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
                    _set_pitch(n, _midi(n) + by, flats[bi] if by >= 0 else True, ties=True)
                    touched.append(n)
                elif kind == 'add' and id(n) in rests:
                    q = _dur(n) / div
                    if op.get('midi'): mid = int(op['midi'])
                    else:  # the middle of its staff as drawn (under an 8va line: an octave up)
                        from .octaveops import shift_at
                        mid = (71 if _st(n) == "1" else 50) + shift_at(part, bi, _st(n), n)
                    _set_pitch(n, mid, flats[bi])
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
        if kind == 'move' and not (to.isdigit() and 1 <= int(to) <= max(2, _staves(part))): raise HTTPException(400, 'to: a staff of the part (1 = the top one)')
        q = None
        if kind == 'len':
            try: q = Fr(str(op.get('q')))
            except (TypeError, ValueError, ZeroDivisionError): raise HTTPException(400, 'q: a length in quarters')
            if q not in LENGTHS: raise HTTPException(400, 'Pick a written length (32nd to a whole note)')
            from .divisions import fit_divisions
            fit_divisions(root, [q])  # a 32nd in a score counted in 16ths: finer <divisions> first (divisions.py)
        div, tsig = Fr(1), (4, 4)
        for m in bars:
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
            if not any((id(n) in want or id(n) in rests) and (kind != 'move' or _st(n) != to) for n in m.iter('note')): continue
            if kind == 'len' and (q * div).denominator != 1: raise HTTPException(400, 'That length is too short for this score')
            beat = _beat(tsig)
            voices, other, bar_len = _read_bar(m, div)
            bar_len = bar_len or Fr(4 * tsig[0], tsig[1]) * div
            if kind == 'len':
                if want:
                    touched += _lengthen(voices, want, q, div, beat, bar_len)
                    keep.update(want)
                for vo in voices:
                    for ev in [e for e in vo.evs if e.kind == 'rest' and e.notes and id(e.notes[0]) in rests]:
                        if ev not in vo.evs: continue
                        t0 = len(took)
                        added += _relen_rest(vo, ev, q, div, beat, bar_len, tsig, bool(op.get('pull')), took)
                        for x in took[t0:]: x['bar'], x['tsig'] = bars.index(m), tsig
                        touched.append(ev.notes[0]); keep.add(id(ev.notes[0]))
            elif kind == 'restdel':
                for vo in voices:
                    for ev in sorted([e for e in vo.evs if e.kind == 'rest' and e.notes and id(e.notes[0]) in rests], key=lambda e: -e.on):
                        if how == 'close': _close_gap(vo, ev, div, beat, bar_len)
                        else:
                            first, a = _fill_from_before(vo, ev, div)
                            added += a; touched.extend(first.notes)
            elif kind == 'fill':
                for vo in voices:
                    for ev in [e for e in vo.evs if e.kind == 'notes' and e.dur and any(id(n) in want for n in e.notes)]:
                        if ev in vo.evs: added += _fill_next(vo, ev, div); touched.extend(ev.notes)
            else:
                taken = _take_out(voices, want, to if kind == 'move' else None)
                for vo in voices:
                    if vo.touched: _normalize(vo, div, beat, bar_len)
                if kind == 'move': touched += _place(voices, taken, to, div, beat, bar_len)
            for vo in voices:
                if vo.touched: _normalize(vo, div, beat, bar_len, keep)
            # a voice with only rests goes when its staff has another voice (the lowest number stays)
            for vo in sorted(voices, key=lambda v: (len(v.num), v.num), reverse=True):
                if vo.touched and all(e.kind != 'notes' for e in vo.evs) and any(o is not vo and o.staff == vo.staff for o in voices):
                    voices.remove(vo)
            voices.sort(key=lambda v: (v.staff, v.first))  # upper staff first, then lower, each as the bar had them
            _write_bar(m, voices, other, bar_len, div, beat)
            tidy.update((bars.index(m), vo.staff, vo.num) for vo in voices if vo.touched)
    nb = {}
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
                if b == bi:
                    s0 = len(nb.get('split', []))
                    normalize_bar(m, st, v, tsig, div, keep=keep, info=nb)
                    for a, qq, ps, what in nb.get('split', [])[s0:]:
                        info.setdefault('said', []).append(
                            f'Bar {bi + 1}: a {value_name(qq)} {what} on beat {_beat_no(a, tsig)} is written as '
                            + ' + '.join(value_name(x) for x in ps) + (' rests' if what == 'rest' else ' (tied)')
                            + ' to keep the beat readable')
    from .barnorm import tidy_score
    tidy_score(root)  # no repeated time / key / clef (a bar left short is shown as such, never filled: incomplete_bars)
    fix_slurs(part, snap)
    dropped = fix_ties(part)
    if tidy and kind in ('pitch', 'add', 'set', 'move'):  # accidentals where the bar needs them, redundant ones gone
        from .rangeops import tidy_accidentals
        tidy_accidentals(part, {b for b, _, _ in tidy})
    gone = ties_gone(ties_before + added + nb.get('ties', 0), part, dropped)
    ET.indent(root, space='  ')
    out = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    ref = {id(e): i for i, e in enumerate(part.iter('note'))}
    if took:
        info['took'] = [{'bar': x['bar'] + 1, 'beat': _beat_no(x['on'], x['tsig']), 'what': '+'.join(pitch_name(n) for n in x['notes']),
                         'was': float(x['was']), 'now': float(x['now']), 'lyrics': x['lyrics']} for x in took]
        info['tookRefs'] = sorted(ref[id(n)] for x in took if x['now'] for n in x['notes'] if id(n) in ref)
    return out, sorted(ref[id(e)] for e in touched if id(e) in ref), gone


def move(text: str, refs, to) -> tuple[str, list]:
    """(new MusicXML, refs of the moved notes in it). refs: note indexes in the piano part; to: 1 (upper) or 2 (lower)."""
    return edit(text, {'op': 'move', 'refs': refs, 'to': to})


# The editor sends every edit so far on each preview (its undo steps are prefixes of one list), so the score after
# each prefix is kept here: a new edit replays only itself, not the whole list. Key: a hash chain over the file's
# text and the ops (edit_ex is a pure function of text + op); value: (text, moved, tiesGone, info) after that op.
_STEPS = OrderedDict()
_STEPS_MAX = 48  # at most 48 copies of a score in memory (a long score: ~20 MB)
_STEPS_LOCK = threading.Lock()


def _chain(text, ops):
    h, out = hashlib.sha1(text.encode('utf-8')).digest(), []
    for op in ops:
        h = hashlib.sha1(h + json.dumps(op, sort_keys=True, separators=(',', ':'), default=str).encode('utf-8')).digest()
        out.append(h)
    return out


def apply_ops(text, ops, info=None):
    """All the edits in order -> (text, refs the last one touched). info (a dict) gets tiesGone: ties the last
    edit had to drop (their notes no longer meet). The longest prefix of ops worked out before (_STEPS) is reused."""
    moved, gone, last = [], 0, {}
    if not isinstance(ops, list) or not all(isinstance(op, dict) for op in ops): raise HTTPException(400, 'ops: a list of edits')
    keys, start = _chain(text, ops), 0
    with _STEPS_LOCK:
        for k in range(len(ops), 0, -1):
            hit = _STEPS.get(keys[k - 1])
            if hit is not None:
                _STEPS.move_to_end(keys[k - 1])
                text, moved, gone, last, start = hit[0], list(hit[1]), hit[2], copy.deepcopy(hit[3]), k
                break
    for k in range(start, len(ops)):
        last = {}
        text, moved, gone = edit_ex(text, ops[k], last)
        with _STEPS_LOCK:
            _STEPS[keys[k]] = (text, tuple(moved), gone, copy.deepcopy(last))
            while len(_STEPS) > _STEPS_MAX: _STEPS.popitem(last=False)
    if info is not None: info.update(last); info['tiesGone'] = gone
    return text, moved


def incomplete_bars(root):
    """Bars of the edit part where a voice does not fill the time signature: [{bar (1-based), have, need (quarters),
    words: '2 of 4 beats'}]. The first bar when short (a pickup) and bars marked implicit are not counted."""
    k, part, _ = edit_part(root)
    if part is None: return []
    out, div, tsig = [], Fr(1), (4, 4)
    for bi, m in enumerate(part.findall('measure')):
        for a in m.findall('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
            tm = a.find('time')
            if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                tsig = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4))
        if m.get('implicit') == 'yes': continue
        voices, _, _ = _read_bar(m, div)
        ends = [Fr(v.evs[-1].end) / div for v in voices if v.evs and any(e.kind != 'gap' for e in v.evs)]
        if not ends: continue
        L = Fr(4 * tsig[0], tsig[1])
        over, short = max(ends), min(ends)
        if over > L: have = over
        elif short < L and not (bi == 0 and over < L): have = short
        else: continue
        unit = Fr(4, tsig[1])
        out.append({'bar': bi + 1, 'have': float(have), 'need': float(L), 'over': have > L,
                    'words': f'{float(have / unit):g} of {tsig[0]} beats'})
    return out


def _time_for(q):
    """A time signature for a bar of q quarters: 3/4, 2/4, 5/8, 7/16 …"""
    q = Fr(q)
    if q.denominator == 1: return int(q), 4
    if (q * 2).denominator == 1: return int(q * 2), 8
    if (q * 4).denominator == 1: return int(q * 4), 16
    return int(q * 8), 32


def _bar_op(text, kind, op, info):
    """delbar / fillbar / bartime on bar op['bar'] (0-based)."""
    from .barnorm import tidy_score
    root = ET.fromstring(text.encode('utf-8'))
    pk, part, _ = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    try: bi = int(op.get('bar'))
    except (TypeError, ValueError): raise HTTPException(400, 'bar: a bar number')
    bars = part.findall('measure')
    if not 0 <= bi < len(bars): raise HTTPException(400, 'No such bar')
    if kind == 'delbar':
        delete_bar(root, bi)
    elif kind == 'fillbar':
        st = tidy_score(root, {(pk, bi)}, whole=True)
        if not st['filled']: raise HTTPException(400, 'Nothing to fill: the bar is full (or longer than its time)')
    else:
        div, tsig, tm_el = Fr(1), (4, 4), None
        for m in bars[:bi + 1]:
            for a in m.findall('attributes'):
                if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
                tm = a.find('time')
                if tm is not None and (tm.findtext('beats') or '').strip().isdigit():
                    tsig, tm_el = (int(tm.findtext('beats')), int(tm.findtext('beat-type') or 4)), tm
        voices, _, _ = _read_bar(bars[bi], div)
        ends = [Fr(v.evs[-1].end) / div for v in voices if v.evs]
        if not ends: raise HTTPException(400, 'This bar is empty')
        q, L = max(ends), Fr(4 * tsig[0], tsig[1])
        if q == L and min(ends) == L: raise HTTPException(400, 'This bar is complete already')
        if q == L: raise HTTPException(400, 'The bar is as long as its time: fill it with rests instead')
        beats, bt = _time_for(q)
        old = copy.deepcopy(tm_el) if tm_el is not None else ET.fromstring('<time><beats>4</beats><beat-type>4</beat-type></time>')
        for p in root.findall('part'):
            ms = p.findall('measure')
            if bi >= len(ms): continue
            new = ET.Element('time'); ET.SubElement(new, 'beats').text = str(beats); ET.SubElement(new, 'beat-type').text = str(bt)
            _put_time(ms[bi], new)
            if bi + 1 < len(ms) and not any(a.find('time') is not None for a in ms[bi + 1].findall('attributes')):
                _put_time(ms[bi + 1], copy.deepcopy(old))
        tidy_score(root, {(pk, bi)}, whole=True)  # a voice shorter than the new length: rests to its end
        info.setdefault('said', []).append(f'Bar {bi + 1} is in {beats}/{bt} now; bar {bi + 2} goes back to {tsig[0]}/{tsig[1]}'
                                           if bi + 1 < len(bars) else f'Bar {bi + 1} is in {beats}/{bt} now')
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n'


def _put_time(m, time_el):
    """The bar's own time signature (in its first <attributes>, made when it has none)."""
    from .barnorm import _sort_attrs
    a = m.find('attributes')
    if a is None or [c.tag for c in m].index('attributes') > min([i for i, c in enumerate(m) if c.tag == 'note'] or [0]):
        a = ET.Element('attributes'); m.insert(0, a)
    for t in a.findall('time'): a.remove(t)
    a.append(time_el)
    _sort_attrs(a)


# ---------- the endpoints ----------

def _xml_path(cf, it):
    if it['kind'] != 'score' or not it.get('musicxml'): raise HTTPException(400, 'Not a score with MusicXML')
    p = item_dir(cf, it) / it['musicxml']
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    return p


def _sha(text):
    from .lyricsedit import sha
    return sha(text)


def _text_for(cf, it, body):
    """The text the editor's ops are made on: the score as it opened it (body.sha; editsafe keeps a copy), so an
    edit by another client meanwhile never shifts the notes under the user's edits. No sha: the file now."""
    text = _xml_path(cf, it).read_text(encoding='utf-8')
    want = body.get('sha')
    if not want or want == _sha(text):
        if not body.get('ops'): editsafe.keep_base(cf, it['id'], text)
        return text
    old = editsafe.base_text(cf, it, want)
    if old is None: raise HTTPException(409, 'The score as the editor opened it is no longer on the Mac — your edits are kept as a draft; open Edit notes again to restore them')
    return old


@router.post('/items/{item_id}/editnotes/preview')
def preview(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    text = _text_for(cf, it, body)
    root = ET.fromstring(text.encode('utf-8'))
    k, part, hands = edit_part(root)
    if part is None: raise HTTPException(400, 'This score has no notes')
    info = {}
    out, moved = apply_ops(text, body.get('ops') or [], info)
    from .barnorm import tidy_score
    ro = ET.fromstring(out.encode('utf-8'))  # one parse for every answer (tidy_score last: it may drop repeated attributes)
    ns, inc, chk = notes(ro), incomplete_bars(ro), _check_of(ro)
    over = [num for _, num in tidy_score(ro)['overfull']]
    return {'xml': out, 'notes': ns, 'moved': moved, 'part': k, 'hands': hands, 'overfull': over,
            'check': chk, 'sha': _sha(text), 'changed': bool(body.get('ops')), 'tiesGone': info['tiesGone'],
            'took': info.get('took', []), 'tookRefs': info.get('tookRefs', []), 'said': info.get('said', []),
            'incomplete': inc}


@router.post('/items/{item_id}/editnotes/clip')
def clip(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """Copy: {ops, start, end, staves} -> {clip} (rangeops.clip_of) from the score as the edits so far leave it."""
    from .rangeops import clip_of
    it = must_item(c, item_id)
    text = _text_for(cf, it, body)
    out, _ = apply_ops(text, body.get('ops') or [])
    return {'clip': clip_of(out, body.get('start'), body.get('end'), body.get('staves'))}


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
        cnt[k] = cnt.get(k, 0) + (len(o.get('bars') or []) if k == 'unmark' else 1 if k in ('alt', 'delbar', 'fillbar', 'bartime', 'clearbar', 'addhand', 'insbar', 'addstaff', 'delstaff', 'clear', 'paste', 'pickup', 'keysig', 'timesig', 'repeat', 'ending', 'chord', 'movechords', 'realize', 'clef', 'ottava', 'unpedal') else len(o.get('refs') or []))
    words = {'move1': lambda n: f'{s(n)} to the right hand', 'move2': lambda n: f'{s(n)} to the left hand', 'move3': lambda n: f'{s(n)} to staff 3',
             'pitch': lambda n: f'{s(n)} higher / lower', 'len': lambda n: f'{n} note{"s" if n != 1 else ""} / rest{"s" if n != 1 else ""} longer / shorter',
             'fill': lambda n: f'{s(n)} filled into the rest after', 'restdel': lambda n: f'{n} rest{"s" if n != 1 else ""} removed',
             'delbar': lambda n: f'{n} bar{"s" if n != 1 else ""} deleted', 'fillbar': lambda n: f'{n} short bar{"s" if n != 1 else ""} filled with rests',
             'bartime': lambda n: f'{n} bar{"s" if n != 1 else ""} given {"their" if n != 1 else "its"} own time signature', 'delete': lambda n: f'{s(n)} deleted',
             'add': lambda n: f'{s(n)} added', 'unmark': lambda n: f'{n} bar{"s" if n != 1 else ""} checked',
             'alt': lambda n: f'{n} bar{"s" if n != 1 else ""} from the other reading',
             'tie': lambda n: f'{n} tie{"s" if n != 1 else ""} changed', 'slur': lambda n: f'{n} slur{"s" if n != 1 else ""} added',
             'unslur': lambda n: f'{n} slur{"s" if n != 1 else ""} removed',
             'clearbar': lambda n: f'{n} bar{"s" if n != 1 else ""} cleared on one staff', 'addhand': lambda n: f'{n} bar{"s" if n != 1 else ""} given a staff',
             'insbar': lambda n: f'{n} empty bar{"s" if n != 1 else ""} added',
             'addstaff': lambda n: f'{n} staff added' if n == 1 else f'{n} staves added', 'delstaff': lambda n: f'{n} staff removed' if n == 1 else f'{n} staves removed',
             'set': lambda n: f'{s(n)} played in',
             'even': lambda n: f'{s(n)} evened out',
             'clear': lambda n: f'{n} stretch{"es" if n != 1 else ""} cut', 'paste': lambda n: f'{n} paste{"s" if n != 1 else ""}',
             'respell': lambda n: f'{s(n)} spelled another way', 'accidental': lambda n: f'{s(n)} given an accidental',
             'courtesy': lambda n: f'{n} courtesy accidental{"s" if n != 1 else ""} changed',
             'pickup': lambda n: 'the pickup changed', 'keysig': lambda n: f'{n} key change{"s" if n != 1 else ""}',
             'timesig': lambda n: f'{n} time change{"s" if n != 1 else ""}', 'repeat': lambda n: f'{n} repeat sign{"s" if n != 1 else ""} changed',
             'ending': lambda n: f'{n} ending{"s" if n != 1 else ""} changed', 'clef': lambda n: f'{n} clef change{"s" if n != 1 else ""}',
             'ottava': lambda n: f'{n} octave line{"s" if n != 1 else ""} (8va / 8vb) changed',
             'unpedal': lambda n: 'pedal marks removed',
             'chord': lambda n: f'{n} chord name{"s" if n != 1 else ""} changed', 'movechords': lambda n: 'chord names moved to another part', 'realize': lambda n: f'left hand written from the chords{f" ({n} times)" if n != 1 else ""}'}
    verses = sorted({str(o.get('verse') or '1') for o in ops if o.get('op') == 'lyrics'}, key=lambda v: (len(v), v))
    out = [words[k](n) for k, n in cnt.items() if k in words and n] + ([f'lyrics of verse{"s" if len(verses) > 1 else ""} {", ".join(verses)}'] if verses else [])
    return ', '.join(out) or 'no notes'


def _tag(ops):
    if all(o.get('op') == 'lyrics' for o in ops): return 'Lyrics added'  # lyricsfit.TAG: words only
    return TAG if all((o.get('op') or 'move') == 'move' for o in ops) else TAG_EDIT


def _save_new(c, cf, it, out, ops, what, title=None, source=None, detail=None):
    """A new score in the same group as `it` -> (item, activity id)."""
    t = now_ms()
    new = {'id': uid('m'), 'kind': 'score', 'title': title or it['title'], 'artist': it.get('artist') or '',
           'tags': [*[x for x in it.get('tags', []) if x not in (TAG, TAG_EDIT)], _tag(ops)], 'createdAt': t, 'updatedAt': t, 'originAt': t,
           'version': it.get('version') or 'original', 'source': source or f'From the score {_q(it["title"])}, notes edited',
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
                      f'Edited notes: {new["title"]}', detail or f'New score, {what} (the score it came from is untouched)')
    return get_item(c, new['id']), aid


def _save_this(c, cf, it, p, text, out, what):
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
    return hist, aid


@router.post('/items/{item_id}/editnotes')
def save(item_id: str, request: Request, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """{ops, mode, sha?, session?, xml?}. When the file changed since the editor opened it (sha), nothing is refused:
    the ops are replayed on the file as it is now (editsafe.rebase) and saved ("merged with a newer change"); ops
    that can't apply are left out there, and the whole edited score is kept as a new version "<title> (my edits)"."""
    it = must_item(c, item_id)
    p = _xml_path(cf, it)
    text = p.read_text(encoding='utf-8')
    ops = body.get('ops') or []
    if not ops: raise HTTPException(422, 'Nothing was changed')
    session = body.get('session') or request.headers.get(editsafe.HEADER)
    stale = bool(body.get('sha')) and body['sha'] != _sha(text)
    base = text
    if stale:
        base = editsafe.base_text(cf, it, body['sha'])
    if base is not None: full, _ = apply_ops(base, ops)  # the score exactly as the user saw it in the editor
    elif isinstance(body.get('xml'), str) and body['xml'].lstrip().startswith('<'): full = body['xml']
    else: raise HTTPException(409, 'The score as the editor opened it is no longer on the Mac, so the edits could not be replayed. Nothing was lost: they are kept as a draft in this browser — open Edit notes again to restore them')
    what = _what(ops)
    done = lambda j: (editsafe.drop_draft(cf, it['id'], session) if session and re.match(r'^[A-Za-z0-9_-]{4,64}$', session) else None, j)[1]
    if body.get('mode') == 'new':
        item, aid = _save_new(c, cf, it, full, ops, what, detail=f'New score, {what} (the score it came from is untouched)' + (' · made from the score as the editor opened it (it was changed meanwhile)' if stale else ''))
        return done({'ok': True, 'mode': 'new', 'item': item, 'activity': aid, 'incomplete': incomplete_bars(ET.fromstring(full.encode('utf-8')))})
    if not stale:
        hist, aid = _save_this(c, cf, it, p, text, full, what)
        return done({'ok': True, 'mode': 'this', 'item': get_item(c, it['id']), 'activity': aid, 'history': hist, 'sha': _sha(full), 'check': check_bars(full),
                     'incomplete': incomplete_bars(ET.fromstring(full.encode('utf-8')))})
    # changed meanwhile: merge
    merged, applied, failed = editsafe.rebase(base, text, ops) if base is not None else (text, [], [(i, 'the score before is gone') for i in range(len(ops))])
    out = {'ok': True, 'mode': 'this', 'merged': True, 'applied': len(applied), 'failed': len(failed)}
    if applied:
        hist, aid = _save_this(c, cf, it, p, text, merged, f'{_what([ops[i] for i in applied])} (merged with a newer change)')
        out.update(activity=aid, history=hist)
    final = merged if applied else text
    if failed:
        copy_item, caid = _save_new(c, cf, it, full, ops, what, title=f'{it["title"]} (my edits)',
                                    source=f'From the score {_q(it["title"])}: your edits in full (that score was changed meanwhile)',
                                    detail=f'Your edits in full ({what}), kept as a new version because the score was changed meanwhile and {len(failed)} of {len(ops)} edits could not be merged')
        out.update(copy=copy_item, copyActivity=caid)
        out['message'] = (f'This score was changed meanwhile. {len(applied)} of {len(ops)} edits were merged into it; '
                          f'all your edits are also kept in full as "{copy_item["title"]}".') if applied else \
                         (f'This score was changed meanwhile and your edits could not be merged into it — they are kept in full as "{copy_item["title"]}". This score is unchanged.')
    else: out['message'] = 'Saved — merged with a newer change to this score.'
    out.update(item=get_item(c, it['id']), sha=_sha(final), check=check_bars(final), incomplete=incomplete_bars(ET.fromstring(final.encode('utf-8'))))
    return done(out)
