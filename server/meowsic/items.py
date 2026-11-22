"""Items, trash, tags, plays, annotations, item files, sheet upload and score MusicXML."""
import datetime
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from .db import KIND_COLS, ensure_tags, folder_path, get_item, item_json, log_event, now_ms, folder_name, rebase, uid, write_item

router = APIRouter(prefix='/api')


def conn(request: Request):
    c = request.app.state.connect()
    try:
        yield c
        c.commit()
    finally:
        c.close()


def cfg(request: Request):
    return request.app.state.cfg


def item_dir(cf, it) -> Path:
    """items/<folder>/ of an item (404 when it has none, e.g. a chord chart)."""
    try: return folder_path(cf, it.get('folder'))
    except ValueError: raise HTTPException(404, 'This item has no files')


def must_item(c, item_id):
    it = get_item(c, item_id)
    if not it:
        raise HTTPException(404, 'No such item')
    return it


def ids_of(body):
    ids = body.get('ids', [])
    return [ids] if isinstance(ids, str) else list(ids)


def summary(titles):  # "Memory" or "3 items", like the UI
    return (f'{len(titles)} items' if len(titles) > 1 else titles[0]), ', '.join(titles)


# ---------- items ----------

@router.get('/items')
def list_items(deleted: bool = False, kind: str | None = None, c=Depends(conn)):
    q = 'SELECT * FROM item WHERE (deleted_at IS NOT NULL) = ?' + (' AND kind = ?' if kind else '') + ' ORDER BY created_at DESC'
    return [item_json(c, r) for r in c.execute(q, (deleted, kind) if kind else (deleted,))]


@router.get('/items/{item_id}')
def read_item(item_id: str, c=Depends(conn)):
    return must_item(c, item_id)


@router.post('/items', status_code=201)
def create_item(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """Add a chord chart, score or (file-less) sheet. Score: pass `musicxmlText` to write the file."""
    kind = body.get('kind')
    if kind not in KIND_COLS or not str(body.get('title', '')).strip():
        raise HTTPException(400, 'kind (sheet|chords|score) and title are required')
    t, prefix = now_ms(), {'sheet': 's', 'chords': 'c', 'score': 'm'}[kind]
    # the UI may pick the id itself (so it can open the item at once); else make one
    want = str(body.get('id') or '')
    ok = re.fullmatch(prefix + r'-[a-z0-9]{3,16}', want) and not c.execute('SELECT 1 FROM item WHERE id=?', (want,)).fetchone()
    text = body.get('musicxmlText')
    if kind == 'chords': body.setdefault('originAt', t)  # fetch / paste time
    it = {'tags': [], 'createdAt': t, 'updatedAt': t, **{k: v for k, v in body.items() if k not in ('folder', 'musicxmlText')},
          'id': want if ok else uid(prefix), 'kind': kind}
    write_item(c, it, new=True)
    if kind == 'score' and text is not None:
        d = item_dir(cf, it)
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{it["folder"]}.musicxml').write_text(text)
        c.execute('UPDATE score SET musicxml=? WHERE item_id=?', (f'{it["folder"]}.musicxml', it['id']))
    return get_item(c, it['id'])


@router.patch('/items/{item_id}')
def update_item(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    patch = {k: v for k, v in body.items() if k not in ('id', 'kind', 'createdAt', 'deleted', 'deletedAt', 'folder')}
    write_item(c, {**patch, 'id': item_id, 'kind': it['kind'], 'updatedAt': now_ms()}, new=False)
    if it['folder'] and 'title' in patch and patch['title'] != it['title']:
        rename_folder(c, cf, it, patch['title'])
    return get_item(c, item_id)


FILE_COLS = ('musicxml', 'musicxml_original', 'midi', 'pdf')


def rename_folder(c, cf, it, title):
    """Title changed: rename items/<folder>/ and the title-named files in it, then the db rows.
    Any failure undoes the renames done so far and keeps the old names."""
    old = it['folder']
    new = folder_name(it['id'], title)
    if new == old:
        return
    src, dst = folder_path(cf, old), folder_path(cf, new)
    done = []  # (from, to) in order, for the undo
    try:
        if src.is_dir():
            os.rename(src, dst)
            done.append((src, dst))
            for f in sorted(dst.iterdir()):
                to = rebase(f.name, old, new)
                if to:
                    os.rename(f, dst / to)
                    done.append((f, dst / to))
    except OSError as e:
        for a, b in reversed(done):
            try: os.rename(b, a)
            except OSError: pass
        logging.getLogger('meowsic').warning('could not rename folder %r -> %r: %s', old, new, e)
        return
    c.execute('UPDATE item SET folder=? WHERE id=?', (new, it['id']))
    for page, f in c.execute('SELECT page, file FROM sheet_page WHERE item_id=?', (it['id'],)).fetchall():
        if rebase(f, old, new): c.execute('UPDATE sheet_page SET file=? WHERE item_id=? AND page=?', (rebase(f, old, new), it['id'], page))
    row = c.execute(f'SELECT {",".join(FILE_COLS)} FROM score WHERE item_id=?', (it['id'],)).fetchone()
    if row:
        c.execute(f'UPDATE score SET {",".join(f"{k}=?" for k in FILE_COLS)} WHERE item_id=?',
                  [(rebase(v, old, new) or v) if v else v for v in row] + [it['id']])


@router.post('/items/trash')
def trash(body: dict = Body(...), c=Depends(conn)):
    titles = []
    for i in ids_of(body):
        r = c.execute('UPDATE item SET deleted_at=? WHERE id=? AND deleted_at IS NULL RETURNING title', (now_ms(), i)).fetchone()
        if r: titles.append(r[0])
    if titles: log_event(c, 'bin', *summary(titles))
    return {'ok': True, 'count': len(titles)}


@router.post('/items/restore')
def restore(body: dict = Body(...), c=Depends(conn)):
    titles = []
    for i in ids_of(body):
        r = c.execute('UPDATE item SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL RETURNING title', (i,)).fetchone()
        if r: titles.append(r[0])
    if titles: log_event(c, 'restore', *summary(titles))
    return {'ok': True, 'count': len(titles)}


@router.post('/items/purge')
def purge(body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    """Delete for good: rows (cascade) and the items/<folder>/ folder."""
    titles = []
    for i in ids_of(body):
        r = c.execute('DELETE FROM item WHERE id=? RETURNING title, folder', (i,)).fetchone()
        if not r: continue
        titles.append(r[0])
        if not r[1]: continue
        d = folder_path(cf, r[1])
        if d.is_dir() and d.resolve().parent == cf.items_dir.resolve():
            shutil.rmtree(d)
    if titles: log_event(c, 'delete', *summary(titles))
    return {'ok': True, 'count': len(titles)}


@router.post('/printed')
def mark_printed(body: dict = Body(...), c=Depends(conn)):
    t = now_ms()
    c.executemany('UPDATE item SET printed_at=? WHERE id=?', [(t, i) for i in ids_of(body)])
    return {'ok': True}


# ---------- tags ----------

@router.get('/tags')
def tags(c=Depends(conn)):
    """All tags in creation order, with the number of items (not in Trash) carrying each."""
    q = '''SELECT tag.name, COUNT(item.id) FROM tag LEFT JOIN item_tag ON item_tag.tag = tag.name
           LEFT JOIN item ON item.id = item_tag.item_id AND item.deleted_at IS NULL GROUP BY tag.name ORDER BY tag.rowid'''
    return [{'name': n, 'count': k} for n, k in c.execute(q)]


@router.post('/tags', status_code=201)
def add_tag(body: dict = Body(...), c=Depends(conn)):
    name = str(body.get('name', '')).strip()
    if not name: raise HTTPException(400, 'name is required')
    ensure_tags(c, [name])
    return {'name': name}


@router.patch('/tags/{name:path}')
def rename_tag(name: str, body: dict = Body(...), c=Depends(conn)):
    to = str(body.get('to', '')).strip()
    if not to: raise HTTPException(400, 'to is required')
    if to == name: return {'name': to}
    if not c.execute('SELECT 1 FROM tag WHERE name=?', (name,)).fetchone(): raise HTTPException(404, 'No such tag')
    if c.execute('SELECT 1 FROM tag WHERE name=?', (to,)).fetchone():
        # merge into the existing tag
        c.execute('INSERT OR IGNORE INTO item_tag(item_id, tag) SELECT item_id, ? FROM item_tag WHERE tag=?', (to, name))
        c.execute('DELETE FROM tag WHERE name=?', (name,))
    else:
        c.execute('UPDATE tag SET name=? WHERE name=?', (to, name))  # item_tag follows (ON UPDATE CASCADE)
    return {'name': to}


@router.delete('/tags/{name:path}')
def delete_tag(name: str, c=Depends(conn)):
    c.execute('DELETE FROM tag WHERE name=?', (name,))
    return {'ok': True}


@router.post('/tags/set')
def set_tags(body: dict = Body(...), c=Depends(conn)):
    """Add and remove tags on many items at once: {ids, add, remove}."""
    add = [t.strip() for t in body.get('add', []) if t.strip()]
    remove = body.get('remove', [])
    ensure_tags(c, add)
    for i in ids_of(body):
        c.executemany('DELETE FROM item_tag WHERE item_id=? AND tag=?', [(i, t) for t in remove])
        c.executemany('INSERT OR IGNORE INTO item_tag(item_id, tag) SELECT id, ? FROM item WHERE id=?', [(t, i) for t in add])
    return {'ok': True}


# ---------- plays ----------

@router.get('/plays')
def plays(item_id: str | None = None, c=Depends(conn)):
    q = 'SELECT item_id, opened_at, closed_at FROM play_session' + (' WHERE item_id=?' if item_id else '') + ' ORDER BY opened_at'
    return [{'itemId': a, 'openedAt': b, 'closedAt': d} for a, b, d in c.execute(q, (item_id,) if item_id else ())]


@router.post('/plays')
def log_play(body: dict = Body(...), c=Depends(conn)):
    """A play counts when the item stayed open 10 s or more."""
    o, cl = int(body['openedAt']), int(body['closedAt'])
    if cl - o < 10000: return {'ok': True, 'logged': False}
    must_item(c, body['itemId'])
    c.execute('INSERT INTO play_session(item_id, opened_at, closed_at) VALUES (?,?,?)', (body['itemId'], o, cl))
    return {'ok': True, 'logged': True}


# ---------- annotations ----------

@router.get('/items/{item_id}/annotations')
def all_strokes(item_id: str, c=Depends(conn)):
    return {p: json.loads(s) for p, s in c.execute('SELECT page, strokes FROM annotation WHERE item_id=?', (item_id,))}


@router.get('/items/{item_id}/annotations/{page}')
def strokes(item_id: str, page: str, c=Depends(conn)):
    r = c.execute('SELECT strokes FROM annotation WHERE item_id=? AND page=?', (item_id, page)).fetchone()
    return json.loads(r[0]) if r else []


@router.put('/items/{item_id}/annotations/{page}')
def set_strokes(item_id: str, page: str, body: list = Body(...), c=Depends(conn)):
    must_item(c, item_id)
    c.execute('INSERT OR REPLACE INTO annotation(item_id, page, strokes) VALUES (?,?,?)', (item_id, page, json.dumps(body)))
    return {'ok': True}


# ---------- files ----------

def safe_file(base: Path, rel: str) -> Path:
    """A file inside the item folder, never outside it."""
    base = base.resolve()
    p = (base / rel).resolve()
    if not p.is_relative_to(base) or p == base:
        raise HTTPException(400, 'Bad path')
    return p


@router.get('/items/{item_id}/file/{rel:path}')
def item_file(item_id: str, rel: str, c=Depends(conn), cf=Depends(cfg)):
    p = safe_file(item_dir(cf, must_item(c, item_id)), rel)
    if not p.is_file(): raise HTTPException(404, 'No such file')
    media = {'.musicxml': 'application/vnd.recordare.musicxml+xml', '.mid': 'audio/midi', '.midi': 'audio/midi'}.get(p.suffix.lower())
    return FileResponse(p, media_type=media)


# ---------- sheet upload ----------
# Files are named after the folder: "s-7k2p9qa Memory 1.jpg", "… Memory 2.png", "… Memory.pdf", "… Memory (2).pdf"

def exif_date(data: bytes):
    """EXIF DateTimeOriginal (local time) as ms, or None."""
    try:
        from PIL import Image
        ex = Image.open(io.BytesIO(data)).getexif()
        s = ex.get_ifd(0x8769).get(36867) or ex.get(306)  # DateTimeOriginal, else DateTime
        return int(datetime.datetime.strptime(str(s).strip('\x00 '), '%Y:%m:%d %H:%M:%S').timestamp() * 1000) if s else None
    except Exception:  # not an image Pillow reads (HEIC), no EXIF, bad date
        return None


IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff'}


def pdf_pages(pdf: Path, d: Path, folder: str, first: int) -> list[str]:
    """Render a PDF to "<Folder> <n>.jpg" with pdftoppm; returns the file names ([] if pdftoppm is missing)."""
    if not shutil.which('pdftoppm'): return []
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['pdftoppm', '-r', '150', '-jpeg', '-jpegopt', 'quality=85', str(pdf), f'{tmp}/p'], check=True, capture_output=True, timeout=600)
        out = []
        for k, f in enumerate(sorted(Path(tmp).glob('p-*.jpg'), key=lambda x: int(x.stem.split('-')[-1]))):
            name = f'{folder} {first + k}.jpg'
            shutil.move(f, d / name)
            out.append(name)
        return out


@router.post('/sheets', status_code=201)
async def upload_sheet(files: list[UploadFile] = File(...), title: str = Form(''), artist: str = Form(''),
                       tags: str = Form('[]'), item_id: str = Form(''), last_modified: str = Form('[]'),
                       c=Depends(conn), cf=Depends(cfg)):
    """Images and/or PDFs -> one sheet item (or more pages on `item_id`). Files seen before are skipped.
    `last_modified`: JSON list of each file's lastModified (ms), in file order; dates a page without EXIF."""
    try: mtimes = [int(x) if x else None for x in json.loads(last_modified or '[]')]
    except (ValueError, TypeError): raise HTTPException(400, 'last_modified must be a JSON list of ms')
    blobs, skipped = [], []
    for n, f in enumerate(files):
        data = await f.read()
        ext = Path(f.filename or '').suffix.lower()
        if ext not in IMAGE_EXT and ext != '.pdf' and f.content_type != 'application/pdf':
            raise HTTPException(400, f'Not an image or PDF: {f.filename}')
        sha = hashlib.sha256(data).hexdigest()
        dup = c.execute('SELECT item_id FROM sheet_page WHERE sha256=? LIMIT 1', (sha,)).fetchone()
        if dup or sha in [b[3] for b in blobs]:
            skipped.append({'file': f.filename, 'duplicateOf': dup[0] if dup else None})
            continue
        is_pdf = ext == '.pdf' or f.content_type == 'application/pdf'
        when = (None if is_pdf else exif_date(data)) or (mtimes[n] if n < len(mtimes) else None)
        blobs.append((f.filename, '.pdf' if is_pdf else ext, data, sha, when))
    if not blobs:
        raise HTTPException(409, {'message': 'These pages are already in the library', 'skipped': skipped})

    if item_id:
        it = must_item(c, item_id)
        if it['kind'] != 'sheet': raise HTTPException(400, 'Not a sheet')
    else:
        it = {'id': uid('s'), 'kind': 'sheet', 'title': title.strip() or Path(blobs[0][0] or 'Untitled').stem,
              'artist': artist, 'tags': json.loads(tags), 'createdAt': now_ms(), 'updatedAt': now_ms(),
              'source': 'pdf' if any(b[1] == '.pdf' for b in blobs) else 'photos', 'pages': 0}
        write_item(c, it, new=True)
    folder = it['folder']
    d = item_dir(cf, it)
    d.mkdir(parents=True, exist_ok=True)
    page = (c.execute('SELECT MAX(page) FROM sheet_page WHERE item_id=?', (it['id'],)).fetchone()[0] or 0) + 1
    t = now_ms()
    for name, ext, data, sha, when in blobs:
        if ext == '.pdf':
            k = 1
            while (d / (f'{folder}.pdf' if k == 1 else f'{folder} ({k}).pdf')).exists(): k += 1
            pdf = d / (f'{folder}.pdf' if k == 1 else f'{folder} ({k}).pdf')
            pdf.write_bytes(data)
            rels = pdf_pages(pdf, d, folder, page)
        else:
            rel = f'{folder} {page}{".jpg" if ext == ".jpeg" else ext}'
            (d / rel).write_bytes(data)
            rels = [rel]
        for rel in rels:  # every page keeps the hash of the file it came from
            c.execute('INSERT INTO sheet_page(item_id, page, file, sha256, captured_at) VALUES (?,?,?,?,?)', (it['id'], page, rel, sha, when))
            page += 1
    c.execute('UPDATE sheet SET pages=(SELECT COUNT(*) FROM sheet_page WHERE item_id=?) WHERE item_id=?', (it['id'], it['id']))
    # the item's date = its earliest page (upload time when no page has one)
    first = c.execute('SELECT MIN(captured_at) FROM sheet_page WHERE item_id=?', (it['id'],)).fetchone()[0]
    c.execute('UPDATE item SET updated_at=?2, origin_at=COALESCE(MIN(?1, origin_at), ?1, origin_at, ?2) WHERE id=?3', (first, t, it['id']))
    return {'item': get_item(c, it['id']), 'skipped': skipped}


# ---------- score MusicXML ("<Folder>.musicxml", "<Folder> (original).musicxml") ----------

def score_paths(c, cf, item_id):
    it = must_item(c, item_id)
    if it['kind'] != 'score': raise HTTPException(400, 'Not a score')
    return it, item_dir(cf, it)


@router.get('/items/{item_id}/musicxml')
def get_musicxml(item_id: str, original: bool = False, c=Depends(conn), cf=Depends(cfg)):
    it, d = score_paths(c, cf, item_id)
    name = it['musicxmlOriginal'] if original else it['musicxml']
    if not name or not safe_file(d, name).is_file(): raise HTTPException(404, 'No MusicXML')
    return PlainTextResponse(safe_file(d, name).read_text(), media_type='application/vnd.recordare.musicxml+xml')


@router.put('/items/{item_id}/musicxml')
async def put_musicxml(item_id: str, request: Request, c=Depends(conn), cf=Depends(cfg)):
    """Save edited notes. The first save keeps the untouched file as musicxml_original."""
    it, d = score_paths(c, cf, item_id)
    text = (await request.body()).decode('utf-8')
    if not text.strip(): raise HTTPException(400, 'Empty MusicXML')
    d.mkdir(parents=True, exist_ok=True)
    name = it['musicxml'] or f'{it["folder"]}.musicxml'
    cur = safe_file(d, name)
    orig = it['musicxmlOriginal']
    if not orig and cur.is_file():
        orig = f'{it["folder"]} (original).musicxml'
        shutil.copyfile(cur, d / orig)
    cur.write_text(text)
    c.execute('UPDATE score SET musicxml=?, musicxml_original=? WHERE item_id=?', (name, orig, item_id))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))
    return {'ok': True, 'musicxml': name, 'musicxmlOriginal': orig}


@router.post('/items/{item_id}/musicxml/revert')
def revert_musicxml(item_id: str, c=Depends(conn), cf=Depends(cfg)):
    it, d = score_paths(c, cf, item_id)
    if not it['musicxmlOriginal']: raise HTTPException(409, 'Nothing to revert')
    shutil.copyfile(safe_file(d, it['musicxmlOriginal']), safe_file(d, it['musicxml']))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), item_id))
    return {'ok': True}
