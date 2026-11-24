"""A new song's info from the user's own library: every add path (Add music, the photo / audio / score jobs,
From Photos, book and page splits, editor copies) calls fill_from_library before the item is written.

  python -m meowsic.autofill --data ~/Documents/Meowsic   # dry run on existing items, read-only (nothing is written)

Rules (only on this Mac, no network):
  match    existing, non-deleted, non-book items whose title is the same once case, accents, punctuation and any
           "(Les Misérables)" / "- Aladdin" part are left out. When the title names an album ("(Cinderella)", a
           known one or one already in the library), items filed under another album are a different song.
  artist   the most common non-empty artist among the matches (never "Meowsic": a score Meowsic made keeps the
           song's real artist; "Made by Meowsic" is drawn on the score), else metafill_known.json.
  album    the album named in the title, else the most common album among the matches, else metafill_known.json.
  version  never copied from other items (another copy of a song is often another arrangement): each path sets
           its own (a score made from a sheet: Original; Simple piano: Simple Piano; a job's Lead / Piano …).
  key      never: the new copy may be in another key. It stays what the add path found, or empty.
  never    a value already set (by the user or the add path) is not changed.
Logged as one Activities row ('autofill', "Info from your library"), "Info filled from your library: artist, album";
undo puts the fields back to empty (the item stays)."""
import argparse
import re
import sqlite3
from collections import Counter
from functools import lru_cache
from pathlib import Path

from .db import NOT_ARTIST
from .metafill import KNOWN_FILE, fold, known_song, load_known, title_parts
from .undolog import fields_step, record_undo

GENERIC = {'', 'untitled', 'new song', 'song'}
DASH = re.compile(r'\s[-–—:]\s')


@lru_cache(maxsize=1)
def _known(path=str(KNOWN_FILE)):
    try: return load_known(path)
    except (OSError, ValueError): return {'songs': {}, 'albums': {}, 'albums_by_tag': {}}


def not_artist(a) -> bool:
    a = ' '.join(str(a or '').split())
    return not a or a in NOT_ARTIST or bool(re.fullmatch(r'(?:made|transcribed|arranged|read) by meowsic', a, re.I))


def _alb(s) -> str:
    return fold(s).removeprefix('the ')


def core(title: str, albums=()) -> str:
    """'Let It Go (Frozen) - Piano' -> 'let it go'; 'Aladdin - A Whole New World' -> 'a whole new world' when
    Aladdin is an album. `albums`: folded album names (no leading 'the ')."""
    t = re.sub(r'\s*[\(\[][^)\]]*[\)\]]', ' ', title or '').strip() or (title or '')
    parts = DASH.split(t, maxsplit=1)
    head = parts[0]
    if len(parts) == 2 and _alb(head) in albums and _alb(parts[1]) not in albums: head = parts[1]
    return fold(head)


def album_hint(title: str, albums: dict):
    """An album named in the title ('(Les Misérables)', ' - Titanic', 'OST Mắt Biếc'), when it is a known one or
    one in the library. albums: folded name -> spelling."""
    _, tails = title_parts(title)
    t = re.sub(r'\s*[\(\[][^)\]]*[\)\]]', ' ', title or '')
    parts = DASH.split(t, maxsplit=1)
    if len(parts) == 2: tails = [*tails, parts[0]]  # 'Aladdin - A Whole New World'
    for x in tails:
        a = albums.get(_alb(x))
        if a: return a
    return None


def _library(c, exclude=()):
    rows = c.execute("""SELECT i.id, i.kind, i.title, i.artist, i.album, i.updated_at, COALESCE(s.book, 0) AS book
                        FROM item i LEFT JOIN sheet s ON s.item_id = i.id WHERE i.deleted_at IS NULL
                        ORDER BY i.updated_at DESC""").fetchall()
    return [dict(r) for r in rows if r['id'] not in exclude and not r['book']]


def _albums(lib, known):
    out = dict(known.get('albums') or {})
    for r in lib:
        a = ' '.join((r['album'] or '').split())
        if a: out.setdefault(_alb(a), a)
    return out


def _most(values):
    """Most common value (case / accents ignored); a tie goes to the most recently changed item (lib is newest first)."""
    vals = [' '.join(str(v or '').split()) for v in values]
    vals = [v for v in vals if v]
    if not vals: return None
    n = Counter(fold(v) for v in vals)
    best = max(n.values())
    return next(v for v in vals if n[fold(v)] == best)


def propose(it: dict, lib: list, known=None) -> dict:
    """{field: value} to fill on `it` (a dict in the item JSON shape) from `lib` (_library rows, `it` not in it)."""
    known = known if known is not None else _known()
    if it.get('book'): return {}
    title = str(it.get('title') or '')
    albums = _albums(lib, known)
    me = core(title, albums)
    if me in GENERIC or len(me) < 2: return {}
    hint = album_hint(title, albums)
    matches = [r for r in lib if core(r['title'], albums) == me]
    if hint: matches = [r for r in matches if not (r['album'] or '').strip() or _alb(r['album']) == _alb(hint)]
    out = {}
    cur_artist = '' if not_artist(it.get('artist')) else it['artist']
    if not cur_artist:
        a = _most(r['artist'] for r in matches if not not_artist(r['artist']))
        if not a:
            s = known_song(known, {**it, 'artist': '', 'tags': it.get('tags') or []})
            a = (s or {}).get('artist')
        if a: out['artist'] = a
    if not ' '.join(str(it.get('album') or '').split()):
        a = hint or _most(r['album'] for r in matches)
        if not a:
            s = known_song(known, {**it, 'artist': out.get('artist') or cur_artist, 'tags': it.get('tags') or []})
            a = (s or {}).get('album')
        if a: out['album'] = a
    return out


def fill_from_library(c, it: dict, *, exclude=()) -> dict:
    """Fill the empty Artist / Album of a new item, in place, before it is written.
    Never the key, never a value already set. Returns {field: value} filled (empty when nothing was)."""
    try:
        new = propose(it, _library(c, {it.get('id'), *exclude}))
    except sqlite3.Error:
        return {}
    it.update(new)  # propose only fills empty fields ('Meowsic' as an artist counts as empty)
    return new


def describe(fills) -> str:
    """'Info filled from your library: artist, album'."""
    ks = [k for k in ('artist', 'album') if any(k in f for _, f in fills)]
    return 'Info filled from your library: ' + ', '.join(ks) if ks else ''


def log_fill(c, fills, ctx=None):
    """fills: [(item, {field: value})]. One Activities row (undo = those fields back to empty) and, for a job,
    a line in its log. Returns the activity id (or None when nothing was filled)."""
    fills = [(it, f) for it, f in fills if f]
    if not fills: return None
    msg = describe(fills)
    steps = [s for it, f in fills if (s := fields_step({'id': it['id'], 'title': it.get('title') or '', **{k: '' for k in f}}, f))]
    titles = list(dict.fromkeys(it.get('title') or '' for it, _ in fills))
    title = titles[0] if len(titles) == 1 else f'{len(fills)} items'
    detail = msg + ' — ' + '; '.join(f'{k} “{v}”' for k, v in fills[0][1].items()) if len(fills) == 1 else msg
    aid = record_undo(c, 'autofill', steps, title, detail)
    if ctx is not None:
        try: ctx.update(msg=msg)
        except Exception: pass  # a cancelled job: the item is saved already
    return aid


def recredit(xml: str, artist: str) -> str:
    """A copied score whose Artist was just filled: composer = that artist, the arranger credit it had stays."""
    from .db import credit_xml
    m = re.search(r'<creator\b[^>]*type="arranger"[^>]*>([\s\S]*?)</creator>', xml)
    by = m[1].strip().replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&') if m else ''
    return credit_xml(xml, artist, by)


# ---------- dry run on the existing library (read-only) ----------

def dry_run(c, known=None):
    lib_all = _library(c)
    out = []
    for r in lib_all:
        if r['artist'].strip() and r['album'].strip(): continue
        lib = [x for x in lib_all if x['id'] != r['id']]
        tags = [t[0] for t in c.execute('SELECT tag FROM item_tag WHERE item_id=?', (r['id'],))]
        f = {k: v for k, v in propose({**r, 'tags': tags}, lib, known).items() if k in ('artist', 'album')}
        if f: out.append((r, f))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='Dry run: which existing items would get Artist / Album from the library')
    ap.add_argument('--data', default=str(Path.home() / 'Documents' / 'Meowsic'))
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args(argv)
    db = Path(a.data).expanduser() / 'meowsic.db'
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    try:
        res = dry_run(c)
        empty = c.execute("""SELECT COUNT(*) FROM item i LEFT JOIN sheet s ON s.item_id=i.id WHERE i.deleted_at IS NULL
                             AND COALESCE(s.book,0)=0 AND (TRIM(i.artist)='' OR TRIM(i.album)='')""").fetchone()[0]
    finally:
        c.close()
    na = sum('artist' in f for _, f in res)
    nb = sum('album' in f for _, f in res)
    print(f'{empty} items with an empty artist or album; {len(res)} fillable ({na} artist, {nb} album)')
    if a.verbose:
        for r, f in res: print(f'  {r["kind"]:6} {r["title"]!r}: ' + ', '.join(f'{k}={v!r}' for k, v in f.items()))


if __name__ == '__main__':
    main()
