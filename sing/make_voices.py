"""Turn downloaded, annotated singing clips into SoulX-Singer prompt voices (<name>.wav + <name>.json, the format of
SoulX-Singer's example/audio/*.json) in ~/ai/models/singer-voices/voices. The clips themselves are not in git.

usage (SoulX venv):
  python -I make_voices.py eval   ANNOT.word.prompt.jsonl AUDIO_DIR ITEM=NAME [ITEM=NAME ...]
  python -I make_voices.py gts    CLIP.json NAME [--max 14]       (GTSinger: CLIP.wav next to CLIP.json)
  options: --cedict FILE (CC-CEDICT, char -> pinyin for Mandarin), --out DIR, --max seconds, --min seconds

Sources: SoulX-Singer-Eval prompt set (Soul-AILab, CC BY-NC 4.0) word-level notes; GTSinger (CC BY-NC-SA 4.0)
word / phoneme / note annotations. Each note -> one prompt note: lyric word + its phonemes (en_ ARPAbet joined by
'-', zh_ pinyin + tone), MIDI pitch, type (1 rest, 2 lyric, 3 slur). f0 at 50 fps from WORLD harvest. Long clips are
cut at a rest so the prompt stays MIN..MAX s.
"""
import argparse
import json
import re
import sys
from pathlib import Path

VOICES_DIR = Path.home() / 'ai' / 'models' / 'singer-voices' / 'voices'
CEDICT = Path.home() / 'git' / 'apps' / 'meowzi' / 'Tools' / 'work' / 'cedict.txt'
SR = 24000


def cedict(path):
    m = {}
    for line in open(path, encoding='utf-8'):
        if line.startswith('#'): continue
        g = re.match(r'(\S+) (\S+) \[([^\]]+)\]', line)
        if not g or len(g[2]) != 1: continue
        m.setdefault(g[2], []).append(g[3].lower().replace('u:', 'v'))
    return m


def notes_from_eval(it, g2p, zh):
    """eval word annotation -> [(text, phoneme, dur, pitch, type)]"""
    out, prev = [], None
    for w, d, p, t in zip(it['note_text'], it['note_dur'], it['note_pitch'], it['note_type']):
        if w in ('<SP>', '<AP>') or t == 1:
            out.append(['<SP>', '<SP>', d, 0, 1]); prev = None; continue
        if t == 3 and prev:
            ph = prev
        elif re.fullmatch(r'[一-鿿]', w):
            ph = 'zh_' + zh(w)
        else:
            ph = 'en_' + '-'.join(g2p(w))
        out.append([w, ph, d, p, 3 if (t == 3 and prev) else 2]); prev = ph
    return out


def notes_from_gts(words):
    out = []
    for w in words:
        if w['word'] in ('<SP>', '<AP>'):
            out.append(['<SP>', '<SP>', w['end_time'] - w['start_time'], 0, 1]); continue
        ph = 'en_' + '-'.join(w['ph'])
        for k, (p, a, b) in enumerate(zip(w['note'], w['note_start'], w['note_end'])):
            if p == 0:
                out.append(['<SP>', '<SP>', b - a, 0, 1]); continue
            out.append([w['word'], ph, b - a, p, 2 if k == 0 else 3])
    return out


def fix_pitch(notes):
    """annotation glitches (e.g. pitch 5) -> the neighbouring note's pitch"""
    ps = [n[3] for n in notes if n[3] > 0]
    if not ps: return
    med = sorted(ps)[len(ps) // 2]
    last = med
    for n in notes:
        if n[3] > 0:
            if abs(n[3] - med) > 18: n[3] = last
            last = n[3]


def cut(notes, lo, hi):
    """first MIN..MAX s ending on a rest (or the whole clip if it fits)"""
    tot = sum(n[2] for n in notes)
    if tot <= hi: return notes
    cum, best = 0, None
    for i, n in enumerate(notes):
        cum += n[2]
        if n[4] == 1 and lo <= cum <= hi: best = i + 1
    if best is None:  # no rest in range: cut after the last note that ends before MAX
        cum = 0
        for i, n in enumerate(notes):
            cum += n[2]
            if cum > hi: break
            best = i + 1
    return notes[:best]


def write_voice(name, wav, notes, out, lang, src):
    import numpy as np
    import librosa
    import soundfile as sf
    import pyworld as pw
    y, _ = librosa.load(str(wav), sr=SR, mono=True)
    dur = sum(n[2] for n in notes)
    y = y[:int(round(dur * SR))]
    y = y / max(1e-6, float(np.max(np.abs(y)))) * 0.9
    f0, _ = pw.harvest(y.astype(np.float64), SR, f0_floor=60.0, f0_ceil=1100.0, frame_period=20.0)
    out.mkdir(parents=True, exist_ok=True)
    sf.write(out / f'{name}.wav', y, SR)
    meta = {'index': name, 'language': lang, 'time': [0, int(round(dur * 1000))],
            'duration': ' '.join(f'{n[2]:.3f}' for n in notes), 'text': ' '.join(n[0] for n in notes),
            'phoneme': ' '.join(n[1] for n in notes), 'note_pitch': ' '.join(str(int(n[3])) for n in notes),
            'note_type': ' '.join(str(n[4]) for n in notes), 'f0': ' '.join(f'{v:.1f}' for v in f0), 'source': src}
    (out / f'{name}.json').write_text(json.dumps([meta], ensure_ascii=False, indent=1))
    ps = [n[3] for n in notes if n[3] > 0]
    print(f'{name}: {dur:.1f} s, {len(notes)} notes, median MIDI {sorted(ps)[len(ps) // 2]}, {lang}: ' +
          ' '.join(dict.fromkeys(n[0] for n in notes if n[0] != '<SP>')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('kind', choices=('eval', 'gts'))
    ap.add_argument('args', nargs='+')
    ap.add_argument('--out', default=str(VOICES_DIR))
    ap.add_argument('--cedict', default=str(CEDICT))
    ap.add_argument('--min', type=float, default=5.0)
    ap.add_argument('--max', type=float, default=14.0)
    a = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from sing import make_g2p, SOULX
    g2p = make_g2p()
    phones = set(json.loads((SOULX / 'soulxsinger' / 'utils' / 'phoneme' / 'phone_set.json').read_text()))
    out = Path(a.out)
    if a.kind == 'eval':
        ann, aud = Path(a.args[0]), Path(a.args[1])
        want = dict(x.split('=') for x in a.args[2:])
        cd = None
        for line in open(ann, encoding='utf-8'):
            it = json.loads(line)
            if it['item_name'] not in want: continue
            if it['language'] == 'Chinese' and cd is None: cd = cedict(a.cedict)

            def zh(ch):
                for r in cd.get(ch, []) if cd else []:
                    if 'zh_' + r in phones: return r
                return 'a1'
            notes = notes_from_eval(it, g2p, zh)
            fix_pitch(notes)
            notes = cut(notes, a.min, a.max)
            for n in notes:  # an unknown phoneme -> breath, as sing.py does
                if n[1] != '<SP>' and not all(x in phones for x in (['en_' + p for p in n[1][3:].split('-')] if n[1].startswith('en_') else [n[1]])):
                    n[1], n[4] = '<SP>', 1
            name = want[it['item_name']]
            write_voice(name, aud / Path(it['wav_fn']).name, notes, out,
                        'Mandarin' if it['language'] == 'Chinese' else 'English', f'SoulX-Singer-Eval {it["item_name"]}')
    else:
        js, name = Path(a.args[0]), a.args[1]
        notes = notes_from_gts(json.loads(js.read_text()))
        fix_pitch(notes)
        notes = cut(notes, a.min, a.max)
        for n in notes:
            if n[1] != '<SP>' and not all(('en_' + p) in phones for p in n[1][3:].split('-')):
                n[1], n[4] = '<SP>', 1
        write_voice(name, js.with_suffix('.wav'), notes, out, 'English', f'GTSinger {js.parent.parent.name}/{js.parent.name}/{js.stem}')


if __name__ == '__main__':
    main()
