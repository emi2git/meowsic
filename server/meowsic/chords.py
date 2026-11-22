"""Chord search + fetch, ported from emi-songbook/lib/sources.js.

Ultimate Guitar (English) and hopamchuan.com (Vietnamese). Songs come back as ChordPro text.
Only a plain desktop User-Agent is sent; nothing personal.
"""
import html as htmllib
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix='/api/chords')

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
ALLOWED_HOSTS = ['hopamchuan.com', 'tabs.ultimate-guitar.com']


def get(url):
    r = httpx.get(url, headers={'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'}, timeout=20, follow_redirects=True)
    if r.status_code != 200:
        raise RuntimeError(f'{urlparse(url).netloc} responded {r.status_code}')
    return r.text


def decode(s): return htmllib.unescape(str(s)).replace('\xa0', ' ')
def strip(s): return decode(re.sub(r'<[^>]*>', '', str(s)))
def clean(s): return re.sub(r'\s+', ' ', strip(s)).strip()


def has_word(s):
    """Real lyric text, as opposed to bar lines, repeat marks (x2) and N.C."""
    s = re.sub(r'\bx\s?\d+\b|\b\d+\s?x\b|N\.?C\.?', '', s, flags=re.I)
    return re.search(r'[^\W\d_]', s) is not None


def tidy(lines):
    """Collapse runs of blank lines, trim blank edges."""
    out = []
    for l in lines:
        if l['t'] == 'blank' and (not out or out[-1]['t'] == 'blank'): continue
        out.append(l)
    while out and out[-1]['t'] == 'blank': out.pop()
    return out


def to_chordpro(lines):
    out = []
    for l in lines:
        if l['t'] == 'blank': out.append('')
        elif l['t'] == 'section': out.append('{c: %s}' % l['text'])
        else: out.append(''.join((f'[{p["chord"]}]' if p['chord'] else '') + p['text'] for p in l['parts']).rstrip())
    return '\n'.join(out)


# ---------- hopamchuan.com (Vietnamese) ----------

VI_DIGITS = ['khong', 'mot', 'hai', 'ba', 'bon', 'nam', 'sau', 'bay', 'tam', 'chin', 'muoi']
def spell_digits(q): return re.sub(r'\b(10|\d)\b', lambda m: VI_DIGITS[int(m[1])], q)


def parse_hac_search(html):
    hits = list(re.finditer(r'<a href="(https://hopamchuan\.com/song/(\d+)/[^"]*)" class="song-title">([\s\S]*?)</a>', html))
    out = []
    for i, m in enumerate(hits):
        chunk = html[m.start(): hits[i + 1].start() if i + 1 < len(hits) else m.start() + 4000]
        artists = [clean(a) for a in re.findall(r'class="author-item">([\s\S]*?)</a>', chunk)]
        prev = re.search(r'song-preview-lyric">([\s\S]*?)</div>', chunk)
        preview = re.sub(r'\s+', ' ', re.sub(r'\[[^\]]*\]', '', clean(prev[1])))[:110] if prev else ''
        out.append({'source': 'hopamchuan', 'id': f'hac-{m[2]}', 'url': re.sub(r'\?.*$', '', m[1]), 'title': clean(m[3]),
                    'artist': ', '.join(dict.fromkeys(artists)), 'preview': preview, 'info': ''})
    return out


def search_hac(q):
    res = parse_hac_search(get('https://hopamchuan.com/search?q=' + quote(q)))
    if not res and re.search(r'\d', q):  # the site spells numbers out: "3 ngon nen" -> "ba ngon nen"
        res = parse_hac_search(get('https://hopamchuan.com/search?q=' + quote(spell_digits(q))))
    return res


def parse_hac_song(html, url):
    sid = (re.search(r'/song/(\d+)', url) or [None, ''])[1]
    m = re.search(r'<h1 id="song-title">\s*<span>([\s\S]*?)</span>', html)
    title = clean(m[1]) if m else ''
    m = re.search(r'id="song-info"[\s\S]{0,300}?data-key="([^"]*)"', html)
    key = m[1] if m else ''
    m = re.search(r'<div id="song-author">([\s\S]*?)</div>', html)
    author = m[1] if m else ''
    m = re.search(r'class="perform-singer-list">([\s\S]*?)</span>', html)
    perform = m[1] if m else ''
    names = lambda b: [clean(a) for a in re.findall(r'class="author-item">([\s\S]*?)</a>', b)]
    artist = ', '.join(dict.fromkeys(names(author) + names(perform)))

    start = html.find('id="song-lyric"')
    if start < 0 or not title: raise RuntimeError('Could not read this hopamchuan page')
    end = html.find('id="song-leftover-space"', start)
    body = html[start: end if end > 0 else None]
    lines = []
    for m in re.finditer(r'<div class="chord_lyric_line([^"]*)">([\s\S]*?)</div>', body):
        inner = m[2]
        if 'text_only' in m[1]:
            text = strip(inner).rstrip()
            lines.append({'t': 'line', 'parts': [{'chord': None, 'text': text}]} if text.strip() else {'t': 'blank'})
            continue
        parts = []
        for tk in re.finditer(r'<span class="hopamchuan_chord">([\s\S]*?)</span>|<span class="hopamchuan_lyric">([\s\S]*?)</span>', inner):
            if tk[1] is not None: parts.append({'chord': strip(tk[1]).strip(), 'text': ''})
            elif parts: parts[-1]['text'] += strip(tk[2])
            else: parts.append({'chord': None, 'text': strip(tk[2])})
        if not parts or all(not p['chord'] and not p['text'].strip() for p in parts):
            lines.append({'t': 'blank'})
            continue
        line = {'t': 'line', 'parts': parts}
        if any(p['chord'] for p in parts) and not any(has_word(p['text']) for p in parts): line['co'] = True
        lines.append(line)
    if not lines: raise RuntimeError('No lyrics found on this hopamchuan page')
    return {'id': f'hac-{sid}', 'source': 'hopamchuan', 'url': url, 'title': title, 'artist': artist, 'key': key, 'capo': 0, 'lines': tidy(lines)}


# ---------- ultimate-guitar.com (English) ----------

def ug_store(html):
    m = re.search(r'class="js-store" data-content="([^"]*)"', html)
    if not m: raise RuntimeError('Ultimate Guitar page layout not recognised')
    return json.loads(decode(m[1]))['store']['page']['data']


def parse_ug_search(html):
    rs = [r for r in ug_store(html).get('results') or []
          if r.get('type') in ('Chords', 'Ukulele Chords') and re.match(r'^https://tabs\.ultimate-guitar\.com/', r.get('tab_url') or '')]
    rs.sort(key=lambda r: -(r.get('votes') or 0) * (r.get('rating') or 0))
    return [{'source': 'ultimate-guitar', 'id': f'ug-{r["id"]}', 'url': r['tab_url'], 'title': decode(r.get('song_name') or ''),
             'artist': decode(r.get('artist_name') or ''), 'preview': '',
             'info': f'{"ukulele · " if r["type"] == "Ukulele Chords" else ""}★ {(r.get("rating") or 0):.1f} ({r.get("votes") or 0})'}
            for r in rs[:15]]


def search_ug(q):
    return parse_ug_search(get('https://www.ultimate-guitar.com/search.php?search_type=title&value=' + quote(q)))


SECTION = re.compile(r'^\s*\[([^\]]+)\]\s*$')


def parse_ug_content(content):
    """Turn UG "chords on the line above the lyric" text into inline chord parts."""
    src = re.sub(r'\[/?tab\]', '', decode(content).replace('\r', '')).split('\n')
    lines = []

    def scan(line):
        chords, plain, last = [], '', 0
        for m in re.finditer(r'\[ch\]([\s\S]*?)\[/ch\]', line):
            plain += line[last:m.start()]
            chords.append({'col': len(plain), 'name': m[1].strip()})
            plain += m[1]
            last = m.end()
        return chords, plain + line[last:]

    i = 0
    while i < len(src):
        raw = src[i]
        if not raw.strip():
            lines.append({'t': 'blank'})
        elif '[ch]' not in raw:
            sec = SECTION.match(raw)
            if sec: lines.append({'t': 'section', 'text': sec[1].strip()})
            elif re.match(r'^\s*\S+\s+[xX0-9()]{4,}\s*$', raw): pass  # guitar fingering legend
            else: lines.append({'t': 'line', 'parts': [{'chord': None, 'text': raw.rstrip()}]})
        else:
            chords, plain = scan(raw)
            residue = list(plain)  # the line with chord names blanked out
            for c in chords:
                for k in range(len(c['name'])):
                    if c['col'] + k < len(residue): residue[c['col'] + k] = ' '
            residue = ''.join(residue)
            nxt = src[i + 1] if i + 1 < len(src) else None
            next_is_lyric = nxt is not None and nxt.strip() and '[ch]' not in nxt and not SECTION.match(nxt)
            parts = []
            if not has_word(residue) and next_is_lyric:
                # chord line sitting above a lyric line -> merge by column
                lyric = nxt.ljust(chords[-1]['col'] + 1)
                if chords[0]['col'] > 0: parts.append({'chord': None, 'text': lyric[:chords[0]['col']]})
                for k, c in enumerate(chords):
                    to = chords[k + 1]['col'] if k + 1 < len(chords) else len(lyric)
                    parts.append({'chord': c['name'], 'text': lyric[c['col']:to]})
                parts[-1]['text'] = parts[-1]['text'].rstrip()
                lines.append({'t': 'line', 'parts': [p for p in parts if p['chord'] or p['text']]})
                i += 2
                continue
            # chords with separators / inline text on the same line
            if chords[0]['col'] > 0: parts.append({'chord': None, 'text': plain[:chords[0]['col']]})
            for k, c in enumerate(chords):
                to = chords[k + 1]['col'] if k + 1 < len(chords) else len(plain)
                parts.append({'chord': c['name'], 'text': plain[c['col'] + len(c['name']):to]})
            parts[-1]['text'] = parts[-1]['text'].rstrip()
            line = {'t': 'line', 'parts': parts}
            if not has_word(residue): line['co'] = True
            lines.append(line)
        i += 1
    return tidy(lines)


def parse_ug_song(html, url):
    data = ug_store(html)
    tab, view = data.get('tab') or {}, data.get('tab_view') or {}
    content = (view.get('wiki_tab') or {}).get('content')
    if not content: raise RuntimeError('This Ultimate Guitar tab has no readable chord sheet')
    meta = view.get('meta') or {}
    try: capo = int(meta.get('capo') or 0)
    except (TypeError, ValueError): capo = 0
    return {'id': f'ug-{tab.get("id")}', 'source': 'ultimate-guitar', 'url': url, 'title': decode(tab.get('song_name') or ''),
            'artist': decode(tab.get('artist_name') or ''), 'key': meta.get('tonality') or tab.get('tonality_name') or '',
            'capo': capo, 'lines': parse_ug_content(content)}


# ---------- public API ----------

def words(s):
    s = unicodedata.normalize('NFD', s.lower())
    s = re.sub(r'[̀-ͯ]', '', s).replace('đ', 'd')
    return [w for w in re.split(r'[^a-z0-9]+', s) if w]


def search(q, lang='auto'):
    srcs = {'en': [('Ultimate Guitar', search_ug)], 'vi': [('Hợp Âm Chuẩn', search_hac)]}
    jobs = srcs.get(lang) or srcs['en'] + srcs['vi']
    with ThreadPoolExecutor(2) as ex:
        futs = [(name, ex.submit(fn, q)) for name, fn in jobs]
    found, errors = [], []
    for name, f in futs:
        try: found += f.result()
        except Exception as e: errors.append(f'{name}: {e}')
    # rank by how much of the query is in the title; ties: Vietnamese-titled first, then site order
    variants = [words(q), words(spell_digits(q))]
    def rel(r):
        t = set(words(r['title']))
        return max(len([w for w in v if w in t]) / (len(v) or 1) for v in variants)
    vi = lambda r: 1 if r['source'] == 'hopamchuan' and re.search(r'[À-ỹ]', r['title']) else 0
    ranked = sorted(enumerate(found), key=lambda x: (-rel(x[1]), -vi(x[1]), x[0]))
    return {'results': [r for _, r in ranked], 'errors': errors}


def fetch_song(url):
    host = urlparse(url).netloc
    if urlparse(url).scheme != 'https' or host not in ALLOWED_HOSTS: raise ValueError('Unsupported site: ' + host)
    html = get(url)
    song = parse_hac_song(html, url) if host == 'hopamchuan.com' else parse_ug_song(html, url)
    song['text'] = to_chordpro(song.pop('lines'))
    return song


@router.get('/search')
def api_search(q: str, lang: str = 'auto'):
    if not q.strip(): raise HTTPException(400, 'q is required')
    return search(q.strip(), lang)


@router.get('/fetch')
def api_fetch(url: str):
    try:
        return fetch_song(url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except (RuntimeError, httpx.HTTPError) as e:
        raise HTTPException(502, str(e))
