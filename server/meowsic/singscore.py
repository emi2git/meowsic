"""MusicXML lead sheet -> what a singing-voice model needs (stdlib only, so the server and tests can use it).

read(xml, verse)     -> {'notes': [{q, d, midi, text, syllabic, extend, sung}], 'chords': [{q, root, bass, pcs}], 'beats',
                        'bpm', 'endQ', 'verses'} (melody = first part, first voice; tied notes merged; q / d in quarter
                        notes; text = that verse's lyric, default the first verse)
mark_sung(notes)     -> sets note['sung']: only notes with a lyric syllable, their melisma / extend continuations and
                        ties are sung; intros, piano fills and other words-less notes are silence for the singer
words(notes)         -> sung units: one per rest (unsung notes count as rests) or per lyric word, with its notes
segments(ws, bpm)    -> phrases of a few seconds, cut at rests or after long notes (the model sings one at a time)
soulx_meta(seg, g2p) -> one SoulX-Singer target-metadata entry: word-level ARPAbet phonemes repeated on every
                        note of the word, note_type 1 rest / 2 word start / 3 same word continues (its training format)
has_lyrics(xml)      -> True when the melody carries lyrics (English words or Chinese characters)
language(notes)      -> 'Chinese' (one character per note, SoulX-Singer 'Mandarin' zh_<pinyin><tone> phonemes) or 'English'
"""
import re
import xml.etree.ElementTree as ET

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
KIND = {  # MusicXML harmony kind -> intervals above the root
    'major': (0, 4, 7), 'minor': (0, 3, 7), 'dominant': (0, 4, 7, 10), 'major-seventh': (0, 4, 7, 11),
    'minor-seventh': (0, 3, 7, 10), 'diminished': (0, 3, 6), 'diminished-seventh': (0, 3, 6, 9),
    'half-diminished': (0, 3, 6, 10), 'augmented': (0, 4, 8), 'suspended-fourth': (0, 5, 7),
    'suspended-second': (0, 2, 7), 'major-sixth': (0, 4, 7, 9), 'minor-sixth': (0, 3, 7, 9),
    'dominant-ninth': (0, 4, 7, 10), 'power': (0, 7),
}
WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")
CJK = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
COUNT = set('一二两三四五六七八九十百千几每这那哪')
NEUTRAL = set('的得地了着吧呢吗嘛们么啊呀')  # usually toneless particles / suffixes (zh_..5 when the voice knows it)


def has_text(t) -> bool:
    return bool(WORD.search(t or '') or CJK.search(t or ''))


def _strip_ns(root):
    for el in root.iter():
        if '}' in el.tag: el.tag = el.tag.split('}', 1)[1]
    return root


def _num(el, path, default=0.0):
    x = el.find(path)
    try: return float(x.text) if x is not None and x.text else default
    except ValueError: return default


def read(xml: str, verse=None) -> dict:
    """verse: the lyric number to sing (default: the first one in the score). A score whose notes carry one lyric
    each has lines, not verses: any lyric number is taken then."""
    root = _strip_ns(ET.fromstring(xml.encode('utf-8') if isinstance(xml, str) else xml))
    part = root.find('part')
    if part is None: raise ValueError('No part in this MusicXML')
    if verse is None:  # repeats and endings: sung as played, verse 1 the first time through, verse 2 the second …
        from .structops import has_repeats, unroll
        if has_repeats(part): root = unroll(root); part = root.find('part')
    notes, chords = [], []
    div, beats, beat_type, bpm, t, end = 1.0, 4, 4, None, 0.0, 0.0
    first_voice, multi, lyrics = None, False, {}
    for m in part.findall('measure'):
        bar_start, last = t, t
        for el in m:
            tag = el.tag
            if tag == 'attributes':
                div = _num(el, 'divisions', div) or div
                if el.find('time/beats') is not None and not notes:
                    beats, beat_type = int(_num(el, 'time/beats', beats)), int(_num(el, 'time/beat-type', beat_type))
            elif tag in ('sound', 'direction'):
                s = el if tag == 'sound' else el.find('.//sound')
                if s is not None and s.get('tempo') and bpm is None:
                    try: bpm = float(s.get('tempo'))
                    except ValueError: pass
            elif tag == 'backup': t -= _num(el, 'duration')
            elif tag == 'forward': t += _num(el, 'duration')
            elif tag == 'harmony':
                r = el.find('root/root-step')
                if r is not None and r.text in STEP:
                    root_pc = (STEP[r.text] + int(_num(el, 'root/root-alter'))) % 12
                    kind = (el.findtext('kind') or 'major').strip()
                    b = el.find('bass/bass-step')
                    bass = (STEP[b.text] + int(_num(el, 'bass/bass-alter'))) % 12 if b is not None and b.text in STEP else root_pc
                    off = _num(el, 'offset')
                    chords.append({'q': (t + off) / div, 'root': root_pc, 'bass': bass,
                                   'pcs': [(root_pc + i) % 12 for i in KIND.get(kind, KIND['major'])]})
            elif tag == 'note':
                d = _num(el, 'duration')
                is_chord = el.find('chord') is not None
                if el.find('grace') is not None: continue
                voice = el.findtext('voice') or '1'
                if first_voice is None: first_voice = voice
                start = last if is_chord else t
                if not is_chord: last, t = t, t + d
                end = max(end, t / div)
                if is_chord or voice != first_voice: continue
                p = el.find('pitch')
                q, dq = start / div, d / div
                lyrs = {}
                for l in el.findall('lyric'):
                    if has_text(l.findtext('text') or ''): lyrs.setdefault(l.get('number') or '1', l)
                if len(lyrs) > 1: multi = True
                lyrics.update(lyrs)
                if p is None or el.find('rest') is not None:
                    if notes and notes[-1]['midi'] == 0 and abs(notes[-1]['q'] + notes[-1]['d'] - q) < 1e-6: notes[-1]['d'] += dq
                    else: notes.append({'q': q, 'd': dq, 'midi': 0, 'text': '', 'syllabic': '', 'extend': False})
                    continue
                midi = 12 * (int(_num(p, 'octave', 4)) + 1) + STEP.get(p.findtext('step') or 'C', 0) + int(round(_num(p, 'alter')))
                ties = {x.get('type') for x in el.findall('tie')}
                prev = notes[-1] if notes else None
                if 'stop' in ties and prev and prev['midi'] == midi and abs(prev['q'] + prev['d'] - q) < 1e-6:
                    prev['d'] += dq  # a tied note just lengthens the one before
                    continue
                notes.append({'q': q, 'd': dq, 'midi': midi, 'lyrics': lyrs})
        # a short (pickup) bar keeps its own length; t already moved by its notes
        end = max(end, t / div)
    verses = sorted(lyrics, key=lambda k: (0, int(k)) if k.isdigit() else (1, k)) if multi else ['1']
    v = str(verse) if verse is not None and str(verse) in verses else verses[0]
    extend_used = False
    for n in notes:  # the chosen verse's lyric on each note (a one-lyric-per-note score: whatever number it has)
        lyrs = n.pop('lyrics', None)
        if lyrs is None: continue
        lyr = lyrs.get(v) if multi else next(iter(lyrs.values()), None)
        n['text'] = (lyr.findtext('text') or '').strip() if lyr is not None else ''
        n['syllabic'] = (lyr.findtext('syllabic') or 'single').strip() if lyr is not None else ''
        n['extend'] = lyr is not None and lyr.find('extend') is not None
        extend_used |= n['extend']
    mark_sung(notes, strict=extend_used)
    q_per_bar = beats * 4 / beat_type
    end_q = -(-round(end, 6) // q_per_bar) * q_per_bar if end else 0
    return {'notes': notes, 'chords': chords, 'beats': beats, 'beatType': beat_type, 'qPerBar': q_per_bar,
            'bpm': bpm, 'endQ': end_q, 'verses': verses if multi else ['1'], 'verse': v}


def has_lyrics(xml: str) -> bool:
    try: notes = read(xml)['notes']
    except (ET.ParseError, ValueError): return False
    sung = [n for n in notes if n['midi']]
    with_text = [n for n in sung if has_text(n['text'])]
    return len(sung) > 0 and len(with_text) >= max(3, 0.4 * len(sung))


def language(notes) -> str:
    """'Chinese' when most lyric notes carry Chinese characters, else 'English'."""
    zh = sum(1 for n in notes if CJK.search(n.get('text') or ''))
    en = sum(1 for n in notes if WORD.search(n.get('text') or ''))
    return 'Chinese' if zh > en else 'English'


def clean_word(text: str) -> str:
    """'grace!' -> 'grace', 'you’re' -> "you're", '虎，' -> '虎'; '' when nothing singable is left."""
    if CJK.search(text or ''): return ''.join(CJK.findall(text))
    t = text.replace('’', "'").replace('‘', "'")
    m = WORD.findall(t)
    return "'".join(m) if len(m) > 1 and "'" in t else (m[0] if m else '')


MELISMA_STEP = 5  # semitones: a words-less note after a syllable is its melisma only when it moves by a step / small leap
MELISMA_RUN = 2   # ... and only a couple of them (4 inside an unfinished word); longer runs are piano fills


def mark_sung(notes, strict=False):
    """note['sung'] = True for the notes the singer sings: a lyric syllable; then the words-less notes right after it
    that continue it (a melisma or an <extend>ed syllable; tied notes are already merged by read). strict (the score
    marks its melismas with <extend>): only extended / unfinished-word continuations. Otherwise a continuation is at
    most MELISMA_RUN notes (MELISMA_RUN * 2 inside an unfinished word), each 1..MELISMA_STEP semitones from the note
    before. Everything else (intros, fills, notes before the first word or after a rest) is silence for the singer."""
    prev, run, open_, ext = None, 0, False, False
    for n in notes:
        n['sung'] = False
        if not n['midi']:
            prev = None; continue
        if clean_word(n.get('text', '')):
            n['sung'], prev, run = True, n, 0
            open_, ext = n.get('syllabic') in ('begin', 'middle'), bool(n.get('extend'))
            continue
        if prev is None: continue
        if strict: ok = ext or open_
        else: ok = run < MELISMA_RUN * (2 if open_ else 1) and 1 <= abs(n['midi'] - prev['midi']) <= MELISMA_STEP
        if ok: n['sung'], prev, run = True, n, run + 1
        else: prev = None  # the rest of this run is a fill too
    return notes


def words(notes) -> list:
    """[{'word': 'amazing'|'' (rest), 'notes': [...]}]. Syllables begin/middle/end join into one word;
    sung words-less notes (melisma, see mark_sung) stay on the syllable before; a rest or an unsung note closes the
    word (an unsung note inside an unfinished word stays in it and is sung as silence)."""
    if notes and 'sung' not in notes[0]: mark_sung(notes)
    out, cur = [], None
    for n in notes:
        if not n['midi'] or not n.get('sung', True):
            if n['midi'] and cur is not None and cur['open']:  # a fill in the middle of a word: silence inside it
                cur['notes'].append(n); cur['syl'].append(cur['syl'][-1]); continue
            cur = None
            if out and out[-1].get('word') == '': out[-1]['notes'].append(n)
            else: out.append({'word': '', 'notes': [n]})
            continue
        syl, text = n['syllabic'], n['text']
        if clean_word(text) and syl in ('middle', 'end') and cur is not None and cur['open']:
            cur['parts'].append(text); cur['notes'].append(n); cur['syl'].append(len(cur['parts']) - 1)
            cur['open'] = syl == 'middle'
        elif clean_word(text):
            cur = {'parts': [text], 'notes': [n], 'syl': [0], 'open': syl in ('begin', 'middle')}
            out.append(cur)
        else:  # melisma: the same syllable carries on (mark_sung only lets these follow a sung note)
            cur['notes'].append(n); cur['syl'].append(cur['syl'][-1])
    for w in out:
        if 'parts' in w:
            w['syllables'] = [clean_word(x) for x in w['parts']]
            w['word'] = clean_word(''.join(w.pop('parts'))) or 'la'
            w.pop('open', None)
    return out


TONES = {c: (v, k + 1) for v, marks in (('a', 'āáǎà'), ('e', 'ēéěè'), ('i', 'īíǐì'), ('o', 'ōóǒò'), ('u', 'ūúǔù'),
                                         ('ü', 'ǖǘǚǜ')) for k, c in enumerate(marks)}


def pinyin_number(syl: str) -> str:
    """'lǎo' -> 'lao3', 'lǜ' -> 'lu:4', 'ma' -> 'ma5' (SoulX-Singer's Mandarin phone names, without the zh_ prefix)."""
    out, tone = [], 5
    for ch in syl.lower():
        if ch in TONES: v, tone = TONES[ch]; out.append(v)
        else: out.append(ch)
    s = ''.join(out)
    s = re.sub(r'^([ln])ü', r'\1u:', s).replace('ü', 'u')  # ü is 'u:' after l / n; after j q x y it is written u
    return re.sub(r'[^a-z:]', '', s) + str(tone)


def mandarin(text: str) -> list:
    """Chinese characters -> one pinyin syllable each (['liang3', 'zhi1', ...]), via macOS's own Mandarin→Latin
    transform (CFStringTransform, offline, word-aware). [] when it isn't available."""
    import subprocess
    chars = CJK.findall(text)
    if not chars: return []
    js = ('ObjC.import("Foundation");function run(a){var m=$.NSMutableString.alloc.initWithString(a[0]);'
          '$.CFStringTransform(m,null,$.kCFStringTransformMandarinLatin,false);return m.js}')
    try:
        r = subprocess.run(['osascript', '-l', 'JavaScript', '-e', js, ''.join(chars)], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return []
    syls = r.stdout.split()
    if r.returncode or len(syls) != len(chars): return []
    out = [pinyin_number(x)[:-1] + '5' if c in NEUTRAL else pinyin_number(x) for c, x in zip(chars, syls)]
    for i, c in enumerate(chars):  # 只 after a number is the measure word zhī ("两只老虎"), not zhǐ "only"
        if c == '只' and i and chars[i - 1] in COUNT: out[i] = 'zhi1'
    return out


def add_pinyin(segs, zh=None):
    """w['pinyin'] for every Chinese word of the song, from one transform of the whole lyric (word context kept)."""
    ws = [w for g in segs for w in g['words'] if w['word'] and CJK.search(w['word'])]
    pys = (zh or mandarin)(''.join(w['word'] for w in ws))
    if len(pys) != sum(len(CJK.findall(w['word'])) for w in ws): return segs
    k = 0
    for w in ws:
        n = len(CJK.findall(w['word'])); w['pinyin'] = pys[k:k + n]; k += n
    return segs


def split_syllables(phones, n):
    """Word phonemes -> n syllables, one vowel each (a lone consonant between vowels starts the next one):
    ['AH0','M','EY1','Z','IH0','NG'], 3 -> [['AH0'], ['M','EY1'], ['Z','IH0','NG']]. None when the vowels don't match."""
    vow = [i for i, p in enumerate(phones) if p[-1:].isdigit()]
    if n <= 1 or len(vow) != n: return None
    cuts = [0] + [vow[k + 1] - 1 if vow[k + 1] - vow[k] > 1 else vow[k + 1] for k in range(n - 1)] + [len(phones)]
    return [phones[cuts[k]:cuts[k + 1]] for k in range(n)]


def segments(ws, bpm, *, min_s=6.0, max_s=14.0) -> list:
    """Cut the words into phrases: after a rest, or after a word whose last note is long, once a phrase is
    min_s long; always by max_s. Returns [{'start': q, 'end': q, 'words': [...]}] covering the song with no gaps."""
    spq = 60.0 / bpm
    segs, cur = [], []

    def length(ws_):
        return sum(n['d'] for w in ws_ for n in w['notes']) * spq

    for i, w in enumerate(ws):
        cur.append(w)
        long_end = w['notes'][-1]['d'] >= 1.5 or not w['word']
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        if nxt is None: break
        if (length(cur) >= min_s and long_end) or length(cur) + length([nxt]) > max_s:
            segs.append(cur); cur = []
    if cur: segs.append(cur)
    out = []
    for s in segs:
        a = s[0]['notes'][0]['q']
        b = s[-1]['notes'][-1]['q'] + s[-1]['notes'][-1]['d']
        out.append({'start': a, 'end': b, 'words': s})
    return out


def soulx_meta(seg, bpm, g2p, index=0, tail_q=0.0, mode='syllable', lang='English', zh=None) -> dict:
    """g2p(word) -> ['AH0', 'M', ...]. tail_q: extra rest after the phrase (the last phrase rings out).
    mode 'word': the whole word's phonemes on each of its notes (the model's training format);
    'syllable': each syllable sung on its own notes (clearer words on long melismatic words, e.g. A-maz-ing)."""
    spq = 60.0 / bpm
    dur, text, ph, pitch, typ = [], [], [], [], []
    for w in seg['words']:
        if not w['word']:
            for n in w['notes']:
                dur.append(n['d'] * spq); text.append('<SP>'); ph.append('<SP>'); pitch.append(0); typ.append(1)
            continue
        if lang == 'Chinese':  # zh(word) -> one pinyin per character; a note with k characters is split in k for the voice
            chars = CJK.findall(w['word'])
            pys = w.get('pinyin') or ((zh or mandarin)(w['word']) if chars else [])
            syl = w.get('syl') or [0] * len(w['notes'])
            for k, n in enumerate(w['notes']):
                if not n.get('sung', True) or not pys:
                    dur.append(n['d'] * spq); text.append('<SP>'); ph.append('<SP>'); pitch.append(0); typ.append(1); continue
                cont = k > 0 and syl[k] == syl[k - 1] and w['notes'][k - 1].get('sung', True)
                own = [i for i, c in enumerate(_note_chars(w, syl, k))] if not cont else []
                if cont:  # melisma: the same character carries on
                    dur.append(n['d'] * spq); text.append(text[-1]); ph.append(ph[-1]); pitch.append(n['midi']); typ.append(3); continue
                start = sum(len(_note_chars(w, syl, j)) for j in range(k) if j == 0 or syl[j] != syl[j - 1])
                for i in own:
                    p_ = pys[min(start + i, len(pys) - 1)]
                    dur.append(n['d'] * spq / len(own)); text.append(chars[min(start + i, len(chars) - 1)])
                    ph.append('zh_' + p_); pitch.append(n['midi']); typ.append(2)
            continue
        phones = [p for p in g2p(w['word'].lower()) if re.fullmatch(r'[A-Z]+[0-2]?', p)]
        tok = 'en_' + '-'.join(phones) if phones else '<SP>'
        syl = w.get('syl') or [0] * len(w['notes'])
        parts = split_syllables(phones, syl[-1] + 1) if mode == 'syllable' else None
        for k, n in enumerate(w['notes']):
            if not n.get('sung', True):  # an unsung note inside a word: silence, same length
                dur.append(n['d'] * spq); text.append('<SP>'); ph.append('<SP>'); pitch.append(0); typ.append(1)
                continue
            t = 'en_' + '-'.join(parts[syl[k]]) if parts else tok
            first = k == 0 or (parts is not None and syl[k] != syl[k - 1]) or not w['notes'][k - 1].get('sung', True)
            dur.append(n['d'] * spq); text.append(w['word']); ph.append(t); pitch.append(n['midi'])
            typ.append(1 if t == '<SP>' else (2 if first else 3))
    if tail_q > 0:
        dur.append(tail_q * spq); text.append('<SP>'); ph.append('<SP>'); pitch.append(0); typ.append(1)
    t0 = seg['start'] * spq * 1000
    return {
        'index': f'seg_{index}', 'language': 'Mandarin' if lang == 'Chinese' else 'English',
        'time': [round(t0), round(t0 + sum(dur) * 1000)],
        'duration': ' '.join(f'{x:.3f}' for x in dur), 'text': ' '.join(text), 'phoneme': ' '.join(ph),
        'note_pitch': ' '.join(map(str, pitch)), 'note_type': ' '.join(map(str, typ)),
    }


def _note_chars(w, syl, k):
    """the characters a word's k-th note starts (its syllable's lyric text); at least one"""
    parts = w.get('syllables') or [w['word']]
    return CJK.findall(parts[min(syl[k], len(parts) - 1)]) or ['']


def sung_spans(notes, spq, pre=0.05, post=0.2):
    """[(a, b)] seconds where the singer may be heard: each sung note from `pre` before its onset to `post` after
    its end, overlapping spans joined. Everything outside is silence (rests, intros, fills)."""
    out = []
    for n in notes:
        if not n['midi'] or not n.get('sung', True): continue
        a, b = max(0.0, n['q'] * spq - pre), (n['q'] + n['d']) * spq + post
        if out and a <= out[-1][1]: out[-1][1] = max(out[-1][1], b)
        else: out.append([a, b])
    return [tuple(x) for x in out]


def song_bpm(info: dict, item_bpm=None) -> float:
    """The tempo to sing at: the score's own tempo mark, else the library's bpm, else 100 (the player's default)."""
    return float(info.get('bpm') or item_bpm or 100)
