"""Make it sing (beta): the extra singer voices (sing/make_voices.py -> ~/ai/models/singer-voices/voices) and --voice."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sing'))
import make_voices as MV  # noqa: E402
import sing  # noqa: E402


def test_voice_choices():
    assert sing.VOICE in sing.VOICES
    assert set(sing.BUILTIN_VOICES) <= set(sing.VOICES)
    assert {'zh_m13', 'en_m8', 'gt_tenor_b', 'gt_alto1'} <= set(sing.EXTRA_VOICES)
    assert len(set(sing.VOICES)) == len(sing.VOICES)


def test_default_voice_is_take_c():
    # the user's final pick: zh_target (low male) sings every language unless a voice is passed
    assert sing.VOICE == 'zh_target' and set(sing.DEFAULT_VOICE.values()) == {'zh_target'}
    assert set(sing.DEFAULT_VOICE) == {'English', 'Chinese'}  # Vietnamese lyrics read as 'English' (Latin letters)


def test_auto_octave_for_a_low_male_voice():
    zh_target = [50, 51, 53, 53, 55, 56]  # its clip sits around D3-G#3
    assert sing.octave_for([60, 62, 64, 65, 67], zh_target) == -12   # a C4-G4 tune -> down one octave
    assert sing.octave_for([48, 50, 52, 53, 55], zh_target) == 0     # already in its range
    assert sing.octave_for([72, 74, 76, 77, 79], zh_target) == -24   # a high tune -> down two


def test_voice_files(tmp_path, monkeypatch):
    a, j = sing.voice_files('en_target')
    assert a.name == 'en_target.mp3' and j.parent.name == 'audio'
    with pytest.raises(SystemExit):
        sing.voice_files('nobody')
    monkeypatch.setattr(sing, 'VOICES_DIR', tmp_path)
    with pytest.raises(SystemExit, match='not installed'):
        sing.voice_files('en_m8')
    (tmp_path / 'en_m8.wav').write_bytes(b'')
    (tmp_path / 'en_m8.json').write_text('[]')
    assert sing.voice_files('en_m8') == (tmp_path / 'en_m8.wav', tmp_path / 'en_m8.json')


def g2p(w):
    return {'quiet': ['K', 'W', 'AY1', 'AH0', 'T'], 'now': ['N', 'AW1']}[w]


def test_eval_notes_slurs_repeat_phonemes():
    it = {'note_text': ['<SP>', 'quiet', 'quiet', 'now', '破', '<AP>'], 'note_dur': [0.2, 0.3, 0.1, 0.5, 0.4, 0.2],
          'note_pitch': [0, 55, 57, 53, 50, 0], 'note_type': [1, 2, 3, 2, 2, 1]}
    n = MV.notes_from_eval(it, g2p, lambda ch: 'po4')
    assert [x[1] for x in n] == ['<SP>', 'en_K-W-AY1-AH0-T', 'en_K-W-AY1-AH0-T', 'en_N-AW1', 'zh_po4', '<SP>']
    assert [x[4] for x in n] == [1, 2, 3, 2, 2, 1]


def test_gts_notes_and_cut():
    words = [{'word': '<SP>', 'start_time': 0, 'end_time': 0.5},
             {'word': 'now', 'ph': ['N', 'AW1'], 'note': [60, 62], 'note_start': [0.5, 1.0], 'note_end': [1.0, 4.0]},
             {'word': '<AP>', 'start_time': 4.0, 'end_time': 4.5},
             {'word': 'now', 'ph': ['N', 'AW1'], 'note': [5], 'note_start': [4.5], 'note_end': [20.0]}]
    n = MV.notes_from_gts(words)
    assert [x[4] for x in n] == [1, 2, 3, 1, 2]
    MV.fix_pitch(n)
    assert n[-1][3] == 62  # a glitch pitch -> the neighbour's
    c = MV.cut(n, 3, 14)
    assert len(c) == 4 and c[-1][1] == '<SP>'  # cut at the rest, 4.5 s
