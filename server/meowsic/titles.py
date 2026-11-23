"""Song title from a sheet page photo: Apple Vision reads the top of the page (omr/title.py, run with the
omr venv so this server doesn't need pyobjc); the title is the biggest text there that isn't a page number,
a credit line, a tempo word, chord names, a site name or the book's running header.

The lines Vision read are cached in work/titles.json by page file and its modified time, so asking again
is instant; the pick itself is cheap and done each time (it can use what other pages of the book say).

From the old Meowsic app (SheetTextRecognizer.swift, in git history before 2.0): between lines about as big,
the one nearer the top and the middle wins; a title printed on two lines (also when the second starts lower
case) is one block; a credit on the title's line is cut off; lines Vision read with low confidence (chord
diagrams, bar lines) count less; and the title is read a second time, zoomed in, with the library's titles
as custom words — a word of that second reading is taken only when the page prints it that way elsewhere."""
import json
import os
import re
import subprocess
import threading
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from . import cleanup
from .db import folder_path
from .items import cfg, conn, must_item

router = APIRouter(prefix='/api')
_lock = threading.Lock()

OMR_DIR = Path(__file__).resolve().parents[2] / 'omr'
SCRIPT = OMR_DIR / 'title.py'
TOP = 0.30  # the title starts in the top 30% of the page


def _python() -> Path | None:
    for p in (os.environ.get('MEOWSIC_OMR_PY'), OMR_DIR / '.venv' / 'bin' / 'python',
              Path.home() / 'git' / 'apps' / 'meowsic' / 'omr' / '.venv' / 'bin' / 'python'):
        if p and Path(p).exists(): return Path(p)
    return None


def available() -> bool:
    return _python() is not None and SCRIPT.is_file()


def read_lines(paths: list[Path]) -> dict[str, dict]:
    """{str(path): {w, h, lines} | {error}} straight from omr/title.py."""
    py = _python()
    if not py or not SCRIPT.is_file(): raise RuntimeError('Title reading is not set up on this Mac (omr/.venv missing)')
    r = subprocess.run([str(py), str(SCRIPT), *map(str, paths)], capture_output=True, text=True, timeout=60 + 20 * len(paths))
    if r.returncode != 0: raise RuntimeError((r.stderr or 'title.py failed').strip().splitlines()[-1][:300])
    return json.loads(r.stdout)


# ---------- picking the title ----------
TEMPO = {'moderately', 'slowly', 'brightly', 'lively', 'gently', 'freely', 'briskly', 'tenderly', 'smoothly', 'quickly',
         'fast', 'slow', 'moderate', 'medium', 'steady', 'flowing', 'happily', 'joyfully', 'cheerfully', 'gracefully',
         'swing', 'swung', 'ballad', 'waltz', 'march', 'rubato', 'expressively', 'majestically', 'playfully', 'bouncy',
         'allegro', 'allegretto', 'andante', 'andantino', 'adagio', 'largo', 'lento', 'moderato', 'presto', 'vivace',
         'maestoso', 'grazioso', 'cantabile', 'dolce', 'tempo', 'rock', 'pop', 'shuffle', 'legato', 'staccato',
         'with', 'feeling', 'and', 'a', 'beat', 'steadily', 'not', 'too', 'very', 'quite', 'in', 'time', 'molto', 'poco',
         'con', 'moto', 'brio', 'ma', 'non', 'troppo', 'mf', 'mp', 'f', 'p', 'ff', 'pp', 'rit', 'cresc', 'dim', 'easy',
         'gospel', 'latin', 'bossa', 'nova', 'reggae', 'country', 'blues', 'tempo:', 'pedal', 'freely,', 'chậm', 'vừa',
         'nhanh', 'more', 'less', 'still', 'flowing', 'easily', 'freedom', 'rhythmically', 'peacefully', 'lightly', 'broadly', 'driving', 'relaxed', 'bright', 'gently,', 'half-time', 'feel', 'straight', 'eighths', 'triplets', 'tempo', 'accel', 'liberamente', 'phải', 'tha', 'thiết', 'nhẹ', 'nhàng', 'tình', 'cảm', 'vui', 'tươi', 'sâu', 'lắng'}
CREDIT = re.compile(r'(words?\s*(and|&)\s*music|music\s*(and|&)\s*(words|lyrics)|\b(music|lyrics?|words|text|melody)\s*(by|:)|'
                    r'\barr(anged|\.|angement)?\s*(by|for|:)|\barr\.|\bcompos(ed|er)\b|\bby\s+[A-Z]|\bfrom\s+(the\s+)?(walt\s+)?(disney|film|motion|movie|musical|broadway|album|opera|suite|ballet)|'
                    r'\bfrom\b.*\b(film|movie|picture|musical|production|show)\b|\bfeaturing\b|\bas\s+(performed|recorded|sung)\b|\brecorded\s+by\b|\bperformed\s+by\b|'
                    r'\bnhạc\s*(và\s*lời|:)|\blời\s*:|\bsáng\s*tác|\bphỏng\s*dịch|\btrình\s*bày|\bsoạn\b|\bthơ\s*:|'
                    r'copyright|©|\(c\)\s*\d|all\s+rights|reserved|international|used\s+by\s+permission|printed|publish|'
                    r'\bop\.\s*\d|\bopus\b|\bno\.\s*\d+\s*$|\bBWV\b|\bK\.\s*\d|\bHob\b|\b1[6-9]\d\d\s*[-–]\s*1[6-9]\d\d\b|\(\s*1[6-9]\d\d)', re.I)
SITE = re.compile(r'(www\.|https?:|\.com\b|\.net\b|\.org\b|\.vn\b|hocnhac|musescore|sheet\s*music|musicnotes|8notes|'
                  r'hal\s*leonard|alfred|faber|schott|edition|wise\s+publications|warner|universal|scribd|pdf|imslp|'
                  r'piano\s*sheet|free\s*sheet|guitar\s*tab|tabs?\b|\bchords?\s*:|\bpage\s*\d|\btrang\s*\d)', re.I)
# web pages around a screenshot: shop banners, buttons, menus (the title is never one of these)
AD = re.compile(r'(\bsale\b|\d\s*%\s*off\b|\bfree\s+trial\b|\bstart\s+free\b|\bsubscribe\b|\bsign\s*(up|in)\b|\blog\s*in\b|\bupload\b|'
                r'\bview\s+offer\b|\bdownload\b|\bcookies?\b|\badvert|\bsongbooks\b.*\bnews\b|\bpremium\b|\bplay\s+along\b)', re.I)
# a credit printed on the same line as the title ("We Are Singapore  Arranged by: Marvin Khoo"): keep the title part
CREDIT_TAIL = re.compile(r'\s+(\(?(words?\s*(and|&)\s*music|music\s*(and|&)\s*lyrics|music|lyrics?|words|arr(anged|\.)?|composed|transcribed)\s*(by|:)|\bby\s+[A-Z]).*$', re.I)
GLYPHS = re.compile(r'[IlHh1|!¡ı:;.,\'"\s]+')  # chord-diagram grids and bar lines read as letters ("I|II", "HI II", "!!!!!")
CHORD_TOK = re.compile(r'^(N\.?C\.?|[A-G][#b♯♭$]?(maj|min|m|M|dim|aug|sus|add|°|ø|\+|-)?[0-9]{0,2}(\(?(b|#|♭|♯|add|sus|maj)?[0-9]{1,2}\)?)*(sus[24]?)?(/[A-G][#b♯♭]?)?)$')
VIET = set('ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ')
SMALL = {'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'from', 'with', 'as', 'vs', 'de', 'la', 'le', 'du', 'des', 'et'}


def fold(s: str) -> str:
    s = unicodedata.normalize('NFD', s.lower())
    return re.sub(r'[^a-z0-9đ]+', ' ', ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn')).strip()


def clean(text: str) -> str:
    t = unicodedata.normalize('NFC', text)
    t = re.sub(r'[‘’`´]', "'", t)
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'^\d{1,3}\s+(?=\D)', '', t)          # page number in front
    t = re.sub(r'(?<=\D)\s+\d{1,3}$', '', t)          # … or at the end
    t = re.sub(r'^[\s"“”\'.\-_|·•:*~]+|[\s"“”\'.\-_|·•:,;*~]+$', '', t)
    t = re.sub(r'\s*-\s*$', '', t)
    t = re.sub(r'\s*(入門|ドレミ付き|ハ長調)\s*', ' ', t).strip()  # "beginner", "with do-re-mi" on Japanese sheets
    if t.endswith(')') and '(' not in t: t = t[:-1]
    return recase(t)


def recase(t: str) -> str:
    """ALL CAPS → Title Case (English) or sentence case (Vietnamese); anything else stays as printed."""
    letters = [ch for ch in t if ch.isalpha()]
    if len(letters) < 2 or any(ch.islower() for ch in letters): return t
    if any(ch in VIET for ch in t.lower()):
        low = t.lower()
        return low[:1].upper() + low[1:]
    out = []
    for k, w in enumerate(t.split(' ')):
        lw = w.lower()
        if re.fullmatch(r'[IVX]+', w) and len(w) <= 4 and w not in ('I',) or w in ('I', "I'M", "I'LL", "I'VE", "I'D"):
            out.append(w if re.fullmatch(r'[IVX]+', w) else 'I' + lw[1:]); continue
        if k and lw in SMALL: out.append(lw); continue
        m = re.match(r'^([^a-z]*)([a-z])(.*)$', lw)
        out.append(m.group(1) + m.group(2).upper() + m.group(3) if m else w)
    return ' '.join(out)


def _chordish(tok: str) -> bool:
    """A chord name as Vision misreads it ('D/FF', 'APmaj7', 'Bo', 'Em(sus4)'), or a lone bit of one."""
    if len(tok) <= 1 or re.fullmatch(r'\d+\.?', tok): return True
    if re.fullmatch(r'(maj|min|dim|aug|sus|add|m)\d*', tok): return True
    return bool(re.match(r'^[A-G]', tok)) and (len(tok) <= 2 or bool(re.search(r'[0-9/#$]|maj|min|dim|aug|sus|add', tok)))


def _size(r, aspect) -> float:
    """How big the letters are: box height, checked against the average letter width (boxes of lines
    with tall punctuation or accents can be taller than the letters are)."""
    n = max(1, len(r['text'].replace(' ', '')))
    cw = r['w'] * aspect / n  # letter width in page-height units
    return min(r['h'], 1.9 * cw) if n >= 4 else r['h']


def _junk(text: str, repeats: set[str]) -> str | None:
    """Why a line can't be the title (None = it can)."""
    t = text.strip()
    letters = sum(ch.isalpha() for ch in t)
    if letters < 2: return 'number'
    if GLYPHS.fullmatch(t): return 'garbled'
    if AD.search(t): return 'site'
    if re.fullmatch(r'[\d\s.,:;/()\-–=♩♪]+', t) or re.search(r'[♩♪]\s*=|=\s*\d{2,3}\b|\bca\.?\s*\d{2,3}\b|\bM\.?M\.?\b', t): return 'number'
    if '=' in t: return 'number'  # metronome mark (♩ = 96)
    toks = t.replace('(', ' ').replace(')', ' ').split()
    if toks and all(CHORD_TOK.match(x) or _chordish(x) for x in toks): return 'chords'
    if CREDIT.search(t): return 'credit'
    if SITE.search(t): return 'site'
    words = [w for w in re.split(r'[^\wÀ-ỹ:]+', t.lower()) if w]
    if words and all(w in TEMPO for w in words): return 'tempo'
    if re.fullmatch(r'(?i)(intro|verse|chorus|bridge|coda|fine|refrain|ending|piano|vocal|voice|solo|duet|primo|secondo|\d\.?)\s*\d*\.?', t): return 'section'
    if fold(t) in repeats: return 'header'
    first = next((ch for ch in t if ch.isalpha()), '')
    if first.islower(): return 'lyrics'  # titles start with a capital; words under the notes mostly don't
    if re.search(r'\w\s*-\s+\w|\w\s+-\s*\w', t) and not re.search(r'\s[-–]\s', t): return 'lyrics'  # hy - phen - ated syllables
    if letters < 0.5 * len(t.replace(' ', '')): return 'garbled'
    return None


def pick(page: dict, repeats: set[str] | None = None) -> dict:
    """{title, confidence 0..1, alts} from one page's Vision lines (title.py output)."""
    repeats = repeats or set()
    staff = page.get('staff')
    top = min(0.4, staff) if staff is not None else TOP  # the title is above the first staff
    lines = [dict(l) for l in page.get('lines') or [] if l['y'] + 0.5 * l['h'] <= top + 0.005 and l['y'] <= max(TOP, top) and l['text'].strip()]
    for l in lines:  # "Title   Arranged by: Someone" on one line → the title part
        m = CREDIT_TAIL.search(l['text'])
        if m and m.start() >= 3 and sum(ch.isalpha() for ch in l['text'][:m.start()]) >= 3:
            l['w'] *= m.start() / max(1, len(l['text'])); l['text'] = l['text'][:m.start()].strip()
    if not lines: return {'title': '', 'confidence': 0.0, 'alts': [], 'why': 'no text above the music'}
    # pieces of one printed line that Vision read apart (same height band) → one line, left to right
    lines.sort(key=lambda l: (l['y'], l['x']))
    rows = []
    for l in lines:
        if _junk(l['text'], repeats): rows.append({**l, 'cy': l['y'] + l['h'] / 2, 'solo': True}); continue
        r = next((r for r in rows if not r.get('solo') and abs(r['cy'] - (l['y'] + l['h'] / 2)) < 0.35 * min(r['h'], l['h'])
                  and 0.75 < l['h'] / r['h'] < 1.33 and l['x'] - (r['x'] + r['w']) < 0.08 and l['x'] > r['x']), None)
        if r:
            r['text'] += ' ' + l['text']; r['w'] = l['x'] + l['w'] - r['x']; r['conf'] = min(r['conf'], l['conf'])
        else:
            rows.append({**l, 'cy': l['y'] + l['h'] / 2})
    aspect = (page.get('w') or 1) / (page.get('h') or 1)
    for r in rows: r['junk'], r['size'] = _junk(r['text'], repeats), _size(r, aspect)
    cands = [r for r in rows if not r['junk']]
    if not cands: return {'title': '', 'confidence': 0.0, 'alts': [], 'why': 'only credits / numbers at the top'}
    # a line Vision read with low confidence (a chord diagram, a drawing) counts as half its size
    eff = lambda r: r['size'] * (1.0 if r['conf'] >= 0.6 else 0.5)
    big = sorted(cands, key=lambda r: -eff(r))
    # the biggest text wins; between lines about as big (within 8%) the one nearer the middle and the top
    # wins (the old Meowsic app weighed size, height on the page and centring the same way)
    lead = [r for r in big if eff(r) >= 0.92 * eff(big[0])]
    best = max(lead, key=lambda r: eff(r) / eff(big[0]) * 1.6 - r['y'] * 1.2 + (1 - abs(r['x'] + r['w'] / 2 - 0.5) * 2) * 0.3)
    # two big lines one under the other that are one title ("THE CIRCLE" / "OF LIFE", "I Want a Hippopotamus" /
    # "for Christmas"): about the same size, close, overlapping sideways; a line read with low confidence
    # (a chord diagram, bar lines) or in brackets (a subtitle) never joins
    overlap = lambda a, b: min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']) > 0.3 * min(a['w'], b['w'])
    group = [best]
    for r in sorted(rows, key=lambda r: abs(r['y'] - best['y'])):
        if r is best or r['junk'] not in (None, 'lyrics') or r['conf'] < 0.6 or r['text'].lstrip().startswith('('): continue
        if r['junk'] == 'lyrics' and not (r['text'].strip()[:1].isalpha() and len(r['text'].split()) <= 4 and not re.match(r'(?i)from\b', r['text'].strip())
                                          and any(ch.islower() for ch in best['text'])): continue  # "for Christmas" under a mixed-case title
        near = min(min(abs(r['y'] - (g['y'] + g['h'])), abs(g['y'] - (r['y'] + r['h']))) for g in group)
        lo = 0.85 if r['junk'] is None else 0.75
        if lo < r['size'] / best['size'] < 1.18 and near < 0.9 * best['h'] and abs(r['cy'] - best['cy']) < 3 * best['h'] \
                and len(group) < 3 and any(overlap(r, g) for g in group):
            group.append(r)
    group.sort(key=lambda r: r['y'])
    text = ' '.join(g['text'] for g in group)
    title = clean(text)
    others = [r for r in big if r not in group]
    # how sure: the title text should clearly be the biggest text up there (all text, junk too, except chord names)
    rivals = [r['size'] for r in rows if r not in group and r['junk'] not in ('chords', 'number', 'garbled', 'lyrics')]
    ratio = best['size'] / max(rivals) if rivals else 2.0
    conf = max(0.0, min(1.0, (ratio - 1.0) / 0.45))
    conf = 0.25 + 0.75 * conf
    if len(title) < 3 or sum(ch.isalpha() for ch in title) < 3: conf *= 0.4
    if len(title) > 70: conf *= 0.5
    if best['conf'] < 0.6: conf *= best['conf']  # Vision itself wasn't sure (art, other scripts)
    if best['size'] < 0.016: conf *= 0.3  # small print: words under the notes, not a title
    alts = []
    for r in others:
        a = clean(r['text'])
        if a and a != title and a not in alts and len(alts) < 3: alts.append(a)
    box = [min(g['x'] for g in group), min(g['y'] for g in group)]
    box += [max(g['x'] + g['w'] for g in group) - box[0], max(g['y'] + g['h'] for g in group) - box[1]]
    return {'title': title[:200], 'confidence': round(conf, 2), 'alts': alts, 'box': [round(v, 4) for v in box]}


# ---------- second look (the old Meowsic app's trick): read the title again, zoomed in ----------
def refine_lines(items: list[tuple[Path, list]], words=()) -> list[dict]:
    """[(path, box)] -> [{text, conf, cands} | {error}] from omr/title.py --refine."""
    py = _python()
    if not py or not SCRIPT.is_file() or not items: return [{'error': 'not set up'} for _ in items]
    job = json.dumps({'items': [{'path': str(p), 'box': b} for p, b in items], 'words': list(words)[:2000]}, ensure_ascii=False)
    r = subprocess.run([str(py), str(SCRIPT), '--refine'], input=job, capture_output=True, text=True, timeout=60 + 10 * len(items))
    if r.returncode != 0: return [{'error': (r.stderr or 'title.py failed').strip()[-300:]} for _ in items]
    out = json.loads(r.stdout)
    return [out.get(str(k)) or {'error': 'nothing read'} for k in range(len(items))]


def _vocab(page: dict, skip_box=None) -> set[str]:
    """Every word printed on the page (lyrics, credits…) except the title itself, lower case, accents kept."""
    out = set()
    for l in page.get('lines') or []:
        if skip_box and abs(l['y'] - skip_box[1]) < 0.5 * max(skip_box[3], 0.01) and l['h'] > 0.6 * skip_box[3]: continue
        out |= {w for w in re.findall(r"[\wÀ-ỹ']+", unicodedata.normalize('NFC', l['text']).lower()) if len(w) > 1}
    return out


def better(first: dict, again: dict, vocab: set[str] = frozenset()) -> dict:
    """Two readings of the title (the whole page, then zoomed in): where they disagree on a word, take the
    zoomed-in word only when the page itself prints it that way elsewhere (titles are mostly words of the
    lyrics: "Xe dạp oi" → "Xe đạp ơi"). A second reading is never trusted on its own."""
    if not first.get('title') or not again or again.get('error') or not again.get('text'): return first
    t = clean(again['text'])
    w1, w2 = first['title'].split(' '), t.split(' ')
    if len(w1) != len(w2): return first
    out, changed = [], False
    for x, y in zip(w1, w2):
        kx, ky = x.lower().strip('.,;:!?\'"()'), y.lower().strip('.,;:!?\'"()')
        if kx != ky and ky in vocab and kx not in vocab:
            out.append(y); changed = True
        else: out.append(x)
    if not changed: return first
    return {**first, 'title': ' '.join(out)[:200], 'first': first['title'], 'refined': True}


def refine_page(path: Path, page: dict, first: dict, words=()) -> dict:
    if not first.get('title') or not first.get('box'): return first
    return better(first, refine_lines([(path, first['box'])], words)[0], _vocab(page, first['box']))


# ---------- cache + endpoint ----------
def _cache_file(cf) -> Path:
    d = cf.data / 'work'
    d.mkdir(exist_ok=True)
    return d / 'titles.json'


def _load(cf) -> dict:
    try: return json.loads(_cache_file(cf).read_text())
    except Exception: return {}


def _save(cf, data):
    tmp = _cache_file(cf).with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(_cache_file(cf))


def page_lines(cf, path: Path) -> dict:
    """Vision's lines for one image, from the cache when the file hasn't changed."""
    key, mt = str(path.relative_to(cf.data)) if path.is_relative_to(cf.data) else str(path), path.stat().st_mtime
    with _lock: hit = _load(cf).get(key)
    if hit and hit.get('mtime') == mt: return hit
    res = read_lines([path]).get(str(path)) or {'error': 'nothing read'}
    if 'error' in res: raise RuntimeError(res['error'])
    res['mtime'] = mt
    with _lock:
        data = _load(cf); data[key] = res; _save(cf, data)
    return res


def library_words(c, skip_id=None) -> list[str]:
    """Titles already in the library: Vision's custom words for the second reading (the old app did this)."""
    return [r[0] for r in c.execute("SELECT DISTINCT title FROM item WHERE deleted_at IS NULL AND title<>'' AND id IS NOT ?", (skip_id,))][:2000]


def detect(cf, path: Path, repeats: set[str] | None = None, words=()) -> dict:
    """The title on one page photo: Vision lines (cached), the pick, then a second zoomed-in reading of the
    title (cached with the lines, by its box) that may fix single words. Raises when Vision can't run."""
    lines = page_lines(cf, path)
    first = pick(lines, repeats)
    if not first.get('title') or not first.get('box'): return first
    key = str(path.relative_to(cf.data)) if path.is_relative_to(cf.data) else str(path)
    want = json.dumps(first['box'])
    again = (lines.get('refine') or {}).get(want)
    if again is None:
        again = refine_lines([(path, first['box'])], words)[0]
        if 'error' not in again:
            with _lock:
                data = _load(cf)
                if key in data and data[key].get('mtime') == lines.get('mtime'):
                    data[key].setdefault('refine', {})[want] = again; _save(cf, data)
    return better(first, again, _vocab(lines, first['box']))


def _repeats(cf, c, item_id, page, d: Path) -> set[str]:
    """Lines printed on many pages of this sheet/book (a running header): from page OCR text and cached Vision lines."""
    counts, n = {}, 0
    rows = c.execute('SELECT page, file, ocr_text FROM sheet_page WHERE item_id=?', (item_id,)).fetchall()
    with _lock: cache = _load(cf)
    for p, file, ocr in rows:
        if p == page: continue
        seen = set()
        for t in (ocr or '').splitlines()[:8]: seen.add(fold(t))
        hit = cache.get(str((d / file).relative_to(cf.data))) if (d / file).is_relative_to(cf.data) else None
        for l in (hit or {}).get('lines', []):
            if l['y'] <= TOP: seen.add(fold(l['text']))
        if seen - {''}: n += 1
        for t in seen - {''}: counts[t] = counts.get(t, 0) + 1
    need = max(3, int(0.3 * n))
    return {t for t, k in counts.items() if k >= need}


@router.get('/items/{item_id}/pages/{page}/title')
def page_title(item_id: str, page: int, c=Depends(conn), cf=Depends(cfg)):
    """The song title printed on a page: {title, confidence 0..1, alts}; title '' when it couldn't be read."""
    it = must_item(c, item_id)
    if it['kind'] != 'sheet' or not it.get('folder'): raise HTTPException(400, 'Only sheets have pages')
    r = c.execute('SELECT file FROM sheet_page WHERE item_id=? AND page=?', (item_id, page)).fetchone()
    if not r: raise HTTPException(404, f'There is no page {page}')
    d = folder_path(cf, it['folder'])
    src = cleanup._original(cleanup._steps(d, page)) or d / r[0]  # a cropped page: read the whole original photo
    if not src.is_file(): raise HTTPException(404, 'No such file')
    if not available(): return {'title': '', 'confidence': 0.0, 'alts': [], 'error': 'Title reading is not set up on this Mac'}
    try: return detect(cf, src, _repeats(cf, c, item_id, page, d), library_words(c, item_id))
    except Exception as e: return {'title': '', 'confidence': 0.0, 'alts': [], 'error': str(e)[:200]}
