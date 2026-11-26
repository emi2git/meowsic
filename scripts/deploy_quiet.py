#!/usr/bin/env python3
"""Is the live app quiet enough to deploy? (scripts/deploy runs this before it changes anything users would see.)

  deploy_quiet.py <data folder> [--self IP ...]     exit 0 = quiet, 1 = not now (the reasons on stderr)

A deploy is held back while someone could lose work or get an app reload in their face:
  1. an edit session is active on any item (Edit notes open, a heartbeat in the last 2 min) — any client at all;
  2. a user device made a request in the last 5 minutes (QUIET_S), background polls aside (BACKGROUND);
  3. a user device made an API write (POST / PUT / PATCH / DELETE /api/…) in the last 2 minutes (WRITE_S).
User devices = every client except this Mac: loopback (127.0.0.0/8, ::1: agents, scripts, curl, the deploy's own
health checks) and this Mac's own addresses (--self, e.g. its LAN IP) don't count for 2 and 3. Requests over
Tailscale (tailscale serve → localhost) carry the device's own 100.x address (proxy headers), so they count.
Activity comes from the access lines of <data>/work/server.log (uvicorn, local time); the sessions from
<data>/meowsic.db (read-only).
"""
import argparse
import ipaddress
import re
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


def is_local(ip, own):
    ip = ip.strip('[]')
    if ip in own: return True
    try: return ipaddress.ip_address(ip).is_loopback
    except ValueError: return False


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


def sessions(db, now):
    if not db.exists(): return []
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    try:
        return c.execute('SELECT item_id, beat_at FROM edit_session WHERE beat_at > ?', (int(now * 1000) - SESSION_TTL_MS,)).fetchall()
    except sqlite3.OperationalError:  # an old DB without the table
        return []
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('data')
    ap.add_argument('--self', dest='own', nargs='*', default=[], help="this Mac's own addresses (not user devices)")
    a = ap.parse_args()
    why = check(a.data, [x for x in a.own if x])
    for w in why: print(w, file=sys.stderr)
    return 1 if why else 0


if __name__ == '__main__':
    sys.exit(main())
