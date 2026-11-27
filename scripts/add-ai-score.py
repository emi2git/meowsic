#!/Users/emi2mac/git/apps/meowsic/server/.venv/bin/python
"""Add a score Claude composed to Meowsic (listed under Scores, source "Meowsic").

Usage:
  add-ai-score.py score.musicxml --title "…" --artist "<the song's real artist>" [--tags "A,B"]
                          [--key "C major"] [--bpm 90] [--version lead] [--server https://localhost:5180] [--force]

Runs with the Meowsic server venv's python (music21; see the shebang). It:
  1. parses the MusicXML (.musicxml / .xml / .mxl) with music21 — exit 2 if it does not parse;
  2. checks every bar of every part (each voice) adds up to its time signature — lists the
     bars that don't and exits 3, unless --force;
  3. POSTs it as kind 'score', version --version (default 'original'), ai true, the given tags,
     source 'Meowsic', artist = --artist, the song's real artist / composer ('Traditional' for folk songs; never
     'Meowsic'); the MusicXML gets composer = that artist + "Made by Meowsic" (HTTPS checked against ~/Documents/Meowsic/certs/meowsic-ca.pem);
  4. prints the new item id, then its URL (https://<host>:5180/#/item/<id>).
Only local hosts (localhost, *.local, loopback / private LAN addresses) are ever contacted (exit 4 otherwise).
"""
import argparse
import ipaddress
import json
import socket
import ssl
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse

CA = Path.home() / 'Documents/Meowsic/certs/meowsic-ca.pem'
AI_SOURCE = 'Meowsic'  # the source of every score Claude writes; the artist is the song's real one
BYLINE = 'Made by Meowsic'


def read_xml(path: Path) -> str:
    if path.suffix.lower() == '.mxl':
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if n.lower().endswith(('.xml', '.musicxml')) and not n.startswith('META-INF')]
        if not names:
            raise ValueError('no MusicXML inside the .mxl')
        return z.read(names[0]).decode('utf-8')
    return path.read_text(encoding='utf-8')


def credit(x: str, artist: str = '') -> str:
    """Composer = the song's real artist, plus "Made by Meowsic" as the arranger (the server does the same)."""
    import re
    from xml.sax.saxutils import escape
    x = re.sub(r'<creator\b[^>]*>[\s\S]*?</creator>|<creator\b[^>]*/>', '', x)
    a = '' if artist.strip() in ('', AI_SOURCE, 'Meowsic AI') else artist.strip()
    c = (f'<creator type="composer">{escape(a)}</creator>' if a else '') + f'<creator type="arranger">{BYLINE}</creator>'
    if '<identification>' in x: return x.replace('<identification>', '<identification>' + c, 1)
    if re.search(r'<identification\s*/>', x): return re.sub(r'<identification\s*/>', '<identification>' + c + '</identification>', x, count=1)
    return re.sub(r'(<part-list\b)', '<identification>' + c + r'</identification>\1', x, count=1)


def bad_bars(score):
    """[(part name, bar number, voice, got quarters, want quarters)] for bars that don't fill their time signature."""
    import music21 as m
    out = []
    for pi, part in enumerate(score.parts, 1):
        name = part.partName or f'Part {pi}'
        for meas in part.getElementsByClass(m.stream.Measure):
            ts = meas.timeSignature or meas.getContextByClass(m.meter.TimeSignature)
            want = float(ts.barDuration.quarterLength) if ts else 4.0
            for v in list(meas.voices) or [meas]:
                got = float(max((n.offset + n.quarterLength for n in v.notesAndRests), default=0.0))
                if abs(got - want) > 1e-6:
                    out.append((name, meas.number, '' if v is meas else str(v.id), got, want))
    return out


def is_local(host: str) -> bool:
    if not host:
        return False
    if host == 'localhost' or host.endswith('.local'):
        return True
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(host, None)}
    except socket.gaierror:
        return False

    def ok(a):
        ip = ipaddress.ip_address(a.split('%')[0])
        return ip.is_loopback or ip.is_private or ip.is_link_local
    return bool(addrs) and all(ok(a) for a in addrs)


def main():
    ap = argparse.ArgumentParser(description='Add a Claude-composed score to Meowsic (AI music).')
    ap.add_argument('file', type=Path)
    ap.add_argument('--title', required=True)
    ap.add_argument('--artist', required=True, help="the song's real artist / composer, e.g. 'Traditional', 'John Newton' (never Meowsic)")
    ap.add_argument('--tags', default='', help='comma-separated')
    ap.add_argument('--key', default='', help='e.g. "C major"')
    ap.add_argument('--bpm', type=float)
    ap.add_argument('--version', default='original', help="score version, e.g. 'lead' for a one-staff lead sheet")
    ap.add_argument('--server', default='https://localhost:5180')
    ap.add_argument('--force', action='store_true', help='add it even if some bars do not fill their time signature')
    a = ap.parse_args()

    if not a.title.strip():
        print('error: --title is empty', file=sys.stderr)
        return 2
    try:
        text = read_xml(a.file)
        import music21 as m
        score = m.converter.parseData(text, format='musicxml')
        if not len(getattr(score, 'parts', [])):
            raise ValueError('no parts')
    except Exception as e:  # noqa: BLE001
        print(f'error: {a.file} is not valid MusicXML: {e}', file=sys.stderr)
        return 2

    bad = bad_bars(score)
    if bad:
        print(f'{len(bad)} bar(s) do not add up to the time signature:', file=sys.stderr)
        for name, num, voice, got, want in bad:
            print(f'  {name} bar {num}{f" voice {voice}" if voice else ""}: {got:g} of {want:g} quarters', file=sys.stderr)
        if not a.force:
            print('Fix them, or pass --force to add it anyway.', file=sys.stderr)
            return 3

    u = urlparse(a.server.rstrip('/'))
    if u.scheme not in ('http', 'https') or not is_local(u.hostname or ''):
        print(f'error: {a.server} is not a local Meowsic server; refusing to send anything', file=sys.stderr)
        return 4

    tags = list(dict.fromkeys(t.strip() for t in a.tags.split(',') if t.strip() and t.strip() != 'AI Studio'))
    body = {'kind': 'score', 'title': a.title.strip(), 'artist': a.artist.strip(), 'version': a.version, 'ai': True,
            'tags': tags, 'source': AI_SOURCE, 'key': a.key.strip(), 'musicxmlText': credit(text, a.artist)}
    if a.bpm:
        body['bpm'] = a.bpm
    base = f'{u.scheme}://{u.netloc}'
    req = urllib.request.Request(base + '/api/items', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    ctx = ssl.create_default_context(cafile=str(CA)) if u.scheme == 'https' else None
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            it = json.load(r)
    except urllib.error.HTTPError as e:
        print(f'error: server said {e.code}: {e.read().decode(errors="replace")[:500]}', file=sys.stderr)
        return 5
    except (urllib.error.URLError, OSError) as e:
        print(f'error: cannot reach {a.server}: {e}', file=sys.stderr)
        return 5

    print(it['id'])
    print(f'{base}/#/item/{it["id"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
