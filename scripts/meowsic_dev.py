"""Shared helpers for scripts/dev-server, test-smoke and test-all: free ports, temp test servers, the UI preview.

Test servers always get their own temp data folder and a port above 5300 (5180 is the live app, 5181 an old
preview habit, 5190-5300 are used by other agents' ad-hoc servers). Nothing here ever touches ~/Documents/Meowsic.
"""
import os
import random
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / 'server'
PY = SERVER / '.venv' / 'bin' / 'python'
LIVE = Path.home() / 'Documents' / 'Meowsic'


def free_port(lo=5301, hi=5999) -> int:
    """A port nothing listens on, picked at random so parallel runs rarely race for the same one."""
    ports = list(range(lo, hi))
    random.shuffle(ports)
    for p in ports:
        with socket.socket() as s:
            try: s.bind(('127.0.0.1', p))
            except OSError: continue
            return p
    raise RuntimeError('no free port')


def temp_data(tag='meowsic') -> Path:
    d = Path(tempfile.mkdtemp(prefix=f'{tag}-data-'))
    assert LIVE not in d.parents and d != LIVE
    return d


def guard(data=None, port=None):
    """Hard stop: a test / dev server never uses the live library (or anything inside it) or port 5180."""
    if port is not None and int(port) <= 5300: sys.exit(f'refusing port {port}: 5180 is the live app; test servers use ports above 5300')
    if data is not None:
        d, live = Path(data).expanduser().resolve(), LIVE.resolve()
        if d == live or live in d.parents: sys.exit(f'refusing to run a test server on the live library ({d})')


def live_pids() -> set[int]:
    """PIDs listening on the live port 5180: never signalled by any test / dev script."""
    r = subprocess.run(['lsof', '-tiTCP:5180', '-sTCP:LISTEN'], capture_output=True, text=True)
    return {int(x) for x in r.stdout.split() if x.isdigit()}


def kill_test_servers(data) -> None:
    """Stop test servers started on the temp data folder `data` (restart suites). Hard-guarded: refuses the live
    library or a folder outside the temp dir, and skips the live server and anything with --port 5180."""
    d = Path(data).expanduser().resolve()
    guard(d)
    tmp = Path(tempfile.gettempdir()).resolve()
    if tmp not in d.parents: sys.exit(f'refusing to kill servers on {d}: not a temp test folder')
    raw = str(Path(data).expanduser())  # as written on the command line (/var/... resolves to /private/var/...)
    r = subprocess.run(['pgrep', '-f', '-l', '--', f'-m meowsic .*--data {raw}'], capture_output=True, text=True)
    keep = live_pids() | {os.getpid()}
    for line in r.stdout.splitlines():
        pid, _, cmd = line.partition(' ')
        if not pid.isdigit() or int(pid) in keep or '--port 5180' in cmd or raw not in cmd: continue
        try: os.kill(int(pid), 15)
        except ProcessLookupError: pass


def wait_up(url, secs=40) -> bool:
    end = time.time() + secs
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200: return True
        except Exception: pass
        time.sleep(0.3)
    return False


class Proc:
    """A background server; stop() ends it. Use as a context manager."""
    def __init__(self, cmd, url, cwd, log, env=None):
        self.url, self.log = url, log
        self.p = subprocess.Popen(cmd, cwd=cwd, stdout=open(log, 'w'), stderr=subprocess.STDOUT, env={**os.environ, **(env or {})})
        if not wait_up(url + ('api/health' if 'api' not in url else '')):
            self.stop()
            raise RuntimeError(f'server did not start: {" ".join(map(str, cmd))} (log {log})')

    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try: self.p.wait(10)
            except subprocess.TimeoutExpired: self.p.kill()

    def __enter__(self): return self
    def __exit__(self, *a): self.stop()


def server(data=None, port=None, log_dir=None, env=None) -> Proc:
    """The real FastAPI server on http://127.0.0.1:<port>/ with temp data (never the live library)."""
    if not PY.exists(): sys.exit(f'{PY} is missing: link it (ln -s ~/git/apps/meowsic/server/.venv server/.venv) or make it (see CLAUDE.md)')
    data = Path(data) if data else temp_data()
    port = port or free_port()
    guard(data, port)
    log = Path(log_dir or data) / f'server-{port}.log'
    pr = Proc([str(PY), '-m', 'meowsic', '--host', '127.0.0.1', '--port', str(port), '--data', str(data)],
              f'http://127.0.0.1:{port}/', SERVER, log, env={'MEOWSIC_CERT': '', 'MEOWSIC_KEY': '', **(env or {})})
    pr.data, pr.port = data, port
    return pr


def preview(port=None, log_dir=None) -> Proc:
    """The static UI preview (serve.py: web/ with sample data at /?preview=1, no server, no data)."""
    port = port or free_port()
    guard(port=port)
    log = Path(log_dir or tempfile.gettempdir()) / f'preview-{port}.log'
    pr = Proc([sys.executable, str(REPO / 'serve.py'), str(port)], f'http://127.0.0.1:{port}/', REPO, log)
    pr.port = port
    return pr
