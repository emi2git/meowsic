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


def analyze(path) -> dict | None:
    a = _load(path)
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
        small = b['h'] < 0.012 and b['x0'] > 0.25 and b['x1'] < 0.75       # page dots, home bar (centred)
        if b['s'] / h > 0.85 and (player or small or b['colour']):
            bottom = b['s']; reasons.append('player bar' if player else 'page dots' if small else 'coloured bar')
        else:
            break
    if not {'top bar', 'player bar', 'page dots', 'coloured bar'} & set(reasons): return None  # a page number alone is not junk
    pad = int(h * 0.008)
    t = max(0, top + pad) if top else 0
    bt = min(h, bottom - pad) if bottom < h else h
    # never cut into the music: keep the gap above the first staff band and below the last
    nxt = next((b['s'] for b in info if b['s'] >= top), 0)
    prv = max((b['e'] for b in info if b['e'] <= bottom), default=h)
    t = min(t, max(0, nxt - pad)) if top else 0
    bt = max(bt, min(h, prv + pad)) if bottom < h else h
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
