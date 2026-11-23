#!/usr/bin/env python3
"""Sheet page photo(s) → every text line on the page (Apple Vision, on this Mac) + how the staves are grouped.

  meta.py page1.jpg [page2.jpg ...]

Prints one JSON object: {path: {"w", "h", "lines": [{text, x, y, w, h, conf}], "staves": [{top, bottom, gap}],
"systems": [staves per system, ...]}} — boxes as fractions of the page, y from the TOP. A system is staves joined
by a line at their left edge (a piano grand staff = 2, voice + piano = 3, a lead sheet = 1 each).
Used by the server's one-time metadata fill (meowsic/metafill.py) for credits, "from the movie …", chord names
(→ key) and Lead / Piano / Duet. Reads only; nothing leaves the Mac. Runs in omr/.venv (pyobjc)."""
import json
import sys


def read_text(path, langs=('vi-VT', 'en-US')):
    import Vision
    from Foundation import NSURL
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)  # accurate
    req.setUsesLanguageCorrection_(False)  # chord names (Am7, F/C) are not words
    req.setRecognitionLanguages_(list(langs))
    try: req.setAutomaticallyDetectsLanguage_(False)
    except AttributeError: pass
    hd = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), None)
    ok, err = hd.performRequests_error_([req], None)
    if not ok: raise RuntimeError(str(err))
    lines = []
    for o in req.results() or []:
        c = o.topCandidates_(1)[0]
        b = o.boundingBox()  # 0..1, origin bottom-left
        lines.append({'text': str(c.string()), 'x': round(b.origin.x, 4), 'y': round(1 - b.origin.y - b.size.height, 4),
                      'w': round(b.size.width, 4), 'h': round(b.size.height, 4), 'conf': round(float(c.confidence()), 3)})
    lines.sort(key=lambda l: (round(l['y'], 2), l['x']))
    return lines


def staves(path):
    """Five-line staves (top / bottom as fractions of the height, gap = line spacing) and the systems they make."""
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert('L')
        if im.height > 2200: im = im.resize((round(im.width * 2200 / im.height), 2200))
        g = np.asarray(im, dtype=np.int16)
    h, w = g.shape
    dark = g < min(170, int(np.percentile(g, 50)) - 40)
    bands = [dark[:, k * w // 8:(k + 1) * w // 8].sum(axis=1) / (w / 8) for k in range(1, 7)]
    frac = np.maximum.reduce([np.maximum.reduce([b, np.roll(b, 1), np.roll(b, -1)]) for b in bands])
    rows = np.flatnonzero(frac > 0.5)
    lines = []
    for r in rows:
        if lines and r - lines[-1][-1] <= 2: lines[-1].append(r)
        else: lines.append([r])
    ys = [sum(l) / len(l) for l in lines]
    out, i = [], 0
    while i <= len(ys) - 5:
        gaps = [ys[i + k + 1] - ys[i + k] for k in range(4)]
        m = sum(gaps) / 4
        if 0.003 * h < m < 0.04 * h and max(gaps) - min(gaps) <= max(2.5, 0.3 * m):
            out.append((ys[i], ys[i + 4], m)); i += 5
        else: i += 1
    # joined staves: a dark vertical line crosses the gap between them near the left edge (system bar line / brace)
    systems, cur = [], 1
    for (t0, b0, m0), (t1, b1, m1) in zip(out, out[1:]):
        lo, hi = int(b0 + 1), int(t1)
        joined = False
        if hi - lo > 2 and hi - lo < 14 * m0:
            col = dark[lo:hi, : w * 3 // 10]
            frac_col = col.mean(axis=0)
            frac_col = np.maximum.reduce([frac_col, np.roll(frac_col, 1), np.roll(frac_col, -1)])
            joined = bool((frac_col > 0.85).any())
        if joined: cur += 1
        else: systems.append(cur); cur = 1
    if out: systems.append(cur)
    return [{'top': round(t / h, 4), 'bottom': round(b / h, 4), 'gap': round(m / h, 5)} for t, b, m in out], systems


def main():
    out = {}
    for p in sys.argv[1:]:
        try:
            st, sy = staves(p)
            out[p] = {'lines': read_text(p), 'staves': st, 'systems': sy}
        except Exception as e: out[p] = {'error': str(e)[:300]}
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
