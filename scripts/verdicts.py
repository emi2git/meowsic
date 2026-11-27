#!/usr/bin/env python3
"""verdicts.py [--json]: the voice verdicts from the takes page (web/takes/), read from Meowsic's feedback.

The page keeps one feedback entry per song + voice (id fb-voice-<song>-<voice>, text
"Voice verdict: <voice> · <song> · approved|rejected|cleared"; older "Voice approved: <voice> (song: <song>)").
Prints song -> voice -> verdict and a per-voice tally (newest entry per song + voice wins).
"""
import json
import re
import ssl
import sys
import urllib.request

URL = 'https://localhost:5180/api/feedback'
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
try:
    rows = json.load(urllib.request.urlopen(URL, context=ctx, timeout=10))
except Exception:
    rows = json.load(urllib.request.urlopen(URL.replace('https', 'http'), timeout=10))
best = {}
for f in rows:
    t = f.get('text') or ''
    m = re.match(r'^Voice verdict: (\S+) · (.+) · (approved|rejected|cleared)$', t)
    if m: voice, song, v = m.groups()
    else:
        m = re.match(r'^Voice approved: (\S+)(?: \(song: (.+)\))?', t)
        if not m: continue
        voice, song, v = ('zh_target' if m[1] == 'take-C' else m[1]), m[2] or 'Amazing Grace', 'approved'
    at = f.get('updatedAt') or f.get('createdAt') or 0
    if (song, voice) not in best or at >= best[(song, voice)][0]: best[(song, voice)] = (at, v)
out, tally = {}, {}
for (song, voice), (_, v) in sorted(best.items()):
    if v == 'cleared': continue
    out.setdefault(song, {})[voice] = v
    a, r = tally.get(voice, (0, 0)); tally[voice] = (a + (v == 'approved'), r + (v == 'rejected'))
if '--json' in sys.argv:
    print(json.dumps({'verdicts': out, 'perVoice': {k: {'approved': a, 'rejected': r} for k, (a, r) in tally.items()}}, ensure_ascii=False, indent=1))
else:
    for song, vs in out.items():
        print(song + ':', ', '.join(f'{k} {"✓" if v == "approved" else "✕"}' for k, v in vs.items()))
    print('per voice:', ', '.join(f'{k}: {a}✓ {r}✕' for k, (a, r) in sorted(tally.items(), key=lambda kv: kv[1][1] - kv[1][0])))
