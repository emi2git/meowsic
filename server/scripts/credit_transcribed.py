"""One-off (Nov 2026): scores whose MusicXML still says "Read by Meowsic" -> "Transcribed by Meowsic", through the live
server's logged route POST /api/items/{id}/credit (one Activities row "Score credits updated", Undo for 24 h; the files
before go to items/<id>/.history/credit-*). Safe to run again: only scores that still say "Read by Meowsic" are touched.

Skipped (run again later): ids given with --skip, scores with an active edit session (GET …/editsession) and scores with
editnotes / preview / draft requests in server.log in the last 10 minutes. Prints ids and counts only (no titles, no lyrics).

  server/.venv/bin/python server/scripts/credit_transcribed.py [--dry-run] [--skip m-a,m-b] [--base https://localhost:5180]
"""
import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OLD = 'Read by Meowsic'
LOG = Path.home() / 'Documents' / 'Meowsic' / 'work' / 'server.log'
CTX = ssl._create_unverified_context()  # the live server's own self-signed cert


def call(base, method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r: return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')


def recently_edited(minutes=10):
    """Item ids with editnotes / preview / draft requests in server.log in the last `minutes`."""
    cut, ids = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - minutes * 60)), set()
    try: lines = LOG.read_text(errors='replace').splitlines()[-20000:]
    except OSError: return ids
    for ln in lines:
        if ln[:19] < cut: continue
        m = re.search(r'/api/items/([^/ ]+)/[^ "]*(?:editnotes|preview|draft)', ln)
        if m: ids.add(m[1])
    return ids


def main():
    ap = argparse.ArgumentParser(description='"Read by Meowsic" -> "Transcribed by Meowsic" on every stored score.')
    ap.add_argument('--base', default='https://localhost:5180')
    ap.add_argument('--skip', default='', help='comma-separated item ids to leave for later')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    base, skip = a.base.rstrip('/'), {s.strip() for s in a.skip.split(',') if s.strip()}
    items = []
    for q in ('false', 'true'):  # the library, then the Trash
        st, txt = call(base, 'GET', f'/api/items?kind=score&deleted={q}')
        if st != 200: sys.exit(f'GET /api/items: {st}')
        items += json.loads(txt)
    todo = []
    for it in items:
        if it.get('kind') != 'score': continue
        for q in ('', '?original=1'):
            if q and not it.get('musicxmlOriginal'): continue
            st, x = call(base, 'GET', f'/api/items/{it["id"]}/musicxml{q}')
            if st == 200 and OLD in x: todo.append(it['id']); break
    print(f'{len(todo)} score(s) say "{OLD}"')
    busy, done, later = recently_edited(), [], []
    for i in todo:
        st, s = call(base, 'GET', f'/api/items/{i}/editsession')
        why = 'asked to skip' if i in skip else 'edit session active' if st == 200 and json.loads(s).get('active') \
            else 'edited in the last 10 min' if i in busy else ''
        if why: later.append((i, why)); continue
        st, r = call(base, 'POST', f'/api/items/{i}/credit', {'dryRun': True} if a.dry_run else {})
        if st == 404 or st == 405: sys.exit('This server has no POST /api/items/{id}/credit yet: deploy first.')
        if st == 423: later.append((i, 'locked (423)')); continue
        if st != 200: later.append((i, f'HTTP {st}')); continue
        done.append((i, json.loads(r)))
    acts = sorted({r['activity'] for _, r in done if r.get('activity')})
    print(f'{"would update" if a.dry_run else "updated"}: {len(done)} score(s), '
          f'{sum(len(r["files"]) for _, r in done)} file(s); activity: {", ".join(acts) or "-"}')
    for i, why in later: print(f'later: {i} ({why})')


if __name__ == '__main__':
    main()
