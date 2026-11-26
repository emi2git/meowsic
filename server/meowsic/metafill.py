"""One-time song info fill: every sheet, score and chord chart gets Artist, Album, Key and Version where it can be known.

  python -m meowsic.metafill [--data ~/Documents/Meowsic] [--dry-run] [--review FILE] [--no-ocr]

Where each value comes from (first that knows wins; only EMPTY fields are filled, except values listed as clearly
wrong in metafill_known.json 'fix' — and never a field set by hand in the app, see hand_set):
  sheets   first page read on this Mac with Apple Vision (omr/meta.py; nothing is uploaded): credits ("Music by …",
           "Words and Music by …", "Nhạc: …") → Artist; "from the movie / musical …" → Album; chord names (first chord of
           the first page = last chord of the last page) or "Key of / Tone / Giọng X" → Key; staves joined into systems
           (2+ = piano grand staff, 1 = lead line) or "Duet / Primo / Secondo" → Version (sheetversion.guess first:
           title / tags). A key written in the title ("Canon In D", "Minuet In G Major") → Key.
  scores   MusicXML key signature (<fifths>/<mode>) → Key; staves (1 = Lead, 2+ = Piano) → Version only when it is
           empty. Artist = the song's real artist: an Artist "Meowsic" (an earlier one-off put it there) counts as
           empty. The MusicXML credits follow: composer = that artist + "Made / Transcribed / Arranged by
           Meowsic" (db.credit_xml; the file before goes to items/<id>/.history/, undo puts it back).
  chords   "tone [X]" in the text, else the first chord → Key; Version → Lead (lyrics + chord names = a lead sheet).
  all      well-known songs (metafill_known.json, by title) → Artist / Album; specific tags (Les Miserables, Frozen …)
           → Album; "(Les Misérables)" / " - Titanic" in the title when that is a known album.
Books (many songs) are left alone. Anything not certain is left empty and written to the review list.
History: a db backup first (<data>/backups/pre-metafill-<ts>.db), every old → new value in
<data>/history/metafill-<ts>.json (never removed), one undoable Activities row ('fields' steps, undo.py).
The changes go through items.update_item, the same code path as an edit in the app."""
import argparse
import json
import re
import sqlite3
import subprocess
import time
import unicodedata
from pathlib import Path

from .db import NOT_ARTIST, Config, connect, credit_xml, folder_path, get_item, init_db, now_ms, quiet, score_byline
from .sheetversion import guess as guess_version, staves_of
from .undolog import fields_step, record_undo

KNOWN_FILE = Path(__file__).with_name('metafill_known.json')
OMR_DIR = Path(__file__).resolve().parents[2] / 'omr'
SCRIPT = OMR_DIR / 'meta.py'
FIELDS = ('artist', 'album', 'key', 'version')


# ---------- titles ----------

def fold(s: str) -> str:
    s = unicodedata.normalize('NFD', s or '').replace('đ', 'd').replace('Đ', 'D')
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn' or ch == '̆' and False)
    s = re.sub(r"['’`]", '', s.lower())
    return ' '.join(re.sub(r'[^\w]+', ' ', s).split())


def title_parts(title: str):
    """'Edelweiss - Sound Of Music' -> ['edelweiss sound of music', 'edelweiss'], tails ['Sound Of Music']."""
    t = (title or '').strip()
    bases, tails = [t], []
    m = re.match(r'^(.*?)\s*[\(\[]([^)\]]+)[\)\]]\s*(.*)$', t)
    if m:
        bases.append((m[1] + ' ' + m[3]).strip()); tails.append(m[2].strip())
        if not m[1].strip() and m[3].strip(): bases.append(m[3].strip())  # '(Everything I Do) I Do It For You'
    nob = re.sub(r'\s*[\(\[][^)\]]*[\)\]]', ' ', t).strip()  # every bracketed part out: 'Music Of The Night (C) (Version 2)'
    if nob and nob not in bases: bases.append(nob)
    for b in list(bases):
        if re.search(r'\s[-–—:]\s', b):
            head, tail = re.split(r'\s[-–—:]\s', b, maxsplit=1)
            bases += [head.strip(), tail.strip()]; tails += [tail.strip(), head.strip()]
    for b in list(bases):  # 'Từ đó - OST Mắt Biếc', 'Còn gì đẹp hơn (phim Mưa Đỏ)'
        m = re.search(r'\b(?:OST|phim)\s+(.+)$', b, re.I)
        if m: tails.append(m[1].strip())
    return [fold(b) for b in bases if fold(b)], [x for x in tails if x]


def load_known(path=KNOWN_FILE) -> dict:
    k = json.loads(Path(path).read_text())
    k['albums'] = {fold(a).removeprefix('the '): a for s in k['songs'].values() if s.get('album') for a in [s['album']]}
    k['albums'].update({fold(a).removeprefix('the '): a for a in k['albums_by_tag'].values()})
    return k


def known_song(known, it):
    """The metafill_known.json entry for this item (or None)."""
    bases, _ = title_parts(it['title'])
    for b in bases:
        s = known['songs'].get(b)
        if not s: continue
        if s.get('only_if_artist') and (it.get('artist') or '') not in s['only_if_artist']: continue
        if s.get('only_tags') and not set(s['only_tags']) & set(it.get('tags') or []): continue
        return s
    return None


def album_from_title(known, title):
    _, tails = title_parts(title)
    for t in tails:
        a = known['albums'].get(fold(t).removeprefix('the '))
        if a: return a
    return None


# ---------- keys ----------
CHORD = re.compile(r'^([A-G])([#♯b♭]?)(m(?!aj)|min|-)?(?:maj|M|sus|add|dim|aug|\+|°|ø|\d|[b#♭♯]\d+|\(|\))*(?:/[A-G][#♯b♭]?)?$')
ACC = {'♯': '#', '♭': 'b'}


def chord_root(tok):
    m = CHORD.match(tok.strip(',.;'))
    if not m: return None
    return m[1] + ACC.get(m[2], m[2]) + ('m' if m[3] else '')


def chord_lines(lines, top=0.0):
    """Chord names in reading order from Vision lines: a line counts when most of its words are chord names."""
    out = []
    for l in lines:
        if l['y'] < top: continue
        toks = l['text'].replace('|', ' ').split()
        if not toks: continue
        roots = [chord_root(t) for t in toks]
        ok = [r for r in roots if r]
        if ok and len(ok) >= 0.6 * len(toks) and sum(len(t) for t in toks) <= 60:
            out += ok
    return out


TEXT_KEY = re.compile(r'(?:\bkey(?:\s+of)?|\btone|\bgiọng|\btông)\s*[:\-]?\s*\[?\s*([A-G](?:#|b|♯|♭)?)\s*(m(?:inor)?\b|min\b|major\b|maj\b|trưởng|thứ)?', re.I)
TITLE_KEY = re.compile(r'(?:\bin\s+|\(\s*)([A-G])(?:\s*(?:-?\s*(flat|sharp)|([#♭♯b])))?(?:\s+(major|minor)|m\b)?\s*\)?(?=\s*(?:$|[,.;:)(\-–—]|op\b|k\.?\s*\d|bwv\b|no\b))', re.I)


def norm_key(root, minor):
    return root[0].upper() + root[1:] + ('m' if minor else '')


def key_in_title(title):
    """'Canon In D' -> 'D', 'Minuet In G Major' -> 'G', 'Sonata No. 17 In D Minor' -> 'Dm', 'Music Of The Night (C)' -> 'C'."""
    for m in TITLE_KEY.finditer(title or ''):
        if m[0].lower().startswith('in') and m[1] != m[1].upper(): continue
        if m[0].startswith('(') and not m[0].rstrip().endswith(')'): continue
        if not m[0].lower().startswith('in') and not m[0].startswith('('): continue
        if m[1].islower(): continue
        acc = {'flat': 'b', 'sharp': '#'}.get((m[2] or '').lower(), ACC.get(m[3] or '', m[3] or ''))
        minor = (m[4] or '').lower() == 'minor' or m[0].rstrip(') ').endswith('m') and not (m[4] or '')
        return norm_key(m[1] + acc, minor)
    return None


def key_in_text(text):
    m = TEXT_KEY.search(text or '')
    if not m: return None
    q = (m[2] or '').lower()
    return norm_key(m[1][0].upper() + ACC.get(m[1][1:], m[1][1:]), q.startswith('m') and q not in ('major', 'maj') or q == 'thứ')


def xml_key(text) -> str:
    """MusicXML first key signature -> 'G major' / 'A minor' (the same words the scores already use)."""
    m = re.search(r'<key\b[^>]*>(.*?)</key>', text or '', re.S)
    if not m: return ''
    f = re.search(r'<fifths>\s*(-?\d+)\s*</fifths>', m[1])
    if not f: return ''
    mode = (re.search(r'<mode>\s*(\w+)\s*</mode>', m[1]) or [None, 'major'])[1].lower()
    n = int(f[1])
    majors = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
    minors = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#']
    if not -7 <= n <= 7: return ''
    return f'{minors[n + 7]} minor' if mode == 'minor' else f'{majors[n + 7]} major'


# ---------- credits / album / version from a page ----------
CREDIT = re.compile(r'^\s*\(?\s*(?:(?:words?|lyrics?)\s*(?:and|&)\s*music|music\s*(?:and|&)\s*(?:words?|lyrics?)|music|composed|written|nhạc\s*(?:và|&)\s*lời|nhạc|sáng\s*tác|st)\s*(?:by|:|-)\s*(.+?)\)?\s*$', re.I)
NOT_NAME = re.compile(r'\b(arr|arranged|transcribed|copyright|rights|reserved|used by|permission|publishing|music company|inc\b|ltd|corp|hal leonard|official|mv\b|video|lyrics?\b|www\.|\.com)|©|\d{4}', re.I)
FROM = re.compile(r'^\s*\(?\s*(?:from|tiru|trích từ|nhạc phim|ost)\s+(?:the\s+)?(?:(?:walt\s+)?disney(?:\s*[•·/-]?\s*pixar)?(?:\'s)?\s+|pixar\s+|dreamworks\s+|broadway\s+|20th century fox\s+)?(?:(?:animated\s+|motion\s+picture|feature\s+|broadway\s+|stage\s+|hit\s+)*(?:film|movie|musical|motion picture|show|picture|series|tv series|opera|ballet)\s+)?["“”\']?(.+?)["“”\']?\s*\)?\s*$', re.I)
DUET_TEXT = re.compile(r'\b(?:duet|primo|secondo|4\s*hands|four\s*hands|1\s*piano,?\s*4\s*hands)\b', re.I)
PIANO_TEXT = re.compile(r'\b(?:easy\s+piano|piano\s+solo|big[\s-]note|for\s+piano|piano\s*/\s*vocal|piano\s+vocal|pvg)\b', re.I)
LEAD_TEXT = re.compile(r'\b(?:lead\s+sheet|fake\s*book)\b', re.I)


def nice_name(s: str) -> str:
    s = ' '.join(s.replace(' and ', ' & ').replace(' AND ', ' & ').split()).strip(' ,;.')
    if s.isupper(): s = ' '.join(w.capitalize() if not re.fullmatch(r'[A-Z]\.?', w) else w for w in s.title().split())
    return s


def credits(lines, top=0.3):
    """'Words and Music by Adele Adkins' + next line 'and Greg Kurstin' -> 'Adele Adkins & Greg Kurstin'."""
    top_lines = [l for l in lines if l['y'] <= top]
    for i, l in enumerate(top_lines):
        m = CREDIT.match(l['text'])
        if not m: continue
        name = m[1]
        nxt = top_lines[i + 1] if i + 1 < len(top_lines) else None
        if nxt and re.match(r'^\s*(?:and|&)\s+\S', nxt['text'], re.I) and abs(nxt['y'] - l['y']) < 0.04:
            name += ' ' + nxt['text']
        name = re.split(r'\s+(?:arr(?:anged|\.)?|lyrics|words|transcribed)\b', name, flags=re.I)[0]
        if NOT_NAME.search(name) or not re.search(r'[A-Za-zÀ-ỹ]{2}', name) or len(name) > 70: continue
        return nice_name(name)
    return None


def album_line(lines, top=0.25):
    for l in lines:
        if l['y'] > top: break
        m = FROM.match(l['text'])
        if not m: continue
        a = m[1].strip(' .,:;-')
        if not a or len(a.split()) > 7 or NOT_NAME.search(a) or not re.search(r'[A-Za-zÀ-ỹ]{2}', a): continue
        if a.lower().split()[0] in ('the', 'a') and len(a.split()) == 1: continue
        return nice_name(a) if a.isupper() else a
    return None


def version_from_page(page):
    """'duet' | 'piano' | 'lead' | None, and how sure: from the words on the page, then from how its staves join."""
    text = ' '.join(l['text'] for l in page.get('lines') or [])
    if DUET_TEXT.search(text): return 'duet', 'text'
    sys_ = [n for n in page.get('systems') or [] if n]
    if len(sys_) >= 2:
        multi = sum(1 for n in sys_ if n >= 2)
        if multi >= 0.75 * len(sys_): return 'piano', 'staves'
        if multi == 0 and len(sys_) >= 3: return 'lead', 'staves'
    if PIANO_TEXT.search(text): return 'piano', 'text'
    if LEAD_TEXT.search(text): return 'lead', 'text'
    return None, None


# ---------- reading pages (Apple Vision, on this Mac) ----------

def _python():
    from .titles import _python as p
    return p()


def _run(py, part):
    try: r = subprocess.run([str(py), str(SCRIPT), *map(str, part)], capture_output=True, text=True, timeout=60 + 30 * len(part))
    except subprocess.TimeoutExpired: return None
    if r.returncode != 0: return None
    try: return json.loads(r.stdout)
    except ValueError: return None


def read_pages(paths, cache_file: Path, log=print, batch=12) -> dict:
    """{str(path): {lines, staves, systems} | {error}}; cached by path + modified time in cache_file."""
    cache = {}
    if cache_file.is_file():
        try: cache = json.loads(cache_file.read_text())
        except ValueError: cache = {}
    stamp = lambda p: f'{p}|{p.stat().st_mtime_ns}' if p.is_file() else None  # noqa: E731
    todo = [p for p in paths if stamp(p) and stamp(p) not in cache]
    py = _python()
    if todo and (not py or not SCRIPT.is_file()): raise RuntimeError('Page reading is not set up on this Mac (omr/.venv missing)')
    for i in range(0, len(todo), batch):
        part = todo[i:i + batch]
        out = _run(py, part)
        if out is None:  # one page took the reader down: read them one by one, a page that fails is marked
            out = {}
            for p in part: out.update(_run(py, [p]) or {str(p): {'error': 'could not be read'}})
        for p in part: cache[stamp(p)] = out.get(str(p)) or {'error': 'not read'}
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(cache, ensure_ascii=False))
        log(f'  read {min(i + batch, len(todo))}/{len(todo)} pages')
    return {str(p): cache.get(stamp(p)) for p in paths if stamp(p)}


# ---------- what to change ----------

def hand_set(c) -> set:
    """(item id, field) pairs someone set by hand in the app (Activities 'edit' / 'version' rows not undone): never overwritten."""
    out = set()
    for (u,) in c.execute("SELECT undo FROM activity WHERE type IN ('edit','version') AND undone_at IS NULL AND undo IS NOT NULL"):
        try: steps = json.loads(u).get('steps') or []
        except (ValueError, AttributeError): continue
        for s in steps:
            if s.get('op') == 'fields':
                for k in s.get('new') or {}: out.add((s.get('id'), k))
    return out


def page_paths(cf, it):
    files = it.get('pageFiles') or []
    if not files or not it.get('folder'): return None, None
    try: d = folder_path(cf, it['folder'])
    except ValueError: return None, None
    return d / files[0], (d / files[-1] if len(files) > 1 else None)


def propose(it, known, page1=None, last=None, xml=None, hand=frozenset()):
    """{field: (value, source)} to set on one item, and [(field, suggestion, why)] for the review list."""
    new, review = {}, []
    s = known_song(known, it)
    cur = {k: (it.get(k) or '') for k in FIELDS}
    kind = it['kind']
    if kind == 'score' and cur['artist'] in NOT_ARTIST and (it['id'], 'artist') not in hand: cur['artist'] = ''  # never a real artist

    def put(k, v, src):
        if not v or k in new: return
        if cur[k]:
            fix = (s or {}).get('fix', {}).get(k) or []
            if v == cur[k]: return
            if cur[k] in fix and v != cur[k] and (it['id'], k) not in hand: new[k] = (v, src + ' (was wrong)')
            return
        if v == (it.get(k) or ''): return
        new[k] = (v, src + (' (was Meowsic)' if k == 'artist' and (it.get(k) or '') in NOT_ARTIST else ''))

    lines = (page1 or {}).get('lines') or []
    # Artist
    if True:
        if s and s.get('artist'): put('artist', s['artist'], 'known song')
        if kind == 'sheet' and lines and 'artist' not in new and not cur['artist']:
            a = credits(lines)
            if a: put('artist', a, 'page 1 credit')
        if 'Trịnh Công Sơn' in (it.get('tags') or []): put('artist', 'Trịnh Công Sơn', 'tag')
    # Album
    if s and s.get('album'): put('album', s['album'], 'known song')
    a = album_from_title(known, it['title'])
    if a: put('album', a, 'title')
    for t in it.get('tags') or []:
        if t in known['albums_by_tag']: put('album', known['albums_by_tag'][t], f'tag {t}')
    if kind == 'sheet' and lines and 'album' not in new and not cur['album']:
        a = album_line(lines)
        if a: review.append(('album', a, 'page 1 says "from …" (not a known album: check)'))
    # Key
    if not cur['key']:
        k = key_in_title(it['title'])
        if k: put('key', k, 'title')
        if kind == 'sheet' and lines:
            k = key_in_text(' '.join(l['text'] for l in lines))
            if k: put('key', k, 'page 1 text')
            first = chord_lines(lines, 0.04)
            end = chord_lines((last or page1).get('lines') or [], 0.0) if (last or page1) else []
            if len(first) >= 3 and end:  # a page with a few chord names, not a stray letter
                if first[0] == end[-1]: put('key', first[0], 'first = last chord')
                elif 'key' not in new: review.append(('key', first[0], f'first chord {first[0]}, last chord {end[-1]}'))
        if kind == 'score' and xml: put('key', xml_key(xml), 'MusicXML key signature')
        if kind == 'chords':
            k = key_in_text(it.get('text') or '')
            if k: put('key', k, 'chord chart text')
            else:
                ch = re.findall(r'\[([^\]]+)\]', it.get('text') or '')
                r = next((chord_root(x) for x in ch if chord_root(x)), None)
                if r: put('key', r, 'first chord')
    # Version
    if not cur['version']:
        if kind == 'sheet':
            v = guess_version(it['title'], it.get('tags') or [])
            if v: put('version', v, 'title / tags')
            elif page1:
                v, how = version_from_page(page1)
                if v: put('version', v, f'page 1 {how}')
                elif page1.get('systems'): review.append(('version', '', f'staves per system on page 1: {page1["systems"]}'))
        if kind == 'chords': put('version', 'lead', 'chord chart = lead')
        if kind == 'score' and xml is not None:
            n = staves_of(xml)
            if n: put('version', 'lead' if n == 1 else 'original', 'MusicXML staves')
    for k in FIELDS:
        if not cur[k] and k not in new and not any(r[0] == k for r in review): review.append((k, '', 'not known'))
    return new, review


def plan(cf, c=None, *, ocr=True, known=None, log=print, cache=None) -> dict:
    own = c is None
    if own: c = connect(cf)
    known = known or load_known()
    hand = hand_set(c)
    ids = [r[0] for r in c.execute("""SELECT item.id FROM item LEFT JOIN sheet ON sheet.item_id = item.id
                                      WHERE item.deleted_at IS NULL AND COALESCE(sheet.book, 0) = 0 ORDER BY item.title""")]
    items = [get_item(c, i) for i in ids]
    pages = {}
    if ocr:
        want = []
        for it in items:
            if it['kind'] != 'sheet': continue
            p1, pl = page_paths(cf, it)
            want += [p for p in (p1, pl) if p]
        pages = read_pages(want, cache or cf.work_dir / 'metafill-ocr.json', log=log) if want else {}
    changes, review = [], []
    for it in items:
        p1 = pl = xml = None
        if it['kind'] == 'sheet':
            a, b = page_paths(cf, it)
            p1, pl = pages.get(str(a)) if a else None, pages.get(str(b)) if b else None
            if p1 and p1.get('error'): p1 = None
            if pl and pl.get('error'): pl = None
        if it['kind'] == 'score' and it.get('musicxml') and it.get('folder'):
            try: xml = (folder_path(cf, it['folder']) / it['musicxml']).read_text(errors='replace')
            except (OSError, ValueError): xml = None
        new, rev = propose(it, known, p1, pl, xml, hand)
        files = score_files(cf, it, new['artist'][0] if 'artist' in new else it.get('artist') or '') if it['kind'] == 'score' else []
        if new or files:
            changes.append({'id': it['id'], 'kind': it['kind'], 'title': it['title'],
                            'old': {k: it.get(k) or '' for k in new}, 'new': {k: v for k, (v, _) in new.items()},
                            'why': {k: w for k, (_, w) in new.items()}, 'files': files})
        if rev:
            review.append({'id': it['id'], 'kind': it['kind'], 'title': it['title'],
                           'now': {k: (new[k][0] if k in new else it.get(k) or '') for k in FIELDS},
                           'check': [{'field': f, 'suggestion': v, 'why': w} for f, v, w in rev]})
    if own: c.close()
    return {'changes': changes, 'review': review, 'items': len(items)}


def score_files(cf, it, artist):
    """The score's MusicXML files whose credits change: [{col, file, text}] (composer = artist, + what Meowsic did)."""
    out = []
    try: d = folder_path(cf, it['folder']) if it.get('folder') else None
    except ValueError: d = None
    for col, k in (('musicxml', 'musicxml'), ('musicxml_original', 'musicxmlOriginal')):
        name = it.get(k)
        if not d or not name or not (d / name).is_file(): continue
        try: x = (d / name).read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError): continue
        y = credit_xml(x, artist, score_byline(it.get('source') or '', it.get('ai')))
        if y != x: out.append({'col': col, 'file': name, 'text': y})
    return out


def summary(changes) -> str:
    n = {k: sum(1 for x in changes if k in x['new']) for k in FIELDS}
    f = sum(1 for x in changes if x.get('files'))
    return ', '.join([f'{v} {k}' for k, v in n.items() if v] + ([f'{f} score credit(s)'] if f else [])) or 'nothing'


def apply(cf, changes, *, backup=True, log=print) -> dict:
    """Write the planned changes through items.update_item (one Activities row, undoable)."""
    from .items import update_item
    if not changes: return {'count': 0, 'log': None, 'backup': None, 'activity': None}
    stamp, t = time.strftime('%Y%m%d-%H%M%S'), now_ms()
    c = connect(cf)
    bk = None
    if backup:
        cf.backups_dir.mkdir(exist_ok=True)
        bk = cf.backups_dir / f'pre-metafill-{stamp}.db'
        with sqlite3.connect(bk) as b: c.backup(b)
    h = cf.data / 'history'
    h.mkdir(exist_ok=True)
    hist = h / f'metafill-{stamp}.json'
    from .creditfix import sha
    steps, done = [], []
    for ch in changes:
        it = get_item(c, ch['id'])
        if not it: continue
        patch = {k: v for k, v in ch['new'].items() if (it.get(k) or '') == ch['old'][k]}  # changed since the plan: keep it
        files = []
        for f in ch.get('files') or []:  # scores: the credits in the MusicXML; the file before is kept in .history
            p = folder_path(cf, it['folder']) / f['file']
            keep = p.parent / '.history' / f'metafill-{stamp}-{f["file"]}'
            keep.parent.mkdir(exist_ok=True)
            keep.write_bytes(p.read_bytes())
            p.write_text(f['text'], encoding='utf-8')
            files.append({'col': f['col'], 'file': f['file'], 'history': f'.history/{keep.name}', 'sha': sha(p)})
        if not patch and not files: continue
        applied = dict(patch)
        if it['kind'] == 'score':  # artist + files: a 'credit' step (creditfix.undo_step puts both back); the rest: 'fields'
            a = {'artist': patch.pop('artist')} if 'artist' in patch else {}
            if a or files: steps.append({'op': 'credit', 'id': it['id'], 'title': it['title'], 'old': {k: it.get(k) or '' for k in a}, 'new': a, 'files': files})
            if a:
                with quiet(): update_item(ch['id'], dict(a), c, cf)
                it = get_item(c, ch['id'])
        st = fields_step(it, patch) if patch else None
        if patch:
            with quiet(): update_item(ch['id'], dict(patch), c, cf)
        if st: steps.append(st)
        done.append({**{k: v for k, v in ch.items() if k != 'files'}, 'old': {k: ch['old'][k] for k in applied}, 'new': applied, 'files': files, 'at': t, 'via': 'metafill'})
    hist.write_text(json.dumps({'what': 'Song info filled (Artist, Album, Key, Version)', 'at': t, 'backup': str(bk) if bk else None,
                                'changes': done}, ensure_ascii=False, indent=1))
    aid = record_undo(c, 'metafill', steps, 'Song info filled', f'{len(done)} item(s): {summary(done)} (log: history/{hist.name})') if steps else None
    c.commit()
    c.close()
    log(f'{len(done)} item(s) changed: {summary(done)}; history {hist}; backup {bk}')
    return {'count': len(done), 'log': str(hist), 'backup': str(bk) if bk else None, 'activity': aid}


def run(data=None, *, dry_run=False, review_file=None, ocr=True, log=print, cache=None) -> dict:
    cf = Config.from_env(data)
    if not dry_run: init_db(cf)  # adds item.album / chord_chart.version on an older db
    p = plan(cf, ocr=ocr, log=log, cache=cache)
    if review_file:
        Path(review_file).write_text(json.dumps({'items': p['items'], 'to_change': len(p['changes']), 'review': p['review']}, ensure_ascii=False, indent=1))
    log(f"{p['items']} items; {len(p['changes'])} to change ({summary(p['changes'])}); {len(p['review'])} to review")
    if dry_run: return {**p, 'applied': None}
    return {**p, 'applied': apply(cf, p['changes'], log=log)}


def main(argv=None):
    ap = argparse.ArgumentParser(description='Fill Artist / Album / Key / Version once (see the module doc).')
    ap.add_argument('--data', default=None)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--review', default=None, help='write the review list (JSON) here')
    ap.add_argument('--plan', default=None, help='write the planned changes (JSON) here')
    ap.add_argument('--cache', default=None, help='page reading cache (default <data>/work/metafill-ocr.json)')
    ap.add_argument('--no-ocr', action='store_true')
    a = ap.parse_args(argv)
    r = run(a.data, dry_run=a.dry_run, review_file=a.review, ocr=not a.no_ocr, cache=Path(a.cache) if a.cache else None)
    if a.plan: Path(a.plan).write_text(json.dumps(r['changes'], ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
