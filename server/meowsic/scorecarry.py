"""Carry the words of one MusicXML onto the notes of another (same song, the notes may differ).

Used by "Revert note edits" (items.revert_musicxml): the notes go back to "<id> (original).musicxml", but lyrics,
chord symbols, the "check lyrics" bar marks and the title / credits of the file now are kept. Also keeps the header
on an Edit-notes save (items.put_musicxml: the page sends the drawn copy, whose credits are the display ones).

Matching is per part (by id, else by position), bar (by position) and staff: each syllable goes to the note of its
staff with the same start in the bar, else the nearest free one after the one before it (a merged / removed note's
syllable moves to the note that is left); a syllable with no note left in its bar is dropped (counted).
"""
import copy
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

CHECK = '⚠ check lyrics'  # lyricsfit.CHECK (not imported: numpy)

HEAD_TOP = ('work', 'movement-number', 'movement-title', 'identification')


def _root(text):
    try: r = ET.fromstring(text.encode('utf-8'))
    except ET.ParseError: return None
    return r if r.tag == 'score-partwise' else None


def _head(text: str) -> str:
    i = text.find('<score-partwise')
    return text[:i] if i > 0 else '<?xml version="1.0" encoding="UTF-8"?>\n'


def _out(text, root):
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n'


def _staff(e): return (e.findtext('staff') or '1').strip()
def _voice(e): return (e.findtext('voice') or '1').strip()


def _walk(part):
    """[(measure, [(element, onset in quarters)])] — every child with the time it sits at."""
    out, div = [], Fr(1)
    for m in part.findall('measure'):
        t, last, evs = Fr(0), Fr(0), []
        for e in m:
            if e.tag == 'attributes' and e.findtext('divisions'):
                try: div = Fr(e.findtext('divisions').strip()) or Fr(1)
                except ValueError: pass
            d = Fr(e.findtext('duration') or 0) / div if e.findtext('duration') else Fr(0)
            if e.tag == 'note':
                if e.find('chord') is not None: evs.append((e, last)); continue
                evs.append((e, t)); last = t
                if e.find('grace') is None: t += d
            elif e.tag == 'backup': t -= d
            elif e.tag == 'forward': evs.append((e, t)); t += d
            else:
                off = Fr(e.findtext('offset') or 0) / div if e.tag in ('harmony', 'direction') and e.findtext('offset') else Fr(0)
                evs.append((e, t + off))
        out.append((m, evs))
    return out


def _heads(evs):
    """The notes a syllable / chord can sit on: sounding, not grace, not a chord's lower member."""
    return [(e, t) for e, t in evs if e.tag == 'note' and e.find('rest') is None and e.find('grace') is None and e.find('chord') is None]


def _pairs(sroot, droot):
    sp, dp = sroot.findall('part'), droot.findall('part')
    by_id = {p.get('id'): p for p in dp}
    return [(s, by_id.get(s.get('id')) if s.get('id') in by_id else (dp[k] if k < len(dp) else None)) for k, s in enumerate(sp)]


def _insert_lyric(note, ly):
    from .lyricsedit import _insert
    _insert(note, ly, (ly.get('number') or '1').strip())


def carry_header(sroot, droot):
    """droot gets sroot's work / movement title / identification / credits."""
    for e in [e for e in droot if e.tag in HEAD_TOP or e.tag == 'credit']: droot.remove(e)
    top = [copy.deepcopy(e) for e in sroot if e.tag in HEAD_TOP]
    for k, e in enumerate(top): droot.insert(k, e)
    kids = list(droot)
    at = next((k for k, e in enumerate(kids) if e.tag == 'part-list'), len(kids))
    for k, e in enumerate([copy.deepcopy(e) for e in sroot if e.tag == 'credit']): droot.insert(at + k, e)


def carry(src_text: str, dst_text: str, header=True, lyrics=True, chords=True):
    """(dst_text with src's words, report {syllables, placed, moved, dropped, chords, chordsPlaced}). Not MusicXML → dst as is."""
    sroot, droot = _root(src_text), _root(dst_text)
    rep = {'syllables': 0, 'placed': 0, 'moved': 0, 'dropped': 0, 'chords': 0, 'chordsPlaced': 0}
    if sroot is None or droot is None: return dst_text, rep
    if header: carry_header(sroot, droot)
    for sp, dp in _pairs(sroot, droot):
        if dp is None: continue
        sw, dw = _walk(sp), _walk(dp)
        if lyrics:
            for e in dp.iter('note'):
                for ly in e.findall('lyric'): e.remove(ly)
        if chords:
            for m in dp.findall('measure'):
                for h in m.findall('harmony'): m.remove(h)
                for d in m.findall('direction'):
                    if any((w.text or '') == CHECK for w in d.iter('words')): m.remove(d)
        dw = _walk(dp)
        for k, (sm, sevs) in enumerate(sw):
            if k >= len(dw): break
            dm, devs = dw[k]
            heads = _heads(devs)
            if lyrics:
                last = {}  # (staff, verse) -> onset of the note the previous syllable went on
                for e, t in sevs:
                    if e.tag != 'note': continue
                    for ly in e.findall('lyric'):
                        rep['syllables'] += 1
                        v = (ly.get('number') or '1').strip()
                        busy = lambda n: any((x.get('number') or '1').strip() == v for x in n.findall('lyric'))
                        lo = last.get((_staff(e), v), Fr(-1))
                        free = [(n, u) for n, u in heads if u > lo and not busy(n)]
                        cand = [x for x in free if _staff(x[0]) == _staff(e)] or free
                        if not cand: rep['dropped'] += 1; continue
                        n, u = min(cand, key=lambda x: (abs(x[1] - t), x[1] < t, _voice(x[0]) != _voice(e)))
                        _insert_lyric(n, copy.deepcopy(ly))
                        last[(_staff(e), v)] = u
                        rep['placed'] += 1
                        if u != t: rep['moved'] += 1
            if chords:
                for e, t in sevs:
                    marks = e.tag == 'direction' and any((w.text or '') == CHECK for w in e.iter('words'))
                    if e.tag != 'harmony' and not marks: continue
                    if e.tag == 'harmony': rep['chords'] += 1
                    h = copy.deepcopy(e)
                    for o in h.findall('offset'): h.remove(o)
                    if marks:
                        kids = list(dm)
                        dm.insert(next((i for i, c in enumerate(kids) if c.tag not in ('print', 'attributes')), len(kids)), h)
                        continue
                    same = [x for x in heads if _staff(x[0]) == _staff(e)] or heads or [x for x in devs if x[0].tag in ('note', 'forward') and x[0].find('chord') is None]
                    if not same: continue
                    n, _ = min(same, key=lambda x: (abs(x[1] - t), x[1] < t))
                    dm.insert(list(dm).index(n), h)
                    rep['chordsPlaced'] += 1
    ET.indent(droot, space='  ')
    return _out(dst_text, droot), rep


def keep_header(old_text: str, new_text: str) -> str:
    """new_text with old_text's title / credits (an Edit-notes save changes notes only)."""
    o, n = _root(old_text), _root(new_text)
    if o is None or n is None: return new_text
    carry_header(o, n)
    return _head(new_text) + ET.tostring(n, encoding='unicode')
