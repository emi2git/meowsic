"""Daily clean-up: Undo is open for 24 hours, then an activity is Final and the old copies kept only for undo go.

Runs inside the server (once at startup when the last run is more than 24 h ago, then every 24 h) and from
Activities → Clean up now (GET /api/daily-cleanup/preview = dry run, POST /api/daily-cleanup/run).

A run:
  * marks activities older than 24 h Final (activity.final_at; jobs are Final 24 h after they ended — derived)
  * deletes, when older than 24 h and not referenced by an activity that can still be undone:
      pageHistory  items/<folder>/.history/* of live items (a page's crop history goes as a whole, only when its
                   newest entry is older than 24 h; the page is then marked "fine as it is" in Clean up)
      history      history/*.json|jsonl (bulk change logs)
      jobWork      work/job-*/ of jobs that ended more than 24 h ago
      backups      backups/*.db (+ -wal/-shm), always keeping the newest one
  * logs itself as an Activities row (type 'cleanup', not undoable) and a line in work/cleanup.log.
Never touched: the db, current page images / scores, Trash items' folders, anything outside the data folder
(paths are resolved; symlinks are never followed, a link is only ever unlinked when it sits inside).
"""
import datetime
import json
import os
import re
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from . import cleanstate as cs
from .db import connect, folder_path, log_event, now_ms
from .items import cfg, conn
from .undolog import GRACE_MS

router = APIRouter(prefix='/api')
DAY = 24 * 3600 * 1000
_lock = threading.Lock()
CATS = ('pageHistory', 'history', 'jobWork', 'backups')
LABEL = {'pageHistory': 'old page images, crops and scores (.history)', 'history': 'bulk change logs (history/)',
         'jobWork': 'job work files (work/job-*)', 'backups': 'database backups (backups/)'}
NO_UNDO = 'A clean-up deletes old copies for good — there is nothing to bring back.'

_STAMPS = (  # time stamps in file names: when the copy was made
    (re.compile(r'(?<!\d)(\d{13})(?!\d)'), lambda m: int(m.group(1))),
    (re.compile(r'(?<!\d)(\d{10})(?!\d)'), lambda m: int(m.group(1)) * 1000),
    (re.compile(r'(?<!\d)(\d{8})-(\d{6}|\d{4})(?!\d)'),
     lambda m: int(datetime.datetime.strptime(m.group(1) + m.group(2).ljust(6, '0'), '%Y%m%d%H%M%S').timestamp() * 1000)),
    (re.compile(r'(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)'), lambda m: int(datetime.datetime.strptime(m.group(1), '%Y-%m-%d').timestamp() * 1000)),
)


def _when(p: Path, st=None) -> int:
    """When a file was last made / changed (ms): the newest of its modified time and any stamp in its name
    (copies made with copy2 keep the source's old modified time, the name stamp says when the copy was made)."""
    st = st or p.lstat()
    t = int(st.st_mtime * 1000)
    for rx, f in _STAMPS:
        for m in rx.finditer(p.name):
            try: t = max(t, f(m))
            except (ValueError, OverflowError): pass
    return t


def _inside(root: Path, p: Path) -> bool:
    """p may be deleted: its folder resolves inside the data folder, and (unless p is a link, which is only
    unlinked) so does p itself."""
    try:
        if not p.parent.resolve().is_relative_to(root): return False
        return p.is_symlink() or p.resolve().is_relative_to(root)
    except (OSError, RuntimeError):
        return False


def _real_dir(p: Path) -> bool:
    return p.is_dir() and not p.is_symlink()


def _strings(x):
    if isinstance(x, str): yield x
    elif isinstance(x, dict):
        for v in x.values(): yield from _strings(v)
    elif isinstance(x, list):
        for v in x: yield from _strings(v)


def _open_refs(c, cutoff):
    """What activities that can still be undone point at: file names, and (item, page) crops."""
    names, pages = set(), set()
    for (u,) in c.execute('SELECT undo FROM activity WHERE at >= ? AND final_at IS NULL AND undo IS NOT NULL', (cutoff,)):
        try: d = json.loads(u)
        except ValueError: continue
        for s in _strings(d):
            if '/' in s or '.' in s: names.add(s.rsplit('/', 1)[-1])
        for st in d.get('steps') or [] if isinstance(d, dict) else []:
            if isinstance(st, dict) and st.get('op') == 'crop': pages.add((st.get('id'), st.get('page')))
    return names, pages


def _page_history(cf, c, root, cutoff, names, pages):
    from .cleanup import _stack, _steps
    out, marks = [], []
    rows = c.execute('SELECT id, folder FROM item WHERE deleted_at IS NULL AND folder IS NOT NULL').fetchall()
    for iid, folder in rows:
        try: d = folder_path(cf, folder)
        except ValueError: continue
        h = d / '.history'
        if not _real_dir(d) or not _real_dir(h) or not _inside(root, h / 'x'): continue
        groups, loose = {}, []
        for e in os.scandir(h):
            if e.is_dir(follow_symlinks=False): continue
            p = Path(e.path)
            m = re.match(r'p(\d+)-(\d+)', e.name)
            (groups.setdefault(int(m.group(1)), []) if m else loose).append((p, e.stat(follow_symlinks=False)))
        for page, fs in groups.items():  # a page's crop history goes as a whole or not at all
            if (iid, page) in pages: continue
            if max(_when(p, st) for p, st in fs) >= cutoff: continue
            if any(p.name in names for p, _ in fs): continue
            out += [('pageHistory', p, st.st_size, 'file') for p, st in fs]
            if _stack(_steps(d, page)): marks.append((iid, page, d, fs))  # cropped now: stays done in Clean up
        for p, st in loose:
            if _when(p, st) < cutoff and p.name not in names:
                out.append(('pageHistory', p, st.st_size, 'file'))
    return out, marks


def _history_logs(cf, root, cutoff, names):
    h = cf.data / 'history'
    if not _real_dir(h): return []
    out = []
    for e in os.scandir(h):
        if not e.is_file(follow_symlinks=False) or not e.name.endswith(('.json', '.jsonl')): continue
        p, st = Path(e.path), e.stat(follow_symlinks=False)
        if _when(p, st) < cutoff and e.name not in names: out.append(('history', p, st.st_size, 'file'))
    return out


def _tree(d: Path):
    """(newest ms, bytes) of everything in a folder, links not followed."""
    newest, size = int(d.lstat().st_mtime * 1000), 0
    for top, dirs, files in os.walk(d, followlinks=False):
        for n in files + [x for x in dirs if os.path.islink(os.path.join(top, x))]:
            st = os.lstat(os.path.join(top, n))
            newest, size = max(newest, int(st.st_mtime * 1000)), size + st.st_size
    return newest, size


def _job_work(cf, c, root, cutoff):
    w = cf.work_dir
    if not _real_dir(w): return []
    jobs = {r[0]: r for r in c.execute('SELECT id, status, started_at, done_at FROM job')}
    out = []
    for e in os.scandir(w):
        if not e.name.startswith('job-') or not e.is_dir(follow_symlinks=False): continue
        p = Path(e.path)
        j = jobs.get(e.name)
        if j and (j[1] in ('queued', 'running') or (j[3] or j[2] or 0) >= cutoff): continue
        newest, size = _tree(p)
        if newest < cutoff: out.append(('jobWork', p, size, 'dir'))
    return out


def _backups(cf, root, cutoff):
    b = cf.backups_dir
    if not _real_dir(b): return [], None
    dbs = []
    for e in os.scandir(b):
        if e.name.endswith('.db') and e.is_file(follow_symlinks=False):
            p = Path(e.path); dbs.append((_when(p), p))
    if not dbs: return [], None
    dbs.sort()
    newest = dbs[-1][1]
    out = []
    for t, p in dbs[:-1]:
        if t >= cutoff: continue
        for f in (p, p.with_name(p.name + '-wal'), p.with_name(p.name + '-shm'), p.with_name(p.name + '-journal')):
            if f.is_file() and not f.is_symlink(): out.append(('backups', f, f.lstat().st_size, 'file'))
    return out, newest.name


def plan(cf, c, now=None):
    """What a run would do (nothing is changed)."""
    now = now or now_ms()
    cutoff = now - GRACE_MS
    root = cf.data.resolve()
    names, pages = _open_refs(c, cutoff)
    ph, marks = _page_history(cf, c, root, cutoff, names, pages)
    bk, kept = _backups(cf, root, cutoff)
    todo = ph + _history_logs(cf, root, cutoff, names) + _job_work(cf, c, root, cutoff) + bk
    never = {cf.db_path.resolve(), *(cf.db_path.with_name(cf.db_path.name + s).resolve() for s in ('-wal', '-shm', '-journal'))}
    todo = [t for t in todo if _inside(root, t[1]) and t[1].resolve() not in never]
    acts = c.execute('SELECT COUNT(*) FROM activity WHERE final_at IS NULL AND at < ?', (cutoff,)).fetchone()[0]
    jobs = c.execute("SELECT COUNT(*) FROM job WHERE status NOT IN ('queued','running') AND COALESCE(done_at, started_at) < ?", (cutoff,)).fetchone()[0]
    return {'now': now, 'cutoff': cutoff, 'activities': acts, 'jobs': jobs, 'todo': todo, 'marks': marks, 'keptBackup': kept}


def summary(p) -> dict:
    cats = {k: {'label': LABEL[k], 'files': 0, 'bytes': 0} for k in CATS}
    for cat, path, size, kind in p['todo']:
        cats[cat]['files'] += 1 if kind == 'file' else sum(len(f) for _, _, f in os.walk(path, followlinks=False)) or 1
        cats[cat]['bytes'] += size
    for v in cats.values(): v['mb'] = round(v['bytes'] / 1e6, 1)
    files, size = sum(v['files'] for v in cats.values()), sum(v['bytes'] for v in cats.values())
    return {'at': p['now'], 'cutoff': p['cutoff'], 'activities': p['activities'], 'jobs': p['jobs'], 'categories': cats,
            'files': files, 'bytes': size, 'mb': round(size / 1e6, 1), 'keptBackup': p['keptBackup'], 'pagesFinal': len(p['marks'])}


def _rm(root: Path, path: Path, kind: str) -> bool:
    if not _inside(root, path): return False
    try:
        if kind == 'dir':
            if path.is_symlink(): return False
            for top, dirs, files in os.walk(path, topdown=False, followlinks=False):
                for n in files: os.unlink(os.path.join(top, n))
                for n in dirs:
                    q = os.path.join(top, n)
                    os.unlink(q) if os.path.islink(q) else os.rmdir(q)
            os.rmdir(path)
        else:
            os.unlink(path)
        return True
    except OSError:
        return False


def last_run(c):
    r = c.execute("SELECT MAX(at) FROM activity WHERE type='cleanup' AND undo LIKE '%\"daily\": true%'").fetchone()
    return r[0] if r else None


def run(cf, c, now=None, dry=False) -> dict:
    """One clean-up. dry=True only says what it would do."""
    with _lock:
        p = plan(cf, c, now)
        s = summary(p)
        s['dry'] = dry
        if dry: return s
        root = cf.data.resolve()
        c.execute('UPDATE activity SET final_at=? WHERE final_at IS NULL AND at < ?', (p['now'], p['cutoff']))
        failed = [str(t[1]) for t in p['todo'] if not _rm(root, t[1], t[3])]
        for iid, page, d, fs in p['marks']:  # its crops are final: the page is "fine as it is" (never back in To do)
            if not any(f.exists() for f, _ in fs):
                try: cs.mark(c, f'{iid}:{page}', True)
                except Exception: pass
        s['failed'] = len(failed)
        cats = s['categories']
        detail = '; '.join(f'{v["label"]}: {v["files"]} ({v["mb"]} MB)' for v in cats.values() if v['files']) or 'nothing old to delete'
        detail += f'; {s["activities"]} activit{"y" if s["activities"] == 1 else "ies"} now Final' + (f'; kept the newest backup {s["keptBackup"]}' if s['keptBackup'] else '')
        if failed: detail += f'; {len(failed)} could not be deleted'
        title = f'Daily clean-up: {s["files"]} file{"s" if s["files"] != 1 else ""} deleted, {s["mb"]} MB freed'
        log_event(c, 'cleanup', title, detail, undo={'none': NO_UNDO, 'daily': True})
        c.commit()
        try:
            cf.work_dir.mkdir(parents=True, exist_ok=True)
            with open(cf.work_dir / 'cleanup.log', 'a') as f:
                f.write(json.dumps({'at': time.strftime('%Y-%m-%d %H:%M:%S'), **{k: v for k, v in s.items() if k != 'dry'}, 'failedFiles': failed[:50]}, ensure_ascii=False) + '\n')
        except OSError: pass
        return s


def daily_loop(cf, stop: threading.Event):
    """Run at startup when the last run is more than 24 h ago, then every 24 h (checked hourly)."""
    while True:
        try:
            c = connect(cf)
            try:
                last = last_run(c)
                if not last or now_ms() - last >= DAY: run(cf, c)
            finally: c.close()
        except Exception: pass
        if stop.wait(3600): return


@router.get('/daily-cleanup/preview')
def preview(c=Depends(conn), cf=Depends(cfg)):
    """Dry run: what a clean-up would delete now (counts and MB per category) and how many activities turn Final."""
    return {**run(cf, c, dry=True), 'lastRun': last_run(c), 'graceHours': GRACE_MS // 3600000}


@router.post('/daily-cleanup/run')
def run_now(body: dict = Body(default={}), c=Depends(conn), cf=Depends(cfg)):
    if (body or {}).get('dry'): return preview(c, cf)
    if not _lock.acquire(blocking=False): raise HTTPException(409, 'A clean-up is running already')
    _lock.release()
    return run(cf, c)
