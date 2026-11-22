"""Find screen junk around a sheet-music photo or screenshot and suggest a trim.

Junk = things that are not the music: the ✕ / back button and status bar at the top, the player bar
(play button, page dots, settings, home bar) at the bottom, coloured app or ad bands.
Method: split the page into horizontal bands of ink separated by white gaps, mark bands that hold
staff lines (long horizontal lines) as music, then drop junk bands from the top and bottom edges.
Returns fractions of the page: {'top', 'bottom'} (0..1) plus the reasons; None when nothing to trim.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps

W = 600  # analysis width


def _load(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    h = max(1, round(im.height * W / im.width))
    return np.asarray(im.resize((W, h), Image.BILINEAR), dtype=np.int16)


def _bands(ink_rows, min_gap):
    """[start, end) row runs that hold ink, split where a white gap is at least min_gap rows."""
    rows = np.flatnonzero(ink_rows)
    if not len(rows): return []
    out, s, prev = [], rows[0], rows[0]
    for r in rows[1:]:
        if r - prev > min_gap:
            out.append([s, prev + 1]); s = r
        prev = r
    out.append([s, prev + 1])
    return out


def _trim(a) -> dict | None:
    h, w, _ = a.shape
    gray = a.mean(axis=2)
    sat = a.max(axis=2) - a.min(axis=2)
    bg = np.median(gray)
    dark = gray < bg - 60                       # ink on a light page
    colour = (sat > 60) & (np.abs(gray - bg) > 25)  # app chrome, ads, highlights
    ink = dark | colour
    row_ink = ink.sum(axis=1)
    # a staff line: one row with a long dark run across the page
    line = (gray < bg - 30) & ~colour
    staff_rows = line.sum(axis=1) > 0.4 * w
    bands = _bands(row_ink > max(2, w * 0.004), min_gap=max(3, int(h * 0.012)))
    if len(bands) < 2: return None

    info = []
    for s, e in bands:
        cols = np.flatnonzero(ink[s:e].any(axis=0))
        x0, x1 = (cols[0], cols[-1] + 1) if len(cols) else (0, 0)
        info.append({
            's': s, 'e': e,
            'staff': int(staff_rows[s:e].sum()) >= 4 and colour[s:e].mean() < 0.5,
            'colour': colour[s:e].mean() > 0.25,
            'x0': x0 / w, 'x1': x1 / w,
            'fill': row_ink[s:e].mean() / w,
            'h': (e - s) / h,
        })
    music = [i for i, b in enumerate(info) if b['staff']]
    if not music: return None
    first, last = music[0], music[-1]

    reasons = []
    top = 0
    for b in info[:first]:
        corner = b['x1'] < 0.14 or b['x0'] > 0.86              # ✕, back arrow, page number in a corner
        chrome = b['colour'] or (b['h'] < 0.035 and b['x0'] < 0.12 and b['x1'] > 0.88 and b['fill'] < 0.25)  # status bar
        if b['s'] / h < 0.12 and (corner or chrome):
            top = b['e']; reasons.append('top bar' if chrome else 'corner button')
        else:
            break
    bottom = h
    for b in reversed(info[last + 1:]):
        player = b['x0'] < 0.15 and b['x1'] > 0.85 and b['fill'] < 0.12   # buttons at both sides, gap between
        small = b['h'] < 0.012 and b['x0'] > 0.25 and b['x1'] < 0.75 and b['x1'] - b['x0'] > 0.04  # page dots, home bar (centred, wider than a page number)
        if b['s'] / h > 0.85 and (player or small or b['colour']):
            bottom = b['s']; reasons.append('player bar' if player else 'page dots' if small else 'coloured bar')
        else:
            break
    if not {'top bar', 'player bar', 'page dots', 'coloured bar'} & set(reasons): return None  # a page number alone is not junk
    # even margins: the white space kept above the music ≈ the white space kept below it
    c_top = next((b['s'] for b in info if b['s'] >= top), 0)
    c_bot = max((b['e'] for b in info if b['e'] <= bottom), default=h)
    cap = int(h * 0.035)
    gap_t = c_top - top if top else c_top          # room we may keep above
    gap_b = bottom - c_bot if bottom < h else h - c_bot
    if top and bottom < h: m_t = m_b = min(gap_t, gap_b, cap)
    elif top: m_t = min(gap_t, cap, h - c_bot); m_b = None
    else: m_b = min(gap_b, cap, c_top); m_t = None
    t = c_top - m_t if m_t is not None else 0
    bt = c_bot + m_b if m_b is not None else h
    if t <= 0 and bt >= h: return None
    return {'top': round(t / h, 4), 'bottom': round(bt / h, 4), 'reasons': sorted(set(reasons))}


def crop(src, dst, top: float, bottom: float, left: float = 0, right: float = 1):
    im = ImageOps.exif_transpose(Image.open(src))
    w, h = im.size
    box = (round(left * w), round(top * h), round(right * w), round(bottom * h))
    out = im.crop(box)
    fmt = 'PNG' if str(dst).lower().endswith('.png') else 'JPEG'
    if fmt == 'JPEG' and out.mode not in ('RGB', 'L'): out = out.convert('RGB')
    out.save(dst, fmt, **({'quality': 92} if fmt == 'JPEG' else {}))


def _dots(path):
    """The page dots of a reader app under the page: how many, and which one is lit (1-based)."""
    im = ImageOps.exif_transpose(Image.open(path)).convert('L')
    W0, H0 = im.size
    y0 = int(H0 * 0.86)
    g = np.asarray(im.crop((int(W0 * 0.25), y0, int(W0 * 0.75), H0)), dtype=np.int16)
    bg = np.median(g)
    mask = g < bg - 25
    out = None
    for s, e in _bands(mask.any(axis=1), min_gap=2):
        bh = e - s
        if not (H0 * 0.002 <= bh <= H0 * 0.014): continue
        cols = mask[s:e].any(axis=0)
        runs, x = [], 0
        while x < len(cols):
            if cols[x]:
                x1 = x
                while x1 < len(cols) and cols[x1]: x1 += 1
                runs.append((x, x1)); x = x1
            else: x += 1
        if not runs or len(runs) > 20: continue
        if len(runs) == 1 and not (0.4 < (runs[0][0] + runs[0][1]) / 2 / len(cols) < 0.6): continue  # one page: one dot, centred
        if not all(W0 * 0.003 <= r1 - r0 <= W0 * 0.016 and 0.5 <= (r1 - r0) / bh <= 2 for r0, r1 in runs): continue
        centres = [(r0 + r1) / 2 for r0, r1 in runs]
        steps = np.diff(centres)
        if len(steps) > 1 and steps.std() / steps.mean() > 0.2: continue
        shade = [g[s:e, r0:r1][mask[s:e, r0:r1]].mean() for r0, r1 in runs]
        k = int(np.argmin(shade))
        rest = [v for i, v in enumerate(shade) if i != k]
        lit = 1 if len(runs) == 1 else k + 1 if np.median(rest) - shade[k] > 25 else None
        out = {'count': len(runs), 'lit': lit}
    return out


def analyze(path, original=None) -> dict:
    """{'trim': {top, bottom, reasons} | None, 'dots': {count, lit} | None}. Dots come from the
    original photo when the page was trimmed already (the dots are cut off then)."""
    t = _trim(_load(path))
    try: d = _dots(original or path)
    except Exception: d = None
    if t: t = {'top': float(t['top']), 'bottom': float(t['bottom']), 'reasons': t['reasons']}
    return {'trim': t, 'dots': d}
