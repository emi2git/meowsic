"""Tidy existing scores once (Edit notes does this on every edit): time signatures, keys, clefs, divisions and
staves that only repeat the ones in force go, and so do the <attributes> left empty. Real changes stay; notes
are not touched. Never runs by itself.

  .venv/bin/python scripts/tidy_scores.py --dry-run              # count only, nothing is written
  .venv/bin/python scripts/tidy_scores.py --only m-7kynu6y       # just one score (repeatable)
  .venv/bin/python scripts/tidy_scores.py                        # do it (the file before: items/<folder>/.history/tidy-*)
  .venv/bin/python scripts/tidy_scores.py --file x.musicxml      # dry run on loose files, no database

--data defaults to $MEOWSIC_DATA or ~/Documents/Meowsic. The code lives in meowsic/barnorm.py (tidy_score). The
database is only read; restart nothing — the server reads the files when a score opens.
"""
import argparse
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meowsic.barnorm import tidy_text  # noqa: E402
from meowsic.chordtidy import score_rows  # noqa: E402
from meowsic.db import Config  # noqa: E402

KINDS = ('time', 'key', 'clef', 'other', 'attributes')


def line(st):
    return ', '.join(f'{st[k]} {k}' for k in KINDS if st[k]) + (f'; over-full bars {[n for _, n in st["overfull"]]}' if st['overfull'] else '')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', help='Meowsic data folder')
    p.add_argument('--dry-run', action='store_true', help='change nothing; count what would go')
    p.add_argument('--only', action='append', default=[], help='score item id (repeatable)')
    p.add_argument('--file', action='append', default=[], help='dry run on a MusicXML file outside the library')
    p.add_argument('-v', '--verbose', action='store_true', help='one line per score')
    a = p.parse_args(argv)
    if a.file:
        for f in a.file:
            _, st = tidy_text(Path(f).read_text(encoding='utf-8'))
            print(f'{f}: {line(st) or "nothing to tidy"}')
        return 0
    data = Config.from_env(a.data).data
    if not (data / 'meowsic.db').is_file():
        print(f'No meowsic.db in {data}', file=sys.stderr)
        return 1
    print(('DRY RUN — nothing is written. ' if a.dry_run else '') + f'Data: {data}')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    n = todo = errs = 0
    total = dict.fromkeys(KINDS, 0)
    by = dict.fromkeys(('time', 'key', 'clef'), 0)
    over = 0
    for row in score_rows(data, a.only or None):
        if row['deleted_at'] or not row['musicxml'] or not row['folder']: continue
        path = data / 'items' / row['folder'] / row['musicxml']
        if not path.is_file(): continue
        n += 1
        try:
            text = path.read_text(encoding='utf-8')
            out, st = tidy_text(text)
        except Exception as e:  # a broken file: say so, go on
            errs += 1; print(f'  ! {row["id"]} {row["title"]}: {e}'); continue
        over += bool(st['overfull'])
        for k in KINDS: total[k] += st[k]
        for k in by: by[k] += bool(st[k])
        if out == text: continue
        todo += 1
        if a.verbose or a.only: print(f'  {row["id"]} {row["title"]}: {line(st)}')
        if a.dry_run: continue
        h = path.parent / '.history'
        h.mkdir(exist_ok=True)
        shutil.copy2(path, h / f'tidy-{stamp}-{path.name}')
        tmp = path.with_name(path.name + '.tidy-tmp')
        tmp.write_text(out, encoding='utf-8')
        tmp.replace(path)
    print(f'{n} scores; {todo} with repeats to tidy ({by["time"]} with a repeated time signature, {by["key"]} a repeated key, '
          f'{by["clef"]} a repeated clef). Repeats: {", ".join(f"{total[k]} {k}" for k in KINDS)}. '
          f'{over} scores have an over-full bar (reported only).' + (f' {errs} could not be read.' if errs else ''))
    return 1 if errs else 0


if __name__ == '__main__':
    sys.exit(main())
