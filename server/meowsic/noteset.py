"""Edit notes: {op:'set', refs, midis} — the picked note / chord / rest takes exactly these pitches (a MIDI keyboard
played in the editor, web/js/midiedit.js). staffmove.edit_ex calls set_op; the bar rebuild, tidying, ties and
slurs after it are staffmove's own.

  - refs: notes of one chord (one onset of one voice), or one rest;
  - midis: MIDI note numbers (one = a note, several = a chord);
  - the picked notes take the pitches (lowest to lowest); more pitches than picked notes → the rest join the chord;
    fewer → the extra picked notes go (the chord's first note, which holds lyrics and slurs, always stays);
  - a rest becomes a note (a chord) of the same length;
  - a tied note takes its tie partners along (the tie stays);
  - spelling: the key's sharps or flats (no key: B♭ and E♭, else sharps).
"""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

from fastapi import HTTPException


def _fifths(part):
    """{bar index: fifths of the key in force}."""
    out, f = {}, 0
    for bi, m in enumerate(part.findall('measure')):
        for k in m.iter('key'):
            try: f = int(k.findtext('fifths') or 0)
            except ValueError: pass
        out[bi] = f
    return out


def flats_for(fifths, midi):
    """Spell this pitch with a flat? A flat key: yes; a sharp key: no; C major / A minor: B♭ and E♭ only."""
    if fifths < 0: return True
    if fifths > 0: return False
    return int(midi) % 12 in (3, 10)


def set_op(part, want, rests, midis):
    """-> (touched notes, {(bar index, staff, voice)} to tidy). want / rests: ids of the picked notes / rests."""
    from .easerests import pieces
    from .staffmove import _dur, _midi, _put, _set_pitch, _set_type, _st, _tie_chain, _vo
    try: midis = sorted({max(21, min(108, int(x))) for x in midis or []})
    except (TypeError, ValueError): raise HTTPException(400, 'midis: MIDI note numbers')
    if not midis: raise HTTPException(400, 'midis: at least one MIDI note number')
    keys = _fifths(part)
    picked, where = [], None
    div = Fr(1)
    for bi, m in enumerate(part.findall('measure')):
        for a in m.iter('attributes'):
            if a.findtext('divisions'): div = Fr(int(float(a.findtext('divisions'))))
        kids = list(m)
        for i, n in enumerate(kids):
            if n.tag != 'note' or (id(n) not in want and id(n) not in rests): continue
            j = i  # the chord's first note
            while j > 0 and kids[j].find('chord') is not None: j -= 1
            head = kids[j]
            if where is None: where = (bi, m, head, div)
            elif where[2] is not head: raise HTTPException(400, 'Pick one note, chord or rest to play into')
            picked.append(n)
    if where is None: raise HTTPException(400, 'Pick some notes first')
    bi, m, head, div = where
    fifths = keys.get(bi, 0)
    if head.find('rest') is not None or head.find('pitch') is None:  # a rest → a note, its length kept
        q = _dur(head) / div
        _set_pitch(head, midis[0], flats_for(fifths, midis[0]))
        if (head.find('type') is None or head.findtext('type') == '') and len(pieces(q)) == 1: _set_type(head, q, div)
        picked = [head]
        chain = {}
    else:
        # the chord's first note always stays; the others picked stay lowest first while there are pitches
        others = sorted((n for n in picked if n is not head), key=_midi)
        keep = ([head] if head in picked else []) + others
        drop = keep[len(midis):] if len(keep) > len(midis) else []
        keep = keep[:len(midis)]
        for n in drop: m.remove(n)
        picked = sorted(keep, key=_midi)
        # each kept note's tie partners move with it
        notes_by_id = {id(e): e for e in part.iter('note')}
        chain = {id(n): [notes_by_id[k] for k in _tie_chain(part, {id(n)}) if k != id(n) and k in notes_by_id] for n in picked}
    touched = []
    for n, mi in zip(picked, midis):
        for p in chain.get(id(n), []):
            _set_pitch(p, mi, flats_for(fifths, mi), ties=True)
            touched.append(p)
        _set_pitch(n, mi, flats_for(fifths, mi), ties=True)
        touched.append(n)
    # more pitches than notes: the rest join the chord, after its last note
    last = picked[-1] if picked else head
    kids = list(m)
    k = kids.index(head)
    while k + 1 < len(kids) and kids[k + 1].tag == 'note' and kids[k + 1].find('chord') is not None: k += 1
    after = kids[k]
    for mi in midis[len(picked):]:
        new = copy.deepcopy(last)
        for tag in ('lyric', 'beam', 'notations', 'stem', 'chord', 'tie'):
            for e in new.findall(tag): new.remove(e)
        _put(new, ET.Element('chord'))
        _set_pitch(new, mi, flats_for(fifths, mi))
        m.insert(list(m).index(after) + 1, new)
        after = new
        touched.append(new)
    return touched, {(bi, _st(head), _vo(head))}
