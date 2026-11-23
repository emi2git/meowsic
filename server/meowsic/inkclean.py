"""Take coloured marks off a sheet page before it is read as a score (OMR).

Music is printed in black. A pen / pencil line drawn on the page, a highlighter stroke or a coloured guide
line confuses the note reader (a red line across a staff reads as a stem, a beam or a ledger line), so:

1. The paper is evened out first (yellowed paper, scanner tint, shade across a photo): each channel is
   divided by the local paper colour, so white paper is white and black ink stays black.
2. A pixel is "clearly coloured" when its colour strength (max - min of R, G, B) is high; a lower bar is
   used next to a clearly coloured pixel so the soft edge of a stroke goes too. The faint colour fringes
   JPEG puts around black ink stay under both bars.
3. Coloured pieces are sorted by shape: a long thin stroke (a line) and a big light patch (highlighter) are
   taken off. Small coloured pieces are kept: coloured words and chord names are part of the song.
4. Where a removed line crossed a staff line or a stem the black ink is joined up again.

Nothing else changes; the cleaned page is a new file (the original is never touched).
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

SEED = 70     # colour strength (0..255) of a clearly coloured pixel
GROW = 35     # ... of the soft edge of a coloured stroke
ANALYSE = 1600  # longest side the shapes are judged at
MIN_SIDE = 2000  # pages smaller than this are enlarged before reading


def _paper(rgb: np.ndarray) -> np.ndarray:
    """The page with the paper colour divided out (float 0..255)."""
    h, w, _ = rgb.shape
    k = max(1, max(w, h) // 64)  # paper is judged over ~1/9 of the page: a highlighter band is not paper
    small = Image.fromarray(rgb).resize((max(1, w // k), max(1, h // k)), Image.BOX)
    bg = small.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(2)).resize((w, h), Image.BILINEAR)
    bg = np.maximum(np.asarray(bg, dtype=np.float32), 60)  # a dark area is not paper: don't blow it up
    return np.clip(rgb.astype(np.float32) * (255.0 / bg), 0, 255)


def _strength(a: np.ndarray) -> np.ndarray:
    return a.max(2) - a.min(2)


def _components(mask: np.ndarray):
    """8-connected pieces of a boolean mask: yields arrays of (row, col)."""
    seen = np.zeros_like(mask, dtype=bool)
    H, W = mask.shape
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]: continue
        seen[r0, c0] = True
        q, pts = deque([(r0, c0)]), []
        while q:
            r, c = q.popleft(); pts.append((r, c))
            for dr in (-1, 0, 1):
                rr = r + dr
                if rr < 0 or rr >= H: continue
                for dc in (-1, 0, 1):
                    cc = c + dc
                    if 0 <= cc < W and mask[rr, cc] and not seen[rr, cc]:
                        seen[rr, cc] = True; q.append((rr, cc))
        yield np.array(pts)


def _shift_or(m: np.ndarray, k: int, axis: int, op) -> np.ndarray:
    """Dilate (op=np.logical_or) / erode (np.logical_and) a mask along one axis by a k-long bar."""
    out = m.copy()
    n = m.shape[axis]
    for d in range(-(k // 2), k // 2 + 1):
        if d == 0 or abs(d) >= n: continue
        src = [slice(None)] * 2; dst = [slice(None)] * 2
        src[axis] = slice(max(0, -d), n - max(0, d)); dst[axis] = slice(max(0, d), n - max(0, -d))
        shifted = np.zeros_like(m) if op is np.logical_or else np.ones_like(m)
        shifted[tuple(dst)] = m[tuple(src)]
        out = op(out, shifted)
    return out


def _close(mask: np.ndarray, k: int = 5) -> np.ndarray:
    """Small gaps closed in any direction (a staff line or stem printed over a stroke)."""
    m = Image.fromarray(mask.astype(np.uint8) * 255)
    return (np.asarray(m.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))) > 0) | mask


def _bridge(mask: np.ndarray, k: int) -> np.ndarray:
    """Gaps up to k long closed along rows and along columns (a note head printed over a pen line)."""
    out = _close(mask)
    for axis in (0, 1):
        out |= _shift_or(_shift_or(mask, k, axis, np.logical_or), k, axis, np.logical_and)
    return out


def _thin(pts: np.ndarray, W: int) -> np.ndarray:
    """Which of the points lie on a one-pen-width stroke: the columns (rows, for an upright piece) where the
    piece is one short run. A word or a chord name sitting on a line is not."""
    r, c = pts[:, 0], pts[:, 1]
    along, across = (c, r) if np.ptp(c) >= np.ptp(r) else (r, c)
    thin = max(3, 0.006 * W)
    order = np.lexsort((across, along))
    a_s, x_s = along[order], across[order]
    starts = np.flatnonzero(np.r_[True, a_s[1:] != a_s[:-1]])
    ends = np.r_[starts[1:], len(a_s)]
    ok = np.zeros(len(pts), dtype=bool)
    for s, e in zip(starts, ends):
        x = x_s[s:e]
        if e - s <= thin and (e - s == 1 or np.all(np.diff(x) == 1)): ok[order[s:e]] = True
    return ok


def _is_line(pts: np.ndarray, W: int, min_len: float = 0.08) -> bool:
    """A long stroke one pen-width thick (any direction, wobbly is fine); words are not."""
    r, c = pts[:, 0], pts[:, 1]
    n = max(np.ptp(r), np.ptp(c)) + 1
    if n < max(12, min_len * W): return False
    along = c if np.ptp(c) >= np.ptp(r) else r
    cover = len(np.unique(along))
    single = len(np.unique(along[_thin(pts, W)]))
    return cover >= 0.6 * n and single >= 0.8 * cover


def _is_marks(pts: np.ndarray, W: int) -> bool:
    """Crossing lines / a loop drawn round something: big but almost empty inside its box (words are dense)."""
    r, c = pts[:, 0], pts[:, 1]
    h, w = r.max() - r.min() + 1, c.max() - c.min() + 1
    return max(h, w) >= max(40, 0.08 * W) and min(h, w) >= 0.03 * W and len(pts) < 0.06 * h * w


def _is_patch(pts: np.ndarray, mine: np.ndarray, light: np.ndarray, H: int, W: int) -> bool:
    """A big, solid, light coloured area (highlighter, a tinted band). `pts`: the area with the black ink it
    covers closed over; `mine`: its coloured pixels."""
    if len(mine) < 0.001 * H * W: return False
    r, c = pts[:, 0], pts[:, 1]
    box = (r.max() - r.min() + 1) * (c.max() - c.min() + 1)
    return len(mine) >= 0.5 * box and float(light[mine[:, 0], mine[:, 1]].mean()) > 170


def _rejoin(out: np.ndarray, removed: np.ndarray, gap: int):
    """Black ink cut by a removed stroke: fill short removed runs whose both ends are dark."""
    lum = out.mean(2)
    for axis in (1, 0):
        rem = removed if axis == 1 else removed.T
        img = out if axis == 1 else out.transpose(1, 0, 2)
        L = lum if axis == 1 else lum.T
        for i in np.flatnonzero(rem.any(1)):
            row = rem[i]
            d = np.diff(np.r_[0, row.astype(np.int8), 0])
            for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
                if e - s > gap or s == 0 or e >= len(row): continue
                if L[i, s - 1] < 110 and L[i, e] < 110:
                    img[i, s:e] = ((img[i, s - 1].astype(np.int16) + img[i, e]) // 2).astype(np.uint8)


def clean(src, dst, debug: str | Path | None = None) -> dict:
    """Write the page `src` without its coloured lines / highlighter to `dst` (PNG).
    Returns {'lines', 'patches', 'pixels'} (pixels: share of the page whitened). `debug`: where to save the
    removed marks (red on white) when something was removed."""
    im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
    rgb = np.asarray(im, dtype=np.uint8)
    H, W, _ = rgb.shape
    norm = _paper(rgb)
    st = _strength(norm)
    low = st >= GROW
    # judge shapes on a smaller copy
    f = min(1.0, ANALYSE / max(H, W))
    h, w = max(1, round(H * f)), max(1, round(W * f))
    st_s = np.asarray(Image.fromarray(st.astype(np.uint8)).resize((w, h), Image.BOX), dtype=np.int16)
    light_s = np.asarray(Image.fromarray(norm.mean(2).astype(np.uint8)).resize((w, h), Image.BOX), dtype=np.int16)
    low_s = st_s >= GROW
    # clearly coloured, and not the colour fringe round black ink (JPEG, screen text rendering)
    ink = (light_s < 100) & (st_s < GROW)
    near_ink = np.asarray(Image.fromarray(ink.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0
    seed_s = (st_s >= SEED) & ~near_ink
    drop = np.zeros((h, w), dtype=bool)
    strokes = np.zeros((h, w), dtype=bool)
    lines, patch_areas = 0, []
    for pts in _components(_close(low_s)):
        mine = pts[low_s[pts[:, 0], pts[:, 1]]]
        if len(mine) < 12: continue
        if _is_line(pts, w, 0.02):  # seeds judged per line below
            t = pts[_thin(pts, w)]
            strokes[t[:, 0], t[:, 1]] = low_s[t[:, 0], t[:, 1]]; continue
        if seed_s[mine[:, 0], mine[:, 1]].mean() < 0.15: continue
        if _is_marks(mine, w): lines += 1; drop[mine[:, 0], mine[:, 1]] = True
        elif _is_patch(pts, mine, light_s, h, w): patch_areas.append(pts)
    # pieces of one pen line cut apart by note heads: long together
    for grp in _components(_bridge(strokes, max(5, round(0.02 * w)) | 1)):
        r, c = grp[:, 0], grp[:, 1]
        if max(r.max() - r.min(), c.max() - c.min()) + 1 < max(40, 0.08 * w): continue
        mine = strokes[r, c]
        if seed_s[r[mine], c[mine]].mean() < 0.15: continue  # colour fringe along a staff line, not a pen line
        lines += 1
        drop[r[mine], c[mine]] = True
    out = rgb.copy()
    if not lines and not patch_areas:
        Image.fromarray(out).save(dst)
        return {'lines': 0, 'patches': 0, 'pixels': 0.0}
    up = lambda m, k=3: np.asarray(Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(k)).resize((W, H), Image.NEAREST)) > 0
    removed = up(drop) & ((st >= GROW) | (_strength(rgb.astype(np.int16)) >= GROW))
    # the soft light edge around a removed stroke
    edge = np.asarray(Image.fromarray(removed.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0
    halo = edge & ~removed & (norm.mean(2) > 150)
    out[removed | halo] = 255
    _rejoin(out, removed, gap=max(4, round(0.008 * W)))
    # highlighter is see-through: divide its colour out, so the print under it comes back as it was
    for pts in patch_areas:
        a = np.zeros((h, w), dtype=bool); a[pts[:, 0], pts[:, 1]] = True
        area = up(a, 5)
        area &= _strength(rgb.astype(np.int16)) >= 20  # tinted pixels only: plain black / grey ink round it stays
        if not area.any(): continue
        px = rgb[area].astype(np.float32)
        tint = np.median(px[px.mean(1) >= np.percentile(px.mean(1), 50)], axis=0)  # the highlighter on bare paper
        out[area] = np.clip(px * (255.0 / np.maximum(tint, 1)), 0, 255).mean(1, keepdims=True).astype(np.uint8)
        removed |= area
    Image.fromarray(out).save(dst)
    if debug:
        dbg = np.full_like(rgb, 255); dbg[removed] = (220, 30, 30)
        Image.fromarray(dbg).save(debug)
    return {'lines': lines, 'patches': len(patch_areas), 'pixels': round(float(removed.mean()), 5)}


def prepare_page(src, work: Path, k: int, box: dict | None = None) -> tuple[Path, dict]:
    """A sheet page made ready for reading: junk trimmed off (box from trim.analyze), coloured marks taken off.
    Work files (the original is never touched): in<k>-raw.png (trimmed), in<k>.png (cleaned, read by OMR),
    in<k>-ink.png (what was taken off, only when something was)."""
    from . import trim
    box = box or {}
    raw, dst = work / f'in{k}-raw.png', work / f'in{k}.png'
    trim.crop(src, raw, box.get('top', 0), box.get('bottom', 1))
    try: r = clean(raw, dst, debug=work / f'in{k}-ink.png')
    except Exception as e:  # never block reading the sheet over this
        import shutil; shutil.copyfile(raw, dst); r = {'lines': 0, 'patches': 0, 'pixels': 0.0, 'error': str(e)}
    # a small picture (a web image, a phone screenshot): enlarge it, the readers miss small notes and words
    im = Image.open(dst)
    if max(im.size) < MIN_SIDE:
        f = MIN_SIDE / max(im.size)
        im.convert('RGB').resize((round(im.width * f), round(im.height * f)), Image.LANCZOS).save(dst)
        r['enlarged'] = round(f, 2)
    return dst, r


def said(k: int, r: dict) -> str | None:
    """A log line for what was taken off page k (None when nothing was)."""
    bits = [f"{r['lines']} coloured line{'s' if r['lines'] != 1 else ''}" if r.get('lines') else '',
            f"{r['patches']} highlight{'s' if r['patches'] != 1 else ''}" if r.get('patches') else '']
    bits = [b for b in bits if b]
    return f"Page {k}: took off {' and '.join(bits)} before reading" if bits else None
