"""FastAPI app: /api/* JSON plus the web/ UI as static files (never cached)."""
import json
import threading
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from . import ai, backup, booksplit, chords, cleanup, items, jobs, pages, photoimport, runners, titles
from .db import WEB_DIR, Config, connect, init_db, log_event
from .items import conn


def create_app(data=None, background=True) -> FastAPI:
    cfg = Config.from_env(data)
    init_db(cfg)
    c0 = connect(cfg); photoimport.ensure_schema(c0); c0.close()  # sheet_page.photo_id + photo_import (From Photos)
    jobs.recover(cfg)
    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(app):
        if background:
            threading.Thread(target=backup.daily_loop, args=(cfg, stop), daemon=True).start()
        yield
        stop.set()

    app = FastAPI(title='Meowsic', lifespan=lifespan)
    app.state.cfg = cfg
    app.state.connect = lambda: connect(cfg)
    app.state.job_runner = runners.dispatch

    @app.middleware('http')
    async def no_store(request, call_next):
        resp = await call_next(request)
        if 'cache-control' not in resp.headers: resp.headers['Cache-Control'] = 'no-store'  # page images set their own (no-cache + ETag)
        return resp

    for r in (items.router, jobs.router, backup.router, chords.router, ai.router, cleanup.router, pages.router, booksplit.router, titles.router, photoimport.router):
        app.include_router(r)

    @app.get('/api/health')
    def health():
        return {'ok': True, 'data': str(cfg.data)}

    # ---- settings: {key: any JSON} ----
    @app.get('/api/settings')
    def get_settings(c=Depends(conn)):
        return {k: json.loads(v) for k, v in c.execute('SELECT key, value FROM setting')}

    @app.put('/api/settings')
    def put_settings(body: dict = Body(...), c=Depends(conn)):
        """Merge keys; a null value removes the key."""
        for k, v in body.items():
            if v is None: c.execute('DELETE FROM setting WHERE key=?', (k,))
            else: c.execute('INSERT OR REPLACE INTO setting VALUES (?,?)', (k, json.dumps(v)))
        return get_settings(c)

    # ---- activity: change events plus jobs, newest first (like the UI's store.activity()) ----
    @app.get('/api/activity')
    def activity(limit: int = 500, c=Depends(conn)):
        acts = [{**dict(r), 'status': 'done'} for r in c.execute('SELECT * FROM activity ORDER BY at DESC LIMIT ?', (limit,))]
        js = [{**j, 'type': j['kind'], 'at': j['startedAt']} for j in jobs.list_jobs(c)]
        return sorted(acts + js, key=lambda a: -a['at'])[:limit]

    @app.post('/api/activity', status_code=201)
    def add_activity(body: dict = Body(...), c=Depends(conn)):
        log_event(c, body['type'], body.get('title', ''), body.get('detail', ''))
        return {'ok': True}

    if WEB_DIR.is_dir():
        app.mount('/', StaticFiles(directory=WEB_DIR, html=True), name='web')
    return app
