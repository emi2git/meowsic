"""Serve the Meowsic UI preview (web/) with caching off, so a reload always gets the newest files.

  python3 serve.py [port]      then open http://localhost:<port>/?preview=1 (sample library, kept in the browser)

There is no server behind it: /api/health says so (the app then runs on its sample data) and gives the same
version fields as the real server; any other /api/* answers 503 {offline: true}, like the service worker does
when the Mac is away.
"""
import functools
import http.server
import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')


def version():
    try: sha = subprocess.run(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=ROOT, capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception: sha = ''
    m = re.search(r"const SHELL = '([^']+)'", open(os.path.join(ROOT, 'sw.js')).read())
    return {'sha': sha, 'serverSha': '', 'shell': m.group(1) if m else ''}


class NoCache(http.server.SimpleHTTPRequestHandler):
    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/api/health'): return self._json(200, {'ok': False, 'mock': True, **version()})
        if self.path.startswith('/api/'): return self._json(503, {'offline': True})
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):  # quiet: only errors
        if len(args) > 1 and str(args[1])[:1] in '45': super().log_message(fmt, *args)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
http.server.ThreadingHTTPServer(('0.0.0.0', port), functools.partial(NoCache, directory=ROOT)).serve_forever()
