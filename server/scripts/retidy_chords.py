"""Tidy the chord symbols of existing scores with the new chord finder (one time; keeps all history).

  .venv/bin/python scripts/retidy_chords.py --dry-run              # what would change, first 16 bars
  .venv/bin/python scripts/retidy_chords.py --only m-7kynu6y       # just one score (repeatable)
  .venv/bin/python scripts/retidy_chords.py                        # do it
  .venv/bin/python scripts/retidy_chords.py --file x.musicxml      # dry run on loose files, no database

--data defaults to $MEOWSIC_DATA or ~/Documents/Meowsic. The code lives in meowsic/chordtidy.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meowsic import chordtidy  # noqa: E402
from meowsic.chordfind import rechord_xml  # noqa: E402
from meowsic.db import Config  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', help='Meowsic data folder')
    p.add_argument('--dry-run', action='store_true', help='change nothing; print old vs new chords')
    p.add_argument('--only', action='append', default=[], help='score item id (repeatable)')
    p.add_argument('--bars', type=int, default=16, help='bars to show per score (default 16)')
    p.add_argument('--no-pdf', action='store_true', help='do not redraw PDFs')
    p.add_argument('--file', action='append', default=[], help='dry run on a MusicXML file outside the library')
    a = p.parse_args(argv)
    if a.file:
        for f in a.file:
            r = rechord_xml(Path(f).read_bytes())
            print(f'== {f}\n     old: {chordtidy.by_bar(r.old, a.bars)}\n     new: {chordtidy.by_bar(r.new, a.bars)}')
        return 0
    data = Config.from_env(a.data).data
    if not (data / 'meowsic.db').is_file():
        print(f'No meowsic.db in {data}', file=sys.stderr)
        return 1
    print(('DRY RUN — nothing is written. ' if a.dry_run else '') + f'Data: {data}\n')
    res = chordtidy.tidy(data, dry_run=a.dry_run, only=a.only or None, pdf=not a.no_pdf)
    chordtidy.report(res, a.bars)
    if not a.dry_run and any(r.status == 'changed' for r in res):
        print(f'History: {data / "history" / "chords-retidy.jsonl"} and items/<folder>/.history/chords-*')
    return 1 if any(r.status == 'error' for r in res) else 0


if __name__ == '__main__':
    sys.exit(main())
