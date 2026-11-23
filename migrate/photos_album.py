#!/usr/bin/env python3
"""Read one Apple Photos album for Meowsic's "Add music → From Photos" (runs in migrate/.venv: osxphotos).

  photos_album.py list <album>                 -> {"album", "photos": [{id, date, filename, w, h, local, sha256}]}
  photos_album.py fetch <out dir> <id> ...     -> {id: {file, sha256, quality, note} | {error}}

Read-only: the Photos library is never changed (osxphotos reads Photos.sqlite; nothing is written there,
no album is made or changed). The album name matches without case ("SHEET" = "Sheet"). fetch copies the
photo as you see it in Photos (your edit there, if any, else the original) into <out dir>; a photo kept only
in iCloud is downloaded through PhotoKit (like migrate.py's --download-missing re-run), else a big enough
local preview is used. HEIC is turned into JPEG (sips), so every browser can show it. sha256 is always the
hash of the file in Photos (the same hash migrate.py kept), so a photo imported before is recognised.
Errors print {"error": "access" | "no-album" | ..., "message"} and exit 0.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PREVIEW_MIN = 1000
ACCESS_HELP = ('Meowsic can’t read your Photos library. On this Mac open System Settings → Privacy & Security → '
               'Full Disk Access (and Photos) and turn on the app that runs the Meowsic server — “Meowsic” when you '
               'start it from ~/Applications, or Terminal when you start it with server/start.sh — then try again.')


def out(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def open_db():
    import osxphotos
    return osxphotos.PhotosDB()


def album_of(db, name):
    want = name.strip().lower()
    for a in db.album_info:
        if (a.title or '').strip().lower() == want: return a
    return None


def shown_path(p):
    """The file Photos shows: the edited version if there is one, else the original (None if not local)."""
    if p.path_edited and os.path.exists(p.path_edited): return p.path_edited
    if not p.ismissing and p.path and os.path.exists(p.path): return p.path
    return None


def cmd_list(name, cache_file=None):
    cache = {}
    if cache_file:
        try: cache = json.loads(Path(cache_file).read_text())
        except Exception: cache = {}
    db = open_db()
    a = album_of(db, name)
    if not a:
        out({'error': 'no-album', 'message': f'There is no album “{name}” in Photos.', 'albums': sorted({x.title for x in db.album_info if x.title})}); return
    photos = []
    for p in a.photos:
        if p.intrash: continue
        path = shown_path(p)
        sha = None
        if path:
            st = os.stat(path)
            key = f'{p.uuid}:{path}:{st.st_mtime_ns}:{st.st_size}'
            sha = cache.get(key) or sha256(path)
            cache[key] = sha
        photos.append({'id': p.uuid, 'date': int(p.date.timestamp() * 1000) if p.date else None, 'filename': p.original_filename or p.filename,
                       'w': p.width, 'h': p.height, 'local': bool(path), 'sha256': sha, 'edited': bool(p.hasadjustments), 'ismovie': bool(p.ismovie)})
    if cache_file:
        try: Path(cache_file).write_text(json.dumps(cache))
        except Exception: pass
    out({'album': a.title, 'photos': photos})


def to_browser(src, dst_base):
    """Copy src next to dst_base with its own extension; HEIC/HEIF/TIFF become JPEG (sips)."""
    ext = Path(src).suffix.lower()
    if ext in ('.heic', '.heif', '.tif', '.tiff'):
        dst = dst_base.with_suffix('.jpg')
        r = subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', str(src), '--out', str(dst)], capture_output=True, text=True)
        if r.returncode or not dst.exists(): raise RuntimeError('could not turn the HEIC photo into JPEG: ' + (r.stderr or '')[:200])
        return dst
    dst = dst_base.with_suffix('.jpg' if ext == '.jpeg' else ext or '.jpg')
    shutil.copyfile(src, dst)
    return dst


def cmd_fetch(outdir, ids):
    outdir = Path(outdir); outdir.mkdir(parents=True, exist_ok=True)
    db = open_db()
    found = {p.uuid: p for p in db.photos(uuid=ids)}
    res = {}
    for k, u in enumerate(ids):
        p = found.get(u)
        if not p: res[u] = {'error': 'This photo is not in Photos any more'}; continue
        try:
            base = outdir / f'{k + 1:04d}'
            path, quality, note = shown_path(p), 'original', ''
            if not path:  # iCloud only: download it (PhotoKit), like migrate.py's --download-missing re-run
                from osxphotos import ExportOptions, PhotoExporter
                with tempfile.TemporaryDirectory() as t:
                    try:
                        r = PhotoExporter(p).export(t, options=ExportOptions(download_missing=True, use_photokit=True, edited=bool(p.hasadjustments), overwrite=True))
                        got = [f for f in (r.exported or []) if os.path.exists(f)]
                    except Exception as e:
                        got, note = [], f'download failed: {e}'[:200]
                    if got:
                        dst = to_browser(got[0], base)
                        res[u] = {'file': dst.name, 'sha256': sha256(got[0]), 'quality': 'downloaded', 'note': 'downloaded from iCloud'}
                        continue
                best, size = None, 0
                from PIL import Image
                for f in p.path_derivatives or []:
                    try:
                        with Image.open(f) as im: s = max(im.size)
                    except Exception: continue
                    if s > size: best, size = f, s
                if best and size >= PREVIEW_MIN:
                    path, quality, note = best, 'preview', f'iCloud only; used the local preview ({size}px). ' + note
                else:
                    res[u] = {'error': 'This photo is only in iCloud and could not be downloaded. In Photos, open it once (or turn on Settings → iCloud → Download Originals), then try again. ' + note}
                    continue
            dst = to_browser(path, base)
            res[u] = {'file': dst.name, 'sha256': sha256(path), 'quality': quality, 'note': note.strip()}
        except Exception as e:
            res[u] = {'error': str(e)[:300]}
    out(res)


def main():
    a = sys.argv[1:]
    try:
        if a and a[0] == 'list' and len(a) >= 2: return cmd_list(a[1], a[2] if len(a) > 2 else None)
        if a and a[0] == 'fetch' and len(a) >= 2: return cmd_fetch(a[1], a[2:])
        out({'error': 'usage', 'message': __doc__})
    except Exception as e:  # the library can't be opened: almost always macOS privacy settings
        msg = f'{type(e).__name__}: {e}'
        access = any(w in msg.lower() for w in ('permission', 'not permitted', 'unable to open', 'authorization', 'operation not', 'access', 'fda', 'full disk'))
        out({'error': 'access' if access else 'failed', 'message': ACCESS_HELP if access else msg[:400], 'detail': msg[:400]})


if __name__ == '__main__':
    main()
