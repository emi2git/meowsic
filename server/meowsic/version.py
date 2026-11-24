"""What is running, for GET /api/health and scripts/deploy: the git commit and the PWA shell cache name.

sha        the checkout's HEAD now (web/ is served live from disk, so this is what the browser gets)
serverSha  HEAD when this server process started (the Python code in memory); differs from sha after a
           deploy that changed only web/ — a restart is only needed when server/ changed
shell      the service worker's shell cache name in web/sw.js (e.g. meowsic-shell-v31); bump it on any shell change
"""
import re
import subprocess
import time

from .db import SERVER_DIR, WEB_DIR

REPO = SERVER_DIR.parent
_cache = {'at': 0.0, 'val': None}


def git_sha() -> str:
    try:
        r = subprocess.run(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=REPO, capture_output=True, text=True, timeout=3)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''


def shell_version() -> str:
    try: m = re.search(r"const SHELL = '([^']+)'", (WEB_DIR / 'sw.js').read_text())
    except OSError: return ''
    return m.group(1) if m else ''


SERVER_SHA = git_sha()


def version() -> dict:
    """{sha, serverSha, shell}; read again at most every 5 s (health is polled by every open app)."""
    now = time.time()
    if _cache['val'] is None or now - _cache['at'] > 5:
        _cache.update(at=now, val={'sha': git_sha(), 'serverSha': SERVER_SHA, 'shell': shell_version()})
    return dict(_cache['val'])
