#!/usr/bin/env python3
"""Make a lead sheet sing (beta), fully offline: MusicXML melody + English lyrics -> a sung vocal with a soft piano.

  sing.py --xml song.musicxml --out DIR --name "m-abc vocal" [--bpm 72] [--steps 32] [--device mps] [--check]
          [--voice en_target] [--tune 0.85] [--octave N]

Voice: SoulX-Singer (Soul-AILab, Apache-2.0) — zero-shot singing voice synthesis, score-controlled (MIDI notes +
phonemes). Code in ~/ai/SoulX-Singer (its own .venv runs this script), weights in ~/ai/models/SoulX-Singer/model.pt.
The singer is one of the project's annotated example clips (--voice; default en_target, an English pop voice); the
clip is cut at its metadata start time so its audio lines up with its notes / phonemes.
Pitch correction (--tune, default 0.85, 0 = off; sing/tune.py): WORLD (pyworld) tracks the sung f0, each note's
slow drift is pulled to the score, vibrato and note-to-note glides are kept, then the voice is resynthesized.
Piano: the app's Salamander samples (web/vendor/piano), block chords from the score's chord symbols
(the melody itself, softly, when there are none).

Writes DIR/<name>.m4a, DIR/<name>.wav (mix, 44.1 kHz) and DIR/<name> dry.wav (voice only, 24 kHz);
prints one JSON line per step ({"stage", "progress", "msg"}) and a last {"done": true, ...} line;
--check adds objective checks (duration, pitch tracking with librosa pyin, silence) to the last line.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / 'server'))
from meowsic import singscore  # noqa: E402  (stdlib only)
import tune  # noqa: E402  (sing/tune.py: pitch correction, WORLD via pyworld)

SOULX = Path(os.environ.get('MEOWSIC_SOULX', Path.home() / 'ai' / 'SoulX-Singer'))
MODEL = Path(os.environ.get('MEOWSIC_SOULX_MODEL', Path.home() / 'ai' / 'models' / 'SoulX-Singer' / 'model.pt'))
NLTK = Path(os.environ.get('NLTK_DATA', Path.home() / 'ai' / 'models' / 'nltk_data'))
PIANO = REPO / 'web' / 'vendor' / 'piano'
# annotated prompt clips in SoulX-Singer's example/audio (<name>.mp3 + <name>.json); VOICE is the default singer
BUILTIN_VOICES = ('en_target', 'en_prompt', 'zh_prompt', 'zh_target', 'yue_target')
# more singers: free annotated clips made into prompts by sing/make_voices.py (<name>.wav + <name>.json), kept out of
# git in VOICES_DIR; sources + licences in ~/ai/models/singer-voices/SOURCES.md (personal, non-commercial use)
VOICES_DIR = Path(os.environ.get('MEOWSIC_VOICES', Path.home() / 'ai' / 'models' / 'singer-voices' / 'voices'))
EXTRA_VOICES = (
    'zh_m13', 'zh_m6', 'zh_m1', 'zh_m5', 'zh_m21',              # Mandarin male singers (SoulX-Singer-Eval prompts)
    'en_m8', 'en_m13', 'en_m21', 'en_m22', 'en_m23', 'en_m1', 'en_m2', 'en_m15',  # English male (SoulX-Singer-Eval)
    'en_f3', 'en_f10', 'en_f14',                                 # English female (SoulX-Singer-Eval)
    'gt_tenor_a', 'gt_tenor_b', 'gt_tenor_c',                    # GTSinger EN-Tenor-1 (male)
    'gt_alto1', 'gt_alto2a', 'gt_alto2b',                        # GTSinger EN-Alto-1 / EN-Alto-2 (female)
)
VOICES = BUILTIN_VOICES + EXTRA_VOICES
VOICE = 'en_target'  # English pop singer: best words + pitch over the five (Amazing Grace tests, 2026-11)
SR_OUT = 44100
TAIL_Q = 1.0  # the last note rings on for a beat after the score ends


def say(stage, progress=None, msg=None, **kw):
    print(json.dumps({'stage': stage, 'progress': progress, 'msg': msg, **kw}), flush=True)


# ---------- the voice ----------

def load_voice(device):
    sys.path.insert(0, str(SOULX))
    os.environ.setdefault('NLTK_DATA', str(NLTK))
    import librosa
    import torch
    from soulxsinger.utils import data_processor as dp
    from soulxsinger.utils.file_utils import load_config

    def load_wav(path, sr):  # torchaudio's loader now needs torchcodec; librosa reads mp3/wav fine
        y, _ = librosa.load(str(path), sr=sr, mono=True)
        return torch.from_numpy(y).float().unsqueeze(0)
    dp.load_wav = load_wav
    from soulxsinger.models.soulxsinger import SoulXSinger
    cfg = load_config(str(SOULX / 'soulxsinger' / 'config' / 'soulxsinger.yaml'))
    model = SoulXSinger(cfg)
    ck = torch.load(str(MODEL), map_location='cpu', weights_only=False)  # official checkpoint from Soul-AILab on Hugging Face
    model.load_state_dict(ck['state_dict'], strict=True)
    del ck
    model.eval().to(device)
    proc = dp.DataProcessor(hop_size=cfg.audio.hop_size, sample_rate=cfg.audio.sample_rate,
                            phoneset_path=str(SOULX / 'soulxsinger' / 'utils' / 'phoneme' / 'phone_set.json'), device=device)
    return model, proc, cfg


def make_g2p():
    import nltk
    nltk.data.path.insert(0, str(NLTK))
    from g2p_en import G2p
    g = G2p()
    return lambda w: [p for p in g(w) if re.fullmatch(r'[A-Z]+[0-2]?', p)]


def voice_files(voice):
    """(audio, json) of a singer: SoulX-Singer's example clips, else VOICES_DIR (sing/make_voices.py)"""
    if voice in BUILTIN_VOICES:
        aud = SOULX / 'example' / 'audio'
        return aud / f'{voice}.mp3', aud / f'{voice}.json'
    if voice not in EXTRA_VOICES: raise SystemExit(f'Unknown voice {voice}')
    a, j = VOICES_DIR / f'{voice}.wav', VOICES_DIR / f'{voice}.json'
    if not (a.exists() and j.exists()): raise SystemExit(f'Voice {voice} is not installed ({VOICES_DIR}); see sing/make_voices.py')
    return a, j


def load_prompt(proc, voice):
    """The singer: an annotated clip. Its notes / phonemes / f0 start at meta['time'][0] inside the audio
    (e.g. en_prompt.mp3 at 5.22 s), so the audio is cut there to line up with them."""
    import librosa
    import soundfile as sf
    import tempfile
    audio, js = voice_files(voice)
    meta = json.loads(js.read_text(encoding='utf-8'))[0]
    meta.pop('source', None)
    t = meta['time']
    t0 = (json.loads(t) if isinstance(t, str) else t)[0] / 1000
    y, sr = librosa.load(str(audio), sr=proc.sample_rate, mono=True)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f: tmp = f.name
    try:
        sf.write(tmp, y[int(round(t0 * sr)):], sr)
        return proc.process(dict(meta), tmp), meta
    finally:
        os.unlink(tmp)


def sing(segs, bpm, device, steps, cfg_scale, on_seg, mode='syllable', voice=VOICE, octave=None):
    import numpy as np
    import torch
    model, proc, cfg = load_voice(device)
    g2p = make_g2p()
    phones = set(proc.phone2idx)
    prompt, prompt_meta = load_prompt(proc, voice)
    pt_med = float(np.median([int(x) for x in prompt_meta['note_pitch'].split() if int(x) > 0]))
    sr = cfg.audio.sample_rate
    metas = [singscore.soulx_meta(s, bpm, g2p, i, TAIL_Q if i == len(segs) - 1 else 0, mode=mode) for i, s in enumerate(segs)]
    for m in metas:  # a phoneme the model does not know (rare) -> sung as a breath instead of crashing
        m['phoneme'] = ' '.join(p if p == '<SP>' or all(('en_' + x) in phones for x in p[3:].split('-')) else '<SP>' for p in m['phoneme'].split())
    gt = [int(x) for m in metas for x in m['note_pitch'].split() if int(x) > 0]
    shift = int(12 * round((pt_med - float(np.median(gt))) / 12)) if gt else 0  # whole octaves only: same notes, the singer's range
    if octave is not None: shift = 12 * octave  # --octave: the caller picks the range (e.g. 0 for a female voice, -1 for a male one)
    total = int(round((metas[-1]['time'][1]) / 1000 * sr)) + sr
    out = np.zeros(total, dtype=np.float32)
    for i, m in enumerate(metas):
        tgt = proc.process(dict(m), None)
        with torch.no_grad():
            y = model.infer({'prompt': prompt, 'target': tgt}, auto_shift=False, pitch_shift=shift, n_steps=steps, cfg=cfg_scale, control='score')
        y = y.squeeze().float().cpu().numpy()
        a = int(round(m['time'][0] / 1000 * sr))
        n = min(len(y), total - a)
        fade = min(240, n)  # 10 ms in / out so phrases join without clicks
        y = y[:n].copy(); y[:fade] *= np.linspace(0, 1, fade); y[n - fade:] *= np.linspace(1, 0, fade)
        out[a:a + n] += y
        on_seg(i + 1, len(metas), m['text'].replace('<SP>', '').split())
    return out, sr, shift, metas


# ---------- the piano ----------

_samples = {}


def sample(n):
    import librosa
    k = min(range(21, 109, 3), key=lambda s: abs(s - n))
    if k not in _samples:
        y, _ = librosa.load(str(PIANO / f'piano-{k:03d}.mp3'), sr=SR_OUT, mono=True)
        _samples[k] = y
    return k, _samples[k]


def piano_note(buf, n, t, held, vel):
    import numpy as np
    k, y = sample(n)
    rate = 2 ** ((n - k) / 12)
    length = int((held + 0.8) * SR_OUT)
    idx = np.arange(length) * rate
    idx = idx[idx < len(y) - 1]
    s = np.interp(idx, np.arange(len(y)), y)
    env = np.ones(len(s))
    h = int(held * SR_OUT)
    if h < len(s): env[h:] = np.exp(-np.arange(len(s) - h) / (0.12 * SR_OUT))
    a = int(t * SR_OUT)
    b = min(len(buf), a + len(s))
    if b > a: buf[a:b] += (s * env)[:b - a] * (vel / 127) ** 1.2


def voicing(ch):
    """Bass in octave 2-3, a close triad (root position-ish) around middle C."""
    bass = 40 + (ch['bass'] - 4) % 12  # E2..D#3
    tri = sorted(55 + (pc - 7) % 12 for pc in ch['pcs'][:4])  # G3..F#4
    return [bass, *tri]


def accompaniment(info, bpm, length):
    import numpy as np
    spq, buf = 60 / bpm, np.zeros(length, dtype=np.float32)
    end, bar = info['endQ'], info['qPerBar']
    chords = sorted(info['chords'], key=lambda c: c['q'])
    if not chords:  # no chord symbols: the tune, softly
        for n in info['notes']:
            if n['midi']: piano_note(buf, n['midi'], n['q'] * spq, n['d'] * spq, 38)
        return buf
    for i, ch in enumerate(chords):
        q1 = chords[i + 1]['q'] if i + 1 < len(chords) else end
        hits = [ch['q']] + [b * bar for b in range(int(ch['q'] // bar) + 1, int(-(-q1 // bar))) if b * bar < q1]
        for j, q in enumerate(hits):
            nxt = hits[j + 1] if j + 1 < len(hits) else q1
            held = (nxt - q) * spq
            notes = voicing(ch)
            piano_note(buf, notes[0], q * spq, held, 44)
            for n in notes[1:]: piano_note(buf, n, q * spq, held, 34)
    return buf


def mix(vocal, vsr, piano):
    import librosa
    import numpy as np
    v = librosa.resample(vocal, orig_sr=vsr, target_sr=SR_OUT)
    n = max(len(v), len(piano))
    v = np.pad(v, (0, n - len(v))); p = np.pad(piano, (0, n - len(piano)))
    rms = lambda x: float(np.sqrt(np.mean(x[np.abs(x) > 1e-4] ** 2))) if np.any(np.abs(x) > 1e-4) else 1.0
    v = v * (0.2 / rms(v))
    p = p * (0.2 / rms(p)) * 0.4  # piano ~8 dB under the voice
    m = v + p
    peak = float(np.max(np.abs(m))) or 1
    return (m * (0.95 / peak if peak > 0.95 else 1)).astype(np.float32)


# ---------- checks ----------

def check(dry, sr, info, bpm, shift, mix_len):
    import librosa
    import numpy as np
    spq = 60 / bpm
    hop = 240
    f0, voiced, _ = librosa.pyin(dry, fmin=70, fmax=1100, sr=sr, frame_length=1024, hop_length=hop)
    rms = librosa.feature.rms(y=dry, frame_length=1024, hop_length=hop)[0]
    L = min(len(f0), len(rms))
    f0, voiced, rms = f0[:L], voiced[:L], rms[:L]
    times = np.arange(L) * hop / sr
    sung = [n for n in info['notes'] if n['midi']]
    within, tracked, silent, cents_all = 0, 0, 0, []
    for n in sung:
        a, b = n['q'] * spq, (n['q'] + n['d']) * spq
        a2, b2 = a + 0.25 * (b - a), b - 0.25 * (b - a)  # the middle half of the note (skip the glide in / out)
        sel = (times >= a2) & (times <= b2)
        if not np.any(sel): continue
        loud = float(np.max(rms[sel]))
        fv = f0[sel][voiced[sel] & ~np.isnan(f0[sel])]
        if loud < 0.003 or len(fv) == 0:
            silent += 1; continue
        tracked += 1
        target = librosa.midi_to_hz(n['midi'] + shift)
        c = 1200 * np.log2(np.median(fv) / target)
        cents_all.append(float(c))
        within += int(abs(c) <= 50)
    exp_s = info['endQ'] * spq
    return {
        'bpm': bpm, 'expectedSeconds': round(exp_s, 2), 'vocalSeconds': round(len(dry) / sr, 2),
        'mixSeconds': round(mix_len / SR_OUT, 2), 'tailSeconds': round(TAIL_Q * spq, 2),
        'notes': len(sung), 'notesTracked': tracked, 'notesSilent': silent,
        'within50c': within, 'within50cPct': round(100 * within / len(sung), 1) if sung else 0,
        'medianAbsCents': round(float(np.median(np.abs(cents_all))), 1) if cents_all else None, 'octaveShift': shift,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xml', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--bpm', type=float, default=None, help='tempo when the score has no tempo mark')
    ap.add_argument('--steps', type=int, default=32)
    ap.add_argument('--cfg', type=float, default=3.0)
    ap.add_argument('--device', default=None)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--mode', choices=('syllable', 'word'), default='syllable', help='phonemes per syllable (default) or per word')
    ap.add_argument('--seed', type=int, default=0, help='same seed + same score = the same take')
    ap.add_argument('--voice', choices=VOICES, default=VOICE, help='the singer: a SoulX-Singer example clip or an installed extra voice (sing/make_voices.py)')
    ap.add_argument('--tune', type=float, default=0.85,
                    help='pitch correction: how far each note\'s pitch is pulled to the score, 0 (off) .. 1 (vibrato kept)')
    ap.add_argument('--octave', type=int, default=None, help='octaves to move the melody (default: nearest the singer\'s own range)')
    a = ap.parse_args()
    os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
    import numpy as np
    import soundfile as sf
    import torch
    device = a.device or ('mps' if torch.backends.mps.is_available() else 'cpu')
    torch.manual_seed(a.seed)

    say(0, 0, 'Reading the score')
    xml = Path(a.xml).read_text(encoding='utf-8')
    info = singscore.read(xml)
    if not singscore.has_lyrics(xml): raise SystemExit('This score has no English lyrics to sing')
    bpm = singscore.song_bpm(info, a.bpm)
    segs = singscore.segments(singscore.words(info['notes']), bpm)
    say(1, 0, f'Loading the voice ({len(segs)} phrases at {bpm:g} bpm)')

    def on_seg(i, n, ws):
        say(2, i / n, f'Phrase {i} of {n}: ' + ' '.join(dict.fromkeys(ws)))
    dry, vsr, shift, _ = sing(segs, bpm, device, a.steps, a.cfg, on_seg, a.mode, a.voice, a.octave)
    tuned = None
    if a.tune > 0:
        say(2, 1, 'Tuning the voice to the score')
        dry, tuned = tune.retune(dry, vsr, info['notes'], bpm, shift, strength=min(1.0, a.tune))
    end_s = (info['endQ'] + TAIL_Q) * 60 / bpm
    dry = np.pad(dry, (0, max(0, int(end_s * vsr) - len(dry))))[:int(end_s * vsr)]

    say(3, 0, 'Piano and mix')
    piano = accompaniment(info, bpm, int(end_s * SR_OUT))
    m = mix(dry, vsr, piano)[:int(end_s * SR_OUT)]
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    wav, m4a, dry_p = out / f'{a.name}.wav', out / f'{a.name}.m4a', out / f'{a.name} dry.wav'
    sf.write(dry_p, dry, vsr)
    sf.write(wav, m, SR_OUT, subtype='PCM_16')
    ffmpeg = next((p for p in ('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg') if Path(p).exists()), 'ffmpeg')
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', str(wav), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(m4a)], check=True)
    rep = None
    if a.check:
        say(4, 0, 'Checking pitch and timing')
        rep = check(dry, vsr, info, bpm, shift, len(m))
        rep.update(voice=a.voice, tune=a.tune, tuning=tuned)
    print(json.dumps({'done': True, 'm4a': str(m4a), 'wav': str(wav), 'dry': str(dry_p), 'bpm': bpm, 'report': rep}), flush=True)


if __name__ == '__main__':
    main()
