"""Play chords (score toolbar): web/js/chordplay.js, run in node. Its chord grammar (parse, tones) gives what
chordname.py gives for a list of names; the voicing (bass C2–B2 under a close root-position chord B♭2–A3); the
<harmony> name (name_of); chordEvents holds each chord to the next name or the bar line, struck again on beat 1."""
import json
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from meowsic import chordname

JS = Path(__file__).resolve().parents[2] / 'web' / 'js' / 'chordplay.js'
NODE = shutil.which('node')
pytestmark = pytest.mark.skipif(not NODE, reason='node not installed')

NAMES = ['C', 'Am', 'F/A', 'G7', 'Bb7sus4', 'Cmaj7', 'CM7', 'CΔ7', 'Dm7b5', 'Bø', 'Bø7', 'C°7', 'Cdim', 'C+', 'C+7', 'Caug',
         'Csus', 'Csus2', 'Csus4', 'Csus7', 'C6', 'Cm6', 'C6/9', 'C69', 'C9', 'Cmaj9', 'Cm9', 'C11', 'C13', 'Cadd9',
         'C(add9)', 'C7b9', 'C7#9', 'C7#11', 'C7b5', 'Cm(maj7)', 'CmM7', 'F#m7/C#', 'Ebmaj7', 'Ab', 'Db/F', 'C5', 'N.C.',
         'NC', 'C♭', 'B♭m', 'H', 'Xyz', '', 'Gm7/F', 'E7sus', 'Amin7', 'Cmi']


def node(code):
    r = subprocess.run([NODE, '--input-type=module', '-e', f"import * as cp from {json.dumps(JS.as_uri())};\n{code}"],
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_parse_and_tones_match_chordname():
    js = node(f"const out = {{}}; for (const n of {json.dumps(NAMES)}) {{ const p = cp.parse(n); out[n] = [p, p ? cp.tones(p) : null]; }}"
              " console.log(JSON.stringify(out));")
    for n in NAMES:
        p = chordname.parse(n)
        t = chordname.tones(p) if p else None
        assert js[n][0] == p, (n, js[n][0], p)
        assert js[n][1] == (list(t[:1]) + [list(t[1]), t[2]] if t else None), (n, js[n][1], t)


def test_voicing():
    v = node("console.log(JSON.stringify(Object.fromEntries(['C', 'Am', 'G7', 'F/A', 'Bb', 'A', 'B/D#', 'C9', 'N.C.', 'Xyz']"
             ".map((n) => [n, cp.voicing(n)]))))")
    assert v['C'] == {'bass': 36, 'upper': [48, 52, 55]}       # C2 under C3 E3 G3
    assert v['Am'] == {'bass': 45, 'upper': [57, 60, 64]}      # A2 under A3 C4 E4
    assert v['G7'] == {'bass': 43, 'upper': [55, 59, 62, 65]}  # G2 under G3 B3 D4 F4
    assert v['F/A'] == {'bass': 45, 'upper': [53, 57, 60]}     # the slash bass
    assert v['Bb'] == {'bass': 34, 'upper': [46, 50, 53]}      # B♭1: the bass stays under the chord
    assert v['C9'] == {'bass': 36, 'upper': [48, 50, 52, 58]}  # four tones: the fifth goes
    assert v['N.C.'] is None and v['Xyz'] is None
    for name, x in v.items():
        if not x: continue
        assert 30 <= x['bass'] < 48 and x['bass'] < min(x['upper']), name
        assert 46 <= min(x['upper']) <= 57 and max(x['upper']) - min(x['upper']) < 12, name


def test_harmony_name_matches_name_of():
    cases = [
        '<harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>minor-seventh</kind></harmony>',
        '<harmony><root><root-step>F</root-step></root><kind text="maj7">major-seventh</kind><bass><bass-step>A</bass-step></bass></harmony>',
        '<harmony><root><root-step>C</root-step></root><kind text="7♭9">dominant</kind></harmony>',
        '<harmony><root><root-step>C</root-step></root><kind>none</kind></harmony>',
        '<harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>',
        '<harmony><root><root-step>F</root-step><root-alter>1</root-alter></root><kind>minor</kind><bass><bass-step>C</bass-step><bass-alter>1</bass-alter></bass></harmony>',
    ]
    parts = []
    for x in cases:
        h = ET.fromstring(x)
        k = h.find('kind')
        parts.append({'rootStep': h.findtext('root/root-step') or '', 'rootAlter': h.findtext('root/root-alter') or '',
                      'kind': k.text, 'kindText': k.get('text'), 'bassStep': h.findtext('bass/bass-step') or '',
                      'bassAlter': h.findtext('bass/bass-alter') or ''})
    js = node(f"console.log(JSON.stringify({json.dumps(parts)}.map(cp.harmonyName)))")
    assert js == [chordname.name_of(ET.fromstring(x)) for x in cases]


def test_chord_events():
    # bars of 4 at 0, 4, 8, 12; C at 0, G at 2, N.C. at 6, F at 9 to the end (16)
    ev = node("console.log(JSON.stringify(cp.chordEvents([{q: 0, name: 'C'}, {q: 2, name: 'G'}, {q: 6, name: 'N.C.'}, {q: 9, name: 'F'}], [0, 4, 8, 12], 16)))")
    strikes = sorted({(e['q'], e['d'], e['chord']) for e in ev})
    assert strikes == [(0, 2, 'C'), (2, 2, 'G'), (4, 2, 'G'), (9, 3, 'F'), (12, 4, 'F')]
    assert all(e['v'] < 90 for e in ev)  # softer than the melody
    assert sorted(e['n'] for e in ev if e['q'] == 0) == [36, 48, 52, 55]
