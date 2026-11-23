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


def staves(png):
    """[(top, bottom, line gap)] of every five-line staff on the page."""
    import numpy as np
    from PIL import Image
    g = np.asarray(Image.open(png).convert('L'), dtype=np.int16)
    h, w = g.shape
    hard = (g < 128).sum(axis=1)
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


def merge_page(h, a, page_no, report, chords=None, words=None):
    """Copy lyrics + chord names from Audiveris (a) onto homr (h); mark bars that disagree."""
    hp = top_part(h)
    hm = list(hp.getElementsByClass(m21.stream.Measure)) if hp else []
    if isinstance(hp, m21.stream.PartStaff) or not hm:
        hm = list(h.parts[0].getElementsByClass(m21.stream.Measure))
    am = list(top_part(a).getElementsByClass(m21.stream.Measure)) if a is not None and a.parts else []
    pairs = align(hm, am) if am else {}
    # a homr bar that doesn't add up, where Audiveris read the same bar so it does (and found at least as many
    # notes): Audiveris' notes are taken (homr misreads a beamed run or drops a tied note now and then)
    for i, j in (pairs.items() if not isinstance(hp, m21.stream.PartStaff) else []):
        if i == 0 or not layers_full(am[j]) or layers_full(hm[i]): continue
        if len(real_notes(am[j])) < len(real_notes(hm[i])) or not real_notes(am[j]): continue
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
    drop_empty_bars(h, page_no, report)
    return h


def drop_empty_bars(h, page_no, report):
    """homr writes an empty bar where a first ending stops at a repeat sign: it is not on the page (it would
    play as a bar of silence). A printed whole-bar rest is a rest, so it stays."""
    parts = list(h.parts)
    if not parts: return
    bars = [list(p.getElementsByClass(m21.stream.Measure)) for p in parts]
    gone = [i for i in range(min(len(b) for b in bars))
            if i > 0 and all(not b[i].recurse().notesAndRests for b in bars)]
    for i in reversed(gone):
        for p, b in zip(parts, bars):
            prev, m = b[i - 1], b[i]
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
    # too long: almost always a second voice the reader put after the first (an under-part, a string line);
    # split it into voices that each fill the bar. No note is dropped.
    if meas is not None and len(list(meas.voices)) < 4:
        acc, k = 0.0, 0
        for j, n in enumerate(notes):
            if acc + float(n.quarterLength) > want + 0.01: break
            acc += float(n.quarterLength); k = j + 1
        if k:
            v = m21.stream.Voice(id=str(len(list(meas.voices)) + 2))
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
    v = m21.stream.Voice(id='1')
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
    merged = [merge_page(h, aud.get(p.stem), k, report, ch, wd) for k, (h, p, ch, wd) in enumerate(zip(homr, pngs, chords, words), 1)]
    score = join(merged, a.title)
    report['bars'] = len(score.parts[0].getElementsByClass(m21.stream.Measure))
    report['filled'] = fill_bars(score)  # every bar adds up to its time signature (the check marks stay)
    report['notFull'] = bars_full(score)
    report['unsure'] = unsure_bars(report, [len(top_part(m).getElementsByClass(m21.stream.Measure)) for m in merged])
    report['lyrics'] = sum(1 for n in score.recurse().notes if n.lyrics)
    score.write('musicxml', fp=str(out / 'score.musicxml'))
    x = (out / 'score.musicxml').read_text()
    x = __import__('re').sub(r'<creator type="composer">Music21</creator>\s*', '', x)
    x = mark_unsure(x, report['unsure'])
    (out / 'score.musicxml').write_text(x)
    (out / 'report.json').write_text(json.dumps(report, indent=1))
    say('done', f"{report['bars']} bars, {len(report['check'])} to check", report=report)


if __name__ == '__main__':
    main()
