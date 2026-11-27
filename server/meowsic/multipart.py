"""Edit notes on a score of several parts (a voice part + a piano part …): every part's notes can be picked and
edited at once, like the staves of one part (no part switch).

The editor sees one list of staves: the parts' staves in score order (voice = staff 1, piano = staves 2–3), and one
list of notes: ref = part index × REF_PART + the note's index in its part, `part` = the part index (notes_all).
An op from the editor (global refs / staves) is split by part (split_op): each piece runs on its own part
(staffmove.using_part), one after the other, and the whole is still one op = one undo step. Ops with no notes or
staff (bars, key, time, repeats, chord names …) run as before (on the piano part / the whole score).
A score with one part is unchanged (plain refs, no `part`)."""
import xml.etree.ElementTree as ET

from fastapi import HTTPException

REF_PART = 100000


def layout(root):
    """[(part id, first staff - 1, staves)] of every part, in score order (None when the score has one part)."""
    from .barops import staves
    parts = root.findall('part')
    if len(parts) < 2: return None
    out, off = [], 0
    for k, p in enumerate(parts):
        n = staves(p)
        out.append((p.get('id') or str(k), off, n))
        off += n
    return out


def notes_all(root, lay):
    """Every part's notes (staffmove.notes of each), refs and staves made global."""
    from .staffmove import notes, using_part
    out = []
    for k, (pid, off, _) in enumerate(lay):
        with using_part(pid):
            for n in notes(root):
                n['ref'] += k * REF_PART
                n['staff'] += off
                n['part'] = k
                out.append(n)
    return out


def _part_of_staff(lay, s):
    try: s = int(s)
    except (TypeError, ValueError): raise HTTPException(400, 'staff: a staff number')
    for k, (_, off, n) in enumerate(lay):
        if off < s <= off + n: return k, s - off
    raise HTTPException(400, 'No such staff')


def split_op(op, lay):
    """[(part index, the op for that part)] — None when the op is not about notes or staves (run as it is)."""
    kind = op.get('op')
    if isinstance(op.get('refs'), list) and op['refs']:
        by = {}
        for r in op['refs']:
            try: r = int(r)
            except (TypeError, ValueError): raise HTTPException(400, f'Not a note: {r}')
            by.setdefault(r // REF_PART, []).append(r % REF_PART)
        out = []
        for k, refs in sorted(by.items()):
            if not 0 <= k < len(lay): raise HTTPException(400, f'No note {k * REF_PART + refs[0]} in this score')
            sub = {**op, 'refs': refs}
            if kind == 'move' and 'to' in op:
                kk, to = _part_of_staff(lay, op['to'])
                if kk != k: raise HTTPException(400, 'Notes move between the staves of one part (the hands), not to another part')
                sub['to'] = to
            out.append((k, sub))
        return out
    if kind == 'lyrics':
        k, s = _part_of_staff(lay, op.get('staff') or 1)
        ns = []
        for x in op.get('notes') or []:
            try: r = int(x.get('ref'))
            except (TypeError, ValueError, AttributeError): raise HTTPException(400, 'Each syllable needs the ref of its note')
            if r // REF_PART != k: raise HTTPException(400, 'Words go on the notes of one staff')
            ns.append({**x, 'ref': r % REF_PART})
        return [(k, {**op, 'staff': s, 'notes': ns})]
    if isinstance(op.get('staves'), list) and len(op['staves']) == 2:  # a window (clear) over staves s0..s1
        s0, s1 = (int(x) for x in op['staves'])
        out = []
        for k, (_, off, n) in enumerate(lay):
            a, b = max(s0, off + 1), min(s1, off + n)
            if a <= b: out.append((k, {**op, 'staves': [a - off, b - off]}))
        return out or None
    if kind in ('clearbar', 'addhand', 'clef', 'ottava', 'paste', 'delstaff') and op.get('staff') is not None:
        k, s = _part_of_staff(lay, op['staff'])
        return [(k, {**op, 'staff': s})]
    if kind == 'addstaff' and op.get('at') is not None:
        at = int(op['at'])
        for k, (_, off, n) in enumerate(lay):
            if off < at <= off + n + 1: return [(k, {**op, 'at': at - off})]
        k, (_, off, n) = len(lay) - 1, lay[-1]
        return [(k, {**op, 'at': n + 1})]
    return None


def run(text, op, info, edit_one):
    """The op on a score of several parts (edit_one = staffmove._edit_ex): split by part, each piece in turn.
    -> (text, touched refs (global), ties gone)."""
    from .staffmove import using_part
    lay = layout(ET.fromstring(text.encode('utf-8')))
    pieces = split_op(op, lay) if lay else None
    if not pieces: return edit_one(text, op, info)
    moved, gone = [], 0
    for k, sub in pieces:
        part_info = {}
        with using_part(lay[k][0]):
            text, m, g = edit_one(text, sub, part_info)
        moved += [k * REF_PART + r for r in m]
        gone += g or 0
        for key, v in part_info.items():
            if key == 'tookRefs': info.setdefault('tookRefs', []).extend(k * REF_PART + r for r in v)
            elif isinstance(v, list): info.setdefault(key, []).extend(v)
            else: info[key] = v
    return text, moved, gone
