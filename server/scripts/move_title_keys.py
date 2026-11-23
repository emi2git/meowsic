"""Move keys out of sheet titles into the key field: "A Little Bit Of You (F)" -> "A Little Bit Of You", key F.

  .venv/bin/python scripts/move_title_keys.py --dry-run                              # list what would change
  .venv/bin/python scripts/move_title_keys.py                                        # do it
  .venv/bin/python scripts/move_title_keys.py --undo history/title-keys-<ts>.jsonl [--dry-run]

Only a key at the END of the title: "(X)", "[X]", " - X", " – X" with X = A–G, #/b/♯/♭, m/min/maj/minor/major
(C, Am, F#m, Bb, Eb major). "(Easy Piano)", "(OST)", "(Book 2)" stay. Sheets that already have another key are
listed and skipped. Running it again changes nothing. --data defaults to $MEOWSIC_DATA or ~/Documents/Meowsic.
Changes go to <data>/history/title-keys-<ts>.jsonl (before / after title + key). The code is meowsic/titlekeys.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meowsic import titlekeys  # noqa: E402
from meowsic.db import Config  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', help='Meowsic data folder')
    p.add_argument('--dry-run', action='store_true', help='change nothing; list what would change')
    p.add_argument('--undo', metavar='LOG', help='put back the changes in this history/title-keys-<ts>.jsonl')
    a = p.parse_args(argv)
    data = Config.from_env(a.data).data
    if not (data / 'meowsic.db').is_file():
        print(f'No meowsic.db in {data}', file=sys.stderr)
        return 1
    print(('DRY RUN — nothing is written. ' if a.dry_run else '') + f'Data: {data}')
    if a.undo:
        log = Path(a.undo)
        if not log.is_absolute() and not log.is_file(): log = data / log
        r = titlekeys.undo(data, log, dry_run=a.dry_run)
        for ch in r['back']: print(f"  {ch['id']}  {ch['after']['title']!r} [{ch['after']['key']}]  ->  {ch['before']['title']!r}")
        print(f"{'Would put back' if a.dry_run else 'Put back'} {len(r['back'])}; skipped {len(r['skipped'])} (changed since).")
        return 0
    r = titlekeys.run(data, dry_run=a.dry_run)
    w = max([len(ch['before']['title']) for ch in r['changes']] or [0])
    for ch in r['changes']:
        print(f"  {ch['id']}  {ch['before']['title']:<{w}}  ->  {ch['after']['title']}   key {ch['after']['key']}")
    for ch in r['skipped']:
        print(f"  SKIP {ch['id']}  {ch['before']['title']}  ({ch['skip']})")
    print(f"{'Would move' if a.dry_run else 'Moved'} {len(r['changes'])} key(s) out of titles; {len(r['skipped'])} skipped."
          + (f" Log: {r['log']}" if r['log'] else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
