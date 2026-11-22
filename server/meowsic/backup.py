"""Backup: JSON export/import (same shape as the UI's mock store) and daily db copies."""
import datetime
import json
import sqlite3
import threading

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from .db import KIND_COLS, connect, ensure_tags, item_json, job_json, now_ms, write_item
from .items import conn

router = APIRouter(prefix='/api')
KEEP = 30


def snapshot(cfg, name=None):
    """Copy the db (sqlite online backup) into backups/; keep the newest 30 daily copies."""
    cfg.backups_dir.mkdir(exist_ok=True)
    dest = cfg.backups_dir / (name or f'meowsic-{datetime.date.today():%Y-%m-%d}.db')
    src, out = connect(cfg), sqlite3.connect(dest)
    try: src.backup(out)
    finally: src.close(); out.close()
    daily = sorted(cfg.backups_dir.glob('meowsic-????-??-??.db'))
    for old in daily[:-KEEP]:
        old.unlink()
    return dest


def daily_loop(cfg, stop: threading.Event):
    while True:
        if not (cfg.backups_dir / f'meowsic-{datetime.date.today():%Y-%m-%d}.db').exists():
            try: snapshot(cfg)
            except Exception: pass
        if stop.wait(3600): return


def export(c) -> dict:
    items = [item_json(c, r) for r in c.execute('SELECT * FROM item ORDER BY created_at DESC')]
    for it in items:
        for k in ('playCount', 'lastPlayed', 'hasStrokes'):
            it.pop(k)
    return {
        'version': 6, 'app': 'meowsic-2', 'exportedAt': now_ms(), 'items': items,
        'tags': [r[0] for r in c.execute('SELECT name FROM tag ORDER BY rowid')],
        'plays': [{'itemId': a, 'openedAt': b, 'closedAt': d} for a, b, d in c.execute('SELECT * FROM play_session ORDER BY opened_at')],
        'jobs': [job_json(r) for r in c.execute('SELECT * FROM job ORDER BY started_at DESC')],
        'activity': [{**dict(r), 'status': 'done'} for r in c.execute('SELECT * FROM activity ORDER BY at DESC')],
        'annotations': {f'{i}:{p}': json.loads(s) for i, p, s in c.execute('SELECT * FROM annotation')},
        'printed': {i: t for i, t in c.execute('SELECT id, printed_at FROM item WHERE printed_at IS NOT NULL')},
        'settings': {k: json.loads(v) for k, v in c.execute('SELECT * FROM setting')},
    }


def import_(c, d: dict):
    """Replace everything in the db with a backup. Files under items/ are left as they are."""
    if not isinstance(d, dict) or not isinstance(d.get('items'), list):
        raise HTTPException(400, 'This is not a Meowsic backup.')
    for t in ('annotation', 'play_session', 'item_tag', 'sheet_page', 'sheet', 'chord_chart', 'score', 'item', 'tag', 'job', 'activity'):
        c.execute(f'DELETE FROM {t}')
    ensure_tags(c, d.get('tags', []))
    printed = d.get('printed') or {}
    t0 = now_ms()
    for it in d['items']:
        if it.get('kind') not in KIND_COLS or not it.get('id'): continue
        it = {'createdAt': t0, 'updatedAt': t0, 'title': '', **it}
        it.setdefault('printedAt', printed.get(it['id']))
        if it.get('deleted') and not it.get('deletedAt'): it['deletedAt'] = t0
        if not it.get('deleted'): it['deletedAt'] = None
        write_item(c, {k: v for k, v in it.items() if v is not None and k != 'deleted'}, new=True)  # None -> column default
        dates = it.get('pageDates') or []
        for n, f in enumerate(it.get('pageFiles') or [], 1):
            c.execute('INSERT INTO sheet_page(item_id, page, file, captured_at) VALUES (?,?,?,?)', (it['id'], n, f, dates[n - 1] if n <= len(dates) else None))
    ids = {r[0] for r in c.execute('SELECT id FROM item')}
    c.executemany('INSERT INTO play_session VALUES (?,?,?)',
                  [(p['itemId'], p['openedAt'], p['closedAt']) for p in d.get('plays', []) if p.get('itemId') in ids])
    for key, strokes in (d.get('annotations') or {}).items():
        i, _, page = key.partition(':')
        if i in ids: c.execute('INSERT OR REPLACE INTO annotation VALUES (?,?,?)', (i, page, json.dumps(strokes)))
    for j in d.get('jobs', []):
        c.execute('INSERT OR REPLACE INTO job(id, kind, title, source, outputs, status, stage, progress, log, result, started_at, done_at, dismissed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            j['id'], 'version' if j.get('gen') or j.get('kind') == 'version' else 'transcribe', j.get('title', ''), j.get('source', ''),
            json.dumps(j.get('outputs', [])), j['status'] if j.get('status') in ('done', 'failed', 'cancelled') else 'failed',
            j.get('stage', 0), j.get('progress', 0), json.dumps(j.get('log', [])), json.dumps(j['result']) if j.get('result') else None,
            j.get('startedAt') or t0, j.get('doneAt'), int(bool(j.get('dismissed')))))
    for a in d.get('activity', []):
        if a.get('type') in ('transcribe', 'version'): continue  # old mock kept failed jobs here; skip
        c.execute('INSERT OR REPLACE INTO activity VALUES (?,?,?,?,?)', (a['id'], a['type'], a.get('title', ''), a.get('detail', ''), a.get('at') or t0))
    if 'settings' in d:
        c.execute('DELETE FROM setting')
        c.executemany('INSERT INTO setting VALUES (?,?)', [(k, json.dumps(v)) for k, v in d['settings'].items()])
    return len(ids)


@router.get('/backup')
def get_backup(c=Depends(conn)):
    stamp = datetime.datetime.now().strftime('%Y-%m-%d')
    return JSONResponse(export(c), headers={'Content-Disposition': f'attachment; filename="meowsic-backup-{stamp}.json"'})


@router.post('/backup/import')
def post_import(request: Request, body: dict = Body(...)):
    cfg = request.app.state.cfg
    snapshot(cfg, f'pre-import-{now_ms()}.db')  # a way back if the import was a mistake
    c = connect(cfg)
    try:
        n = import_(c, body)
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()
    return {'ok': True, 'items': n}


@router.post('/backup/snapshot')
def post_snapshot(request: Request):
    return {'ok': True, 'file': snapshot(request.app.state.cfg).name}
