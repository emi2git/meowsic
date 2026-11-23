"""Fill in sheet versions once (Lead / Duet) from titles and tags; blanks stay blank.

  .venv/bin/python scripts/fill_sheet_versions.py --dry-run     # what would change, nothing written
  .venv/bin/python scripts/fill_sheet_versions.py               # do it (db backed up first)

Duet = title or tag says duet / 4 hands / piano duet / primo / secondo; Lead = tag "Super Easy" or "Lead sheet".
Only sheets with no version yet are touched (running it again does nothing); books are left alone.
--data defaults to $MEOWSIC_DATA or ~/Documents/Meowsic. Changes go to <data>/history/versions-<ts>.jsonl
(before / after); the db is copied to backups/meowsic-before-versions-<ts>.db. The code is meowsic/versions.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meowsic import versions  # noqa: E402
from meowsic.db import Config  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', help='Meowsic data folder')
    p.add_argument('--dry-run', action='store_true', help='change nothing; list what would change')
    p.add_argument('--no-backup', action='store_true', help='do not copy the db to backups/ first')
    a = p.parse_args(argv)
    data = Config.from_env(a.data).data
    if not (data / 'meowsic.db').is_file():
        print(f'No meowsic.db in {data}', file=sys.stderr)
        return 1
    print(('DRY RUN — nothing is written. ' if a.dry_run else '') + f'Data: {data}')
    r = versions.fill(data, dry_run=a.dry_run, backup=not a.no_backup)
    for ch in r['changes']:
        print(f"  {ch['after'].title():5}  {ch['id']}  {ch['title']}  [{', '.join(ch['tags'])}]")
    n = r['counts']
    print(f"{'Would set' if a.dry_run else 'Set'} {n['duet']} Duet, {n['lead']} Lead; {n['blank']} left blank, "
          f"{n['kept']} already had a version, {n['books']} books skipped." + (f" Log: {r['log']}" if r['log'] else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
