#!/usr/bin/env python3
"""Make a Meowsic score sing (beta): its melody + English lyrics sung offline by SoulX-Singer over a soft piano.

Usage:
  scripts/sing.py "Amazing Grace"         # a score title (or an item id like m-iz2tgli)
                  [--server https://localhost:5180] [--direct] [--repo DIR (default: this checkout)]
                  [--data ~/Documents/Meowsic] [--seed 0]

1. Finds the score on the Meowsic server (GET /api/items; HTTPS checked against ~/Documents/Meowsic/certs/meowsic-ca.pem;
   only local hosts are contacted). Prefers the original AI lead sheet when several scores share the title.
2. Asks the server to sing it (POST /api/items/<id>/sing, the "Make it sing (beta)" job) and prints its progress.
3. --direct, or a server without that endpoint (older code): runs <repo>/sing/sing.py itself in SoulX-Singer's venv
   (~/ai/SoulX-Singer/.venv; weights ~/ai/models/SoulX-Singer/model.pt), then writes
   items/<folder>/<folder> vocal.m4a + .wav and sets score.vocal_audio / vocal_bpm for that one score
   (adding those two columns if the database doesn't have them yet — the server adds them the same way).
Prints the objective checks (duration, % of notes within 50 cents by pitch tracking, silent notes).
"""
import argparse
import ipaddress
import json
import os
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

HOME = Path.home()
CA = HOME / 'Documents/Meowsic/certs/meowsic-ca.pem'
SOULX_PY = HOME / 'ai/SoulX-Singer/.venv/bin/python'


def local_only(url):
    h = urlparse(url).hostname or ''
    if h == 'localhost' or h.endswith('.local'): return
    try:
        if all(ipaddress.ip_address(a[4][0]).is_private or ipaddress.ip_address(a[4][0]).is_loopback for a in socket.getaddrinfo(h, None)): return
    except (OSError, ValueError): pass
    sys.exit(f'refusing to contact a non-local server: {h}')


def call(server, method, path, body=None):
    ctx = ssl.create_default_context(cafile=str(CA)) if server.startswith('https') and CA.exists() else None
    req = urllib.request.Request(server.rstrip('/') + '/api' + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return json.loads(r.read() or b'null')


def find(server, what):
    items = [x for x in call(server, 'GET', '/items?kind=score') if not x.get('deleted')]
    hit = [x for x in items if x['id'] == what] or [x for x in items if x['title'].casefold() == what.casefold()]
    if not hit: sys.exit(f'no score called {what!r}')
    hit.sort(key=lambda x: (not x.get('ai'), x.get('version') != 'original', -x['updatedAt']))
    return hit[0]


def via_server(server, it):
    try: job = call(server, 'POST', f'/items/{quote(it["id"])}/sing')
    except urllib.error.HTTPError as e:
        if e.code in (404, 405): return None  # an older server: sing it here instead
        sys.exit(f'server said {e.code}: {e.read().decode()[:300]}')
    seen = 0
    while True:
        time.sleep(2)
        j = call(server, 'GET', f'/jobs/{job["id"]}')
        for x in j['log'][seen:]: print('  ', x['msg'])
        seen = len(j['log'])
        if j['status'] in ('done', 'failed', 'cancelled'):
            if j['status'] != 'done': sys.exit(f'job {j["status"]}')
            return call(server, 'GET', f'/items/{quote(it["id"])}')


def direct(it, repo, data, seed):
    xml = data / 'items' / it['folder'] / (it['musicxml'] or f'{it["folder"]}.musicxml')
    if not SOULX_PY.exists(): sys.exit(f'missing {SOULX_PY} (SoulX-Singer venv)')
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [str(SOULX_PY), str(repo / 'sing' / 'sing.py'), '--xml', str(xml), '--out', tmp, '--name', 'vocal', '--check', '--seed', str(seed)]
        if it.get('bpm'): cmd += ['--bpm', str(it['bpm'])]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=str(repo),
                             env={**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
        done = None
        for line in p.stdout:
            try: ev = json.loads(line)
            except ValueError: continue
            if ev.get('done'): done = ev
            elif ev.get('msg'): print('  ', ev['msg'])
        if p.wait() or not done: sys.exit(f'sing.py failed (exit {p.returncode})')
        d = data / 'items' / it['folder']
        name = f'{it["folder"]} vocal.m4a'
        shutil.copyfile(done['m4a'], d / name)
        shutil.copyfile(done['wav'], d / f'{it["folder"]} vocal.wav')
    db = sqlite3.connect(data / 'meowsic.db', timeout=30)
    cols = [r[1] for r in db.execute('PRAGMA table_info(score)')]
    for col, typ in (('vocal_audio', 'TEXT'), ('vocal_bpm', 'REAL')):
        if col not in cols: db.execute(f'ALTER TABLE score ADD COLUMN {col} {typ}')
    db.execute('UPDATE score SET vocal_audio=?, vocal_bpm=? WHERE item_id=?', (name, done['bpm'], it['id']))
    db.commit(); db.close()
    return {**it, 'vocalAudio': name, 'vocalBpm': done['bpm'], 'report': done.get('report')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('score')
    ap.add_argument('--server', default='https://localhost:5180')
    ap.add_argument('--direct', action='store_true')
    ap.add_argument('--repo', default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument('--data', default=os.environ.get('MEOWSIC_DATA', str(HOME / 'Documents/Meowsic')))
    ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    local_only(a.server)
    it = find(a.server, a.score)
    print(f'{it["title"]} ({it["id"]}, {it.get("bpm") or "?"} bpm)')
    out = None if a.direct else via_server(a.server, it)
    if out is None: out = direct(it, Path(a.repo).expanduser(), Path(a.data).expanduser(), a.seed)
    print('vocal:', Path(a.data).expanduser() / 'items' / it['folder'] / out['vocalAudio'], f'(sung at {out["vocalBpm"]:g} bpm)')
    if out.get('report'): print(json.dumps(out['report'], indent=1))
    print(f'open: {a.server.rstrip("/")}/#/item/{it["id"]}  → Play (Voice on)')


if __name__ == '__main__':
    main()
