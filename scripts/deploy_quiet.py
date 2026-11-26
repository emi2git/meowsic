#!/usr/bin/env python3
"""Is the live app quiet enough to deploy? (scripts/deploy runs this before it changes anything users would see.)

  deploy_quiet.py <data folder> [--self IP ...] [--dry-run]
      exit 0 = quiet, 1 = not now (the reasons on stderr), 2 = could not check (fail closed: no deploy)
      --dry-run: only report (one line on stdout: "quiet" or "not quiet: ..." or "cannot check: ..."), exit 0

A deploy is held back while someone could lose work or get an app reload in their face:
  1. an edit session is active on any item (Edit notes open, a heartbeat in the last 2 min) — any client at all;
  2. a user device made a request in the last 5 minutes (QUIET_S), background polls aside (BACKGROUND);
  3. a user device made an API write (POST / PUT / PATCH / DELETE /api/…) in the last 2 minutes (WRITE_S).
User devices = every client except this Mac. This Mac (self_addresses) = loopback (127.0.0.0/8, ::1: agents,
scripts, curl, the deploy's own health checks), its non-tailnet interface addresses (ifconfig: the LAN IP), the
tailnet IPs of the node the Meowsic server listens on (`tailscale --socket=<Tailscale-Meowsic> ip`, meowsic-mac)
and the allowlist (--self, env MEOWSIC_SELF_IPS: comma / space separated). Other tailnet addresses on the Mac's
interfaces (e.g. Tailscale.app's own node, emis-macbook-air) are NOT this Mac: a browser on it reaches the app over
the tailnet like any device. Requests over Tailscale (tailscale serve → localhost) carry the device's own 100.x
address (proxy headers), so they count.
Activity comes from the access lines of <data>/work/server.log (uvicorn, local time); the sessions from
<data>/meowsic.db (read-only: mode=ro, else a normal connection with PRAGMA query_only).
Any error = fail closed: one line, no traceback, no deploy.
"""
import argparse
import ipaddress
import os
import re
import subprocess
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

QUIET_S = 5 * 60
WRITE_S = 2 * 60
SESSION_TTL_MS = 120_000  # = editsafe.TTL_MS
TAIL_BYTES = 4 << 20  # the last 4 MB of the log is plenty for 5 minutes
LINE = re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ \S+ uvicorn\.access (\[?[0-9a-fA-F.:]+?\]?):\d+ - "(\w+) (\S+)')
# requests an open app makes by itself, not a person doing something
BACKGROUND = re.compile(r'^(/api/health|/api/jobs|/sw\.js|/api/items/[^/]+/editsession(/end)?)(\?|$)')
WRITES = {'POST', 'PUT', 'PATCH', 'DELETE'}
TS_SOCKET = Path.home() / 'Library/Application Support/Tailscale-Meowsic/tailscaled.sock'  # the Meowsic node's tailscaled
TAILNET = (ipaddress.ip_network('100.64.0.0/10'), ipaddress.ip_network('fd7a:115c:a1e0::/48'))


class CheckError(Exception):
    """The check itself failed: refuse to deploy (fail closed)."""


def _addr(s):
    try: return ipaddress.ip_address(s.strip().strip('[]').split('%')[0])
    except ValueError: return None


def _run(cmd):
    try: return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError): return ''


def self_addresses(ifconfig=None, meowsic_ts=None, allow=()):
    """This Mac's own addresses: interface addresses outside the tailnet ranges, the Meowsic node's tailnet IPs
    (only those: the Mac may carry another node's 100.x too) and the allowlist. ifconfig / meowsic_ts = the text of
    `ifconfig` / `tailscale --socket=… ip` (None = run them)."""
    if ifconfig is None: ifconfig = _run(['/sbin/ifconfig'])
    if meowsic_ts is None:
        meowsic_ts = _run(['tailscale', f'--socket={TS_SOCKET}', 'ip']) if TS_SOCKET.exists() else ''
    own = set()
    for m in re.finditer(r'^\s*inet6?\s+(\S+)', ifconfig, re.M):
        a = _addr(m.group(1))
        if a and not any(a in n for n in TAILNET): own.add(str(a))
    for ln in meowsic_ts.split():
        a = _addr(ln)
        if a: own.add(str(a))
    for x in allow:
        for y in re.split(r'[,\s]+', x or ''):
            a = _addr(y) if y else None
            if a: own.add(str(a))
    return own


def is_local(ip, own):
    a = _addr(ip)
    if a is None: return False
    if a.version == 6 and a.ipv4_mapped: a = a.ipv4_mapped
    return a.is_loopback or str(a) in own


def activity(log, own, now):
    """(seconds since the last user-device request, seconds since its last API write, the client) or None."""
    if not log.exists(): return None, None, None
    with open(log, 'rb') as f:
        f.seek(0, 2); f.seek(max(0, f.tell() - TAIL_BYTES))
        lines = f.read().decode('utf-8', 'replace').splitlines()
    last_req = last_write = who = None
    for ln in lines:
        m = LINE.match(ln)
        if not m: continue
        ts, ip, method, path = m.groups()
        if is_local(ip, own): continue
        try: t = datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').timestamp()
        except ValueError: continue
        if method in WRITES and path.startswith('/api/'): last_write = t
        if not BACKGROUND.match(path): last_req, who = t, ip.strip('[]')
    age = lambda t: None if t is None else now - t
    return age(last_req), age(last_write), who


def _open(db):
    """Read-only: mode=ro first. That fails ("unable to open database file") when the WAL's -shm can't be made or
    mapped read-only; then a normal connection with PRAGMA query_only (it can't write either)."""
    try:
        c = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
        c.execute('SELECT 1 FROM sqlite_master LIMIT 1').fetchall()
        return c
    except sqlite3.Error:
        pass
    c = sqlite3.connect(str(db), timeout=5)
    c.execute('PRAGMA query_only = ON')
    return c


def sessions(db, now):
    if not db.exists(): return []
    try:
        c = _open(db)
    except sqlite3.Error as e:
        raise CheckError(f'cannot read {db.name} for edit sessions ({e})') from None
    try:
        if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_session'").fetchone():
            return []  # an old DB without the table
        return c.execute('SELECT item_id, beat_at FROM edit_session WHERE beat_at > ?', (int(now * 1000) - SESSION_TTL_MS,)).fetchall()
    except sqlite3.Error as e:
        raise CheckError(f'cannot read edit sessions from {db.name} ({e})') from None
    finally:
        c.close()


def check(data, own=(), now=None):
    """[] when quiet, else the reasons."""
    now = time.time() if now is None else now
    data = Path(data)
    why = []
    s = sessions(data / 'meowsic.db', now)
    if s: why.append(f'{len(s)} edit session(s) active (Edit notes open on {", ".join(sorted({r[0] for r in s}))}): wait until it is closed')
    req, wr, who = activity(data / 'work' / 'server.log', set(own), now)
    if req is not None and req < QUIET_S:
        why.append(f'a user device ({who}) was active {int(req)} s ago: wait {int(QUIET_S - req) + 1} s more (5 quiet minutes)')
    if wr is not None and wr < WRITE_S:
        why.append(f'a user device saved something {int(wr)} s ago: wait {int(WRITE_S - wr) + 1} s more (2 minutes after the last write)')
    return why


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('data')
    ap.add_argument('--self', dest='own', nargs='*', default=[], help="more of this Mac's own addresses (allowlist; also env MEOWSIC_SELF_IPS)")
    ap.add_argument('--dry-run', action='store_true', help='only report, always exit 0')
    a = ap.parse_args(argv)
    try:
        own = self_addresses(allow=[*a.own, os.environ.get('MEOWSIC_SELF_IPS', '')])
        why = check(a.data, own)
    except Exception as e:  # fail closed, one line, no traceback
        msg = str(e) if isinstance(e, CheckError) else f'{type(e).__name__}: {e}'
        if a.dry_run: print(f'cannot check (a real deploy would refuse): {msg}'); return 0
        print(f'deploy_quiet: cannot check, refusing to deploy: {msg}', file=sys.stderr); return 2
    if a.dry_run:
        print('quiet' if not why else 'not quiet: ' + '; '.join(why)); return 0
    for w in why: print(w, file=sys.stderr)
    return 1 if why else 0


if __name__ == '__main__':
    sys.exit(main())
