"""Serve the Meowsic UI preview (web/) with caching off, so a reload always gets the newest files."""
import http.server, functools, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
http.server.ThreadingHTTPServer(('0.0.0.0', port), functools.partial(NoCache, directory=root)).serve_forever()
