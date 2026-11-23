"""MusicXML lead sheet -> what a singing-voice model needs (stdlib only, so the server and tests can use it).

read(xml)            -> {'notes': [{q, d, midi, text, syllabic}], 'chords': [{q, root, bass, pcs}], 'beats', 'bpm', 'endQ'}
                        (melody = first part, first voice; tied notes merged; q / d in quarter notes)
words(notes)         -> sung units: one per rest or per lyric word, each with all its notes (melisma included)
segments(ws, bpm)    -> phrases of a few seconds, cut at rests or after long notes (the model sings one at a time)
soulx_meta(seg, g2p) -> one SoulX-Singer target-metadata entry: word-level ARPAbet phonemes repeated on every
                        note of the word, note_type 1 rest / 2 word start / 3 same word continues (its training format)
has_lyrics(xml)      -> True when the melody carries English-looking lyrics
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


def _strip_ns(root):
    for el in root.iter():
        if '}' in el.tag: el.tag = el.tag.split('}', 1)[1]
    return root


def _num(el, path, default=0.0):
    x = el.find(path)
    try: return float(x.text) if x is not None and x.text else default
    except ValueError: return default


def read(xml: str) -> dict:
    root = _strip_ns(ET.fromstring(xml.encode('utf-8') if isinstance(xml, str) else xml))
    part = root.find('part')
    if part is None: raise ValueError('No part in this MusicXML')
    notes, chords = [], []
    div, beats, beat_type, bpm, t, end = 1.0, 4, 4, None, 0.0, 0.0
    first_voice = None
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
                lyr = next((l for l in el.findall('lyric') if (l.get('number') or '1') == '1'), None)
                if lyr is None: lyr = el.find('lyric')
                text = (lyr.findtext('text') or '').strip() if lyr is not None else ''
                syl = (lyr.findtext('syllabic') or 'single').strip() if lyr is not None else ''
                if p is None or el.find('rest') is not None:
                    if notes and notes[-1]['midi'] == 0 and abs(notes[-1]['q'] + notes[-1]['d'] - q) < 1e-6: notes[-1]['d'] += dq
                    else: notes.append({'q': q, 'd': dq, 'midi': 0, 'text': '', 'syllabic': ''})
                    continue
                midi = 12 * (int(_num(p, 'octave', 4)) + 1) + STEP.get(p.findtext('step') or 'C', 0) + int(round(_num(p, 'alter')))
                ties = {x.get('type') for x in el.findall('tie')}
                prev = notes[-1] if notes else None
                if 'stop' in ties and prev and prev['midi'] == midi and abs(prev['q'] + prev['d'] - q) < 1e-6:
                    prev['d'] += dq  # a tied note just lengthens the one before
                    continue
                notes.append({'q': q, 'd': dq, 'midi': midi, 'text': text, 'syllabic': syl})
        # a short (pickup) bar keeps its own length; t already moved by its notes
        end = max(end, t / div)
    q_per_bar = beats * 4 / beat_type
    end_q = -(-round(end, 6) // q_per_bar) * q_per_bar if end else 0
    return {'notes': notes, 'chords': chords, 'beats': beats, 'beatType': beat_type, 'qPerBar': q_per_bar,
            'bpm': bpm, 'endQ': end_q}


def has_lyrics(xml: str) -> bool:
    try: notes = read(xml)['notes']
    except (ET.ParseError, ValueError): return False
    sung = [n for n in notes if n['midi']]
    with_text = [n for n in sung if WORD.search(n['text'])]
    return len(sung) > 0 and len(with_text) >= max(3, 0.4 * len(sung))


def clean_word(text: str) -> str:
    """'grace!' -> 'grace', 'you’re' -> "you're"; '' when nothing singable is left."""
    t = text.replace('’', "'").replace('‘', "'")
    m = WORD.findall(t)
    return "'".join(m) if len(m) > 1 and "'" in t else (m[0] if m else '')


def words(notes) -> list:
    """[{'word': 'amazing'|'' (rest), 'notes': [...]}]. Syllables begin/middle/end join into one word;
    pitched notes without a lyric (melisma) stay on the word before; a rest closes the word."""
    out, cur = [], None
    for n in notes:
        if not n['midi']:
            cur = None
            if out and out[-1].get('word') == '': out[-1]['notes'].append(n)
            else: out.append({'word': '', 'notes': [n]})
            continue
        syl, text = n['syllabic'], n['text']
        if text and syl in ('middle', 'end') and cur is not None and cur['open']:
            cur['parts'].append(text); cur['notes'].append(n); cur['syl'].append(len(cur['parts']) - 1)
            cur['open'] = syl == 'middle'
        elif text:
            cur = {'parts': [text], 'notes': [n], 'syl': [0], 'open': syl in ('begin', 'middle')}
            out.append(cur)
        elif cur is not None:
            cur['notes'].append(n); cur['syl'].append(cur['syl'][-1])  # melisma: the same syllable carries on
        else:
            cur = {'parts': ['la'], 'notes': [n], 'syl': [0], 'open': False}  # a note with no words at all: "la"
            out.append(cur)
    for w in out:
        if 'parts' in w:
            w['syllables'] = [clean_word(x) for x in w['parts']]
            w['word'] = clean_word(''.join(w.pop('parts'))) or 'la'
            w.pop('open', None)
    return out


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


def soulx_meta(seg, bpm, g2p, index=0, tail_q=0.0, mode='syllable') -> dict:
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
        phones = [p for p in g2p(w['word'].lower()) if re.fullmatch(r'[A-Z]+[0-2]?', p)]
        tok = 'en_' + '-'.join(phones) if phones else '<SP>'
        syl = w.get('syl') or [0] * len(w['notes'])
        parts = split_syllables(phones, syl[-1] + 1) if mode == 'syllable' else None
        for k, n in enumerate(w['notes']):
            t = 'en_' + '-'.join(parts[syl[k]]) if parts else tok
            first = k == 0 or (parts is not None and syl[k] != syl[k - 1])
            dur.append(n['d'] * spq); text.append(w['word']); ph.append(t); pitch.append(n['midi'])
            typ.append(1 if t == '<SP>' else (2 if first else 3))
    if tail_q > 0:
        dur.append(tail_q * spq); text.append('<SP>'); ph.append('<SP>'); pitch.append(0); typ.append(1)
    t0 = seg['start'] * spq * 1000
    return {
        'index': f'seg_{index}', 'language': 'English',
        'time': [round(t0), round(t0 + sum(dur) * 1000)],
        'duration': ' '.join(f'{x:.3f}' for x in dur), 'text': ' '.join(text), 'phoneme': ' '.join(ph),
        'note_pitch': ' '.join(map(str, pitch)), 'note_type': ' '.join(map(str, typ)),
    }


def song_bpm(info: dict, item_bpm=None) -> float:
    """The tempo to sing at: the score's own tempo mark, else the library's bpm, else 100 (the player's default)."""
    return float(info.get('bpm') or item_bpm or 100)
