#!/usr/bin/env python3
"""Put a sheet's lyrics into a Meowsic score through the live server's Fit lyrics API (undo + .history copy).

The sheet must already be read (POST /api/items/<score>/lyrics/sheet once; cached in work/lyricsfit/).
The fit itself runs here with the lyricsfit code of --repo (default: the checkout this script is in, so a newer aligner can be used before the server
restarts); the save goes through POST /api/items/<score>/lyrics (mode 'this').
Prints counts only, never the words.

  server/.venv/bin/python scripts/sheet-lyrics.py m-7kynu6y s-3hmg922 [--repo DIR] [--dry]
"""
import argparse
import json
import ssl
import sys
import urllib.request
from pathlib import Path

DATA = Path.home() / 'Documents' / 'Meowsic'
BASE = 'https://localhost:5180'


def call(method, path, body=None):
    ctx = ssl.create_default_context(cafile=str(DATA / 'certs' / 'meowsic-ca.pem'))
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, context=ctx) as r: return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('score'); ap.add_argument('sheet')
    ap.add_argument('--repo', default=str(Path(__file__).resolve().parents[1]), help='Meowsic checkout (default: this one)')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    sys.path.insert(0, str(Path(a.repo) / 'server'))
    from meowsic import lyricsedit as le

    st = call('POST', f'/api/items/{a.score}/lyrics/sheet', {'sheetId': a.sheet})
    if st.get('status') != 'done': sys.exit(f'sheet not read yet: {st}')
    sheet = call('GET', f'/api/items/{a.sheet}')
    sheet = sheet.get('item', sheet)
    cache = DATA / 'work' / 'lyricsfit' / f"{a.sheet}-{sheet.get('updatedAt') or 0}" / 'out' / 'score.musicxml'
    mel = call('GET', f'/api/items/{a.score}/lyrics')
    score = call('GET', f'/api/items/{a.score}')
    score = score.get('item', score)
    text = (DATA / 'items' / score['folder'] / score['musicxml']).read_text(encoding='utf-8')
    if le.sha(text) != mel['sha']: sys.exit('score file and server disagree')
    res = le.sheet_fit(text, cache.read_text(encoding='utf-8'), mel['line'])
    # a word cut short (a syllable found no note) still reads right
    order = {n['ref']: k for k, n in enumerate(mel['notes'])}
    assign = sorted(res['assign'], key=lambda n: order[n['ref']])
    lost_after = {u['after'] for u in res['unplaced']}
    for k, n in enumerate(assign):
        if n['syllabic'] in ('begin', 'middle') and (k + 1 == len(assign) or n['ref'] in lost_after
                                                     or assign[k + 1]['syllabic'] in ('single', 'begin')):
            n['syllabic'] = 'single' if n['syllabic'] == 'begin' else 'end'
        if n['syllabic'] in ('middle', 'end') and (k == 0 or assign[k - 1]['syllabic'] in ('single', 'end')):
            n['syllabic'] = 'single' if n['syllabic'] == 'end' else 'begin'
    bars = {mel['notes'][order[n['ref']]]['bar'] for n in assign}
    print(json.dumps({'syllables': res['syllables'], 'placed': len(assign), 'sure': sum(n['sure'] for n in assign),
                      'unplaced': len(res['unplaced']), 'barsWithLyrics': len(bars), 'bars': len(mel['bars'])}))
    if a.dry: return
    out = call('POST', f'/api/items/{a.score}/lyrics', {'line': mel['line'], 'verse': '1', 'mode': 'this', 'sha': mel['sha'],
                                                       'notes': [{k: n[k] for k in ('ref', 'text', 'syllabic')} for n in assign], 'holds': []})
    print(json.dumps({'ok': out.get('ok'), 'history': out.get('history'), 'activity': out.get('activity')}))


if __name__ == '__main__':
    main()
