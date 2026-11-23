#!/usr/bin/env python3
"""Sheet page photo(s) → the text lines on the top part of each page, with their boxes (Apple Vision).

  title.py [--top 0.45] page1.png [page2.jpg ...]
  title.py --refine < {"items": [{"path", "box": [x, y, w, h]}], "words": [...]}


Prints one JSON object: {path: {"w": px, "h": px, "lines": [{text, x, y, w, h, conf}]}} — boxes as
fractions of the page, y from the TOP. Only lines starting in the top part are kept. The server
(meowsic/titles.py) picks the song title from these; this script only reads. Runs in omr/.venv
(pyobjc), so the server's own venv doesn't need it. A page that can't be read gets {"error": ...}.
"""
import argparse
import json
import sys


def read(path, top, langs=('vi-VT', 'en-US')):
    import Vision
    from Foundation import NSURL
    from PIL import Image
    with Image.open(path) as im: w, h = im.size
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)  # accurate
    req.setUsesLanguageCorrection_(True)
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
        y = 1 - b.origin.y - b.size.height
        if y > top: continue
        lines.append({'text': str(c.string()), 'x': round(b.origin.x, 4), 'y': round(y, 4),
                      'w': round(b.size.width, 4), 'h': round(b.size.height, 4), 'conf': round(float(c.confidence()), 3)})
    lines.sort(key=lambda l: (l['y'], l['x']))
    return {'w': w, 'h': h, 'lines': lines, 'staff': first_staff(path)}


def refine(path, box, words=(), langs=('vi-VT', 'en-US')):
    """Read one region again, zoomed in, with language correction (and the library's titles as custom
    words): the title found on the whole page, re-read with all of Vision's attention on its letters.
    The old Meowsic app did this (SheetTextRecognizer.refineTitle). -> {text, conf, cands} (cands: Vision's
    top 3 readings of each line, best first)."""
    import Vision
    from PIL import Image
    from Quartz import CGImageSourceCreateWithData, CGImageSourceCreateImageAtIndex
    from Foundation import NSData
    import io
    with Image.open(path) as im:
        im = im.convert('RGB')
        W, H = im.size
        x, y, w, h = box
        px, py = 0.02, 0.015  # a little room around the title, not the next line
        l, t = max(0, int((x - px) * W)), max(0, int((y - py) * H))
        r, b = min(W, int((x + w + px) * W)), min(H, int((y + h + py) * H))
        crop = im.crop((l, t, r, b))
        if crop.height < 240:  # small letters get more pixels (at most 4x)
            k = min(4.0, 240 / max(1, crop.height))
            crop = crop.resize((round(crop.width * k), round(crop.height * k)), Image.LANCZOS)
        buf = io.BytesIO(); crop.save(buf, 'PNG')
    data = NSData.dataWithBytes_length_(buf.getvalue(), len(buf.getvalue()))
    cg = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(data, None), 0, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)
    req.setUsesLanguageCorrection_(True)
    req.setRecognitionLanguages_(list(langs))
    try: req.setAutomaticallyDetectsLanguage_(False)
    except AttributeError: pass
    if words:
        try: req.setCustomWords_(list(words)[:2000])
        except AttributeError: pass
    hd = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, err = hd.performRequests_error_([req], None)
    if not ok: raise RuntimeError(str(err))
    rows = []
    for o in req.results() or []:
        cs = o.topCandidates_(3)
        bb = o.boundingBox()
        rows.append({'y': 1 - bb.origin.y - bb.size.height, 'x': bb.origin.x, 'h': bb.size.height,
                     'cands': [str(c.string()) for c in cs], 'conf': float(cs[0].confidence()) if len(cs) else 0.0})
    big = max((r['h'] for r in rows), default=0)
    rows = [r for r in rows if r['h'] >= 0.6 * big]  # only the title's own lines (not a credit that crept in)
    rows.sort(key=lambda r: (round(r['y'], 2), r['x']))
    return {'text': ' '.join(r['cands'][0] for r in rows if r['cands']), 'conf': round(min((r['conf'] for r in rows), default=0.0), 3),
            'cands': [r['cands'] for r in rows]}


def first_staff(path):
    """Top of the first five-line staff, as a fraction of the page height from the top (None = none found).
    A song's title is printed above it; on a page that goes on with a song the staff starts near the top."""
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert('L')
        if im.height > 1800: im = im.resize((round(im.width * 1800 / im.height), 1800))
        g = np.asarray(im, dtype=np.int16)
    h, w = g.shape
    dark = g < min(170, int(np.percentile(g, 50)) - 40)
    # staff lines can be slightly tilted in photos: count dark pixels per row in a few vertical bands
    bands = [dark[:, k * w // 8:(k + 1) * w // 8].sum(axis=1) / (w / 8) for k in range(1, 7)]
    frac = np.maximum.reduce([np.maximum.reduce([b, np.roll(b, 1), np.roll(b, -1)]) for b in bands])
    rows = np.flatnonzero(frac > 0.5)
    lines = []
    for r in rows:
        if lines and r - lines[-1][-1] <= 2: lines[-1].append(r)
        else: lines.append([r])
    ys = [sum(l) / len(l) for l in lines]
    for i in range(len(ys) - 4):
        gaps = [ys[i + k + 1] - ys[i + k] for k in range(4)]
        m = sum(gaps) / 4
        if 0.004 * h < m < 0.04 * h and max(gaps) - min(gaps) <= max(2.5, 0.3 * m):
            return round(ys[i] / h, 4)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=float, default=0.45)
    ap.add_argument('--refine', action='store_true')
    ap.add_argument('pages', nargs='*')
    a = ap.parse_args()
    out = {}
    if a.refine:
        job = json.load(sys.stdin)
        for k, it in enumerate(job.get('items', [])):
            try: out[str(k)] = refine(it['path'], it['box'], job.get('words') or ())
            except Exception as e: out[str(k)] = {'error': str(e)[:300]}
        json.dump(out, sys.stdout, ensure_ascii=False)
        return
    for p in a.pages:
        try:
            out[p] = read(p, a.top)
            # nothing big read with confidence: maybe the title is Japanese / Chinese / Korean (Ghibli books)
            if not any(l['conf'] >= 0.6 and l['h'] >= 0.018 and sum(ch.isalpha() for ch in l['text']) >= 2 for l in out[p]['lines']):
                cjk = read(p, a.top, ('ja-JP', 'zh-Hans', 'ko-KR', 'en-US'))
                if any(l['conf'] >= 0.6 and any(ord(ch) > 0x2e80 for ch in l['text']) for l in cjk['lines']): out[p] = cjk
        except Exception as e: out[p] = {'error': str(e)[:300]}
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
