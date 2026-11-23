"""Move old '<id> <title>' item folders to the id scheme: items/<id>/ with '<id> 1.jpg', '<id>.musicxml'…

Books (items/Books/<name>/) are left alone. Only top-level files named after the old folder are renamed;
.history/ moves with its folder and keeps its names (they are page based: p<n>-<ts>.*). The db rows
(item.folder, sheet_page.file, score file columns, page_scan.file) follow in the same step, one item at a
time. Every move is written to <data>/history/folders-<ts>.jsonl (one line per item: old -> new for the
folder and each file), and undo(<log>) puts everything back. Both are safe to run again: items already
moved (or already put back) are skipped.
"""
import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from .db import BOOKS, rebase

SCORE_COLS = ('musicxml', 'musicxml_original', 'midi', 'pdf')


@dataclass
class Plan:
    id: str
    old: str
    new: str
    files: list = field(default_factory=list)   # [(old name, new name)] top-level files in the folder
    pages: dict = field(default_factory=dict)   # {page: (old, new)}
    score: dict = field(default_factory=dict)   # {col: (old, new)}
    missing: list = field(default_factory=list)  # files the db names that are not in the folder (before the move)
    problem: str = ''                            # why this item is skipped


def _connect(data: Path):
    c = sqlite3.connect(data / 'meowsic.db', timeout=30)
    c.execute('PRAGMA foreign_keys = ON')
    return c


def _has_table(c, name):
    return c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def plan(c, items: Path, only=None) -> list[Plan]:
    q = "SELECT id, folder FROM item WHERE folder IS NOT NULL AND folder <> id AND folder NOT LIKE ? ORDER BY created_at"
    out = []
    for iid, folder in c.execute(q, (BOOKS + '/%',)).fetchall():
        if only and iid not in only: continue
        p = Plan(iid, folder, iid)
        src, dst = items / folder, items / iid
        if '/' in folder or folder.startswith('.'): p.problem = 'odd folder name'
        elif not src.is_dir(): p.problem = 'folder not on disk'
        elif dst.exists(): p.problem = f'items/{iid} already exists'
        if not p.problem:
            names = {f.name for f in src.iterdir()}
            for name in sorted(names):
                to = rebase(name, folder, iid)
                if to and (src / name).is_file(): p.files.append((name, to))
            targets = [b for _, b in p.files]
            clash = {b for b in targets if targets.count(b) > 1} | ({b for b in targets} & (names - {a for a, _ in p.files}))
            if clash: p.problem = f'name clash: {sorted(clash)[0]}'
        mv = dict(p.files)
        for page, f in c.execute('SELECT page, file FROM sheet_page WHERE item_id=? ORDER BY page', (iid,)):
            if f in mv: p.pages[page] = (f, mv[f])
            elif not p.problem and not (src / f).is_file(): p.missing.append(f)
        row = c.execute(f'SELECT {",".join(SCORE_COLS)} FROM score WHERE item_id=?', (iid,)).fetchone()
        for col, f in zip(SCORE_COLS, row or ()):
            if not f: continue
            if f in mv: p.score[col] = (f, mv[f])
            elif not p.problem and not (src / f).is_file(): p.missing.append(f)
        out.append(p)
    return out


def _log_line(path: Path, line: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a') as f:
        f.write(json.dumps(line, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())


def _activity(c, title, detail):
    import secrets, string
    c.execute('INSERT INTO activity(id, type, title, detail, at) VALUES (?,?,?,?,?)',
              ('act-' + ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(7)),
               'migrate', title, detail, int(time.time() * 1000)))


def _rename_all(moves):
    """os.rename each (a, b) in order; on failure put back the ones done and raise."""
    done = []
    try:
        for a, b in moves:
            os.rename(a, b)
            done.append((a, b))
    except OSError:
        for a, b in reversed(done):
            try: os.rename(b, a)
            except OSError: pass
        raise


def _db_apply(c, iid, folder_from, folder_to, pages, score, scan):
    """pages / score: {key: (from, to)}; only rows still at `from` are changed."""
    n = c.execute('UPDATE item SET folder=? WHERE id=? AND folder=?', (folder_to, iid, folder_from)).rowcount
    if n != 1: raise RuntimeError(f'item {iid} is not in {folder_from!r} any more')
    for page, (a, b) in pages.items():
        c.execute('UPDATE sheet_page SET file=? WHERE item_id=? AND page=? AND file=?', (b, iid, int(page), a))
    for col, (a, b) in score.items():
        c.execute(f'UPDATE score SET {col}=? WHERE item_id=? AND {col}=?', (b, iid, a))
    if scan:
        for page, (a, b) in pages.items():
            c.execute('UPDATE page_scan SET file=? WHERE item_id=? AND page=? AND file=?', (b, iid, int(page), a))


def migrate(data: Path, dry_run=False, only=None, backup=True, out=print) -> dict:
    data = Path(data)
    items = data / 'items'
    c = _connect(data)
    try:
        plans = plan(c, items, only)
        todo = [p for p in plans if not p.problem]
        res = {'items': len(todo), 'skipped': len(plans) - len(todo), 'files': sum(len(p.files) for p in todo),
               'pages': sum(len(p.pages) for p in todo), 'score_files': sum(len(p.score) for p in todo),
               'missing': sum(len(p.missing) for p in todo), 'log': None, 'problems': [(p.id, p.old, p.problem) for p in plans if p.problem]}
        why = {}
        for p in plans:
            if p.problem: why.setdefault(p.problem.split(':')[0].replace(p.id, '<id>'), []).append(p)
            elif p.missing: out(f'  note {p.id}: the db names {len(p.missing)} file(s) not in the folder: {p.missing[:3]}')
        for k, ps in why.items():
            out(f'  skip {len(ps)} item(s): {k} — e.g. ' + ', '.join(f'{p.id} {p.old!r}' for p in ps[:3]))
        if dry_run or not todo:
            return res
        stamp = time.strftime('%Y%m%d-%H%M%S')
        if backup:
            (data / 'backups').mkdir(exist_ok=True)
            dest = sqlite3.connect(data / 'backups' / f'meowsic-before-id-folders-{stamp}.db')
            try: c.backup(dest)
            finally: dest.close()
        log = data / 'history' / f'folders-{stamp}.jsonl'
        res['log'] = str(log)
        scan = _has_table(c, 'page_scan')
        moved = 0
        for p in todo:
            src, dst = items / p.old, items / p.new
            try:
                _rename_all([(src, dst)] + [(dst / a, dst / b) for a, b in p.files])
            except OSError as e:
                out(f'  FAILED {p.id}: {e} (nothing moved)')
                res.setdefault('failed', []).append(p.id)
                continue
            try:
                _db_apply(c, p.id, p.old, p.new, p.pages, p.score, scan)
                c.commit()
            except Exception as e:
                c.rollback()
                _rename_all([(dst / b, dst / a) for a, b in reversed(p.files)] + [(dst, src)])
                out(f'  FAILED {p.id}: {e} (files put back)')
                res.setdefault('failed', []).append(p.id)
                continue
            _log_line(log, {'at': int(time.time() * 1000), 'id': p.id, 'folder': [p.old, p.new], 'files': [list(x) for x in p.files],
                            'pages': {str(k): list(v) for k, v in p.pages.items()}, 'score': {k: list(v) for k, v in p.score.items()}})
            moved += 1
        res['moved'] = moved
        _activity(c, 'Item folders', f'{moved} folder(s) → items/<id>/ ({res["files"]} files renamed); log history/{log.name}')
        c.commit()
        return res
    finally:
        c.close()


def undo(data: Path, log: Path, dry_run=False, out=print) -> dict:
    """Put back every move in `log` (newest first). Items already back (or changed since) are skipped."""
    data, log = Path(data), Path(log)
    items = data / 'items'
    lines = [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
    c = _connect(data)
    res = {'items': 0, 'skipped': 0, 'files': 0, 'log': None}
    try:
        scan = _has_table(c, 'page_scan')
        ulog = data / 'history' / f'folders-undo-{time.strftime("%Y%m%d-%H%M%S")}.jsonl'
        for e in reversed(lines):
            old, new = e['folder']
            row = c.execute('SELECT folder FROM item WHERE id=?', (e['id'],)).fetchone()
            why = ('item gone' if not row else 'already back' if row[0] == old else f'folder is now {row[0]!r}' if row[0] != new
                   else f'items/{old} exists' if (items / old).exists() else f'items/{new} missing' if not (items / new).is_dir() else '')
            if why:
                out(f'  skip {e["id"]}: {why}'); res['skipped'] += 1; continue
            files = [(b, a) for a, b in e['files'] if (items / new / b).exists()]
            res['items'] += 1; res['files'] += len(files)
            if dry_run: continue
            src, dst = items / new, items / old
            _rename_all([(src / b, src / a) for b, a in reversed(files)] + [(src, dst)])
            try:
                _db_apply(c, e['id'], new, old, {k: (b, a) for k, (a, b) in e['pages'].items()},
                          {k: (b, a) for k, (a, b) in e['score'].items()}, scan)
                c.commit()
            except Exception:
                c.rollback()
                _rename_all([(dst, src)] + [(src / a, src / b) for b, a in files])
                raise
            _log_line(ulog, {'at': int(time.time() * 1000), 'id': e['id'], 'folder': [new, old], 'files': [[b, a] for b, a in files], 'undo_of': log.name})
            res['log'] = str(ulog)
        if res['log']:
            _activity(c, 'Item folders', f'undo of history/{log.name}: {res["items"]} folder(s) back; log history/{ulog.name}')
            c.commit()
        return res
    finally:
        c.close()

