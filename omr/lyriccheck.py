"""Is a word read off a sheet a real word? Vietnamese: a well-formed syllable (initial + rhyme + at most one tone,
and the tone fits the ending) that the Mac's Vietnamese spelling dictionary knows; English: the Mac's English
spelling dictionary (else /usr/share/dict/words with plain endings taken off). All on this Mac, nothing sent out.
Used by omr.py to flag poorly read lyric lines ("lyrics unsure"); the words read are always kept."""
import re
import unicodedata
from pathlib import Path

TONES = {'\u0300', '\u0301', '\u0303', '\u0309', '\u0323'}  # huyền sắc ngã hỏi nặng
INITIALS = ('ngh', 'ch', 'gh', 'gi', 'kh', 'ng', 'nh', 'ph', 'qu', 'th', 'tr',
            'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x', '')
RHYMES = set('''a ac ach ai am an ang anh ao ap at au ay ăc ăm ăn ăng ăp ăt âc âm ân âng âp ât âu ây
e ec em en eng eo ep et ê êch êm ên ênh êp êt êu i ia ich im in inh ip it iu iêc iêm iên iêng iêp iêt iêu
o oc oi om on ong op ot oong ooc oa oac oach oai oam oan oang oanh oao oap oat oay oăc oăm oăn oăng oăt
oe oen oeo oet ô ôc ôi ôm ôn ông ôp ôt ơ ơi ơm ơn ơp ơt u ua uc ui um un ung up ut uân uâng uât uây uê uêch
uênh uy uya uych uyên uyêt uynh uyt uyu uơ uôc uôi uôm uôn uông uôt ư ưa ưc ưi ưm ưn ưng ưt ưu ươc ươi ươm
ươn ương ươp ươt ươu y yêm yên yêng yêt yêu'''.split())


def _untone(w):
    """(word without its tone mark, tone marks found)."""
    d = unicodedata.normalize('NFD', w)
    tones = [c for c in d if c in TONES]
    return unicodedata.normalize('NFC', ''.join(c for c in d if c not in TONES)), tones


def viet(word):
    """A well-formed Vietnamese syllable (any case: Này, NÀY, này)."""
    w = word.strip(".,;:!?\"'“”‘’()…")
    if not w or not (w.islower() or w.isupper() or (w[0].isupper() and w[1:].islower())): return False
    base, tones = _untone(w.lower())
    if len(tones) > 1 or not re.fullmatch(r'[a-zđăâêôơư]+', base): return False
    for ini in INITIALS:
        if not base.startswith(ini): continue
        r = base[len(ini):]
        if ini == 'gi' and (r == '' or r in RHYMES or 'i' + r in RHYMES): pass
        elif r not in RHYMES: continue
        elif ini == 'qu' and r[:1] in ('u', 'o'): continue
        elif ini in ('k', 'gh', 'ngh') and r[:1] not in ('i', 'e', 'ê', 'y'): continue
        elif ini in ('c', 'g', 'ng') and r[:1] in ('i', 'e', 'ê') and not (ini == 'g' and r.startswith('i')): continue
        if r.endswith(('p', 't', 'c', 'ch')) and tones and tones[0] not in ('\u0301', '\u0323'): continue  # stopped endings: sắc / nặng only
        return spelled(w.lower(), 'vi') is not False
    return False


_EN = set()
_SPELL = []


def spelled(word, lang):
    """The Mac's spelling dictionary for lang ('vi', 'en') knows the word; None when it can't be asked."""
    if not _SPELL:
        try:
            import AppKit
            _SPELL.append(AppKit.NSSpellChecker.sharedSpellChecker())
        except Exception:
            _SPELL.append(None)
    sc = _SPELL[0]
    if sc is None: return None
    r = sc.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount_(word, 0, lang, False, 0, None)
    return r[0].length == 0


def _english_words():
    if not _EN:
        try: _EN.update(l.strip().lower() for l in Path('/usr/share/dict/words').read_text(errors='ignore').splitlines())
        except OSError: pass
        _EN.update(("i", "a", "o", "oh", "ah", "la", "na", "da", "doo", "ooh", "hey", "yeah", "gonna", "wanna", "ok", "okay"))
    return _EN


def english(word):
    w = word.strip(".,;:!?\"“”‘’()…").replace('’', "'").lower()
    if not re.fullmatch(r"[a-z]+(?:'[a-z]+)?'?", w or '-'): return False
    if len(w) == 1 and w not in ('a', 'i', 'o'): return False
    sp = spelled(w, 'en')
    if sp is not None: return sp
    ws = _english_words()
    w = w.rstrip("'")
    w = re.sub(r"(n't|'s|'re|'ll|'ve|'d|'m)$", '', w) or w
    if w.endswith("in'"): w = w[:-1] + 'g'
    if w in ws: return True
    for end, add in (('s', ''), ('es', ''), ('ies', 'y'), ('ed', ''), ('ed', 'e'), ('d', ''), ('ing', ''), ('ing', 'e'),
                     ('ly', ''), ('er', ''), ('est', ''), ('ied', 'y'), ('iness', 'y'), ('ness', '')):
        if w.endswith(end) and len(w) > len(end) + 1 and (w[:-len(end)] + add) in ws: return True
        if w.endswith(end) and len(w) > len(end) + 2 and w[-len(end) - 1] == w[-len(end) - 2] and w[:-len(end) - 1] in ws: return True  # running → run
    return False


def word_ok(word):
    """A real word (or a syllable of one) in Vietnamese or English."""
    return viet(word) or english(word)


def bad_shape(word):
    """Clearly not a word: digits, symbols, capitals inside a word (OCR noise)."""
    w = word.strip(".,;:!?\"'“”‘’()…")
    if not w: return True
    if re.search(r'[0-9@#$%^&*=+<>{}\[\]|\\/~]', w): return True
    return any(c.isupper() for c in w[1:]) and not w.isupper()


PUNCT = ".,;:!?\"'“”‘’()…"


def join_pieces(pieces):
    """Syllables [(text, hyphen after)] joined back into words by their hyphens: [(word, [piece indices])]."""
    out, cur, idx = [], '', []
    for k, (t, hy) in enumerate(pieces):
        cur += t; idx.append(k)
        if not hy: out.append((cur, idx)); cur, idx = '', []
    if cur: out.append((cur, idx))
    return out


def credits(pieces):
    """[(word, piece indices, real word?)] for a line of syllables [(text, hyphen after)]. A word is sung one
    syllable per note ("beau-ti-ful"), so the syllables are judged as the word they make: joined by their hyphens;
    hyphenated syllables that are each real count ("sun-shine"); pieces whose hyphen wasn't read ("beau ti ful")
    count when they join into a real word; a word cut at the line end ("won-") goes on to the next line."""
    words = join_pieces(pieces)
    ok = [word_ok(w.strip(PUNCT)) for w, _ in words]
    for k, (w, idx) in enumerate(words):
        if not ok[k] and len(idx) > 1 and all(word_ok(pieces[i][0].strip(PUNCT)) for i in idx):
            ok[k] = True
    for k in range(len(words)):
        if ok[k]: continue
        for a in range(max(0, k - 3), k + 1):  # a run of pieces around it that makes a real word
            hit = next((b for b in range(max(k + 1, a + 2), min(len(words), a + 4) + 1)
                        if not any(w[-1:] in PUNCT for w, _ in words[a:b - 1])
                        and not any(bad_shape(w) for w, _ in words[a:b])
                        and word_ok(''.join(w for w, _ in words[a:b]).strip(PUNCT))), None)
            if hit:
                for q in range(a, hit): ok[q] = True
                break
    if words and not ok[-1] and pieces[words[-1][1][-1]][1] and not bad_shape(words[-1][0]):
        ok[-1] = True
    return [(w, idx, o) for (w, idx), o in zip(words, ok)]


def line_score(words):
    """Share of the words of a line that are real words, the syllables sung on separate notes ("beau-", "ti-",
    "ful", or "beau", "ti", "ful") judged as the word they make."""
    pieces = [(w.rstrip('-–'), w.endswith(('-', '–'))) for w in words if w.strip('-–')]
    cr = credits(pieces)
    return sum(o for *_, o in cr) / len(cr) if cr else 0.0


def split_viet(word):
    """Words printed too close together and read as one ("Hômchia" → Hôm, chia; "hitwallson" → hit, walls, on):
    the fewest real Vietnamese syllables (or English words of 2+ letters) that make up the word, or None."""
    w = word.strip(".,;:!?\"'“”‘’()…")
    if len(w) < 5 or word_ok(w): return None
    ok = lambda part: viet(part) or (len(part) >= 2 and part.isascii() and english(part)) or part in ('a', 'I')
    best = {0: []}
    for i in range(len(w)):
        if i not in best: continue
        for j in range(i + 1, min(len(w), i + 10) + 1):
            part = w[i:j]
            if (j not in best or len(best[i]) + 1 < len(best[j])) and ok(part): best[j] = best[i] + [part]
    parts = best.get(len(w))
    return parts if parts and 1 < len(parts) <= 4 else None
