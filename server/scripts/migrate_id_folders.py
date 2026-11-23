"""Rename old item folders '<id> <title>' to items/<id>/ and their title-named files to '<id> <n>.jpg',
'<id>.musicxml'… (one time; keeps all history). Books (items/Books/<name>/) are not touched.

  .venv/bin/python scripts/migrate_id_folders.py --dry-run                    # what would move, nothing written
  .venv/bin/python scripts/migrate_id_folders.py                              # do it (db backed up first)
  .venv/bin/python scripts/migrate_id_folders.py --only s-k3j9x2a             # just one item (repeatable)
  .venv/bin/python scripts/migrate_id_folders.py --undo history/folders-<ts>.jsonl [--dry-run]

--data defaults to $MEOWSIC_DATA or ~/Documents/Meowsic. Best run with the server stopped (or at least idle).
Every move goes to <data>/history/folders-<ts>.jsonl; the db is copied to backups/meowsic-before-id-folders-<ts>.db.
Running it again skips items already moved; --undo skips items already back. The code lives in meowsic/idfolders.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meowsic import idfolders  # noqa: E402
from meowsic.db import Config  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', help='Meowsic data folder')
    p.add_argument('--dry-run', action='store_true', help='change nothing; say what would move')
    p.add_argument('--only', action='append', default=[], help='item id (repeatable)')
    p.add_argument('--undo', metavar='LOG', help='put back the moves in this history/folders-<ts>.jsonl')
    p.add_argument('--no-backup', action='store_true', help='do not copy the db to backups/ first')
    a = p.parse_args(argv)
    data = Config.from_env(a.data).data
    if not (data / 'meowsic.db').is_file():
        print(f'No meowsic.db in {data}', file=sys.stderr)
        return 1
    print(('DRY RUN — nothing is written. ' if a.dry_run else '') + f'Data: {data}')
    if a.undo:
        log = Path(a.undo)
        if not log.is_absolute() and not log.is_file(): log = data / log
        r = idfolders.undo(data, log, dry_run=a.dry_run)
        print(f"{'Would put back' if a.dry_run else 'Put back'} {r['items']} folder(s), {r['files']} file(s); skipped {r['skipped']}."
              + (f" Log: {r['log']}" if r['log'] else ''))
        return 0
    r = idfolders.migrate(data, dry_run=a.dry_run, only=set(a.only) or None, backup=not a.no_backup)
    print(f"{'Would move' if a.dry_run else 'Moved'} {r.get('moved', r['items'])} folder(s): {r['files']} file(s) renamed "
          f"({r['pages']} page rows, {r['score_files']} score file columns); skipped {r['skipped']}; "
          f"{r['missing']} file(s) the db names were already missing." + (f" Log: {r['log']}" if r['log'] else ''))
    if r.get('failed'): print(f"FAILED (left as they were): {', '.join(r['failed'])}")
    return 1 if r.get('failed') else 0


if __name__ == '__main__':
    sys.exit(main())
