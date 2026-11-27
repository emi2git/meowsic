#!/usr/bin/env python3
"""Burned-in subtitles of a video -> lines with on-screen times (Apple Vision OCR, all local).

usage: video-subtitle-ocr.py VIDEO OUT.json [--fps 4] [--crop W:H:X:Y] [--lang en-US]
Frames are sampled with ffmpeg (crop = the subtitle strip), each is OCR'd, and consecutive identical
lines are merged: [{start, end, text, conf}]. Run with a python that has pyobjc-framework-Vision
(e.g. ~/git/apps/meowsic/omr/.venv/bin/python)."""
import argparse, json, subprocess, tempfile, difflib
from pathlib import Path


def ocr(path, langs):
    import Vision
    from Foundation import NSURL
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)
    req.setUsesLanguageCorrection_(True)
    req.setRecognitionLanguages_(list(langs))
    hd = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), None)
    hd.performRequests_error_([req], None)
    out = []
    for r in req.results() or []:
        c = r.topCandidates_(1)[0]
        bb = r.boundingBox()
        out.append((-(bb.origin.y), bb.origin.x, str(c.string()), float(c.confidence())))
    out.sort()
    return ' '.join(t for _, _, t, _ in out).strip(), (min(c for *_, c in out) if out else 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video'); ap.add_argument('out')
    ap.add_argument('--fps', type=float, default=4)
    ap.add_argument('--crop', default='1200:100:360:850')
    ap.add_argument('--lang', action='append')
    a = ap.parse_args()
    langs = a.lang or ['en-US']
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(['ffmpeg', '-v', 'error', '-i', a.video, '-vf', f'fps={a.fps},crop={a.crop}', f'{td}/f%05d.png'], check=True)
        frames = sorted(Path(td).glob('f*.png'))
        raw = []
        for i, f in enumerate(frames):
            t = i / a.fps
            txt, conf = ocr(f, langs)
            raw.append((t, txt, conf))
    lines = []
    for t, txt, conf in raw:
        if lines and txt and difflib.SequenceMatcher(None, lines[-1]['text'].lower(), txt.lower()).ratio() > 0.85 and lines[-1]['end'] >= t - 1.01 / a.fps:
            L = lines[-1]; L['end'] = t + 1 / a.fps
            L['seen'].append((txt, conf))
            continue
        if not txt: continue
        lines.append({'start': t, 'end': t + 1 / a.fps, 'text': txt, 'conf': conf, 'seen': [(txt, conf)]})
    for L in lines:  # the reading seen most often (ties: highest confidence)
        cnt = {}
        for s, c in L['seen']: cnt.setdefault(s, []).append(c)
        best = max(cnt.items(), key=lambda kv: (len(kv[1]), max(kv[1])))
        L['text'], L['conf'], L['frames'] = best[0], max(best[1]), len(L.pop('seen'))
    Path(a.out).write_text(json.dumps(lines, indent=1, ensure_ascii=False))
    print(f'{len(frames)} frames, {len(lines)} lines')


if __name__ == '__main__':
    main()
