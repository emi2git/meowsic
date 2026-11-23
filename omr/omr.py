#!/usr/bin/env python3
"""Sheet photo(s) → one MusicXML score (beta), fully offline.

  omr.py --out DIR --title "Song" page1.png [page2.png ...]

1. homr (deep-learning OMR, models in ~/ai/models/homr) reads the notes of each page.
2. Audiveris (classic OMR) reads the same pages; its lyrics and chord names are copied onto homr's
   notes where the two agree on the bar, and every bar where the two disagree is marked
   "check" (red text above the bar) and listed in report.json.
3. Bars whose notes don't add up to the time signature are marked too.
4. Pages are joined into one score with the song's title.

Prints one JSON line per step ({"step": ..., "msg": ...}) so the server can show progress.
Writes DIR/score.musicxml and DIR/report.json.
"""
import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import music21 as m21

HERE = Path(__file__).resolve().parent
HOMR = next((p for p in (HERE / '.venv' / 'bin' / 'homr', Path.home() / 'git' / 'apps' / 'meowsic' / 'omr' / '.venv' / 'bin' / 'homr') if p.exists()),
            HERE / '.venv' / 'bin' / 'homr')  # a git worktree has no venv of its own
AUDIVERIS = Path.home() / 'Applications' / 'Audiveris.app' / 'Contents' / 'MacOS' / 'Audiveris'


def say(step, msg, **kw):
    print(json.dumps({'step': step, 'msg': msg, **kw}), flush=True)


def run_homr(png: Path) -> Path | None:
    out = png.with_suffix('.musicxml')
    r = subprocess.run([str(HOMR), str(png)], cwd=png.parent, capture_output=True, text=True)
    return out if out.is_file() else None


TESSDATA = Path.home() / 'Library' / 'Application Support' / 'AudiverisLtd' / 'audiveris' / 'tessdata'


def audiveris_languages():
    """Audiveris reads words (lyrics) with Tesseract: English + Vietnamese when their data is installed."""
    have = [l for l in ('eng', 'vie') if (TESSDATA / f'{l}.traineddata').is_file()]
    return ['-option', f"org.audiveris.omr.text.Language.defaultSpecification={'+'.join(have)}"] if have else []


def run_audiveris(pngs: list[Path], out: Path) -> dict:
    """{page stem: music21 score} for the pages Audiveris could read (it's optional)."""
    if not AUDIVERIS.exists(): return {}
    out.mkdir(exist_ok=True)
    subprocess.run([str(AUDIVERIS), '-batch', '-export', '-output', str(out), *audiveris_languages(), *map(str, pngs)], capture_output=True, text=True)
    res = {}
    for p in pngs:
        mxl = out / f'{p.stem}.mxl'
        if not mxl.is_file(): continue
        try:
            with zipfile.ZipFile(mxl) as z:
                name = next(n for n in z.namelist() if n.endswith('.xml') and not n.startswith('META'))
                res[p.stem] = m21.converter.parseData(z.read(name).decode('utf-8'), format='musicxml')
        except Exception:
            pass
    return res


def top_part(s):
    return s.parts[0] if s.parts else None


def top_notes(meas):
    """(offset, pitch names or 'r', length) of the upper staff's first voice, in order."""
    out = []
    for n in meas.recurse().notesAndRests:
        if n.duration.isGrace: continue
        st = n.getContextByClass(m21.stream.PartStaff)
        off = round(float(n.getOffsetInHierarchy(meas)), 3)
        name = 'r' if n.isRest else '.'.join(sorted(p.nameWithOctave for p in n.pitches))
        out.append((off, name, round(float(n.quarterLength), 3)))
    return out


def melody(meas):
    """Highest sounding note at each onset (what both tools should agree on)."""
    by = {}
    for n in real_notes(meas):
        off = round(float(n.getOffsetInHierarchy(meas)), 3)
        top = max(p.midi for p in n.pitches)
        by[off] = max(by.get(off, -1), top)
    return sorted(by.items())


def real_notes(meas):
    """Notes and chords, not chord names (music21 counts a chord name as a chord)."""
    return [n for n in meas.recurse().notes if not isinstance(n, m21.harmony.ChordSymbol) and not n.duration.isGrace]


def align(hm, am):
    """homr bar index → Audiveris bar index, matching bars by their melody (counts may differ)."""
    import difflib
    key = lambda ms: [tuple(melody(x)) for x in ms]
    sm = difflib.SequenceMatcher(a=key(hm), b=key(am), autojunk=False)
    pairs = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal' or (tag == 'replace' and i2 - i1 == j2 - j1):
            for k in range(i2 - i1): pairs[i1 + k] = j1 + k
    return pairs


def bar_len(meas):
    ts = next(iter(meas.getElementsByClass(m21.meter.TimeSignature)), None) or meas.getContextByClass(m21.meter.TimeSignature)
    return float(ts.barDuration.quarterLength) if ts else 4.0


# ---------- chord names: Apple Vision reads the strip above each top staff ----------
CHORD = __import__('re').compile(r"^(N\.?C\.?|[A-G][#b♯♭]?(maj|min|m|M|dim|aug|sus|add|°|ø|\+)?[0-9]{0,2}(\(?(b|#|♭|♯|add|sus|maj)?[0-9]{1,2}\)?)*(sus[24]?)?(/[A-G][#b♯♭]?)?)$")


def note_positions(xml_path):
    """[(measure index, offset in quarters, staff, x, y)] for every homr note, from its imgpos comment."""
    import re
    import xml.etree.ElementTree as ET
    root = ET.parse(xml_path, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))).getroot()
    out, div = [], 1
    for mi, meas in enumerate(root.iter('measure')):
        t = last = 0
        for e in meas:
            if e.tag == 'attributes' and e.find('divisions') is not None: div = int(e.find('divisions').text)
            elif e.tag == 'backup': t -= int(e.find('duration').text)
            elif e.tag == 'forward': t += int(e.find('duration').text)
            elif e.tag == 'note':
                d = int(e.findtext('duration') or 0)
                chord = e.find('chord') is not None
                start = last if chord else t
                pos = next((c.text for c in e if c.tag is ET.Comment and 'imgpos' in (c.text or '')), None)
                if pos:
                    x, y = map(int, re.findall(r'\d+', pos)[:2])
                    out.append((mi, start / div, e.findtext('staff') or '1', x, y))
                if not chord: last, t = t, t + d
    return out


def staves(png, cut=128):
    """[(top, bottom, line gap)] of every five-line staff on the page. cut: how dark a line pixel is (0–255)."""
    import numpy as np
    from PIL import Image
    g = np.asarray(Image.open(png).convert('L'), dtype=np.int16)
    h, w = g.shape
    hard = (g < cut).sum(axis=1)
    dark = ((255 - g) / 255).sum(axis=1)  # grey, anti-aliased lines too (a thin line can fall across two pixel rows)
    rows = np.flatnonzero((hard > 0.4 * w) | (dark > 0.3 * w))
    lines = []
    for r in rows:
        if lines and r - lines[-1][-1] <= 1: lines[-1].append(r)
        else: lines.append([r])
    lines = [l for l in lines if max(hard[r] for r in l) > 0.4 * w or sum(dark[r] for r in l) > 0.6 * w]
    # a long beam touching a staff line joins its run: the line is the run's darkest rows, not its middle
    ys = [float(np.mean([r for r in l if dark[r] >= 0.6 * max(dark[q] for q in l)])) for l in lines]
    out, i = [], 0
    while i + 4 < len(ys):
        gaps = [ys[i + k + 1] - ys[i + k] for k in range(4)]
        if max(gaps) - min(gaps) <= max(2, 0.25 * sum(gaps) / 4):
            out.append((ys[i], ys[i + 4], sum(gaps) / 4)); i += 5
        else: i += 1
    return out


def _ink(png, st):
    """(ink, ink without staff lines) as 0/1 arrays; what crosses a staff line (ink right above and below) stays."""
    import numpy as np
    from PIL import Image
    ink = (np.asarray(Image.open(png).convert('L')) < 150).astype(np.uint8)
    H = ink.shape[0]
    clean = ink.copy()
    for top, bot, gp in st:
        for k in range(5):
            y = top + k * gp
            r0, r1 = max(0, int(y - 2)), min(H - 1, int(y + 2) + 1)
            keep = (ink[max(0, r0 - 1)] > 0) & (ink[r1] > 0)
            clean[r0:r1, ~keep] = 0
    return ink, clean


def page_arcs(png, st=None):
    """Ties and slurs printed on the page: thin curved strokes near a staff, once staff lines, stems, note heads and
    beams are taken off. [{staff, x0, y0, x1, y1, xm, ym, under}] (image pixels; x0 < x1; ym = the curve's middle)."""
    import cv2
    import numpy as np
    st = (staves(png) or staves(png, 200)) if st is None else st
    if not st: return []
    gap = float(np.median([s[2] for s in st]))
    ink, clean = _ink(png, st)
    k = max(3, int(round(0.45 * gap)))  # thick ink (note heads, beams) and stems / bar lines off
    thick = cv2.dilate(cv2.morphologyEx(clean, cv2.MORPH_OPEN, np.ones((k, k), np.uint8)), np.ones((3, 3), np.uint8))
    tall = cv2.dilate(cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((int(1.6 * gap), 1), np.uint8)), np.ones((1, 3), np.uint8))
    thin = clean & (1 - thick) & (1 - tall)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(thin, connectivity=8)
    pieces = []  # thin strokes: (staff, xs, ys) of their middle line, absolute pixels
    for i in range(1, n):
        x, y, w, h, area = map(int, stats[i])
        if w < 0.6 * gap or h > 0.5 * w + 0.6 * gap: continue
        cy = y + h / 2
        si = min(range(len(st)), key=lambda j: max(0, st[j][0] - cy, cy - st[j][1]))
        top, bot, _ = st[si]
        if not (top - 3 * gap <= cy <= bot + 2.6 * gap): continue  # not a lyric line or chord name
        m = lab[y:y + h, x:x + w] == i
        cols = m.any(0)
        if cols.mean() < 0.85: continue  # one stroke, not dots or letters side by side
        cnt = m.sum(0)
        if cnt.max() > 0.6 * gap or np.median(cnt[cols]) > 0.35 * gap: continue  # thin all along (no bracket hooks)
        xs = np.flatnonzero(cols)
        pieces.append([si, x + xs, y + np.array([np.flatnonzero(m[:, c]).mean() for c in xs])])
    # an arc cut by a stem or a bar line it crosses: its pieces join up (end of one near the start of the next)
    pieces.sort(key=lambda q: (q[0], q[1][0]))
    arcs = []
    for q in pieces:
        for a_ in arcs:
            if a_[0] != q[0]: continue
            dx = q[1][0] - a_[1][-1]
            if 0 < dx <= 0.8 * gap and abs(q[2][0] - a_[2][-1]) <= 0.25 * gap + 0.12 * dx + 1:
                a_[1] = np.concatenate([a_[1], q[1]]); a_[2] = np.concatenate([a_[2], q[2]]); break
        else:
            arcs.append(list(q))
    out = []
    for si, xs, ys in arcs:
        w = xs[-1] - xs[0] + 1
        h = ys.max() - ys.min()
        if w < 1.4 * gap or h > 0.5 * w + 0.6 * gap or (np.diff(xs) > 1).sum() > 0 and len(xs) < 0.7 * w: continue
        u = (xs - xs[0]).astype(float)
        a, b, c = np.polyfit(u, ys, 2)
        if np.sqrt(np.mean((ys - (a * u * u + b * u + c)) ** 2)) > 0.12 * gap + 0.6: continue  # a smooth curve
        y0, y1 = float(ys[:3].mean()), float(ys[-3:].mean())
        mid = int(np.argmin(np.abs(xs - (xs[0] + xs[-1]) / 2)))
        ym = float(ys[max(0, mid - 2): mid + 3].mean())
        sag = ym - (y0 + y1) / 2
        if abs(sag) < max(1.5, 0.18 * gap) or a * sag >= 0: continue  # bends one way (an extender or a beam is straight)
        out.append({'staff': si, 'x0': int(xs[0]), 'y0': round(y0, 1), 'x1': int(xs[-1]), 'y1': round(y1, 1),
                    'xm': int(xs[mid]), 'ym': round(ym, 1), 'under': bool(sag > 0)})
    return sorted(out, key=lambda q: (q['staff'], q['x0']))


def _head_y(n, p, bot, gap):
    """Where pitch p's note head sits on a staff whose bottom line is at y = bot."""
    cl = n.getContextByClass(m21.clef.Clef)
    low = getattr(cl, 'lowestLine', None) or 31
    return bot - (p.diatonicNoteNum - low) * gap / 2


def _sequence(part):
    """The part's notes / chords in playing order, each with its measure index and voice: [(mi, offset, voice, note)]."""
    out = []
    for mi, meas in enumerate(part.getElementsByClass(m21.stream.Measure)):
        for n in real_notes(meas):
            v = n.activeSite.id if isinstance(n.activeSite, m21.stream.Voice) else ''
            out.append((mi, round(float(n.getOffsetInHierarchy(meas)), 3), str(v), n))
    out.sort(key=lambda q: (q[0], q[1]))
    return out


def _next_in_voice(seq, k):
    v = seq[k][2]
    return next((j for j in range(k + 1, len(seq)) if seq[j][2] == v or not v or not seq[j][2]), None)


def _common(n1, n2):
    """Pitches two notes / chords share (by sound)."""
    b = {p.ps for p in n2.pitches}
    return [p for p in n1.pitches if p.ps in b]


def tie(n1, n2, near_y=None, head_y=None):
    """Tie n1 to n2 (the pitches they share; one pitch of a chord: the one nearest the arc). False if they share none."""
    common = _common(n1, n2)
    if not common: return False
    if isinstance(n1, m21.chord.Chord) and len(common) < len(n1.pitches) and near_y is not None and head_y:
        common = [min(common, key=lambda p: abs(head_y(p) - near_y))]
    for n, kind in ((n1, 'start'), (n2, 'stop')):
        for p in common:
            old = n.getTie(p) if isinstance(n, m21.chord.Chord) else n.tie
            t = old.type if old is not None else None
            new = kind if t in (None, kind) else 'continue'
            if isinstance(n, m21.chord.Chord): n.setTie(m21.tie.Tie(new), p)
            else: n.tie = m21.tie.Tie(new)
    return True


def tied(n1, n2):
    t1 = n1.tie if not isinstance(n1, m21.chord.Chord) else next((n1.getTie(p) for p in n1.pitches if n1.getTie(p)), None)
    return t1 is not None and t1.type in ('start', 'continue') and bool(_common(n1, n2))


def slur(part, n1, n2):
    """A slur from n1 to n2 in part, unless one is there already."""
    for sp in part.spanners.getElementsByClass(m21.spanner.Slur):
        if sp.isFirst(n1) and sp.isLast(n2): return False
    part.insert(0, m21.spanner.Slur(n1, n2))
    return True


def slurs_to_ties(part):
    """A slur over just two notes in a row with the same pitch is a tie (homr reads a tie as a slur now and then)."""
    seq = _sequence(part)
    at = {id(q[3]): k for k, q in enumerate(seq)}
    done = 0
    for sp in list(part.spanners.getElementsByClass(m21.spanner.Slur)):
        el = sp.getSpannedElements()
        if len(el) != 2 or id(el[0]) not in at or id(el[1]) not in at: continue
        k = at[id(el[0])]
        if _next_in_voice(seq, k) == at[id(el[1])] and {p.ps for p in el[0].pitches} == {p.ps for p in el[1].pitches}:
            tie(el[0], el[1]); part.remove(sp); done += 1
    return done


def place_arcs(h, png, xml_path, page_no, report):
    """Ties and slurs seen on the page image (page_arcs) put on homr's notes: an arc between two notes in a row with the
    same pitch is a tie (they play as one note), any other arc a slur. Returns the note a tie runs off the page from
    (the next page's first note gets it), or None."""
    import numpy as np
    parts = list(h.parts)
    if not parts: return None
    st = staves(png) or staves(png, 200)
    arcs = page_arcs(png, st)
    if not arcs: return None
    gap = float(np.median([s[2] for s in st]))
    _, clean = _ink(png, st)
    W = clean.shape[1]
    pos = note_positions(xml_path)
    grand = len(parts) > 1 and isinstance(parts[0], m21.stream.PartStaff)
    seqs = [_sequence(p) for p in parts]
    # every note on the page: its part, place in the part's sequence, page staff, head x and y
    heads = []
    used = set()
    for mi, off, sn, x, y in pos:
        pi = (int(sn) - 1 if grand else 0)
        if pi >= len(parts): continue
        seq = seqs[pi]
        k = next((j for j, q in enumerate(seq) if q[0] == mi and abs(q[1] - off) < 0.02 and (pi, j) not in used), None)
        if k is None: continue
        used.add((pi, k))
        n = seq[k][3]
        si = min(range(len(st)), key=lambda j: abs((st[j][0] + st[j][1]) / 2 - y))
        top, bot, _ = st[si]
        hy = _head_y(n, max(n.pitches, key=lambda p: p.ps), bot, gap)
        # homr's position is rough: the head is the inkiest spot on its line nearby
        y0, y1 = int(max(0, hy - 0.45 * gap)), int(hy + 0.45 * gap) + 1
        x0, x1 = int(max(0, x - 2.5 * gap)), int(min(W, x + 2.5 * gap))
        hx = x
        if x1 - x0 > 2 * gap and y1 < clean.shape[0]:
            colsum = clean[y0:y1, x0:x1].sum(0).astype(float)
            w = max(3, int(1.2 * gap))
            run = np.convolve(colsum, np.ones(w), 'valid')
            if run.size and run.max() > 0.2 * w * (y1 - y0):
                best = np.flatnonzero(run >= 0.97 * run.max())
                c = best[np.argmin(np.abs(best + w / 2 + x0 - x))]
                hx = x0 + c + w / 2
        heads.append({'pi': pi, 'k': k, 'staff': si, 'x': float(hx), 'y': hy, 'bot': bot})
    out_tie, added = None, {'ties': 0, 'slurs': 0}
    for a in arcs:
        mine = sorted((q for q in heads if q['staff'] == a['staff']), key=lambda q: q['x'])
        if not mine: continue
        pi = mine[0]['pi']
        seq = seqs[pi]
        mine = [q for q in mine if q['pi'] == pi]
        near = lambda x: min(mine, key=lambda q: abs(q['x'] - x))
        first, last = mine[0], mine[-1]
        open_left = a['x0'] < first['x'] - 0.5 * gap
        open_right = a['x1'] > last['x'] + 2.5 * gap
        if open_left and open_right: continue
        if open_left:  # the end of a tie from the line before
            q2 = near(a['x1'])
            if abs(q2['x'] - a['x1']) > 3 * gap or q2['k'] == 0: continue
            k1 = q2['k'] - 1
            while k1 >= 0 and seq[k1][2] != seq[q2['k']][2]: k1 -= 1
            if k1 < 0: continue
            n1, n2 = seq[k1][3], seq[q2['k']][3]
            if not tied(n1, n2) and tie(n1, n2): added['ties'] += 1
            continue
        q1 = near(a['x0'] - 0.3 * gap)
        if abs(q1['x'] - a['x0']) > 3 * gap: continue
        hy1 = q1['y']
        if open_right:  # a tie running to the next line (or page)
            if abs(a['y0'] - hy1) > 2 * gap: continue
            k2 = _next_in_voice(seq, q1['k'])
            n1 = seq[q1['k']][3]
            if k2 is None: out_tie = n1; continue
            n2 = seq[k2][3]
            if not tied(n1, n2) and tie(n1, n2): added['ties'] += 1
            continue
        q2 = near(a['x1'] + 0.3 * gap)
        if q2['k'] <= q1['k'] or abs(q2['x'] - a['x1']) > 3 * gap: continue
        n1, n2 = seq[q1['k']][3], seq[q2['k']][3]
        if _next_in_voice(seq, q1['k']) == q2['k'] and _common(n1, n2):
            if abs(a['y0'] - hy1) > 2 * gap: continue
            if not tied(n1, n2) and tie(n1, n2, a['y0'], lambda p: _head_y(n1, p, q1['bot'], gap)): added['ties'] += 1
        elif slur(parts[pi], n1, n2): added['slurs'] += 1
    if added['ties'] or added['slurs']: report.setdefault('arcs', []).append({'page': page_no, **added})
    return out_tie


def audiveris_arcs(hm, am, pairs, part):
    """Ties and slurs Audiveris read, put on homr's notes with the same onset and pitch (bars matched by `pairs`)."""
    def find(meas, off, ps):
        return next((n for n in real_notes(meas) if abs(float(n.getOffsetInHierarchy(meas)) - off) < 0.02 and ps & {p.ps for p in n.pitches}), None)
    seq = _sequence(part)
    at = {id(q[3]): k for k, q in enumerate(seq)}
    ref = {}  # Audiveris note → the homr note at the same place
    for i, j in pairs.items():
        for n in real_notes(am[j]):
            hn = find(hm[i], float(n.getOffsetInHierarchy(am[j])), {p.ps for p in n.pitches})
            if hn is not None: ref[id(n)] = hn
    added = {'ties': 0, 'slurs': 0}
    for i, j in pairs.items():
        for n in real_notes(am[j]):
            hn = ref.get(id(n))
            if hn is None or id(hn) not in at: continue
            t = n.tie if not isinstance(n, m21.chord.Chord) else next((n.getTie(p) for p in n.pitches if n.getTie(p)), None)
            if t is not None and t.type in ('start', 'continue'):
                k2 = _next_in_voice(seq, at[id(hn)])
                if k2 is not None and not tied(hn, seq[k2][3]) and tie(hn, seq[k2][3]): added['ties'] += 1
    src = am[0].getContextByClass(m21.stream.Part) if am else None
    for sp in (src.spanners.getElementsByClass(m21.spanner.Slur) if src is not None else []):
        el = sp.getSpannedElements()
        if len(el) < 2: continue
        n1, n2 = ref.get(id(el[0])), ref.get(id(el[-1]))
        if n1 is None or n2 is None or n1 is n2: continue
        k1, k2 = at.get(id(n1)), at.get(id(n2))
        if k1 is None or k2 is None or k2 <= k1: continue
        if _next_in_voice(seq, k1) == k2 and _common(n1, n2):
            if not tied(n1, n2) and tie(n1, n2): added['ties'] += 1
        elif slur(part, n1, n2): added['slurs'] += 1
    return added


def ocr(img):
    import Vision
    from Foundation import NSData
    import io
    b = io.BytesIO(); img.save(b, 'PNG')
    data = NSData.dataWithBytes_length_(b.getvalue(), len(b.getvalue()))
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0); req.setUsesLanguageCorrection_(False)
    req.setRecognitionLanguages_(['vi-VT', 'en-US'])
    hd = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    hd.performRequests_error_([req], None)
    import re
    from Foundation import NSMakeRange
    out = []
    for o in req.results() or []:
        c = o.topCandidates_(1)[0]
        text = str(c.string())
        for m in re.finditer(r'\S+', text):  # one box per word
            box, _ = c.boundingBoxForRange_error_(NSMakeRange(m.start(), m.end() - m.start()), None)
            if box is None: continue
            bb = box.boundingBox()
            out.append((m.group(), bb.origin.x, bb.size.width))
    return out


_TPL = []


def _norm(a):
    import numpy as np
    from PIL import Image
    ys, xs = np.flatnonzero(a.any(1)), np.flatnonzero(a.any(0))
    a = a[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1]
    return np.asarray(Image.fromarray((a * 255).astype('uint8')).resize((24, 32), Image.BILINEAR)) / 255 > 0.5, a.shape[1] / a.shape[0]


def _templates():
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    if _TPL: return _TPL
    def add(kind, ch, fontfile):
        try: font = ImageFont.truetype(fontfile, 120)
        except OSError: return
        im = Image.new('L', (240, 240), 0); ImageDraw.Draw(im).text((30, 30), ch, fill=255, font=font)
        a = np.asarray(im) > 128
        if a.any(): _TPL.append((kind, ch) + _norm(a))
    for f in ('/System/Library/Fonts/Supplemental/Times New Roman.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'):
        for L in 'ABCDEFG': add('root', L, f)
        for d in '679': add('sup', d, f)
    for f in ('/System/Library/Fonts/Apple Symbols.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'):
        add('sup', '♭', f); add('sup', '♯', f)
    return _TPL


def _best(a, kind):
    import numpy as np
    t, ar = _norm(a)
    sc = sorted(((np.logical_and(t, x).sum() / np.logical_or(t, x).sum() - 0.5 * abs(ar - r), ch) for k, ch, x, r in _templates() if k == kind), reverse=True)
    other = next((v for v, ch in sc[1:] if ch != sc[0][1]), -1)
    return sc[0][1] if sc[0][0] >= 0.55 and sc[0][0] - other >= 0.1 else None


def _components(a):
    """Connected ink shapes of a small image: [(x0, x1, y0, y1, mask)], left to right."""
    import numpy as np
    seen = np.zeros_like(a, dtype=bool)
    h, w = a.shape
    out = []
    for y, x in zip(*np.nonzero(a)):
        if seen[y, x]: continue
        stack, pts = [(y, x)], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop(); pts.append((cy, cx))
            for ny in (cy - 1, cy, cy + 1):
                for nx in (cx - 1, cx, cx + 1):
                    if 0 <= ny < h and 0 <= nx < w and a[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; stack.append((ny, nx))
        ys, xs = zip(*pts)
        m = np.zeros_like(a, dtype=bool); m[list(ys), list(xs)] = True
        out.append((min(xs), max(xs) + 1, min(ys), max(ys) + 1, m))
    return sorted(out, key=lambda c: c[0])


def _mark(a):
    """A small raised ♭ or 7 by its shape: ♭ = stem on the left + bowl at the bottom right; 7 = bar on top."""
    import numpy as np
    h, w = a.shape
    if h < 4 or w < 3: return None
    left = a[:, : max(1, int(w * 0.35))].any(1).mean()
    top_right = a[: h // 2, w // 2:].mean()
    bottom_right = a[h // 2:, w // 2:].mean()
    top_bar = a[: max(1, int(h * 0.22)), :].any(0).mean()
    bottom_left = a[h // 2:, : w // 2].mean()
    if left > 0.85 and top_right < 0.08 and bottom_right > 0.15: return '♭'
    # a flat whose stem touches the letter: only its bowl is left — a straight right side, open on the left
    mid = a[int(h * 0.35): int(h * 0.75)]
    if len(mid) >= 3 and all(r.any() for r in mid):
        rights = [np.flatnonzero(r)[-1] for r in mid]
        lefts = [np.flatnonzero(r)[0] for r in mid]
        if np.std(rights) < 1.6 and min(lefts) > w * 0.35 and a[-max(1, h // 5):, : w // 2].any(): return '♭'
    if top_bar > 0.7 and bottom_left < 0.12: return '7'
    return None


def letter(a):
    """A chord name the shape of a letter A–G, maybe with a small raised ♭ ♯ 6 7 9 (Vision skips these);
    None if unsure."""
    import numpy as np
    comps = [c for c in _components(a) if (c[1] - c[0]) * (c[3] - c[2]) > 4]
    if not comps or len(comps) > 3: return None
    root = max(comps, key=lambda c: (c[3] - c[2]) * (c[1] - c[0]))
    if root is not comps[0]: return None  # the letter comes first
    L = _best(root[4][root[2]:root[3], root[0]:root[1]], 'root')
    if not L: return None
    rest = comps[1:]
    if not rest: return L
    if len(rest) > 2: return None
    # a raised mark can be in two pieces (a flat's thin stem + its bowl): take them together
    m = np.logical_or.reduce([c[4] for c in rest])
    x0, x1, y0, y1 = min(c[0] for c in rest), max(c[1] for c in rest), min(c[2] for c in rest), max(c[3] for c in rest)
    if y0 > (root[2] + root[3]) / 2 or y1 - y0 > 0.9 * (root[3] - root[2]): return None  # not a small raised mark
    sup = _mark(m[y0:y1, x0:x1]) or _best(m[y0:y1, x0:x1], 'sup')
    return {'♭': L + 'b', '♯': L + '#'}.get(sup, L + sup if sup else None)


def chord_names(png, xml_path):
    """[(measure index, offset, figure)] read from the page image, placed on the nearest upper-staff note."""
    from PIL import Image
    notes = [n for n in note_positions(xml_path) if n[2] == '1']
    if not notes: return []
    st = staves(png)
    im = Image.open(png).convert('L')
    W = im.width
    found = []
    for top, bot, gap in st:
        mine = [n for n in notes if top - 6 * gap <= n[4] <= bot + 6 * gap]
        if not mine: continue  # a lower (bass) staff, or not a staff homr used
        y0, y1 = max(0, int(top - 5.5 * gap)), int(top - 0.6 * gap)
        strip = im.crop((0, y0, W, y1))
        strip = strip.resize((strip.width * 2, strip.height * 2))
        words = ocr(strip)
        # lone letters Vision skipped: ink clusters not covered by a word, letter-sized
        import numpy as np
        ink = np.asarray(strip) < 128
        sw = strip.width
        cols = np.flatnonzero(ink.any(0))
        groups = []
        for c in cols:
            if groups and c - groups[-1][1] <= gap: groups[-1][1] = c
            else: groups.append([c, c])
        for c0, c1 in groups:
            sub = ink[:, c0:c1 + 1]
            rows = np.flatnonzero(sub.any(1))
            hgt, wid = rows[-1] - rows[0] + 1, c1 - c0 + 1
            if hgt < 1.6 * gap or wid > 2.2 * hgt: continue  # (strip is 2× size)
            if any(x * sw - 4 <= c1 and c0 <= (x + w) * sw + 4 for _, x, w in words): continue
            L = letter(sub)
            if L: words.append((L, c0 / sw, wid / sw))
        for tok, x, w in words:
                tok = tok.strip(',.;:')
                tok = __import__('re').sub(r'^([A-G])5(?=$|/)', r'\\1b', tok)  # a raised ♭ reads as 5
                if not CHORD.match(tok): continue
                tx = x * W
                if len(tok) == 1 and tx < min(q[3] for q in mine) - 1.5 * gap: continue  # the top of a clef reads as a letter
                n = min(mine, key=lambda q: abs(q[3] - (tx + 0.5 * gap)))
                if abs(n[3] - tx) > 8 * gap: continue
                found.append((n[0], n[1], tok))
    return sorted(set(found))



def lyric_words(png, xml_path, first_verse=False):
    """[(measure index, offset, text, syllabic, verse)] read under each top staff with Apple Vision.
    Each line of words under a staff is a verse (lyric number 1, 2, ...); with first_verse only the top line
    under each staff (the words of the main tune, for "Add lyrics from a sheet")."""
    import re
    from PIL import Image, ImageOps
    notes = [n for n in note_positions_notes(xml_path) if n[2] == '1']
    if not notes: return []
    st = staves(png)
    im = Image.open(png).convert('L')
    W = im.width
    found = []  # [measure, offset, text, hyphen-after, verse]
    for k, (top, bot, gap) in enumerate(st):
        mine = [n for n in notes if top - 6 * gap <= n[4] <= bot + 6 * gap]
        if not mine: continue
        nxt = st[k + 1][0] if k + 1 < len(st) else im.height
        nxt_top_staff = k + 1 < len(st) and any(st[k + 1][0] - 6 * gap <= n[4] <= st[k + 1][1] + 6 * gap for n in notes)
        y0 = int(bot + 0.8 * gap)
        y1 = int(min(nxt - (4.8 if nxt_top_staff else 0.8) * gap, bot + 12 * gap))  # stop above the next system's chord names
        if first_verse and nxt_top_staff:  # tight systems: read down to the next staff; its chord names are dropped below
            y1 = int(min(nxt - 1.0 * gap, bot + 12 * gap))
        if y1 - y0 < gap: continue
        strip = im.crop((0, y0, W, y1)).resize((W * 2, (y1 - y0) * 2))
        line_h = 2.2 * gap / (y1 - y0)  # a text line, as a fraction of the strip height
        lines = []
        for wd in sorted(ocr_lines(strip), key=lambda q: -q[3]):  # Vision y: 0 bottom, 1 top
            if lines and abs(lines[-1][-1][3] - wd[3]) < 0.5 * line_h: lines[-1].append(wd)
            else: lines.append([wd])
        order = sorted(mine, key=lambda q: (q[0], q[1]))
        lines = [l for l in lines if sum(any(ch.isalpha() for ch in w[0]) for w in l) >= 3]  # stray marks are not a verse
        # a line of chord names (the next system's) is not words
        lines = [l for l in lines if sum(bool(CHORD.match(w[0].strip('.,'))) for w in l) < 0.6 * len(l)]
        for verse, words in enumerate((sorted(l, key=lambda q: q[1]) for l in lines), 1):
            toks, aside = [], []  # [text, centre x, hyphen-after]; x ranges of (Instrumental) etc.
            for t, x, w, _ in words:
                if t.startswith('(') or t.endswith(')'):
                    aside.append((x * W - gap, (x + w) * W + gap)); continue
                if first_verse and re.fullmatch(r"[A-Z][A-Z.'’]*:", t): continue  # a singer's name ("JV:"), not a word
                if t in ('-', '–'):  # a hyphen between syllables, unless the word before ends a phrase
                    if toks and toks[-1][0][-1:] not in '.,;:!?': toks[-1][2] = True
                    continue
                if t.strip('-—_–') == '': continue  # hold line
                if t.startswith(('-', '–')) and toks and toks[-1][0][-1:] not in '.,;:!?': toks[-1][2] = True
                parts = re.split(r'(?<=\w)[-–](?=\w)', t.strip('-–—_'))
                for i, q in enumerate(parts):  # "mat-ter" → two syllables across the word's box
                    cx = (x + w * (i + 0.5) / len(parts)) * W
                    toks.append([q, cx, i < len(parts) - 1 or t.rstrip('_—').endswith(('-', '–'))])
            last, got = -1, []
            for t, cx, hy in toks:  # in reading order, each word to the next unused note nearest to it
                cand = [(abs(q[3] + 0.6 * gap - cx), j) for j, q in enumerate(order) if j > last]
                if not cand: break
                d, j = min(cand)
                if d > 4 * gap: continue
                last = j
                got.append([order[j][0], order[j][1], t, hy])
            # words Vision skipped (often short ones at a line end): read under each bare note alone (one verse only)
            if toks and len(lines) == 1:
                have = {(f[0], f[1]) for f in got}
                for j, q in enumerate(order):
                    if (q[0], q[1]) in have or any(a0 <= q[3] <= a1 for a0, a1 in aside): continue
                    left = (order[j - 1][3] + q[3]) / 2 if j else q[3] - 3 * gap
                    right = (order[j + 1][3] + q[3]) / 2 + gap if j + 1 < len(order) else q[3] + 4 * gap
                    box = im.crop((int(max(0, left)), y0, int(min(W, right)), y1))
                    big = ImageOps.expand(box.resize((box.width * 3, box.height * 3)), border=40, fill=255)
                    alone = [w for w in ocr_lines(big) if any(ch.isalpha() for ch in w[0]) and not w[0].startswith('(')]
                    if len(alone) == 1:
                        t = alone[0][0].strip('_—')
                        got.append([q[0], q[1], t.strip('-–'), t.endswith(('-', '–'))])
            found += [[*f, verse] for f in got]
    if first_verse: found = [f for f in found if f[4] == 1]  # several verses: the top line is the main tune's words
    out, open_ = [], {}
    for mi, off, t, hy, verse in sorted(found, key=lambda f: (f[4], f[0], f[1])):
        o = open_.get(verse, False)
        syl = ('middle' if hy else 'end') if o else ('begin' if hy else 'single')
        out.append((mi, off, t, syl, verse)); open_[verse] = hy
    return out


def note_positions_notes(xml_path):
    """note_positions without rests (lyrics sit under notes)."""
    import xml.etree.ElementTree as ET
    root = ET.parse(xml_path).getroot()
    rest = []
    for meas in root.iter('measure'):
        for e in meas:
            if e.tag == 'note' and e.find('chord') is None: rest.append(e.find('rest') is not None)
    pos = note_positions(xml_path)
    # note_positions lists chord notes too; keep single onsets that are not rests
    seen, out = set(), []
    for n in pos:
        if (n[0], n[1], n[2]) in seen: continue
        seen.add((n[0], n[1], n[2])); out.append(n)
    return [n for n, r in zip(out, rest) if not r] if len(out) == len(rest) else out


def ocr_lines(img):
    """Words with their box: (text, x, width, y) — x, width as fractions of the image width."""
    import Vision, io, re
    from Foundation import NSData, NSMakeRange
    b = io.BytesIO(); img.save(b, 'PNG')
    data = NSData.dataWithBytes_length_(b.getvalue(), len(b.getvalue()))
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0); req.setUsesLanguageCorrection_(False)
    req.setRecognitionLanguages_(['vi-VT', 'en-US'])
    hd = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    hd.performRequests_error_([req], None)
    out = []
    for o in req.results() or []:
        c = o.topCandidates_(1)[0]
        text = str(c.string())
        lb = o.boundingBox()
        for m in re.finditer(r'\S+', text):
            box, _ = c.boundingBoxForRange_error_(NSMakeRange(m.start(), m.end() - m.start()), None)
            if box is None: continue
            bb = box.boundingBox()
            out.append((m.group(), bb.origin.x, bb.size.width, lb.origin.y))
    out.sort(key=lambda w: w[1])
    keep = []  # Vision can return the same words twice (overlapping lines): keep the first box only
    for w in out:
        if keep and w[1] < keep[-1][1] + keep[-1][2] * 0.6 and abs(w[3] - keep[-1][3]) < 0.3: continue
        keep.append(w)
    return keep


def to_m21_figure(tok):
    import re
    tok = tok.replace('♭', 'b').replace('♯', '#')
    return re.sub(r'(^|/)([A-G])b', r'\1\2-', tok)


def layers_full(meas):
    want = bar_len(meas)
    ls = _layers(meas)
    return bool(ls) and all(abs(sum(float(n.quarterLength) for n in _timed(c)) - want) < 0.01 for c in ls)


def take_bar(dst, src):
    """Put the notes of bar src (another reader's) into bar dst, keeping dst's clef / key / time / chord names."""
    import copy
    for e in list(dst.elements):
        if isinstance(e, (m21.note.GeneralNote, m21.stream.Voice)) and not isinstance(e, m21.harmony.ChordSymbol): dst.remove(e)
    for e in src.elements:
        if isinstance(e, m21.stream.Voice) or (isinstance(e, m21.note.GeneralNote) and not isinstance(e, m21.harmony.ChordSymbol)):
            x = copy.deepcopy(e)
            for n in ([x] if not isinstance(x, m21.stream.Voice) else x.notesAndRests): n.lyrics = []  # words come from the page image
            dst.insert(float(e.offset), x)


def merge_page(h, a, page_no, report, chords=None, words=None, empty=None, png=None, carry=None):
    """Copy lyrics + chord names from Audiveris (a) onto homr (h); mark bars that disagree. Ties and slurs: homr's,
    Audiveris', and the arcs seen on the page image (png). carry['tie_out']: a note tied over to the next page."""
    hp = top_part(h)
    hm = list(hp.getElementsByClass(m21.stream.Measure)) if hp else []
    if isinstance(hp, m21.stream.PartStaff) or not hm:
        hm = list(h.parts[0].getElementsByClass(m21.stream.Measure))
    am = list(top_part(a).getElementsByClass(m21.stream.Measure)) if a is not None and a.parts else []
    pairs = align(hm, am) if am else {}
    # for "bars to check": where each bar is on the page, and the other reader's notes for it
    import copy
    boxes = bar_boxes(png, Path(png).with_suffix('.musicxml'), len(hm)) if png is not None else {}
    for i, meas in enumerate(hm):
        meas.meowsicPage, meas.meowsicBox = page_no, boxes.get(i)
        meas.meowsicAlt = [('audiveris', copy.deepcopy(am[pairs[i]]))] if i in pairs and not isinstance(hp, m21.stream.PartStaff) else []
        meas.meowsicWant = bar_len(meas)
    # a homr bar that doesn't add up, where Audiveris read the same bar so it does (and found at least as many
    # notes): Audiveris' notes are taken (homr misreads a beamed run or drops a tied note now and then)
    for i, j in (pairs.items() if not isinstance(hp, m21.stream.PartStaff) else []):
        if i == 0 or not layers_full(am[j]) or layers_full(hm[i]): continue
        if len(real_notes(am[j])) < len(real_notes(hm[i])) or not real_notes(am[j]): continue
        hm[i].meowsicAlt = [('homr', copy.deepcopy(hm[i]))]
        take_bar(hm[i], am[j])
        report.setdefault('taken', []).append({'page': page_no, 'bar': i + 1})
    # lyrics read from the page image come first; Audiveris only fills gaps in bars that have words
    worded = set()
    for mi, off, text, syl, verse in words or []:
        if mi >= len(hm): continue
        ns = sorted(real_notes(hm[mi]), key=lambda x: abs(float(x.getOffsetInHierarchy(hm[mi])) - off))
        n = ns[0] if ns and abs(float(ns[0].getOffsetInHierarchy(hm[mi])) - off) < 0.26 else None
        if n is not None and not any(l.number == verse for l in n.lyrics):
            n.lyrics = [*n.lyrics, m21.note.Lyric(text=text, number=verse, syllabic=syl)]
            worded.add(mi)
    if am and len(am) != len(hm):
        report['notes'].append(f'page {page_no}: the two readers found {len(hm)} and {len(am)} bars')
    for i, meas in enumerate(hm):
        flags = []
        full = sum(float(n.quarterLength) for n in meas.getElementsByClass(m21.note.GeneralNote) if not n.duration.isGrace)
        voices = list(meas.voices)
        if voices: full = max(sum(float(n.quarterLength) for n in v.notesAndRests) for v in voices)
        want = bar_len(meas)
        if abs(full - want) > 0.01 and not (i == 0 and full < want):  # a short first bar can be a pickup
            flags.append(f'bar adds up to {full:g} beats, not {want:g}')
        if am and i not in pairs:
            flags.append('only one reader found this bar')
        if i in pairs:
            ameas = am[pairs[i]]
            hmel, amel = melody(meas), melody(ameas)
            if hmel != amel:
                flags.append('the two readers disagree')
            # chord names from Audiveris fill in what the page image reading missed
            mine = [(o, t) for mi, o, t in chords or [] if mi == i]
            for hs in ameas.recurse().getElementsByClass(m21.harmony.ChordSymbol):
                off = float(hs.getOffsetInHierarchy(ameas))
                fig = __import__('re').sub(r'^([A-G])5(?=$|/)', r'\1-', hs.figure or '')
                if not CHORD.match(fig.replace('-', 'b')): continue
                if any(abs(o - off) <= 0.75 for o, _ in mine): continue
                try:
                    cs = m21.harmony.ChordSymbol(fig)
                    cs.writeAsChord = False
                    meas.insert(off, cs)
                except Exception:
                    pass
            # lyrics, by onset
            lyr = {}
            for n in real_notes(ameas):
                if n.lyrics: lyr.setdefault(round(float(n.getOffsetInHierarchy(ameas)), 3), n.lyrics)
            for n in (real_notes(meas) if (not words or i in worded) else []):
                off = round(float(n.getOffsetInHierarchy(meas)), 3)
                if off in lyr and n.lyrics and lyr[off][0].syllabic in ('begin', 'middle') and n.lyrics[0].syllabic in ('single', 'end', None) and (n.lyrics[0].text or '')[-1:] not in '.,;:!?' \
                        and (lyr[off][0].text or '').strip('.,;:!?').lower() == (n.lyrics[0].text or '').strip('.,;:!?').lower():
                    n.lyrics[0].syllabic = 'begin' if n.lyrics[0].syllabic in ('single', None) else 'middle'  # "loy al" → "loy-al"
                if off in lyr and not n.lyrics and any(ch.isalpha() for l in lyr[off] for ch in (l.text or '')):
                    n.lyrics = [m21.note.Lyric(text=l.text, number=l.number, syllabic=l.syllabic) for l in lyr.pop(off)]
        if flags:
            tx = m21.expressions.TextExpression('⚠ check')
            tx.style.color = '#D22'
            tx.placement = 'above'
            meas.insert(0, tx)
            report['check'].append({'page': page_no, 'bar': i + 1, 'why': flags})
    for mi, off, tok in chords or []:
        if mi < len(hm):
            try:
                cs = m21.harmony.ChordSymbol(to_m21_figure(tok)); cs.writeAsChord = False
                hm[mi].insert(off, cs)
            except Exception:
                report['notes'].append(f'page {page_no}: chord name “{tok}” not understood')
    # ties and slurs (connection arcs): homr's, then Audiveris', then what the page image shows
    for part in h.parts: slurs_to_ties(part)
    if am and pairs and hp is not None:
        got = audiveris_arcs(hm, am, pairs, hp)
        if got['ties'] or got['slurs']: report.setdefault('arcsAudiveris', []).append({'page': page_no, **got})
    if png is not None:
        try:
            n = place_arcs(h, png, Path(png).with_suffix('.musicxml'), page_no, report)
            if carry is not None: carry['tie_out'] = n
        except Exception as e:
            report['notes'].append(f'page {page_no}: ties / slurs: {e}')
    drop_empty_bars(h, page_no, report, empty or set())
    return h


def empty_bars(xml_path):
    """Indices of the bars homr wrote with no note or rest at all (music21 fills those with a whole rest)."""
    import xml.etree.ElementTree as ET
    try: root = ET.parse(xml_path).getroot()
    except Exception: return set()
    by = {}
    for part in root.iter('part'):
        for i, m in enumerate(part.iter('measure')):
            by[i] = by.get(i, True) and m.find('note') is None
    return {i for i, e in by.items() if e}


def drop_empty_bars(h, page_no, report, empty):
    """homr writes an empty bar where a first ending stops at a repeat sign: it is not on the page (it would
    play as a bar of silence). `empty`: those bars (empty_bars). A printed whole-bar rest is a rest, so it stays."""
    parts = list(h.parts)
    if not parts or not empty: return
    bars = [list(p.getElementsByClass(m21.stream.Measure)) for p in parts]
    gone = [i for i in sorted(empty) if 0 < i < min(len(b) for b in bars)]
    for i in reversed(gone):
        for p, b in zip(parts, bars):
            prev, m = b[i - 1], b[i]
            nxt = b[i + 1] if i + 1 < len(b) else None
            for cs in list(m.recurse().getElementsByClass(m21.harmony.ChordSymbol)):  # a chord name read there: next bar
                if nxt is not None and not any(float(x.offset) == 0 for x in nxt.getElementsByClass(m21.harmony.ChordSymbol)):
                    m.remove(cs, recurse=True); nxt.insert(0, cs)
            for sp in list(h.recurse().getElementsByClass(m21.spanner.Spanner)):
                if sp.isFirst(m) or sp.isLast(m) or m in sp.getSpannedElements():
                    sp.replaceSpannedElement(m, prev) if prev not in sp.getSpannedElements() else sp.removeSpannedElements(m)
            p.remove(m)
        report['check'] = [c for c in report['check'] if not (c['page'] == page_no and c['bar'] == i + 1)]
        for c in report['check']:
            if c['page'] == page_no and c['bar'] > i + 1: c['bar'] -= 1
        for t in report.get('taken', []):
            if t['page'] == page_no and t['bar'] > i + 1: t['bar'] -= 1
    if gone: report.setdefault('dropped', []).append({'page': page_no, 'bars': [i + 1 for i in gone]})


FIXED = (m21.clef.Clef, m21.key.KeySignature, m21.meter.TimeSignature, m21.instrument.Instrument, m21.bar.Barline)


def _timed(c):
    return [n for n in c.notesAndRests if not n.duration.isGrace and not isinstance(n, m21.harmony.ChordSymbol)]


def _triplet(c, notes, want):
    """A too-long bar where three notes in a row, read as plain notes, are really a triplet (the "3" bracket was
    missed): the three become a quarter (or eighth / half) triplet when that makes the bar add up exactly.
    The window whose notes are closest to the triplet's note value wins."""
    have = sum(float(n.quarterLength) for n in notes)
    best = None
    for j in range(len(notes) - 2):
        win = notes[j:j + 3]
        if any(n.duration.tuplets or n.duration.isGrace for n in win): continue
        rest = have - sum(float(n.quarterLength) for n in win)
        for q in (1.0, 0.5, 2.0):  # quarter, eighth, half triplets: three of them last 2q
            if abs(rest + 2 * q - want) < 0.01:
                cost = sum(abs(float(n.quarterLength) - q) for n in win)
                if best is None or cost < best[0]: best = (cost, j, q)
    if best is None: return None
    _, j, q = best
    t = None
    for k, n in enumerate(notes[j:j + 3]):
        d = m21.duration.Duration(q)
        d.appendTuplet(m21.duration.Tuplet(3, 2, {1.0: 'quarter', 0.5: 'eighth', 2.0: 'half'}[q]))
        d.tuplets[0].type = 'start' if k == 0 else 'stop' if k == 2 else None
        n.duration = d
    off = 0.0
    for n in _timed(c):  # close the gaps / overlaps the new lengths leave
        n.offset = off; off += float(n.quarterLength)
    return f'three notes made a triplet ({q:g}-beat notes)'


def new_voice(meas):
    """A voice with a number no other voice of the bar has (two voices with one number are written as one)."""
    used = {str(v.id) for v in meas.voices}
    k = 1
    while str(k) in used: k += 1
    return m21.stream.Voice(id=str(k))


def _layers(meas):
    """What has to add up: each voice, and the notes standing in the bar itself (beside voices they get a voice of their own)."""
    vs = list(meas.voices)
    return vs + ([meas] if _timed(meas) else []) if vs else [meas]


def _fill(c, want, pickup, meas=None):
    """Make the notes and rests of c (a bar, or one voice of it) add up to `want` quarters. Returns what was done."""
    notes = _timed(c)
    have = sum(float(n.quarterLength) for n in notes)
    gap = want - have
    if abs(gap) < 0.01: return None
    if not notes:
        c.insert(0, m21.note.Rest(quarterLength=want)); return 'empty: whole-bar rest'
    if gap > 0:
        if pickup:  # a pickup: the rest goes in front, so the tune still lands on the beat
            for e in list(c.elements):
                if not isinstance(e, FIXED): e.offset += gap
            c.insert(0, m21.note.Rest(quarterLength=gap)); return f'pickup: {gap:g}-beat rest in front'
        last = notes[-1]
        if not last.isRest and not last.duration.tuplets and last.duration.dots == 0 and abs(float(last.quarterLength) * 0.5 - gap) < 0.01:
            last.duration.dots = 1; return 'missing dot on the last note'
        end = max(float(n.offset) + float(n.quarterLength) for n in notes)
        c.insert(end, m21.note.Rest(quarterLength=gap)); return f'{gap:g} beats short: rest added'
    fix = _triplet(c, notes, want)  # a "3" bracket the reader missed
    if fix: return fix
    # too long: almost always a second voice the reader put after the first (an under-part, a string line);
    # split it into voices that each fill the bar. No note is dropped.
    if meas is not None and len(list(meas.voices)) < 4:
        acc, k = 0.0, 0
        for j, n in enumerate(notes):
            if acc + float(n.quarterLength) > want + 0.01: break
            acc += float(n.quarterLength); k = j + 1
        if k:
            v = new_voice(meas)
            start = float(notes[k].offset)
            for n in notes[k:]:
                o = float(n.offset) - start
                c.remove(n); v.insert(o, n)
            meas.insert(0, v)
            done = [f'{-gap:g} beats too long: split into voices']
            for layer in (c, v):
                f = _fill(layer, want, False, meas)
                if f: done.append(f)
            return '; '.join(done)
    for n in reversed(notes):  # no way to split: shorten the last notes (their words stay on the bar's notes)
        if gap > -0.01: break
        ql = float(n.quarterLength)
        if ql > -gap + 0.01: n.quarterLength = ql + gap; gap = 0
        elif n.isRest: c.remove(n); gap += ql
        else: n.quarterLength = ql / 2; gap += ql / 2
    return 'too long: shortened'


def one_voice_each(meas):
    """Notes standing in a bar beside voices go into a voice of their own (MusicXML writing garbles the mix)."""
    loose = _timed(meas)
    if not loose or not list(meas.voices): return
    v = new_voice(meas)
    for n in loose:
        o = float(n.offset); meas.remove(n); v.insert(o, n)
    meas.insert(0, v)


def fill_bars(score):
    """Every bar of every part adds up to its time signature (no short, long or empty bars).
    Returns [{part, bar, fix}] for the bars that were changed."""
    done = []
    for pi, part in enumerate(score.parts):
        for k, meas in enumerate(part.getElementsByClass(m21.stream.Measure)):
            want = bar_len(meas)
            for c in _layers(meas):
                fix = _fill(c, want, k == 0, meas)
                if fix: done.append({'part': pi + 1, 'bar': k + 1, 'fix': fix})
            one_voice_each(meas)
    return done


def bars_full(score):
    """[(part, bar)] whose notes and rests don't add up to the time signature (empty when all are full)."""
    bad = []
    for pi, part in enumerate(score.parts):
        for k, meas in enumerate(part.getElementsByClass(m21.stream.Measure)):
            for c in _layers(meas):
                if abs(sum(float(n.quarterLength) for n in _timed(c)) - bar_len(meas)) > 0.01: bad.append((pi + 1, k + 1))
    return bad


def bar_boxes(png, xml_path, nbars):
    """{homr bar index: [x0, y0, x1, y1]}: where each bar is printed on the page (image pixels), from homr's note
    positions, the staves and the bar lines between them."""
    import numpy as np
    try:
        st = staves(png)
        pos = note_positions(xml_path)
    except Exception:
        return {}
    st = st or staves(png, 200)  # faint (grey, enlarged) staff lines
    if not st or not pos: return {}
    gap = float(np.median([s[2] for s in st]))
    ink, _ = _ink(png, st)
    H, W = ink.shape
    def staff_of(y): return min(range(len(st)), key=lambda j: abs((st[j][0] + st[j][1]) / 2 - y))
    def bar_lines(si):  # columns inked the whole staff height
        top, bot, _ = st[si]
        col = ink[int(top):int(bot) + 1].mean(0)
        xs = np.flatnonzero(col >= 0.92)
        out = []
        for x in xs:
            if out and x - out[-1][1] <= 2: out[-1][1] = x
            else: out.append([x, x])
        return [(a + b) / 2 for a, b in out if b - a <= 0.6 * gap]
    def ends(si):  # where the staff lines start and stop
        xs = np.flatnonzero(ink[int(round(st[si][0]))])
        return (float(xs[0]), float(xs[-1])) if xs.size else (0.0, float(W))
    by = {}
    for mi, off, sn, x, y in pos:
        by.setdefault(mi, []).append((x, staff_of(y)))
    lines = {}
    out = {}
    bars = sorted(by)
    for k, mi in enumerate(bars):
        xs = [q[0] for q in by[mi]]
        sis = sorted({q[1] for q in by[mi]})
        si = sis[0]
        xs = [q[0] for q in by[mi] if q[1] == si] or xs
        if si not in lines: lines[si] = bar_lines(si)
        left_end, right_end = ends(si)
        prev = by[bars[k - 1]] if k and min(q[1] for q in by[bars[k - 1]]) == si else None  # the bar before, on this line
        nxt = by[bars[k + 1]] if k + 1 < len(bars) and min(q[1] for q in by[bars[k + 1]]) == si else None
        lo = max(q[0] for q in prev) if prev else left_end
        hi = min(q[0] for q in nxt) if nxt else right_end
        cand_l = [b for b in lines[si] if lo - gap <= b <= min(xs)]
        cand_r = [b for b in lines[si] if max(xs) <= b <= hi + gap]
        x0 = max(cand_l) if cand_l else (lo + min(xs)) / 2 if lo != left_end else left_end
        x1 = min(cand_r) if cand_r else (hi + max(xs)) / 2 if hi != right_end else right_end
        top = st[si][0]
        bot = st[sis[-1]][1]
        nxt_top = next((t for t, b, g in st if t > bot + gap), H)
        out[mi] = [int(max(0, x0 - 0.3 * gap)), int(max(0, top - 4 * gap)), int(min(W, x1 + 0.3 * gap)), int(min(H, bot + 4.5 * gap, nxt_top - 4 * gap) if nxt_top < H else min(H, bot + 4.5 * gap))]
    return {mi: b for mi, b in out.items() if mi < nbars}


REASONS = (  # what was done to a bar → a short plain reason for "bars to check"
    ('three notes made a triplet', 'triplet added to make the bar add up'),
    ('split into voices', 'bar was too long — split into 2 voices'),
    ('rest added', 'rest added to fill the bar'),
    ('missing dot', 'dot added to make the bar add up'),
    ('shortened', 'bar was too long — last notes shortened'),
    ('empty', 'empty bar — whole-bar rest added'),
    ('pickup', 'short first bar — rest added in front'),
)


def plain_reason(fix):
    return next((r for k, r in REASONS if k in fix), fix)


def alt_xml(meas, number, want):
    """Another reader's notes for a bar as a MusicXML <measure> (made to add up to `want` quarters; no words)."""
    import copy
    import xml.etree.ElementTree as ET
    m = copy.deepcopy(meas)
    for e in list(m.recurse().getElementsByClass((m21.harmony.ChordSymbol, m21.expressions.TextExpression, m21.spanner.Spanner))):
        m.remove(e, recurse=True)
    for n in m.recurse().notes: n.lyrics = []
    for c in _layers(m): _fill(c, want, False, m)
    one_voice_each(m)
    m.number = number
    s = m21.stream.Score(); p = m21.stream.Part(); p.append(m); s.append(p)
    root = ET.fromstring(m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse())
    x = root.find('.//measure')
    for at in x.findall('attributes'):  # only the note lengths' unit; clef / key / time stay the score's own
        for ch in list(at):
            if ch.tag != 'divisions': at.remove(ch)
    for ch in list(x):
        if ch.tag not in ('attributes', 'note', 'backup', 'forward'): x.remove(ch)
    x.attrib = {'number': str(number)}
    for e in x.iter():  # the other reader's page layout means nothing here
        for k in ('default-x', 'default-y', 'relative-x', 'relative-y', 'width'): e.attrib.pop(k, None)
    return ET.tostring(x, encoding='unicode')


def check_sheet(score, report, merged, pngs):
    """check.json: for every bar to check, why (plain words), where it is printed (page + box in image pixels) and
    the other reader's notes for it (a MusicXML <measure> the app can put in instead)."""
    from PIL import Image
    page_bars = [len(top_part(m).getElementsByClass(m21.stream.Measure)) for m in merged]
    first = [sum(page_bars[:k]) for k in range(len(page_bars))]
    why = {}
    for c in report['check']:
        if c['page'] - 1 < len(first): why.setdefault(first[c['page'] - 1] + c['bar'], []).extend(c['why'])
    for t in report.get('taken', []):
        why.setdefault(first[t['page'] - 1] + t['bar'], []).append("notes taken from the second reader (homr's didn't add up)")
    for t in report.get('filled', []):
        if t['part'] == 1 and not t['fix'].startswith('pickup'):
            why.setdefault(t['bar'], []).extend(plain_reason(f) for f in t['fix'].split('; '))
    bars = list(score.parts[0].getElementsByClass(m21.stream.Measure))
    out = []
    for b in report['unsure']:
        if not 0 < b <= len(bars): continue
        meas = bars[b - 1]
        alts = []
        for src, am in getattr(meas, 'meowsicAlt', None) or []:
            try:
                alts.append({'id': src, 'label': {'audiveris': 'Second reader (Audiveris)', 'homr': 'First reader (homr)'}[src],
                             'musicxml': alt_xml(am, b, getattr(meas, 'meowsicWant', None) or bar_len(meas))})
            except Exception as e:
                report['notes'].append(f'bar {b}: other reading not kept ({e})')
        reasons = list(dict.fromkeys(why.get(b) or ['marked to check']))
        box = getattr(meas, 'meowsicBox', None)
        out.append({'bar': b, 'page': getattr(meas, 'meowsicPage', None), 'box': box, 'reasons': reasons, 'alternatives': alts})
    pages = []
    for k, p in enumerate(pngs, 1):
        with Image.open(p) as im: pages.append({'page': k, 'file': p.name, 'width': im.width, 'height': im.height})
    return {'version': 1, 'pages': pages, 'bars': out}


def unsure_bars(report, page_bars):
    """Score bar numbers (1-based, all pages joined) to check: readers disagreed, or the bar was changed to add up."""
    first = [sum(page_bars[:k]) for k in range(len(page_bars))]
    out = {first[c['page'] - 1] + c['bar'] for c in report['check'] if c['page'] - 1 < len(first)}
    out |= {t['bar'] for t in report.get('filled', []) if not t['fix'].startswith('pickup')}
    out |= {first[t['page'] - 1] + t['bar'] for t in report.get('taken', [])}
    return sorted(out)


def mark_unsure(xml, bars):
    """Keep the bars to check in the MusicXML itself: <miscellaneous-field name="meowsic-check-bars">3 7</...>."""
    if not bars: return xml
    f = f'<miscellaneous><miscellaneous-field name="meowsic-check-bars">{" ".join(map(str, bars))}</miscellaneous-field></miscellaneous>'
    if '</identification>' in xml: return xml.replace('</identification>', f + '</identification>', 1)
    return __import__('re').sub(r'(<part-list\b)', '<identification>' + f + r'</identification>\1', xml, count=1)


def join(scores, title):
    """Append each page's measures after the previous page's, part by part."""
    base = scores[0]
    for s in scores[1:]:
        for pi, part in enumerate(s.parts):
            if pi >= len(base.parts): break
            for meas in part.getElementsByClass(m21.stream.Measure):
                base.parts[pi].append(meas)
            for sp in part.spanners:  # slurs etc. live in the part, not in its bars
                base.parts[pi].insert(0, sp)
    for pi, part in enumerate(base.parts):
        for k, meas in enumerate(part.getElementsByClass(m21.stream.Measure), 1):
            meas.number = k
    base.metadata = base.metadata or m21.metadata.Metadata()
    base.metadata.title = title
    base.metadata.movementName = None
    base.metadata.composer = None
    # homr sometimes puts a chord name in as the title text: drop page text boxes
    for tb in list(base.recurse().getElementsByClass(m21.text.TextBox)):
        base.remove(tb, recurse=True)
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--title', default='')
    ap.add_argument('--first-verse', action='store_true', help='several lines of words under a staff: keep the top one')
    ap.add_argument('pages', nargs='+')
    a = ap.parse_args()
    out = Path(a.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    pngs = []
    for k, p in enumerate(a.pages, 1):
        dst = out / f'page{k}{Path(p).suffix.lower()}'
        shutil.copyfile(p, dst); pngs.append(dst)
    report = {'pages': len(pngs), 'check': [], 'notes': []}
    homr = []
    for k, p in enumerate(pngs, 1):
        say('notes', f'Reading the notes on page {k} of {len(pngs)}', progress=(k - 1) / len(pngs))
        x = run_homr(p)
        if not x: raise SystemExit(f'Could not read page {k}')
        homr.append(m21.converter.parse(str(x)))
    say('lyrics', 'Reading lyrics and chord names')
    aud = run_audiveris(pngs, out / 'aud')
    say('check', 'Checking every bar')
    say('chords', 'Reading chord names')
    chords = []
    for p in pngs:
        try: chords.append(chord_names(p, p.with_suffix('.musicxml')))
        except Exception as e: chords.append([]); report['notes'].append(f'chord names: {e}')
    say('words', 'Reading the words')
    words = []
    for p in pngs:
        try: words.append(lyric_words(p, p.with_suffix('.musicxml'), a.first_verse))
        except Exception as e: words.append(None); report['notes'].append(f'words: {e}')
    carries = [{} for _ in pngs]
    merged = [merge_page(h, aud.get(p.stem), k, report, ch, wd, empty_bars(p.with_suffix('.musicxml')), p, cr)
              for k, (h, p, ch, wd, cr) in enumerate(zip(homr, pngs, chords, words, carries), 1)]
    for k, cr in enumerate(carries[:-1]):  # a tie running off a page ends on the next page's first note
        n1 = cr.get('tie_out')
        nxt = merged[k + 1].parts
        if n1 is None or not nxt: continue
        first = next((q[3] for q in _sequence(nxt[0])), None)
        if first is not None and not tied(n1, first) and tie(n1, first): report.setdefault('arcs', []).append({'page': k + 2, 'ties': 1, 'slurs': 0})
    score = join(merged, a.title)
    report['bars'] = len(score.parts[0].getElementsByClass(m21.stream.Measure))
    report['filled'] = fill_bars(score)  # every bar adds up to its time signature (the check marks stay)
    report['notFull'] = bars_full(score)
    report['unsure'] = unsure_bars(report, [len(top_part(m).getElementsByClass(m21.stream.Measure)) for m in merged])
    report['lyrics'] = sum(1 for n in score.recurse().notes if n.lyrics)
    report['ties'] = sum(1 for n in score.recurse().notes if not isinstance(n, m21.harmony.ChordSymbol) and n.tie is not None and n.tie.type == 'start')
    report['slurs'] = len(score.recurse().getElementsByClass(m21.spanner.Slur))
    score.write('musicxml', fp=str(out / 'score.musicxml'))
    x = (out / 'score.musicxml').read_text()
    x = __import__('re').sub(r'<creator type="composer">Music21</creator>\s*', '', x)
    x = mark_unsure(x, report['unsure'])
    (out / 'score.musicxml').write_text(x)
    try: (out / 'check.json').write_text(json.dumps(check_sheet(score, report, merged, pngs), ensure_ascii=False, indent=1))
    except Exception as e: report['notes'].append(f'check.json: {e}')
    (out / 'report.json').write_text(json.dumps(report, indent=1))
    say('done', f"{report['bars']} bars, {len(report['check'])} to check", report=report)


if __name__ == '__main__':
    main()
