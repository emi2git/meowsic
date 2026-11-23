"""Manage library → Organize pages: every sheet and book, plus "Recommended to check".

Refresh runs a scan as a job (kind 'organize', progress like any job): it looks at every live sheet and book
and lists what looks fishy, most likely first, each with a short reason —
  several   the pages show more than one title / a page starts like a new song / page dots start again
  merge     sheets whose titles say they are one song in parts ("X (2)", "X part 2", "X — p6")
  order     page numbers (printed, or page dots) out of order
  duplicate the same page twice
  blank     a (nearly) blank page
"This is a complete song" (organize_reviewed) hides an item from every scan; it is undoable in Activities
(step {op: 'reviewed'}) and "Show hidden" lists them. The newest scan is kept in organize_scan.
What a page looks like (a tiny grey picture, its spread) is cached in work/organize-pages.json; titles come from
the title cache (titles.py, the same Vision reading the editor's title detection uses) — the scan reads the
titles of pages not read before when Vision is set up on this Mac.
"""
import hashlib
import hashlib
import json
import re
import threading
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from . import cleanstate as cs
from . import titles
from .db import connect, folder_path, get_item, log_event, now_ms
from .items import cfg, conn, must_item
from .undolog import record_undo

router = APIRouter(prefix='/api')
_cache_lock = threading.Lock()
KINDS = ('several', 'merge', 'order', 'duplicate', 'blank')


# ---------- reviewed ("This is a complete song") ----------

def is_reviewed(c, item_id) -> bool:
    return c.execute('SELECT 1 FROM organize_reviewed WHERE item_id=?', (item_id,)).fetchone() is not None


def set_reviewed(c, item_id, on: bool):
    if on: c.execute('INSERT OR IGNORE INTO organize_reviewed(item_id, at) VALUES (?,?)', (item_id, now_ms()))
    else: c.execute('DELETE FROM organize_reviewed WHERE item_id=?', (item_id,))


def reviewed_ids(c) -> set:
    return {r[0] for r in c.execute('SELECT item_id FROM organize_reviewed')}


# ---------- what each page looks like (cached) ----------

def _cache_file(cf) -> Path:
    d = cf.data / 'work'
    d.mkdir(exist_ok=True)
    return d / 'organize-pages.json'


def _load(cf) -> dict:
    try: return json.loads(_cache_file(cf).read_text())
    except Exception: return {}


def _save(cf, data):
    tmp = _cache_file(cf).with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(_cache_file(cf))


def look(path: Path) -> dict | None:
    """{g: 16×16 grey (hex, contrast stretched), std: spread of the grey levels 0..255, md5: of the file}."""
    from PIL import Image, ImageOps, ImageStat
    try:
        md5 = hashlib.md5(path.read_bytes()).hexdigest()
        im = Image.open(path)
        im.draft('L', (256, 256))
        im = ImageOps.exif_transpose(im).convert('L')
        im.thumbnail((256, 256))
    except Exception:
        return None
    std = ImageStat.Stat(im).stddev[0]
    g = ImageOps.autocontrast(im.resize((16, 16)), cutoff=1)
    return {'g': g.tobytes().hex(), 'std': round(std, 2), 'md5': md5}


def _diff(a: str, b: str) -> float:
    x, y = bytes.fromhex(a), bytes.fromhex(b)
    return sum(abs(p - q) for p, q in zip(x, y)) / max(1, len(x))


# ---------- the checks ----------

PART = re.compile(r'\s*(?:[\(\[]\s*(?:(?:part|pt\.?|phần|p\.?|page|trang|tờ)\s*)?(\d{1,2})\s*[\)\]]|\b(?:part|pt\.?|phần|page|trang|tờ)\s*(\d{1,2}))\s*$', re.I)
DASH_P = re.compile(r'\s+[—–-]\s*p(\d{1,3})$', re.I)
CONT = re.compile(r'\s*[\(\[]?\s*(cont(?:inued|\.)?|tiếp(?: theo)?)\s*[\)\]]?\s*$', re.I)
PAGENUM = re.compile(r'^\s*[-–—(]?\s*(\d{1,3})\s*[-–—)]?\s*$')


def base_title(t: str):
    """('moon river', 2) for "Moon River (2)" / "Moon River part 2" / "Moon River — p6"; (fold, None) without a marker."""
    t = (t or '').strip()
    for rx in (DASH_P, PART):
        m = rx.search(t)
        if m and m.start() > 0 and len(titles.fold(t[:m.start()])) >= 3: return titles.fold(t[:m.start()]), int(next(g for g in m.groups() if g))
    m = CONT.search(t)
    if m and m.start() > 0: return titles.fold(t[:m.start()]), 99
    return titles.fold(t), None


def _page_number(lines: dict | None, ocr: str | None):
    """The printed page number: a line of only 1–3 digits at the very top or bottom (Vision), else in the OCR text."""
    for l in (lines or {}).get('lines') or []:
        m = PAGENUM.match(l.get('text') or '')
        if m and (l['y'] < 0.08 or l['y'] + l['h'] > 0.92): return int(m.group(1))
    for line in reversed((ocr or '').splitlines()):
        m = PAGENUM.match(line)
        if m: return int(m.group(1))
    return None


def check_item(it: dict, pages: list[dict], hint: list[str]) -> list[dict]:
    """Candidates for one item. pages: [{page, title, conf, num, dots, look}] (sheet_page.sha256 is the source file's: a PDF's pages share it)."""
    out = []
    n = len(pages)
    # several songs: more than one title on the pages, or grouping says so (page dots, titles)
    named = [(p['page'], p['title'], p['conf']) for p in pages if p['title'] and p['conf'] >= 0.6]
    distinct = {}
    for pg, t, conf in named: distinct.setdefault(titles.fold(t), (pg, t, conf))
    if len(distinct) >= 2 or hint:
        firsts = sorted(distinct.values())
        later = [x for x in firsts if x[0] > 1]
        reason = (f'its pages show {len(distinct)} titles: ' + ', '.join(f'“{t}” (p{pg})' for pg, t, _ in firsts[:3])) if len(distinct) >= 2 else hint[0]
        score = max(0.8 if hint else 0, 0.55 + 0.35 * min(x[2] for x in firsts[:2]) if len(distinct) >= 2 else 0)
        out.append({'kind': 'several', 'score': round(score, 3), 'reason': reason,
                    'pages': sorted({x[0] for x in later} | {int(m.group(1)) for h in hint if (m := re.match(r'page (\d+)', h))})})
    elif n > 1:  # one title only, but a later page starts with a title of its own (not the sheet's)
        own = titles.fold(it['title'])
        tops = [(p['page'], p['title'], p['conf']) for p in pages[1:] if p['title'] and p['conf'] >= 0.7 and titles.fold(p['title']) != own]
        if tops:
            pg, t, conf = tops[0]
            out.append({'kind': 'several', 'score': round(0.4 + 0.3 * conf, 3), 'reason': f'page {pg} starts like a new song: “{t}”', 'pages': [x[0] for x in tops]})
    # order: printed page numbers, or page dots of one run, going backwards
    nums = [(p['page'], p['num']) for p in pages if p['num'] is not None]
    if len(nums) >= 2 and any(b[1] < a[1] for a, b in zip(nums, nums[1:])) and len({v for _, v in nums}) == len(nums):
        out.append({'kind': 'order', 'score': 0.65, 'reason': 'printed page numbers read ' + ', '.join(str(v) for _, v in nums[:8]),
                    'pages': [pg for pg, _ in nums]})
    else:
        dots = [(p['page'], p['dots']) for p in pages if p['dots'] and p['dots'].get('lit')]
        back = [b for a, b in zip(dots, dots[1:]) if b[1]['count'] == a[1]['count'] and 1 < b[1]['lit'] < a[1]['lit']]
        if back:
            out.append({'kind': 'order', 'score': 0.7, 'reason': 'page dots read ' + ', '.join(f'{d["lit"]}/{d["count"]}' for _, d in dots[:8]), 'pages': [pg for pg, _ in back]})
    # the same page twice
    dup = []
    for i, a in enumerate(pages):
        for b in pages[i + 1:]:
            if not (a['look'] and b['look']) or min(a['look']['std'], b['look']['std']) < 6: continue  # blank pages: said below
            if a['look'].get('md5') == b['look'].get('md5'): dup.append((a['page'], b['page'], 0.9))
            elif a['look']['std'] > 9 and _diff(a['look']['g'], b['look']['g']) < 3.0: dup.append((a['page'], b['page'], 0.6))
    if dup:
        a, b, s = max(dup, key=lambda x: x[2])
        out.append({'kind': 'duplicate', 'score': s, 'reason': f'pages {a} and {b} look the same' + (f' (and {len(dup) - 1} more)' if len(dup) > 1 else ''),
                    'pages': sorted({x for d in dup for x in d[:2]})})
    # blank pages
    blank = [p['page'] for p in pages if p['look'] and p['look']['std'] < 6]
    if blank:
        out.append({'kind': 'blank', 'score': 0.6, 'reason': f'page{"s" if len(blank) > 1 else ""} {", ".join(map(str, blank[:5]))} look{"" if len(blank) > 1 else "s"} blank', 'pages': blank})
    return out


def merge_candidates(items: list[dict]) -> list[dict]:
    """Sheets whose titles say "one song in parts", or the same title added a few minutes apart."""
    groups = {}
    for it in items:
        if re.search(r'\b(version|ver\.?|arr\.?|easy|simplified)\b', it['title'], re.I): continue  # versions are meant to be apart
        b, k = base_title(it['title'])
        if b: groups.setdefault(b, []).append((it, k))
    out = []
    for b, xs in groups.items():
        if len(xs) < 2: continue
        marked = [x for x in xs if x[1] is not None]
        xs.sort(key=lambda x: (x[1] or 0, x[0]['createdAt'] or 0))
        first = xs[0][0]
        if marked:
            out.append({'id': first['id'], 'kind': 'merge', 'score': 0.75, 'others': [x[0]['id'] for x in xs[1:]],
                        'reason': ' and '.join(f'“{x[0]["title"]}”' for x in xs[:3]) + ' look like one song in parts'})
        else:
            close = [x[0] for x in xs[1:] if abs((x[0]['createdAt'] or 0) - (first['createdAt'] or 0)) <= 15 * 60_000]
            if close:
                out.append({'id': first['id'], 'kind': 'merge', 'score': 0.5, 'others': [x['id'] for x in close],
                            'reason': f'{len(close) + 1} sheets called “{first["title"]}”, added minutes apart — one song split in two?'})
    return out


def _items(c) -> list[dict]:
    rows = c.execute("SELECT i.id, i.title, s.pages, s.book, i.updated_at, i.created_at, i.folder FROM item i JOIN sheet s ON s.item_id = i.id "
                     "WHERE i.deleted_at IS NULL AND i.kind = 'sheet' AND i.folder IS NOT NULL AND s.pages >= 1").fetchall()
    return [{'id': r[0], 'title': r[1], 'pages': r[2], 'book': bool(r[3]), 'updatedAt': r[4], 'createdAt': r[5], 'folder': r[6]} for r in rows]


READ_MAX = 240   # titles read per Refresh (Vision, about 0.3 s a page); the rest the next time — the cache keeps them
READ_PAGES = 60  # sheets / books with more pages than this: their titles are read in the editor, not in a scan


def _read_titles(cf, c, items, tcache, progress):
    """Read (Vision, omr/title.py) the titles of pages not read before, newest sheets first, in batches; cached in titles.json."""
    todo = []
    for it in sorted(items, key=lambda x: -(x['createdAt'] or 0)):
        if not 2 <= it['pages'] <= READ_PAGES: continue
        d = folder_path(cf, it['folder'])
        for (f,) in c.execute('SELECT file FROM sheet_page WHERE item_id=? ORDER BY page', (it['id'],)):
            pth = d / f
            try: mt = pth.stat().st_mtime
            except OSError: continue
            if (tcache.get(str(pth.relative_to(cf.data))) or {}).get('mtime') != mt: todo.append((pth, mt))
        if len(todo) >= READ_MAX: break
    todo = todo[:READ_MAX]
    for k in range(0, len(todo), 12):
        part = todo[k:k + 12]
        try: res = titles.read_lines([x[0] for x in part])
        except Exception: continue
        with titles._lock:
            data = titles._load(cf)
            for pth, mt in part:
                r = res.get(str(pth))
                if r and 'error' not in r: data[str(pth.relative_to(cf.data))] = {**r, 'mtime': mt}
            titles._save(cf, data)
        progress(0, 1, f'Read the titles of {k + len(part)} of {len(todo)} new pages')
    with titles._lock: return titles._load(cf)


def scan(cf, progress=lambda done, total, msg: None, read=True) -> dict:
    """Look at every live sheet and book; {at, items, candidates} most likely first."""
    from .booksplit import _hint
    c = connect(cf)
    try:
        items = _items(c)
        hidden = reviewed_ids(c)
        scans = cs.scan_all(c)
        total = sum(it['pages'] for it in items) or 1
        with _cache_lock: cache = _load(cf)
        with titles._lock: tcache = titles._load(cf)
        if read and titles.available():
            tcache = _read_titles(cf, c, items, tcache, progress)
        cands, done = [], 0
        for k, it in enumerate(items):
            d = folder_path(cf, it['folder'])
            rows = [dict(r) for r in c.execute('SELECT page, file, sha256, ocr_text FROM sheet_page WHERE item_id=? ORDER BY page', (it['id'],))]
            paths = [d / r['file'] for r in rows]
            pages = []
            for r, p in zip(rows, paths):
                rel = str(p.relative_to(cf.data))
                try: st = p.stat()
                except OSError: continue
                key, sig = rel, f'{st.st_size}:{st.st_mtime_ns}'
                ent = cache.get(key)
                if not ent or ent.get('sig') != sig or ent.get('v') != 2:
                    ent = {'sig': sig, 'look': look(p), 'v': 2}
                    cache[key] = ent
                lines = tcache.get(rel)
                t = titles.pick(lines) if lines and lines.get('mtime') == st.st_mtime and 'lines' in lines else {}
                res = ((scans.get(f'{it["id"]}:{r["page"]}') or [0, None])[1] or {})
                pages.append({'page': r['page'], 'title': t.get('title', ''), 'conf': t.get('confidence', 0) or 0, 'num': _page_number(lines, r.get('ocr_text')),
                              'dots': res.get('dots'), 'look': ent['look']})
            hint = _hint(c, cf, [(it['id'], it['folder'])]).get(it['id'], []) if len(rows) > 1 else []
            for x in check_item(it, pages, hint):
                cands.append({'id': it['id'], **x})
            done += it['pages']
            if k % 10 == 0 or k == len(items) - 1: progress(done, total, f'Checked {k + 1} of {len(items)}')
        with _cache_lock: _save(cf, cache)
        cands += merge_candidates([it for it in items if not it['book']])
        cands = [x for x in cands if x['id'] not in hidden and not any(o in hidden for o in x.get('others') or [])]
        cands.sort(key=lambda x: (-x['score'], KINDS.index(x['kind'])))
        return {'at': now_ms(), 'items': len(items), 'candidates': cands}
    finally:
        c.close()


# ---------- endpoints ----------

def _latest(c):
    r = c.execute('SELECT job_id, at, result FROM organize_scan WHERE id=1').fetchone()
    if not r: return None
    return {'job': r[0], 'at': r[1], **json.loads(r[2])}


def _view(c, scan_row):
    """The scan as shown: items gone, in the Trash or marked complete since are left out; titles as they are now."""
    if not scan_row: return None
    hidden = reviewed_ids(c)
    live = {it['id']: it for it in _items(c)}
    out = []
    for x in scan_row['candidates']:
        if x['id'] not in live or x['id'] in hidden: continue
        others = [o for o in x.get('others') or [] if o in live]
        if x['kind'] == 'merge' and (not others or any(o in hidden for o in others)): continue
        out.append({**x, 'others': others, 'title': live[x['id']]['title'], 'otherTitles': [live[o]['title'] for o in others]})
    return {'at': scan_row['at'], 'job': scan_row['job'], 'items': scan_row['items'], 'candidates': out}


@router.get('/organize')
def organize_get(c=Depends(conn)):
    """{items: every live sheet and book (reviewed flag, marks), scan: the newest Recommended to check, job: a running scan}."""
    hidden = reviewed_ids(c)
    undo = cs.can_unmake(c)
    items = [{k: v for k, v in it.items() if k != 'folder'} | {'reviewed': it['id'] in hidden, 'starts': cs.split_starts(c, it['id']), 'canUnmake': it['id'] in undo}
             for it in _items(c)]
    items.sort(key=lambda x: x['title'].lower())
    j = c.execute("SELECT id, status, progress FROM job WHERE kind='organize' AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1").fetchone()
    return {'items': items, 'scan': _view(c, _latest(c)), 'job': {'id': j[0], 'status': j[1], 'progress': j[2]} if j else None}


@router.post('/organize/scan')
def organize_scan(request: Request, body: dict = Body(default={})):
    """Start the Refresh scan as a job ({wait: true}: run it here and return the result)."""
    from . import jobs
    app = request.app
    cf = app.state.cfg
    c = app.state.connect()
    try:
        j = c.execute("SELECT id FROM job WHERE kind='organize' AND status IN ('queued','running') LIMIT 1").fetchone()
    finally: c.close()
    if j and not body.get('wait'): return jobs.get_job_row(app, j[0])

    def runner(ctx):
        res = scan(cf, lambda done, total, msg: ctx.update(progress=round(0.98 * done / max(total, 1), 3), stage='Checking pages', msg=None), read=body.get('read', True))
        c2 = connect(cf)
        try:
            c2.execute('INSERT OR REPLACE INTO organize_scan(id, job_id, at, result) VALUES (1,?,?,?)', (ctx.id, res['at'], json.dumps({'items': res['items'], 'candidates': res['candidates']}, ensure_ascii=False)))
            c2.commit()
        finally: c2.close()
        ctx.update(progress=1, msg=f'Done — {len(res["candidates"])} to check', status='done', result={'candidates': len(res['candidates']), 'items': res['items']})

    job = jobs.start_job(app, 'organize', 'Organize pages: find what to check', 'On this Mac', [], {}, runner=runner, thread=not body.get('wait'))
    return jobs.get_job_row(app, job['id'])


@router.post('/organize/reviewed')
def organize_reviewed(body: dict = Body(...), c=Depends(conn)):
    """{id, on: true} "This is a complete song" (scans leave it out) — {on: false} shows it again. Undoable in Activities."""
    it = must_item(c, str(body.get('id')))
    on = bool(body.get('on', True))
    if is_reviewed(c, it['id']) == on: return {'reviewed': on, 'activity': None}
    set_reviewed(c, it['id'], on)
    aid = log_event(c, 'reviewed' if on else 'unreviewed', it['title'], 'a complete song — left out of Recommended to check' if on else 'back in Recommended to check')
    record_undo(c, aid, {'op': 'reviewed', 'id': it['id'], 'title': it['title'], 'on': on})
    return {'reviewed': on, 'activity': aid}
