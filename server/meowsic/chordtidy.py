"""One-time tidy of the chord symbols in existing scores, with the new chord finder (chordfind.py).

For each score item: the chord symbols are worked out again from the score's own notes and the
<harmony> elements are swapped; every note stays byte for byte. Nothing is lost: before a file
changes it is copied to items/<folder>/.history/chords-<timestamp>-<file>, and one JSON line per
file goes to <data>/history/chords-retidy.jsonl. The database is only read, never written.

Skipped (and reported): AI-composed lead sheets (ai=1 / source 'Meowsic': their chords were
written on purpose), scores read from a sheet ('From the sheet …': the chords were printed on the
sheet), and items in the Trash.
"""
import json
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import arrange
from .chordfind import rechord_xml


@dataclass
class Result:
    id: str
    title: str
    status: str                       # 'changed' | 'unchanged' | 'skipped' | 'error'
    why: str = ''
    files: list = field(default_factory=list)  # [(file name, old [(bar, name)], new [(bar, name)])]


def skip_reason(row) -> str:
    src = row['source'] or ''
    if row['deleted_at']: return 'in the Trash'
    if row['ai'] or src in ('Meowsic', 'Meowsic AI'): return 'AI-composed lead sheet (chords written on purpose)'
    if src.startswith('From the sheet'): return 'read from a sheet (chords printed on it)'
    if not row['musicxml'] or not row['folder']: return 'no MusicXML file'
    return ''


def open_db(db: Path) -> sqlite3.Connection:
    """Read-only: the live server may hold the database open; this never writes to it."""
    try:
        c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        c.execute('SELECT 1 FROM item LIMIT 1')
    except sqlite3.OperationalError:
        c = sqlite3.connect(f'file:{db}?immutable=1', uri=True)
    c.row_factory = sqlite3.Row
    return c


def score_rows(data: Path, only=None):
    c = open_db(data / 'meowsic.db')
    try:
        q = ('SELECT i.id, i.title, i.folder, i.deleted_at, s.version, s.musicxml, s.musicxml_original, s.pdf, s.ai, s.source '
             'FROM item i JOIN score s ON s.item_id = i.id WHERE i.kind = \'score\'')
        args = []
        if only:
            q += ' AND i.id IN (%s)' % ','.join('?' * len(only))
            args = list(only)
        return [dict(r) for r in c.execute(q + ' ORDER BY i.created_at', args)]
    finally:
        c.close()


def _history_line(data: Path, line: dict):
    d = data / 'history'
    d.mkdir(exist_ok=True)
    with open(d / 'chords-retidy.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps(line, ensure_ascii=False) + '\n')


def _keep(folder: Path, name: str, stamp: str):
    h = folder / '.history'
    h.mkdir(exist_ok=True)
    shutil.copy2(folder / name, h / f'chords-{stamp}-{name}')


def _write(path: Path, data: bytes):
    tmp = path.with_name(path.name + '.chords-tmp')
    tmp.write_bytes(data)
    tmp.replace(path)


def tidy(data: Path, *, dry_run=True, only=None, pdf=True, log=print):
    """Tidy every score's chords (or only the ids in `only`). Returns [Result]."""
    data = Path(data)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out = []
    for row in score_rows(data, only):
        res = Result(row['id'], row['title'], 'unchanged')
        out.append(res)
        why = skip_reason(row)
        if why:
            res.status, res.why = 'skipped', why
            continue
        folder = data / 'items' / row['folder']
        names = [n for n in dict.fromkeys([row['musicxml'], row['musicxml_original']]) if n]
        try:
            todo = []
            for name in names:
                p = folder / name
                if not p.is_file():
                    if name == row['musicxml']: raise FileNotFoundError(f'{name} is missing')
                    continue
                before = p.read_bytes()
                r = rechord_xml(before)
                res.files.append((name, r.old, r.new))
                if r.xml != before: todo.append((p, r))
            if not todo: continue
            res.status = 'changed'
            if dry_run: continue
            for p, r in todo:
                _keep(folder, p.name, stamp)
                _write(p, r.xml)
                _history_line(data, {'id': row['id'], 'title': row['title'], 'file': p.name,
                                     'before_chords': [f'{b}:{n}' for b, n in r.old],
                                     'after_chords': [f'{b}:{n}' for b, n in r.new],
                                     'history': f'.history/chords-{stamp}-{p.name}', 'at': int(time.time() * 1000)})
            # the PDF shows the chord symbols too: draw it again (the old one is kept in .history)
            if pdf and row['pdf'] and (folder / row['pdf']).is_file():
                tmp = folder / (row['pdf'] + '.chords-tmp.pdf')
                if arrange.render_pdf(folder / row['musicxml'], tmp):
                    _keep(folder, row['pdf'], stamp)
                    tmp.replace(folder / row['pdf'])
                    _history_line(data, {'id': row['id'], 'title': row['title'], 'file': row['pdf'], 'redrawn': True,
                                         'history': f'.history/chords-{stamp}-{row["pdf"]}', 'at': int(time.time() * 1000)})
                else:
                    tmp.unlink(missing_ok=True)
                    log(f'  {row["title"]}: PDF not redrawn (MuseScore unavailable) — it still shows the old chords')
        except Exception as e:  # one broken file must not stop the others
            res.status, res.why = 'error', f'{type(e).__name__}: {e}'
    return out


def by_bar(chords, bars=16):
    """'1: A | 2: F#m | …' for the first `bars` bars (bars without a new symbol are left out)."""
    rows = {}
    for b, n in chords:
        if b <= bars: rows.setdefault(b, []).append(n)
    return ' | '.join(f'{b}: {" ".join(ns)}' for b, ns in sorted(rows.items())) or '(none)'


def report(results, bars=16, log=print):
    for r in results:
        if r.status == 'skipped':
            continue
        log(f'== {r.title} ({r.id}) — {r.status}{": " + r.why if r.why else ""}')
        for name, old, new in r.files:
            log(f'   {name}')
            log(f'     old: {by_bar(old, bars)}')
            log(f'     new: {by_bar(new, bars)}')
    skipped = [r for r in results if r.status == 'skipped']
    if skipped:
        log(f'\nSkipped {len(skipped)}:')
        for r in skipped: log(f'   {r.title} ({r.id}): {r.why}')
    counts = {s: sum(r.status == s for r in results) for s in ('changed', 'unchanged', 'skipped', 'error')}
    log('\n' + ', '.join(f'{v} {k}' for k, v in counts.items()))
