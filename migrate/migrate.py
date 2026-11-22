#!/usr/bin/env python3
"""One-off migration: Meowsic 1, Emi Songbook, Emi Music Note and the "2023 Music sheet" folder -> Meowsic 2.0.

Sources are opened read-only and never changed. Output: <out>/meowsic.db + <out>/items/<folder>/.
Every item gets a `legacy_ref`, so re-running only adds what is new (and fills in Meowsic 1 sheet pages
that were not available locally the first time).

  .venv/bin/python migrate.py --dry-run     # counts only, writes nothing
  .venv/bin/python migrate.py               # real run
  .venv/bin/python migrate.py --verify      # re-count from the db, check every referenced file exists
"""
import argparse, hashlib, json, os, plistlib, re, shutil, sqlite3, subprocess, sys, tempfile, time, unicodedata, zlib
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

HOME = Path.home()
SERVER = Path(__file__).resolve().parent.parent / 'server'
SCHEMA = SERVER / 'schema.sql'
sys.path.insert(0, str(SERVER))
from meowsic import db as server_db   # same init_db / folder_name as the API server (stdlib only)
M1_STORE = HOME / 'Documents/Meowsic/Meowsic.store'
M1_BACKUPS = sorted((HOME / 'Library/Mobile Documents/com~apple~CloudDocs').glob('meowsic-backup*.json'))
SONGBOOK = HOME / 'Documents/Emi Songbook/library.json'
MUSICNOTE = HOME / 'Documents/Emi Music Note'
FOLDER = HOME / 'Library/Mobile Documents/com~apple~CloudDocs/Desktop/2023 Music sheet'
APPLE_EPOCH = 978307200
SYSTEM_TAGS = {'Sheet', 'Chord', 'Score', 'Deleted'}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif'}
PREVIEW_MIN = 1000          # a local Photos preview is used only if its long side is at least this many px
NOW = int(time.time() * 1000)


# ---------- helpers ----------

def ms(apple_ts):
    return int((float(apple_ts) + APPLE_EPOCH) * 1000) if apple_ts is not None else NOW


def item_id(kind, ref):
    n, out = int(hashlib.sha1(ref.encode()).hexdigest(), 16), ''
    for _ in range(7):
        n, r = divmod(n, 36); out += '0123456789abcdefghijklmnopqrstuvwxyz'[r]
    return {'sheet': 's', 'chords': 'c', 'score': 'm'}[kind] + '-' + out


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def title_case(s):
    """Same rule as Meowsic 1: first letter of each word upper, rest lower."""
    out = []
    for w in s.split():
        i = next((k for k, ch in enumerate(w) if ch.isalpha()), None)
        out.append(w if i is None else w[:i] + w[i].upper() + w[i + 1:].lower())
    return ' '.join(out)


def norm(s):
    """Loose title key: no accents, case, punctuation or plural s."""
    s = unicodedata.normalize('NFKD', s or '').replace('đ', 'd').replace('Đ', 'D')
    s = ''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    words = re.sub(r"[^a-z0-9]+", ' ', s.replace("'", '')).split()
    return ' '.join(w[:-1] if len(w) > 3 and w.endswith('s') else w for w in words)


KEY_RE = r'[A-G][#b]?m?'


def strip_key(t):
    if re.search(rf'\bin\s+\(?{KEY_RE}\)?$', t, re.I): return t      # 'Canon in C' keeps its key
    return re.sub(rf'\s*\(?\b{KEY_RE}\)?$', '', t).strip() or t


def norm_url(u):
    if not u: return ''
    p = urlsplit(u.strip())
    return (p.netloc.lower().removeprefix('www.') + p.path.rstrip('/')).lower()


def folder_name(title):
    s = unicodedata.normalize('NFC', title or 'Untitled')
    s = re.sub(r'[/:\\]', '-', s)
    s = re.sub(r'[\x00-\x1f\x7f]', '', s)
    s = s.strip().lstrip('.').strip() or 'Untitled'
    return s[:100].rstrip(' .') or 'Untitled'


CHORD = r'[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|°|ø|\+)?\d*(?:(?:add|sus|maj|b|#)\d+)*(?:\([^)]*\))?(?:-\d+)?(?:/[A-G][#b]?)?'
CHORD_RE = re.compile(rf'^{CHORD}$')
BRACKET_CHORD = re.compile(rf'\[({CHORD})\]')


def is_chord_line(line):
    toks = line.replace('|', ' ').split()
    return bool(toks) and all(CHORD_RE.match(t) or t in {'-', 'x2', 'x3', 'x4', 'N.C.', '/'} for t in toks) \
        and any(CHORD_RE.match(t) for t in toks)


def to_chordpro(text):
    """Chord-over-lyrics / [Section] / inline [C] text -> ChordPro."""
    lines = (text or '').replace('\r\n', '\n').split('\n')
    out, i = [], 0
    while i < len(lines):
        ln = lines[i].rstrip()
        m = re.match(r'^\[?([A-Za-z][A-Za-z0-9 ]*?)\]\s*(.*)$', ln.strip())
        if m and not CHORD_RE.match(m.group(1)) and len(m.group(1)) < 30:
            out.append(f'{{c: {m.group(1).strip()}}}')
            ln = m.group(2)
            if not ln:
                i += 1; continue
        if is_chord_line(ln) and not BRACKET_CHORD.search(ln):
            nxt = lines[i + 1].rstrip() if i + 1 < len(lines) else ''
            chords = [(mm.start(), mm.group()) for mm in re.finditer(r'\S+', ln) if CHORD_RE.match(mm.group())]
            if nxt.strip() and not is_chord_line(nxt) and not re.match(r'^\[.*\]$', nxt.strip()):
                lyr = nxt.ljust(max(p for p, _ in chords) + 1)
                for p, c in reversed(chords):
                    lyr = lyr[:p] + f'[{c}]' + lyr[p:]
                out.append(lyr.rstrip()); i += 2; continue
            out.append(' '.join(f'[{c}]' for _, c in chords)); i += 1; continue
        out.append(ln); i += 1
    return '\n'.join(out).strip() + '\n'


def first_chord(text):
    m = BRACKET_CHORD.search(text or '')
    return m.group(1) if m else ''


def musicxml_key_bpm(xml):
    key, bpm = '', None
    m = re.search(r'<fifths>(-?\d+)</fifths>(?:\s*<mode>(\w+)</mode>)?', xml)
    if m:
        f, mode = int(m.group(1)), (m.group(2) or 'major')
        names = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
        if -7 <= f <= 7:
            key = (names[f + 7] if mode == 'major' else names[min(f + 10, 14)]) + ' ' + mode
    m = re.search(r'<per-minute>([\d.]+)</per-minute>', xml) or re.search(r'tempo="([\d.]+)"', xml)
    if m: bpm = float(m.group(1))
    return key, bpm


def split_title(t):
    """'One Day More - Les Miserables' -> ('One Day More', 'Les Miserables')."""
    t = re.sub(r'[\U0001F000-\U0001FFFF☀-➿]', '', t).strip()
    t = re.sub(r'^(Đệm Mẫu Piano|Piano)\s*[–-]\s*', '', t)
    t = re.sub(r'\s*[-(]*\s*(Easy )?Piano (Tutorial|Cover)\)?\s*$', '', t, flags=re.I).strip()
    parts = re.split(r'\s+[-–]\s+', t, maxsplit=1)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else (t, '')


# ---------- output db ----------

class Out:
    def __init__(self, root, dry):
        self.root, self.dry = Path(root), dry
        self.items_dir = self.root / 'items'
        self.db_path = self.root / 'meowsic.db'
        if dry and not self.db_path.exists():
            self.c = sqlite3.connect(':memory:')
            self.c.executescript(SCHEMA.read_text())
        elif dry:
            self.c = sqlite3.connect(f'file:{self.db_path}?mode=ro', uri=True)
        else:
            server_db.init_db(server_db.Config(self.root))   # creates/upgrades the db exactly like the server
            self.c = sqlite3.connect(self.db_path)
        self.c.execute('PRAGMA foreign_keys = ON')
        cols = [r[1] for r in self.c.execute('PRAGMA table_info(item)')]
        for col in ('folder TEXT', 'origin_at INTEGER'):      # additive columns agreed after schema.sql
            if col.split()[0] not in cols:
                if dry and not getattr(self, '_copied', False): self.c = self._mem_copy(); self._copied = True
                self.c.execute(f'ALTER TABLE item ADD COLUMN {col}')
                if not dry: self.c.commit()
        self.legacy = {r[0]: r[1] for r in self.c.execute('SELECT legacy_ref, id FROM item WHERE legacy_ref IS NOT NULL')}
        self.shas = {r[0]: r[1] for r in self.c.execute('SELECT sha256, item_id FROM sheet_page WHERE sha256 IS NOT NULL')}
        self.titles = [(r[0], r[1]) for r in self.c.execute("SELECT title, id FROM item WHERE kind='sheet'")]
        self.m1_sheet_titles = []   # every Meowsic 1 sheet title, also those not importable yet (so re-runs add no duplicates)

    def _mem_copy(self):
        m = sqlite3.connect(':memory:'); self.c.backup(m); return m

    def new_folder(self, iid, title):
        """Folder = '<id> <title>'; files inside are named after the folder."""
        return server_db.folder_name(iid, title)

    def ensure_tag(self, name):
        self.c.execute('INSERT OR IGNORE INTO tag(name) VALUES (?)', (name,))

    def add_item(self, it, tags=()):
        """it: dict with id, kind, title, artist, created_at, deleted_at, transpose, legacy_ref, folder."""
        self.c.execute('INSERT INTO item(id, kind, title, artist, created_at, updated_at, deleted_at, transpose, legacy_ref, folder, origin_at) '
                       'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                       (it['id'], it['kind'], it['title'], it.get('artist') or '', it['created_at'], it['created_at'],
                        it.get('deleted_at'), it.get('transpose'), it['legacy_ref'], it.get('folder'),
                        it.get('origin_at') or it['created_at']))
        for t in tags:
            self.ensure_tag(t)
            self.c.execute('INSERT OR IGNORE INTO item_tag(item_id, tag) VALUES (?,?)', (it['id'], t))
        self.legacy[it['legacy_ref']] = it['id']

    def activity(self, key, title, detail):
        if self.dry: return
        if 'created' not in detail and 'refilled' not in detail and \
                self.c.execute('SELECT 1 FROM activity WHERE id=?', (f'act-import-{key}',)).fetchone():
            return   # a re-run that added nothing keeps the original import entry
        self.c.execute('INSERT OR REPLACE INTO activity(id, type, title, detail, at) VALUES (?,?,?,?,?)',
                       (f'act-import-{key}', 'import', title, detail, NOW))


class Stats:
    def __init__(self):
        self.c = defaultdict(Counter)
        self.notes = defaultdict(list)

    def add(self, src, what, n=1): self.c[src][what] += n

    def note(self, src, msg): self.notes[src].append(msg)


def render_pdf(pdf, outdir, jobs=os.cpu_count() or 4):
    """pdftoppm (same settings as the server: 150 dpi, JPEG q85), page ranges rendered in parallel."""
    info = subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True).stdout
    m = re.search(r'^Pages:\s+(\d+)', info, re.M)
    n = int(m.group(1)) if m else 0
    base = ['pdftoppm', '-r', '150', '-jpeg', '-jpegopt', 'quality=85']
    if n < 8:
        subprocess.run(base + [str(pdf), f'{outdir}/p'], check=True, capture_output=True, timeout=3600); return
    step = -(-n // jobs)
    procs = [subprocess.Popen(base + ['-f', str(a), '-l', str(min(a + step - 1, n)), str(pdf), f'{outdir}/p'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) for a in range(1, n + 1, step)]
    for p in procs:
        if p.wait(timeout=3600): raise RuntimeError(f'pdftoppm failed: {p.stderr.read()[:200]!r}')


def write_sheet(out, st, src, it, pages, tags, pdf=None):
    """pages: list of (copy_fn(dest_path)->None, ext, sha, captured_at). Writes files then rows; one commit per item."""
    if out.dry:
        out.add_item(it, tags); return True
    d = out.items_dir / it['folder']
    tmp = out.items_dir / f'.tmp-{it["id"]}'
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    F = it['folder']
    rows = []
    try:
        n = 1
        if pdf:
            shutil.copyfile(pdf, tmp / f'{F}.pdf')
            sha = sha256(pdf)
            with tempfile.TemporaryDirectory() as t:
                render_pdf(pdf, t)
                for f in sorted(Path(t).glob('p-*.jpg'), key=lambda x: int(x.stem.split('-')[-1])):
                    rel = f'{F} {n}.jpg'; shutil.move(f, tmp / rel)
                    rows.append((n, rel, sha, it.get('origin_at') or it['created_at'])); n += 1
            if not rows: raise RuntimeError('pdftoppm produced no pages')
        for copy, ext, sha, cap in pages:
            rel = f'{F} {n}{ext}'; copy(tmp / rel)
            rows.append((n, rel, sha, cap)); n += 1
        if d.exists(): raise RuntimeError(f'folder exists: {d}')
        tmp.rename(d)
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        st.add(src, 'failed'); st.note(src, f'FAILED {it["title"]}: {e}')
        return False
    try:
        out.add_item(it, tags)
        out.c.execute('INSERT INTO sheet(item_id, source, pages) VALUES (?,?,?)', (it['id'], 'pdf' if pdf else 'photos', len(rows)))
        out.c.executemany('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at) VALUES (?,?,?,?,?)',
                          [(it['id'], *r) for r in rows])
        out.c.commit()
    except Exception as e:
        out.c.rollback(); shutil.rmtree(d, ignore_errors=True); out.legacy.pop(it['legacy_ref'], None)
        st.add(src, 'failed'); st.note(src, f'FAILED {it["title"]}: {e}')
        return False
    for r in rows:
        if r[2]: out.shas.setdefault(r[2], it['id'])
    return True


# ---------- source 1: Meowsic 1 ----------

def keyed_array(blob):
    if not blob: return []
    p = plistlib.loads(blob); objs = p['$objects']
    root = objs[p['$top']['root'].data if hasattr(p['$top']['root'], 'data') else p['$top']['root']]
    return [objs[u.data] for u in root['NS.objects']]


class Photos:
    def __init__(self):
        import osxphotos  # in migrate/.venv
        self.db = osxphotos.PhotosDB()  # osxphotos reads Photos.sqlite read-only (works on a copy when locked)
        self.cache = {}

    def get(self, uuids):
        missing = [u for u in uuids if u not in self.cache]
        if missing:
            for p in self.db.photos(uuid=missing, intrash=False) + self.db.photos(uuid=missing, intrash=True):
                self.cache[p.uuid] = p
            for u in missing: self.cache.setdefault(u, None)
        return [self.cache[u] for u in uuids]


def best_source(p):
    """-> (path, quality, reason). quality: original | preview | None."""
    from PIL import Image
    if p is None: return None, None, 'not in the Photos library (deleted?)'
    if p.path_edited and os.path.exists(p.path_edited): return p.path_edited, 'original', ''
    if not p.ismissing and p.path and os.path.exists(p.path): return p.path, 'original', ''
    best, size = None, 0
    for f in p.path_derivatives or []:
        try:
            w, h = Image.open(f).size
        except Exception:
            continue
        if max(w, h) > size: best, size = f, max(w, h)
    if best and size >= PREVIEW_MIN: return best, 'preview', f'iCloud only; used local preview {size}px'
    return None, None, f'iCloud only, not downloaded (largest local preview {size}px)'


def copier(src):
    ext = Path(src).suffix.lower()   # keep the real format (jpg/png/heic/gif/webp)
    return (lambda dst: shutil.copyfile(src, dst)), ('.jpg' if ext == '.jpeg' else ext)


def import_meowsic1(out, st, manifest):
    S = 'meowsic1'
    tmp = Path(tempfile.mkdtemp(prefix='m1store-'))
    for f in M1_STORE.parent.glob(M1_STORE.name + '*'):
        shutil.copy2(f, tmp / f.name)            # read a copy (+wal/shm) so the original is never touched
    c = sqlite3.connect(f'file:{tmp / M1_STORE.name}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    tags_by_pk = {r[0]: r[1] for r in c.execute('SELECT Z_PK, ZNAME FROM ZTAG WHERE ZISSYSTEM=0') if r[1] not in SYSTEM_TAGS}
    st.add(S, 'tags', len(tags_by_pk))
    for t in tags_by_pk.values(): out.ensure_tag(t)
    links = defaultdict(list)
    for s, t in c.execute('SELECT Z_6SONGS, Z_11TAGLINKS FROM Z_6TAGLINKS'):
        if t in tags_by_pk: links[s].append(tags_by_pk[t])
    songs = c.execute('SELECT * FROM ZSONG ORDER BY ZFIRSTPAGEDATE').fetchall()
    chords = {r['ZID']: r for r in c.execute('SELECT * FROM ZCHORDSONG')}
    scores = {r['ZID']: r for r in c.execute('SELECT * FROM ZSCORESONG')}
    photos = None
    ref_of = {}
    analysed = {r[0]: ms(r[1]) for r in c.execute('SELECT ZASSETLOCALIDENTIFIER, ZCREATIONDATE FROM ZPHOTOANALYSIS') if r[1] is not None}
    for s in songs:
        kind = {'sheet': 'sheet', 'chord': 'chords', 'score': 'score'}[s['ZKINDRAW']]
        ref = f'meowsic1:{s["ZKINDRAW"]}:{s["ZID"]}'
        ref_of[s['ZID']] = ref
        tags = sorted(set(links[s['Z_PK']]))
        deleted = NOW if s['ZISHIDDEN'] else None
        it = {'id': item_id(kind, ref), 'kind': kind, 'title': s['ZTITLE'] or 'Untitled', 'artist': s['ZARTIST'] or '',
              'created_at': ms(s['ZFIRSTPAGEDATE']), 'deleted_at': deleted, 'legacy_ref': ref}
        if kind == 'sheet':
            out.m1_sheet_titles.append((it['title'], it['id']))
            assets = keyed_array(s['ZPAGEASSETIDS'])
            if photos is None: photos = Photos()
            ps = photos.get([a.split('/')[0] for a in assets])
            pages, plan = [], []
            for a, p in zip(assets, ps):
                path, q, why = best_source(p)
                plan.append({'asset': a, 'quality': q, 'reason': why})
                if path:
                    fn, ext = copier(path)
                    cap = int(p.date.timestamp() * 1000) if p and p.date else analysed.get(a, it['created_at'])
                    pages.append((fn, ext, sha256(path), cap))
            if pages: it['origin_at'] = min(pg[3] for pg in pages)
            exists = ref in out.legacy
            if exists:
                if refill_sheet(out, st, S, out.legacy[ref], pages, plan, manifest): continue
                st.add(S, 'sheets existing'); continue
            for k, pl in enumerate(plan, 1):
                if pl['quality'] == 'preview': st.add(S, 'pages from local preview')
                if not pl['quality']:
                    st.add(S, 'pages not exported'); st.note(S, f'page not exported: "{it["title"]}" p{k} ({pl["asset"]}): {pl["reason"]}')
            st.add(S, 'pages exported', len(pages))
            if not pages:
                st.add(S, 'sheets failed'); st.note(S, f'FAILED sheet "{it["title"]}": no page available locally'); continue
            it['folder'] = out.new_folder(it['id'], it['title'])
            if write_sheet(out, st, S, it, pages, tags):
                st.add(S, 'sheets created' + (' (in Trash)' if deleted else ''))
                manifest[it['id']] = {'plan': plan, 'shas': [p[2] for p in pages]}
        elif kind == 'chords':
            if ref in out.legacy: st.add(S, 'chords existing'); continue
            ch = chords.get(s['ZID'])
            raw = ch['ZCHORDTEXT'] if ch else s['ZCHORDTEXT']
            text = to_chordpro(raw)
            url = (ch['ZSOURCEURL'] if ch else '') or ''
            host = urlsplit(url).netloc.lower().removeprefix('www.').removeprefix('tabs.')
            source = host.split('.')[0] if host else 'pasted'
            if ch: it['created_at'] = it['origin_at'] = ms(ch['ZCREATEDAT'])
            out.add_item(it, tags)
            out.c.execute('INSERT INTO chord_chart(item_id, source, url, key, capo, text) VALUES (?,?,?,?,?,?)',
                          (it['id'], source, url, first_chord(text), 0, text))
            if not out.dry: out.c.commit()
            st.add(S, 'chords created')
        else:
            if ref in out.legacy: st.add(S, 'scores existing'); continue
            sc = scores[s['ZID']]
            xml = sc['ZXML'][1:] if sc['ZXML'][:1] == b'\x01' else sc['ZXML']
            try: xml = zlib.decompress(xml, -15)
            except zlib.error: xml = zlib.decompress(xml) if xml[:1] == b'x' else xml
            midi = sc['ZMIDI']; midi = midi[1:] if midi and midi[:1] == b'\x01' else midi
            title, artist = split_title(sc['ZTITLE'] or it['title'])
            it.update(title=title, artist=artist or it['artist'], created_at=ms(sc['ZCREATEDAT']), origin_at=ms(sc['ZCREATEDAT']))
            key, bpm = musicxml_key_bpm(xml.decode('utf-8', 'replace'))
            files = {'.musicxml': xml}
            if midi: files['.mid'] = midi
            write_score(out, st, S, it, files, key, bpm, 'Meowsic 1', None, ['Original'] + tags)
    # play sessions
    n = 0
    for r in c.execute('SELECT * FROM ZSONGOPEN'):
        iid = out.legacy.get(ref_of.get(r['ZSONGID'], ''))
        if not iid: st.note(S, f'play session skipped: song {r["ZSONGID"]} not imported'); continue
        o, cl = ms(r['ZOPENEDAT']), ms(r['ZCLOSEDAT'])
        if out.c.execute('SELECT 1 FROM play_session WHERE item_id=? AND opened_at=?', (iid, o)).fetchone(): continue
        out.c.execute('INSERT INTO play_session(item_id, opened_at, closed_at) VALUES (?,?,?)', (iid, o, cl)); n += 1
    st.add(S, 'play sessions created', n)
    # the JSON backups are older snapshots of the same store: report anything they know that the store lacks
    keys = {s['ZID'] for s in songs} | {a for s in songs for a in keyed_array(s['ZPAGEASSETIDS'])}
    for b in M1_BACKUPS:
        d = json.loads(b.read_text())
        extra = [x['songKey'] for x in d.get('tagSets', []) + d.get('renames', []) if x['songKey'] not in keys]
        extra += [x['id'] for x in (d.get('chordSongs') or []) + (d.get('scoreSongs') or []) if x['id'] not in keys]
        st.note(S, f'backup {b.name}: older snapshot, {len(extra)} song keys not in the store')
    if not out.dry: out.c.commit()
    c.close(); shutil.rmtree(tmp, ignore_errors=True)
    return st


def refill_sheet(out, st, S, iid, pages, plan, manifest):
    """Re-run: rebuild a Meowsic 1 sheet's pages when more/better pages are local now, if the user has not changed it."""
    m = manifest.get(iid)
    if not m:   # manifest lost (interrupted run): adopt the current pages if they are exactly what we would write now
        cur = [r[0] for r in out.c.execute('SELECT sha256 FROM sheet_page WHERE item_id=? ORDER BY page', (iid,))]
        if cur == [p[2] for p in pages]: manifest[iid] = {'plan': plan, 'shas': cur}
        return False
    better = sum(1 for o, n in zip(m['plan'], plan) if (o['quality'], n['quality']) in
                 ((None, 'preview'), (None, 'original'), ('preview', 'original')))
    for k, pl in enumerate(plan, 1):
        if not pl['quality']: st.add(S, 'pages not exported'); st.note(S, f'page still not exported: {iid} p{k} ({pl["asset"]}): {pl["reason"]}')
    if not better: return False
    cur = [r[0] for r in out.c.execute('SELECT sha256 FROM sheet_page WHERE item_id=? ORDER BY page', (iid,))]
    ann = out.c.execute('SELECT 1 FROM annotation WHERE item_id=?', (iid,)).fetchone()
    if cur != m['shas'] or ann:
        st.note(S, f'{iid}: {better} better pages available but the sheet was changed in Meowsic 2.0; left as is'); return False
    st.add(S, 'sheets refilled')
    if out.dry: return True
    folder = out.c.execute('SELECT folder FROM item WHERE id=?', (iid,)).fetchone()[0]
    d = out.items_dir / folder
    tmp = out.items_dir / f'.tmp-{iid}'; shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(parents=True)
    rows = []
    for n, (fn, ext, sha, cap) in enumerate(pages, 1):
        rel = f'{folder} {n}{ext}'; fn(tmp / rel); rows.append((iid, n, rel, sha, cap))
    for (old,) in out.c.execute('SELECT file FROM sheet_page WHERE item_id=?', (iid,)).fetchall():
        (d / old).unlink(missing_ok=True)
    for f in tmp.iterdir(): f.rename(d / f.name)
    tmp.rmdir()
    out.c.execute('DELETE FROM sheet_page WHERE item_id=?', (iid,))
    out.c.executemany('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at) VALUES (?,?,?,?,?)', rows)
    out.c.execute('UPDATE sheet SET pages=? WHERE item_id=?', (len(rows), iid))
    out.c.execute('UPDATE item SET origin_at=? WHERE id=?', (min(r[4] for r in rows), iid))
    out.c.commit()
    manifest[iid] = {'plan': plan, 'shas': [r[3] for r in rows]}
    return True


def write_score(out, st, S, it, files, key, bpm, source, group, tags):
    """files: {name: bytes | Path}."""
    F = it['folder'] = out.new_folder(it['id'], it['title'])
    files = {f'{F}{suffix}': v for suffix, v in files.items()}
    names = set(files)
    if not out.dry:
        d = out.items_dir / it['folder']
        try:
            d.mkdir(parents=True)
            for n, v in files.items():
                (shutil.copyfile(v, d / n) if isinstance(v, Path) else (d / n).write_bytes(v))
        except Exception as e:
            shutil.rmtree(d, ignore_errors=True); st.add(S, 'scores failed'); st.note(S, f'FAILED score {it["title"]}: {e}'); return
    out.add_item(it, tags)
    out.c.execute('INSERT INTO score(item_id, version, musicxml, midi, pdf, key, bpm, source, group_id) VALUES (?,?,?,?,?,?,?,?,?)',
                  (it['id'], 'original', f'{F}.musicxml', f'{F}.mid' if f'{F}.mid' in names else None,
                   f'{F}.pdf' if f'{F}.pdf' in names else None, key, bpm, source, group))
    if not out.dry: out.c.commit()
    st.add(S, 'scores created')


# ---------- source 2: Emi Songbook ----------

def lines_to_chordpro(lines):
    out = []
    for l in lines:
        if l['t'] == 'section': out.append(f'{{c: {l["text"]}}}')
        elif l['t'] == 'blank': out.append('')
        else: out.append(''.join((f'[{p["chord"]}]' if p.get('chord') else '') + (p.get('text') or '') for p in l['parts']).rstrip())
    return '\n'.join(out).strip() + '\n'


def import_songbook(out, st, m1_chords):
    S = 'songbook'
    d = json.loads(SONGBOOK.read_text())
    tags_of = defaultdict(list)
    for col in d.get('collections', []):
        for sid in col['songIds']: tags_of[sid].append(col['name'])
    urls = {norm_url(u) for u, _, _ in m1_chords if u}
    ta = {(norm(t), norm(a)) for _, t, a in m1_chords}
    for sid, s in d['songs'].items():
        ref = f'songbook:{sid}'
        if ref in out.legacy: st.add(S, 'existing'); continue
        if norm_url(s.get('url')) in urls or (norm(s['title']), norm(s.get('artist'))) in ta:
            st.add(S, 'skipped (duplicate of a Meowsic 1 chord chart)'); st.note(S, f'duplicate skipped: {s["title"]}'); continue
        try:
            text = lines_to_chordpro(s['lines'])
            created = int(datetime.fromisoformat(s['addedAt'].replace('Z', '+00:00')).timestamp() * 1000)
            it = {'id': item_id('chords', ref), 'kind': 'chords', 'title': s['title'], 'artist': s.get('artist') or '',
                  'created_at': created, 'origin_at': created, 'transpose': s.get('transpose') or None, 'legacy_ref': ref}
            out.add_item(it, tags_of[sid])
            out.c.execute('INSERT INTO chord_chart(item_id, source, url, key, capo, text) VALUES (?,?,?,?,?,?)',
                          (it['id'], s.get('source') or 'pasted', s.get('url') or '', s.get('key') or '', int(s.get('capo') or 0), text))
            if not out.dry: out.c.commit()
            st.add(S, 'created')
        except Exception as e:
            out.c.rollback(); st.add(S, 'failed'); st.note(S, f'FAILED {s.get("title")}: {e}')


# ---------- source 3: Emi Music Note ----------

def import_musicnote(out, st):
    S = 'musicnote'
    jobs = []
    for f in (MUSICNOTE / '_jobs').glob('*.json'):
        try: jobs.append(json.loads(f.read_text()))
        except Exception: pass
    for d in sorted(p for p in MUSICNOTE.iterdir() if p.is_dir() and not p.name.startswith(('_', '.'))):
        ref = f'musicnote:{d.name}'
        if ref in out.legacy: st.add(S, 'existing'); continue
        xml = d / f'{d.name}.musicxml'
        if not xml.exists():
            xs = sorted(d.glob('*.musicxml'))
            if not xs: st.add(S, 'failed'); st.note(S, f'FAILED {d.name}: no MusicXML'); continue
            xml = xs[0]
        midi = next((p for p in [d / f'{d.name}-score.mid', *sorted(d.glob('*-score.mid')), d / f'{d.name}.mid', *sorted(d.glob('*.mid'))] if p.exists()), None)
        pdf = next((p for p in [d / f'{d.name}.pdf', *sorted(d.glob('*.pdf'))] if p.exists()), None)
        meta = json.loads((d / 'meta.json').read_text()) if (d / 'meta.json').exists() else {}
        sj = json.loads((d / 'score.json').read_text()) if (d / 'score.json').exists() else {}
        text = xml.read_text('utf-8', 'replace')
        m = re.search(r'<work-title>([^<]*)</work-title>', text)
        title, artist = split_title(m.group(1) if m else meta.get('title') or d.name)
        k2, b2 = musicxml_key_bpm(text)
        src = meta.get('source', '')
        yt = re.search(r'(?:v=|youtu\.be/)([\w-]{6,})', src)
        source = f'YouTube · youtu.be/{yt.group(1)}' if yt else (f'Audio file · {Path(src).name}' if src else '')
        it = {'id': item_id('score', ref), 'kind': 'score', 'title': title, 'artist': artist,
              'origin_at': int(xml.stat().st_mtime * 1000), 'legacy_ref': ref,
              'created_at': int(min([j['created'] * 1000 for j in jobs if j.get('slug') == d.name] or [xml.stat().st_mtime * 1000])),
              'transpose': sj.get('transpose') or None}
        files = {'.musicxml': xml}
        if midi: files['.mid'] = midi
        if pdf: files['.pdf'] = pdf
        if (d / 'versions').is_dir():
            others = [v.name for v in (d / 'versions').iterdir() if v.is_dir() and v.name != 'original']
            if others: st.note(S, f'{title}: other versions not imported: {", ".join(others)}')
        write_score(out, st, S, it, files, sj.get('key') or k2, sj.get('bpm') or b2, source, 'g-' + d.name[:40], ['Original'])


# ---------- source 4: "2023 Music sheet" folder ----------

FOLDER_TAGS = {   # path part -> tags ([] = no tag)
    'Frozen': ['Frozen', 'Disney'], 'Les Miserable': ['Les Miserables', 'Musical'], 'Phantom of the opera': ['Phantom of the opera', 'Musical'],
    'Ghibli': ['Ghibli'], 'VN': ['Vietnamese'], 'Vietnamese songs': ['Vietnamese'], 'Trinh Cong Son': ['Trịnh Công Sơn', 'Vietnamese'],
    'Piano books': ['Piano book'], 'Theory': ['Theory'], 'Christmas': ['Christmas'], 'Chistmas Easy': ['Christmas'],
    'Disney song book': ['Disney'], 'Disney pieces': ['Disney'], 'Richard Clayderman (Sheet Music)': ['Richard Clayderman'],
    'Level 1': ['Level 1'], 'Level 2': ['Level 2'], 'Level 3': ['Level 3'], 'Duet': ['Duet'],
    'Collection of my favorite': ['Favorite'], 'Laputa - The Castle in the Sky': ['Ghibli'], 'Ponyo': ['Ghibli'],
}
SONG_FOLDERS = {   # folders that hold one song: their name is the title
    'The heart asks pleasure first (Michael Nyman)', 'Canon in D (Pachebel - Lee Galloway version)',
    'Comptine D Un Autre Ete (Yann Tiersen)', 'Ha Noi mua vang nhung con mua', 'Mot minh', 'Romance De Amor',
    'Laputa Ly version', 'Original Laputa', 'laputa piano easy',
}


def page_key(stem):
    """'A million dreams 3' -> ('A million dreams', 3); 'Sheet nhac Pho mua dong 2' -> ('Pho mua dong', 2)."""
    s = re.sub(r'^Sheet nhac\s+', '', stem, flags=re.I)
    s = re.sub(r'\s*\(\d\)$', '', s).strip()                         # "(1)" copy markers
    s = re.sub(r'\s+\d{1,2}\.\d\d\.\d\d\s*[AP]M$', '', s)            # screenshot times -> one group
    m = re.match(rf'^(.*?)(?:[\s_-]+|(?<=[A-G])|(?<=[A-G][#bm]))0*(\d{{1,3}})\s*([-?]?)$', s)
    if m and m.group(1).strip() and not re.search(r'\d$', m.group(1)):
        # 'Music of the night C 1-' / '1?' are other scans of the same pages: their own sheet
        v = {'-': ' (version 2)', '?': ' (version 3)'}.get(m.group(3), '')
        return m.group(1).strip(' -_.') + v, int(m.group(2))
    return s.strip(' -_.?'), 0


def clean_title(base):
    ver = re.search(r' \(version \d\)$', base)
    if ver: return clean_title(base[:ver.start()]) + ver.group().title()
    t = base.replace('_', ' ').strip()
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(rf'\s*[-_]\s*({KEY_RE})$', r' \1', t)                 # 'X-HAPPY NEW YEAR-C' -> '... C'
    m = re.match(rf'^(.*\S)\s+({KEY_RE})\.?$', t)                     # trailing key -> "(C)"
    if m and len(m.group(1)) > 2 and not re.search(r'\bin$', m.group(1), re.I): t = f'{m.group(1)} ({m.group(2)})'
    return title_case(t)


def import_folder(out, st):
    S = 'folder'
    files = sorted(p for p in FOLDER.rglob('*') if p.is_file() and not p.name.startswith('.'))
    groups = defaultdict(list)
    for f in files:
        ext = f.suffix.lower()
        if ext not in IMAGE_EXT and ext != '.pdf':
            st.add(S, 'files ignored (not image/pdf)'); continue
        rel = f.relative_to(FOLDER)
        parts = rel.parts[:-1]
        if parts and parts[-1] in SONG_FOLDERS:
            key = (parts, parts[-1], ext == '.pdf' and f.name)
            groups[key].append((0, f.name, f))
        elif ext == '.pdf':
            groups[(parts, f.stem, f.name)].append((0, f.name, f))
        else:
            base, n = page_key(f.stem)
            groups[(parts, base.lower(), None)].append((n, f.name, f, base))
    m1_titles = {norm(strip_key(t)): t for t, _ in out.titles + out.m1_sheet_titles if not t.startswith('Untitled')}
    seen_titles = {}
    st.add(S, 'files', sum(len(v) for v in groups.values()))
    for (parts, base, pdfname), members in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        members.sort(key=lambda m: (m[0], m[1].lower()))
        first = members[0][2]
        ref = f'folder2023:{"/".join(parts + (first.name,))}'
        if ref in out.legacy: st.add(S, 'existing'); continue
        raw = parts[-1] if parts and parts[-1] in SONG_FOLDERS else (members[0][3] if len(members[0]) > 3 else Path(base).stem if pdfname else base)
        if pdfname and not (parts and parts[-1] in SONG_FOLDERS): raw = first.stem
        raw = re.sub(r'^Sheet nhac\s+', '', raw, flags=re.I)
        title = clean_title(raw)
        tags = sorted({t for p in parts for t in FOLDER_TAGS.get(p, [])})
        # exact duplicates by sha256
        keep, mine = [], set()
        for m in members:        # images and PDFs alike: skip a file whose bytes are already in the library
            h = sha256(m[2])
            if h in out.shas or h in mine:
                st.add(S, 'files skipped (exact duplicate)')
                st.note(S, f'duplicate file skipped: {"/".join(parts + (m[1],))} = {out.shas.get(h, "same group")}')
                continue
            mine.add(h); keep.append((m, h))
        if not keep:
            st.add(S, 'sheets skipped (all pages duplicate)'); continue
        tk = norm(strip_key(title))
        if tk in m1_titles:
            st.add(S, 'sheets skipped (title already imported)'); st.note(S, f'title match skipped: "{"/".join(parts + (first.name,))}" ({len(keep)} files) ~ "{m1_titles[tk]}"')
            continue
        if norm(title) in seen_titles:
            st.add(S, 'sheets skipped (title already imported)'); st.note(S, f'title match skipped: "{"/".join(parts + (first.name,))}" ~ "{seen_titles[norm(title)]}"')
            continue
        seen_titles[norm(title)] = title
        for _, h in keep: out.shas[h] = f'{title} (folder)'
        it = {'id': item_id('sheet', ref), 'kind': 'sheet', 'title': title, 'created_at': NOW,
              'origin_at': int(min(m[2].stat().st_mtime for m, _ in keep) * 1000),
              'legacy_ref': ref}
        it['folder'] = out.new_folder(it['id'], title)
        if pdfname:
            (m, h), = keep
            if out.dry:
                out.add_item(it, tags); st.add(S, 'sheets created'); st.add(S, 'pdf sheets')
                st.note(S, f'pdf: "{title}" {tags} <- {m[1]}'); continue
            ok = write_sheet(out, st, S, it, [], tags, pdf=m[2])
            if ok:
                out.c.execute('UPDATE sheet_page SET sha256=? WHERE item_id=?', (h, it['id'])); out.c.commit()
                st.add(S, 'sheets created'); st.add(S, 'pdf sheets')
            continue
        pages = []
        for m, h in keep:
            fn, ext = copier(m[2]); pages.append((fn, ext, h, int(m[2].stat().st_mtime * 1000)))
        if write_sheet(out, st, S, it, pages, tags):
            st.add(S, 'sheets created'); st.add(S, 'pages', len(pages))
            st.note(S, f'group: "{title}" {tags} <- {", ".join(m[1] for m, _ in keep)}')


# ---------- verify ----------

def verify(root):
    c = sqlite3.connect(f'file:{Path(root) / "meowsic.db"}?mode=ro', uri=True)
    items = Path(root) / 'items'
    print('items by source/kind:')
    for r in c.execute("SELECT substr(legacy_ref,1,instr(legacy_ref,':')-1), kind, count(*), sum(deleted_at IS NOT NULL) FROM item GROUP BY 1,2"):
        print(f'  {r[0]:10} {r[1]:7} {r[2]:5}  (in Trash: {r[3]})')
    for t in ('tag', 'item_tag', 'sheet_page', 'play_session', 'activity'):
        print(f'  {t}: {c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]}')
    bad = []
    q = {'sheet_page': "SELECT i.folder, p.file, i.id FROM sheet_page p JOIN item i ON i.id=p.item_id",
         'score': "SELECT i.folder, f, i.id FROM (SELECT item_id, musicxml f FROM score UNION ALL SELECT item_id, midi FROM score "
                  "UNION ALL SELECT item_id, pdf FROM score UNION ALL SELECT item_id, musicxml_original FROM score) s JOIN item i ON i.id=s.item_id WHERE f IS NOT NULL"}
    n = 0
    for sql in q.values():
        for folder, f, iid in c.execute(sql):
            n += 1
            if not folder or not (items / folder / f).is_file(): bad.append(f'{iid}: {folder}/{f}')
    checks = {
        'sheets whose page count != rows': "SELECT count(*) FROM sheet s WHERE pages != (SELECT count(*) FROM sheet_page p WHERE p.item_id=s.item_id)",
        'sheets with 0 pages': "SELECT count(*) FROM sheet WHERE pages=0",
        'items without kind row': "SELECT count(*) FROM item i WHERE NOT EXISTS (SELECT 1 FROM sheet WHERE item_id=i.id) AND NOT EXISTS (SELECT 1 FROM chord_chart WHERE item_id=i.id) AND NOT EXISTS (SELECT 1 FROM score WHERE item_id=i.id)",
        'items without legacy_ref': "SELECT count(*) FROM item WHERE legacy_ref IS NULL",
        'duplicate legacy_ref': "SELECT count(*) FROM (SELECT legacy_ref FROM item GROUP BY legacy_ref HAVING count(*)>1)",
        'duplicate folders': "SELECT count(*) FROM (SELECT lower(folder) FROM item WHERE folder IS NOT NULL GROUP BY 1 HAVING count(*)>1)",
        'folder not "<id> <title>"': "SELECT count(*) FROM item WHERE folder IS NOT NULL AND substr(folder,1,length(id)+1) != id || ' '",
        'sheet/score without folder': "SELECT count(*) FROM item WHERE kind!='chords' AND folder IS NULL",
        'chords with folder': "SELECT count(*) FROM item WHERE kind='chords' AND folder IS NOT NULL",
        'items without origin_at': "SELECT count(*) FROM item WHERE origin_at IS NULL",
        'pages without captured_at': "SELECT count(*) FROM sheet_page WHERE captured_at IS NULL",
        'fk violations': "SELECT count(*) FROM pragma_foreign_key_check",
    }
    fails = 0
    for name, sql in checks.items():
        v = c.execute(sql).fetchone()[0]
        if v: fails += 1
        print(f'  {"FAIL" if v else "ok  "} {name}: {v}')
    print(f'  {"FAIL" if bad else "ok  "} referenced files exist: {n - len(bad)}/{n}')
    for b in bad[:20]: print('    missing', b)
    on_disk = {p.name for p in items.iterdir()} if items.exists() else set()
    orphans = on_disk - {r[0] for r in c.execute('SELECT folder FROM item WHERE folder IS NOT NULL')}
    print(f'  {"FAIL" if orphans else "ok  "} folders without an item: {len(orphans)} {sorted(orphans)[:5]}')
    size = sum(f.stat().st_size for f in items.rglob('*') if f.is_file()) if items.exists() else 0
    print(f'  disk: items {size / 1e9:.2f} GB, db {(Path(root) / "meowsic.db").stat().st_size / 1e6:.1f} MB')
    print('  sample rows (created_at = first added to a library, origin_at = original date):')
    for r in c.execute("SELECT substr(legacy_ref,1,instr(legacy_ref,':')-1) src, kind, title, date(created_at/1000,'unixepoch'), "
                       "date(origin_at/1000,'unixepoch'), folder FROM item WHERE id IN (SELECT min(id) FROM item GROUP BY substr(legacy_ref,1,instr(legacy_ref,':')-1), kind)"):
        print(f'    {r[0]:9} {r[1]:6} created {r[3]} origin {r[4]}  {r[2][:40]!r}  [{r[5]}]')
    ok = not (fails or bad or orphans)
    print('VERIFY', 'PASSED' if ok else 'FAILED')
    return ok


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true', help='print counts, write nothing')
    ap.add_argument('--verify', action='store_true', help='only re-count from the db and check files')
    ap.add_argument('--out', default=str(HOME / 'Documents/Meowsic'), help='output folder (db + items/)')
    ap.add_argument('--only', default='meowsic1,songbook,musicnote,folder')
    a = ap.parse_args()
    if a.verify: sys.exit(0 if verify(a.out) else 1)
    out = Out(a.out, a.dry_run)
    if not a.dry_run: out.items_dir.mkdir(parents=True, exist_ok=True)
    report_dir = Path(a.out) / 'migrate'
    mpath = report_dir / 'manifest.json'
    manifest = json.loads(mpath.read_text()) if mpath.exists() else {}
    st = Stats()
    only = a.only.split(',')
    m1_chords = []
    if 'meowsic1' in only or 'songbook' in only:
        cc = sqlite3.connect(f'file:{M1_STORE}?mode=ro&immutable=1', uri=True)  # chord list only; WAL rows come from the copy below
        tmp = Path(tempfile.mkdtemp())
        for f in M1_STORE.parent.glob(M1_STORE.name + '*'): shutil.copy2(f, tmp / f.name)
        cc.close(); cc = sqlite3.connect(f'file:{tmp / M1_STORE.name}?mode=ro', uri=True)
        m1_chords = [(r[0] or '', r[1] or '', r[2] or '') for r in cc.execute(
            "SELECT c.ZSOURCEURL, s.ZTITLE, s.ZARTIST FROM ZCHORDSONG c JOIN ZSONG s ON s.ZID=c.ZID")]
        m1_chords += [('', r[0] or '', r[1] or '') for r in cc.execute('SELECT ZTITLE, ZARTIST FROM ZCHORDSONG')]
        cc.close(); shutil.rmtree(tmp)
    steps = [('meowsic1', 'Meowsic 1', lambda: import_meowsic1(out, st, manifest)),
             ('songbook', 'Emi Songbook', lambda: import_songbook(out, st, m1_chords)),
             ('musicnote', 'Emi Music Note', lambda: import_musicnote(out, st)),
             ('folder', '2023 Music sheet folder', lambda: import_folder(out, st))]
    for key, label, fn in steps:
        if key not in only: continue
        t = time.time(); fn()
        detail = ', '.join(f'{v} {k}' for k, v in st.c[key].items())
        out.activity(key, f'Imported from {label}', detail)
        if not out.dry:
            out.c.commit(); report_dir.mkdir(exist_ok=True); mpath.write_text(json.dumps(manifest, indent=1))
        print(f'{label} ({time.time() - t:.0f}s): {detail}')
    if not a.dry_run:
        report_dir.mkdir(exist_ok=True)
        mpath.write_text(json.dumps(manifest, indent=1))
        rp = report_dir / f'report-{datetime.now():%Y%m%d-%H%M%S}.txt'
        rp.write_text('\n'.join(f'[{k}] {n}' for k, ns in st.notes.items() for n in ns) + '\n' +
                      json.dumps({k: dict(v) for k, v in st.c.items()}, indent=1, ensure_ascii=False))
        print('report:', rp)
    else:
        rp = Path(tempfile.gettempdir()) / 'meowsic-migrate-dryrun.txt'
        rp.write_text('\n'.join(f'[{k}] {n}' for k, ns in st.notes.items() for n in ns))
        print('dry run, nothing written. notes:', rp)


if __name__ == '__main__':
    main()
