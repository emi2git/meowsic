"""Make it sing (beta): the gentle pitch correction (sing/tune.py) snaps note centres to the score and keeps vibrato."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sing'))
import tune  # noqa: E402

FP = tune.FRAME_S
NOTES = [{'q': 0, 'd': 1, 'midi': 67}, {'q': 1, 'd': 1, 'midi': 0}, {'q': 2, 'd': 2, 'midi': 71}]  # G4, rest, B4 at 60 bpm


def hz(m):
    return 440.0 * 2 ** ((np.asarray(m, dtype=float) - 69) / 12)


def sung(detune_c, vib_c=30.0):
    t = np.arange(int(4 / FP)) * FP
    tgt = tune.target_curve(NOTES, 60, 0, t)
    vib = vib_c * np.sin(2 * np.pi * 5.5 * t)
    f0 = np.where(tgt > 0, hz(tgt) * 2 ** ((detune_c + vib) / 1200), 0.0)
    return t, tgt, f0, vib


def cents(f0, tgt):
    return 1200 * np.log2(f0 / hz(tgt))


def test_target_curve_follows_the_score_and_shift():
    t = np.arange(int(4 / FP)) * FP
    tgt = tune.target_curve(NOTES, 60, -12, t)
    assert tgt[int(0.5 / FP)] == 55 and tgt[int(1.5 / FP)] == 0 and tgt[int(3 / FP)] == 59


def test_flat_singer_is_pulled_in_tune_and_vibrato_stays():
    t, tgt, f0, vib = sung(-40)  # 40 cents flat everywhere
    out = tune.retune_f0(f0, t, tgt, strength=1.0)
    mid = (t > 2.3) & (t < 3.7)
    c = cents(out[mid], tgt[mid])
    assert abs(np.median(c)) < 5  # centred on the note
    assert np.std(c) > 0.8 * np.std(vib[mid])  # vibrato depth kept
    assert tune.note_stats(f0, t, tgt)['in25'] == 0 and tune.note_stats(out, t, tgt)['in25'] == 100


def test_strength_is_gentle_and_rests_untouched():
    t, tgt, f0, _ = sung(-40, vib_c=0)
    out = tune.retune_f0(f0, t, tgt, strength=0.5)
    mid = (t > 2.3) & (t < 3.7)
    assert -25 < np.median(cents(out[mid], tgt[mid])) < -15  # half the error left
    assert np.all(out[tgt == 0] == 0)


def test_octave_off_and_wild_frames_left_alone():
    t, tgt, f0, _ = sung(-30, vib_c=0)
    f0_oct = f0 * 2  # sung an octave up: tuned within that octave
    out = tune.retune_f0(f0_oct, t, tgt, strength=1.0)
    mid = (t > 2.3) & (t < 3.7)
    assert abs(np.median(cents(out[mid], tgt[mid])) - 1200) < 5
    wild = f0 * 2 ** (500 / 1200)  # 5 semitones off: a tracking slip, not touched
    assert np.allclose(tune.retune_f0(wild, t, tgt, strength=1.0), wild)
