#!/usr/bin/env python3
"""Read and close Meowsic feedback (Developer page) — for Claude.

Usage:
  feedback.py [list] [--all] [--json]          open feedback (New + In progress), oldest first; --all: every status
  feedback.py show <id> [--json]               one note with its history
  feedback.py set <id> <status> [--note "…"]   status: new | in_progress (progress) | fixed | wontfix
Common: --server https://localhost:5180 (HTTPS checked against ~/Documents/Meowsic/certs/meowsic-ca.pem).

Talks to the running Meowsic server's /api/feedback (the server keeps the history and the rules: Fixed / Won't fix
lock a note against the user's edits and removal). Only local hosts are ever contacted (exit 4 otherwise).
Exit 0 ok, 2 bad arguments, 5 server error / not reachable.
"""
import argparse
import ipaddress
import json
import socket
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlparse

CA = Path.home() / 'Documents' / 'Meowsic' / 'certs' / 'meowsic-ca.pem'
ALIASES = {'progress': 'in_progress', 'in-progress': 'in_progress', 'inprogress': 'in_progress', 'done': 'fixed',
           'wont-fix': 'wontfix', "won't-fix": 'wontfix', 'won’t-fix': 'wontfix'}
STATUSES = ('new', 'in_progress', 'fixed', 'wontfix')
LABEL = {'new': 'New', 'in_progress': 'In progress', 'fixed': 'Fixed', 'wontfix': "Won't fix"}


def is_local(host: str) -> bool:
    if not host: return False
    if host == 'localhost' or host.endswith('.local'): return True
    try: addrs = {ai[4][0] for ai in socket.getaddrinfo(host, None)}
    except socket.gaierror: return False
    def ok(a):
        ip = ipaddress.ip_address(a.split('%')[0])
        return ip.is_loopback or ip.is_private or ip.is_link_local
    return bool(addrs) and all(ok(a) for a in addrs)


class Api:
    def __init__(self, server):
        u = urlparse(server.rstrip('/'))
        if u.scheme not in ('http', 'https') or not is_local(u.hostname or ''):
            print(f'error: {server} is not a local Meowsic server; refusing to send anything', file=sys.stderr)
            sys.exit(4)
        self.base = f'{u.scheme}://{u.netloc}/api/feedback'
        self.ctx = None
        if u.scheme == 'https':
            self.ctx = ssl.create_default_context(cafile=str(CA)) if CA.exists() else ssl.create_default_context()

    def __call__(self, method, path='', body=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=20) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            print(f'error: server said {e.code}: {e.read().decode(errors="replace")[:500]}', file=sys.stderr)
        except (urllib.error.URLError, OSError) as e:
            print(f'error: cannot reach the Meowsic server at {self.base}: {e}', file=sys.stderr)
        sys.exit(5)


def when(ms): return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M') if ms else ''


def text_of(f):
    head = f"[{f['id']}] {when(f['createdAt'])}  {LABEL.get(f['status'], f['status'])}" + (f"  ({f['device']})" if f.get('device') else '')
    body = '\n'.join('    ' + l for l in f['text'].splitlines())
    about = ''
    it, ctx = f.get('item'), f.get('context') or {}
    if it: about += f"\n    about: {it.get('title') or '?'} ({it.get('kind') or 'item'} {it.get('id')})"
    if ctx: about += '\n    context: ' + ', '.join(f'{k}={v}' for k, v in ctx.items())
    note = f"\n    → {f['fixNote']}" if f.get('fixNote') else ''
    return f'{head}{about}\n{body}{note}'


def main():
    ap = argparse.ArgumentParser(description='Meowsic feedback for Claude: list open notes, set status + fix note.')
    ap.add_argument('cmd', nargs='?', default='list', choices=('list', 'show', 'set'))
    ap.add_argument('id', nargs='?')
    ap.add_argument('status', nargs='?')
    ap.add_argument('--note', help='fix note (what was done / why not)')
    ap.add_argument('--all', action='store_true', help='list: every status, not just open ones')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--server', default='https://localhost:5180')
    a = ap.parse_args()
    api = Api(a.server)

    if a.cmd == 'list':
        rows = api('GET')
        if not a.all: rows = [r for r in rows if r['status'] in ('new', 'in_progress')]
        rows.sort(key=lambda r: r['createdAt'])  # oldest first: work order
        if a.json: print(json.dumps(rows, ensure_ascii=False, indent=1))
        else: print('\n\n'.join(text_of(r) for r in rows) if rows else 'No open feedback.')
        return 0
    if not a.id:
        print(f'error: {a.cmd} needs a feedback id', file=sys.stderr); return 2
    if a.cmd == 'show':
        f = api('GET', '/' + quote(a.id))
        if a.json: print(json.dumps(f, ensure_ascii=False, indent=1)); return 0
        print(text_of(f))
        for h in f.get('history', []):
            print(f"    · {when(h['at'])} before {h['change']}: {LABEL.get(h['status'], h['status'])} — {h['text'][:200]!r}")
        return 0
    st = ALIASES.get((a.status or '').lower(), (a.status or '').lower())
    if st not in STATUSES:
        print(f'error: status must be one of {", ".join(STATUSES)}', file=sys.stderr); return 2
    body = {'status': st}
    if a.note is not None: body['fixNote'] = a.note
    f = api('PATCH', '/' + quote(a.id), body)
    print(json.dumps(f, ensure_ascii=False, indent=1) if a.json else text_of(f))
    return 0


if __name__ == '__main__':
    sys.exit(main())
