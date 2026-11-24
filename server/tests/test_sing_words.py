"""Make it sing (beta): only the words are sung (intros, piano fills and notes before the first word are silence for
the singer, the piano keeps them, timing stays exact), verses, the gate, Chinese lyrics and the job's voice choice."""
import json
import sys
from pathlib import Path

import pytest

from meowsic import singscore
from test_sing import FAKE, XML, wait


def _n(step, octave, dur, text=None, syl='single', num='1', extend=False, more=''):
    lyr = '' if text is None else (f'<lyric number="{num}"><syllabic>{syl}</syllabic><text>{text}</text>'
                                   + ('<extend/>' if extend else '') + '</lyric>')
    return f'<note><pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>{dur}</duration>{more}{lyr}</note>'


def _score(*bars):
    ms = ''.join(f'<measure number="{i + 1}">' + ('<attributes><divisions>2</divisions><time><beats>4</beats>'
                 '<beat-type>4</beat-type></time></attributes><sound tempo="60"/>' if i == 0 else '')
                 + b + '</measure>' for i, b in enumerate(bars))
    return ('<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><part-list><score-part id="P1">'
            f'<part-name>Voice</part-name></score-part></part-list><part id="P1">{ms}</part></score-partwise>')


REST = '<note><rest/><duration>2</duration></note>'
# bar 1: a 4-note piano intro (no words); bar 2: "sing" + a stepwise melisma note, then a fill that leaps (piano),
# a rest; bar 3: "the" "song", "song" again on the same pitch without words (not a melisma), "now"
INTRO = _score(
    _n('C', 6, 1) + _n('G', 5, 1) + _n('E', 5, 1) + _n('C', 5, 5),
    _n('G', 4, 2, 'sing') + _n('A', 4, 1) + _n('C', 6, 1) + _n('G', 5, 1) + _n('E', 5, 1) + REST,
    _n('E', 4, 2, 'the') + _n('D', 4, 2, 'song') + _n('D', 4, 2) + _n('C', 4, 2, 'now'))
G2P = {'sing': ['S', 'IH1', 'NG'], 'the': ['DH', 'AH0'], 'song': ['S', 'AO1', 'NG'], 'now': ['N', 'AW1']}.__getitem__


def test_unsung_notes_are_rests_for_the_singer():
    s = singscore.read(INTRO)
    p = [n for n in s['notes'] if n['midi']]
    assert [n['sung'] for n in p] == [False] * 4 + [True, True, False, False, False] + [True, True, False, True]
    assert s['notes'][0]['q'] == 0 and s['notes'][0]['midi'] == 84  # the piano still has every note, at its time
    ws = singscore.words(s['notes'])
    assert [w['word'] for w in ws] == ['', 'sing', '', 'the', 'song', '', 'now']
    segs = singscore.segments(ws, 60, min_s=100, max_s=100)
    m = singscore.soulx_meta(segs[0], 60, G2P)
    ph, pitch, typ = m['phoneme'].split(), m['note_pitch'].split(), m['note_type'].split()
    assert ph[:4] == ['<SP>'] * 4 and pitch[:4] == ['0'] * 4 and typ[:4] == ['1'] * 4  # no "la" on the intro
    assert ph[4:6] == ['en_S-IH1-NG'] * 2 and typ[4:6] == ['2', '3']  # the melisma keeps the syllable
    assert ph[6:10] == ['<SP>'] * 4 and ph[12] == '<SP>' and pitch[12] == '0'  # fill + rest + repeated note: silent
    dur = [float(x) for x in m['duration'].split()]
    assert abs(sum(dur) - 12) < 1e-6 and m['time'] == [0, 12000]  # exact timing: 12 beats at 60 bpm
    spans = singscore.sung_spans(s['notes'], 1.0)
    assert spans[0][0] == pytest.approx(3.95)  # nothing before the first word
    assert not any(a < 6.5 < b for a, b in spans) and not any(a < 10.5 < b for a, b in spans)  # fill, repeated note


def test_extend_marks_melismas_strictly():
    x = _score(_n('G', 4, 2, 'oh', extend=True) + _n('A', 4, 2) + _n('B', 4, 2, 'yes') + _n('C', 5, 2))
    assert [n['sung'] for n in singscore.read(x)['notes']] == [True, True, True, False]  # no extend on "yes"


def test_tied_continuation_and_open_word_are_sung():
    x = _score(_n('G', 4, 4, 'A', 'begin', more='<tie type="start"/>') + _n('G', 4, 4, more='<tie type="stop"/>'),
               _n('A', 4, 2) + _n('B', 4, 2, 'men', 'end') + REST + REST)
    n = [q for q in singscore.read(x)['notes'] if q['midi']]
    assert [(q['d'], q['sung']) for q in n] == [(4, True), (1, True), (1, True)]


def test_verse_choice():
    x = _score(''.join(f'<note><pitch><step>{st}</step><octave>4</octave></pitch><duration>2</duration>'
                       f'<lyric number="1"><syllabic>single</syllabic><text>one{st}</text></lyric>'
                       f'<lyric number="2"><syllabic>single</syllabic><text>two{st}</text></lyric></note>' for st in 'CDEF'))
    assert singscore.read(x)['verses'] == ['1', '2'] and singscore.read(x)['notes'][0]['text'] == 'oneC'
    assert singscore.read(x, verse=2)['notes'][0]['text'] == 'twoC' and singscore.read(x, verse=9)['verse'] == '1'


def test_gate_silences_everything_but_the_sung_notes():
    np = pytest.importorskip('numpy')
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sing'))
    import sing as singpy
    s = singscore.read(INTRO)
    sr = 1000
    y = singpy.gate(np.ones(14 * sr, dtype=np.float32), sr, s['notes'], 60)
    assert not y[:int(3.9 * sr)].any()  # before the first word
    assert not y[int(6.3 * sr):int(7.9 * sr)].any()  # the piano fill + the rest
    assert y[int(4.1 * sr):int(5.4 * sr)].min() == 1  # "sing" and its melisma


# ---------- Chinese: one character per note, SoulX-Singer Mandarin phonemes ----------

TIGERS = _score(''.join(_n(st, 4, 2, ch) for st, ch in zip('CDEC', '两只老虎')),
                _n('E', 4, 2, '跑') + _n('F', 4, 2, '得') + _n('G', 4, 4, '快！'))
PINYIN = {'两只老虎跑得快': ['liang3', 'zhi1', 'lao3', 'hu3', 'pao3', 'de5', 'kuai4']}


def test_chinese_lyrics_are_found_and_sung_per_character():
    assert singscore.has_lyrics(TIGERS)
    s = singscore.read(TIGERS)
    assert singscore.language(s['notes']) == 'Chinese' and singscore.language(singscore.read(XML)['notes']) == 'English'
    segs = singscore.add_pinyin(singscore.segments(singscore.words(s['notes']), 60, min_s=100, max_s=100), zh=PINYIN.get)
    m = singscore.soulx_meta(segs[0], 60, None, lang='Chinese')
    assert m['language'] == 'Mandarin' and m['text'].split()[-1] == '快'
    assert m['phoneme'].split() == ['zh_' + p for p in PINYIN['两只老虎跑得快']] and m['note_type'].split() == ['2'] * 7


def test_pinyin_numbers():
    assert [singscore.pinyin_number(x) for x in ('liǎng', 'zhī', 'lǜ', 'nǚ', 'jú', 'ma', 'dé')] == \
        ['liang3', 'zhi1', 'lu:4', 'nu:3', 'ju2', 'ma5', 'de2']


@pytest.mark.skipif(sys.platform != 'darwin', reason='macOS Mandarin transform')
def test_mandarin_transform_on_macos():
    assert singscore.mandarin('两只老虎跑得快') == PINYIN['两只老虎跑得快']


def test_sing_job_takes_a_voice(client, data, tmp_path, monkeypatch):
    fake = tmp_path / 'fakepy'
    fake.write_text(FAKE.format(py=sys.executable).replace('bpm = float', "(out / 'args.json').write_text(json.dumps(a))\nbpm = float"))
    fake.chmod(0o755)
    monkeypatch.setenv('MEOWSIC_SING_PYTHON', str(fake))
    it = client.post('/api/items', json={'kind': 'score', 'title': 'Two Tigers', 'musicxmlText': TIGERS}).json()
    assert client.post(f'/api/items/{it["id"]}/sing', json={'voice': '../x'}).status_code == 400
    assert client.post(f'/api/items/{it["id"]}/sing', json={'octave': 7}).status_code == 400
    j = client.post('/api/jobs', json={'kind': 'sing', 'title': 'x', 'fromItemId': it['id'], 'voice': 'zh_target', 'octave': -1})
    assert j.status_code == 201
    j = wait(client, j.json()['id'])
    assert j['status'] == 'done', j['log']
    args = json.loads(next(data.rglob('args.json')).read_text())
    assert args[args.index('--voice') + 1] == 'zh_target' and args[args.index('--octave') + 1] == '-1'


# ---------- Vietnamese: every Unicode letter is kept (NFC), each syllable mapped to ARPAbet for the voice ----------
VI = _score(_n('C', 4, 2, 'Trăng') + _n('D', 4, 2, 'người,') + _n('E', 4, 2, 'đi') + _n('F', 4, 2, 'đâu?'),
            _n('G', 4, 2, 'ánh') + _n('A', 4, 2, 'em') + _n('G', 4, 2, 'thương', 'begin') + _n('E', 4, 2, 'nhớ', 'end'))


def test_vietnamese_words_keep_every_letter():
    assert singscore.clean_word('trăng,') == 'trăng' and singscore.clean_word('người!') == 'người'
    assert singscore.clean_word('đi') == 'đi' and singscore.clean_word('“Ước') == 'Ước'
    assert singscore.clean_word('ăn') == 'ăn'  # decomposed -> NFC
    assert singscore.clean_word('虎，') == '虎' and singscore.clean_word("you’re") == "you're"
    s = singscore.read(VI)
    texts = [n['text'] for n in s['notes'] if n['midi']]
    assert texts[4] == 'ánh' and all(n['sung'] for n in s['notes'] if n['midi'])
    ws = [w['word'] for w in singscore.words(s['notes']) if w['word']]
    assert ws == ['Trăng', 'người', 'đi', 'đâu', 'ánh', 'em', 'thươngnhớ']


def test_vietnamese_language():
    assert singscore.language(singscore.read(VI)['notes']) == 'Vietnamese'
    assert singscore.language(singscore.read(XML)['notes']) == 'English'
    assert singscore.language(singscore.read(TIGERS)['notes']) == 'Chinese'
    assert singscore.is_vietnamese('đi') and singscore.is_vietnamese('người') and singscore.is_vietnamese('trăng')
    assert not singscore.is_vietnamese('café') and not singscore.is_vietnamese('em')


@pytest.mark.parametrize('syl,phones', [
    ('trăng', ['CH', 'AA1', 'NG']), ('người', ['NG', 'UH1', 'AH0', 'Y']), ('đi', ['D', 'IY1']),
    ('Ánh', ['AY1', 'NG']), ('gì', ['Z', 'IY1']), ('gia', ['Z', 'AA1']), ('quê', ['K', 'W', 'EY1']),
    ('hương', ['HH', 'UH1', 'AH0', 'NG']), ('tôi', ['T', 'OY1']), ('chuyện', ['CH', 'W', 'IY1', 'AH0', 'N']),
    ('nhớ', ['N', 'Y', 'AH1']), ('khóc', ['HH', 'AO1', 'K']), ('xuân', ['S', 'W', 'AH1', 'N'])])
def test_vietnamese_phonemes(syl, phones):
    assert singscore.vietnamese(syl) == phones


def test_vietnamese_every_syllable_has_one_vowel_and_known_phones():
    import json
    known = set(json.loads((Path.home() / 'ai/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json').read_text())) \
        if (Path.home() / 'ai/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json').exists() else None
    for syl in ('trăng', 'người', 'đi', 'đâu', 'ánh', 'em', 'thương', 'nhớ', 'yêu', 'ngoài', 'khuya', 'giữa', 'ước',
                'rượu', 'quýt', 'oẳn', 'ngủ', 'phố', 'xưa', 'mộng', 'ghế', 'nghĩ', 'Ầu', 'z'):
        ph = singscore.vietnamese(syl)
        assert sum(p.endswith('1') for p in ph) == (0 if syl == 'z' else 1), syl
        if known: assert all('en_' + p in known for p in ph), (syl, ph)


def test_vietnamese_meta_sings_every_syllable():
    s = singscore.read(VI)
    segs = singscore.segments(singscore.words(s['notes']), 60, min_s=100, max_s=100)
    m = singscore.soulx_meta(segs[0], 60, None, lang='Vietnamese')
    ph, typ = m['phoneme'].split(), m['note_type'].split()
    assert m['language'] == 'English' and len(ph) == 8 and '<SP>' not in ph
    assert ph[0] == 'en_CH-AA1-NG' and ph[2] == 'en_D-IY1' and ph[6] == 'en_T-UH1-AH0-NG' and ph[7] == 'en_N-Y-AH1'
    assert typ == ['2'] * 8  # each syllable starts its own note (thương-nhớ: a new syllable on note 2)
