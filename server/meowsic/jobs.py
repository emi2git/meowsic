"""Jobs (transcriptions, "make another version", AI tag suggestions, photo → score, lyrics from a sheet) with a pluggable runner.

A runner is `fn(ctx: JobContext)`, run on its own thread (`app.state.job_runner`; the real ones are in
runners.py, `stub_runner` just says the engine is not installed).
"""
import json
import re
import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile

from .db import connect, job_json, now_ms, platform_of, uid
from .items import conn

router = APIRouter(prefix='/api')


class Cancelled(Exception):
    pass


class JobContext:
    def __init__(self, cfg, job_id):
        self.cfg, self.id = cfg, job_id

    def _job(self, c):
        return c.execute('SELECT * FROM job WHERE id=?', (self.id,)).fetchone()

    @property
    def job(self) -> dict:
        c = connect(self.cfg)
        try: return job_json(self._job(c))
        finally: c.close()

    def cancelled(self) -> bool:
        return self.job['status'] == 'cancelled'

    @property
    def params(self) -> dict:
        c = connect(self.cfg)
        try: return json.loads(c.execute('SELECT params FROM job WHERE id=?', (self.id,)).fetchone()[0] or '{}')
        finally: c.close()

    @property
    def work(self) -> Path:
        """<data>/work/<job id>/ (made on first use)."""
        d = self.cfg.work_dir / self.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def update(self, stage=None, progress=None, msg=None, status=None, result=None):
        """Write progress; raises Cancelled when the user cancelled the job."""
        c = connect(self.cfg)
        try:
            j = self._job(c)
            if j['status'] == 'cancelled': raise Cancelled()
            log = json.loads(j['log'])
            if msg: log.append({'t': now_ms(), 'msg': msg})
            done = status in ('done', 'failed')
            c.execute('UPDATE job SET stage=?, progress=?, log=?, status=?, result=?, done_at=? WHERE id=?', (
                j['stage'] if stage is None else stage, j['progress'] if progress is None else progress, json.dumps(log),
                status or j['status'], json.dumps(result) if result is not None else j['result'],
                now_ms() if done else j['done_at'], self.id))
            c.commit()
        finally:
            c.close()


def stub_runner(ctx: JobContext):
    ctx.update(msg='Transcription engine is not installed yet', status='failed')


def run_job(app, job_id, runner=None):
    ctx = JobContext(app.state.cfg, job_id)
    try:
        ctx.update(status='running')
        (runner or app.state.job_runner)(ctx)
        if ctx.job['status'] == 'running':
            ctx.update(progress=1, msg='Done', status='done')
    except Cancelled:
        pass
    except Exception as e:  # a crash marks the job failed, never the server
        try: ctx.update(msg=f'Failed: {e}', status='failed')
        except Cancelled: pass


def recover(cfg):
    """Jobs that were running when the server stopped cannot continue."""
    c = connect(cfg)
    rows = c.execute("SELECT id, log FROM job WHERE status IN ('queued','running')").fetchall()
    for r in rows:
        log = json.loads(r['log']) + [{'t': now_ms(), 'msg': 'Failed: the server restarted'}]
        c.execute("UPDATE job SET status='failed', log=?, done_at=? WHERE id=?", (json.dumps(log), now_ms(), r['id']))
    c.commit()
    c.close()


@router.get('/jobs')
def list_jobs(c=Depends(conn)):
    return [job_json(r) for r in c.execute('SELECT * FROM job ORDER BY started_at DESC')]


@router.get('/jobs/{job_id}')
def get_job(job_id: str, c=Depends(conn)):
    r = c.execute('SELECT * FROM job WHERE id=?', (job_id,)).fetchone()
    if not r: raise HTTPException(404, 'No such job')
    return job_json(r)


PARAMS = ('url', 'fromItemId', 'sheetId', 'artist', 'tags', 'key')  # body keys the runner reads later


def get_job_row(app, job_id) -> dict:
    c = app.state.connect()
    try: return job_json(c.execute('SELECT * FROM job WHERE id=?', (job_id,)).fetchone())
    finally: c.close()


def start_job(app, kind, title, source, outputs, params, jid=None, runner=None, thread=True):
    """Queue a job and run it on a thread (`thread=False`: run it here and return when it ends).
    `runner` overrides app.state.job_runner (the AI tag jobs bring their own)."""
    jid, t = jid or uid('job'), now_ms()
    c = app.state.connect()
    try:
        c.execute("INSERT INTO job(id, kind, title, source, outputs, status, log, started_at, params) VALUES (?,?,?,?,?,'queued',?,?,?)",
                  (jid, kind, title, source or '', json.dumps(outputs or []), json.dumps([{'t': t, 'msg': 'Started'}]), t, json.dumps(params)))
        c.commit()
        job = job_json(c.execute('SELECT * FROM job WHERE id=?', (jid,)).fetchone())
    finally:
        c.close()
    if thread: threading.Thread(target=run_job, args=(app, jid, runner), daemon=True).start()
    else: run_job(app, jid, runner)
    return job


@router.post('/jobs', status_code=201)
def create_job(request: Request, body: dict = Body(...)):
    """{kind: transcribe|version|omr|lyrics, title, source, outputs: [...], url?, fromItemId?, sheetId?, artist?, tags?} -> queued, then runs on a thread."""
    kind = body.get('kind') or ('version' if body.get('gen') else 'transcribe')
    if kind == 'sing':  # Make it sing (beta): checks the score has lyrics, then queues it
        from .voice import make_it_sing
        if not body.get('fromItemId'): raise HTTPException(400, 'fromItemId is required')
        c = request.app.state.connect()
        try: return make_it_sing(body['fromItemId'], request, c, request.app.state.cfg)
        finally: c.close()
    if kind not in ('transcribe', 'version', 'omr', 'lyrics') or not body.get('title'):
        raise HTTPException(400, 'kind (transcribe|version|omr|lyrics|sing) and title are required')
    if kind == 'lyrics' and not (body.get('fromItemId') and body.get('sheetId')):
        raise HTTPException(400, 'fromItemId (the score) and sheetId (the sheet with the words) are required')
    params, source = {k: body[k] for k in PARAMS if body.get(k) not in (None, '')}, body.get('source', '')
    if kind == 'transcribe':  # keep the full original link; the source shown is just the platform ('YouTube' / 'Facebook')
        from .runners import link_of
        url = params.get('url') or link_of({'source': source}, {})
        if url: params['url'], source = url, platform_of(url)
    return start_job(request.app, kind, body['title'], source, body.get('outputs', []), params)


def _outputs(v: str) -> list:
    """'["original","easy"]' or 'original,easy'."""
    v = (v or '').strip()
    try: out = json.loads(v) if v.startswith('[') else [x.strip() for x in v.split(',') if x.strip()]
    except ValueError: raise HTTPException(400, 'outputs must be a JSON list or comma-separated')
    return [str(x) for x in out] or ['original']


@router.post('/jobs/upload', status_code=201)
def upload_job(request: Request, file: UploadFile = File(...), title: str = Form(''), outputs: str = Form(''),
               artist: str = Form(''), tags: str = Form('[]'), source: str = Form('')):
    """Multipart audio (or video) + title + outputs -> a transcribe job; the file goes into the job's work dir."""
    name = re.sub(r'[/\\\x00-\x1f]', '-', Path(file.filename or 'audio').name).lstrip('.') or 'audio'
    outs = _outputs(outputs)
    try: tag_list = json.loads(tags or '[]')
    except ValueError: raise HTTPException(400, 'tags must be a JSON list')
    jid = uid('job')
    d = request.app.state.cfg.work_dir / jid / 'upload'
    d.mkdir(parents=True, exist_ok=True)
    with open(d / name, 'wb') as f:
        shutil.copyfileobj(file.file, f, 1 << 20)
    if not (d / name).stat().st_size:
        shutil.rmtree(d.parent, ignore_errors=True)
        raise HTTPException(400, 'The file is empty')
    params = {'upload': str(d / name), 'artist': artist, 'tags': tag_list}
    return start_job(request.app, 'transcribe', title.strip() or Path(name).stem, source or f'Audio file · {name}', outs,
                     {k: v for k, v in params.items() if v}, jid=jid)


@router.patch('/jobs/{job_id}')
def update_job(job_id: str, request: Request, body: dict = Body(...), c=Depends(conn)):
    """Progress from outside (the UI's updateJob): {stage, progress, msg, status}."""
    get_job(job_id, c)
    try:
        JobContext(request.app.state.cfg, job_id).update(body.get('stage'), body.get('progress'), body.get('msg'), body.get('status'), body.get('result'))
    except Cancelled:
        raise HTTPException(409, 'Job was cancelled')
    return get_job(job_id, c)


@router.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str, c=Depends(conn)):
    j = get_job(job_id, c)
    if j['status'] in ('queued', 'running'):
        log = j['log'] + [{'t': now_ms(), 'msg': 'Cancelled'}]
        c.execute("UPDATE job SET status='cancelled', log=?, done_at=? WHERE id=?", (json.dumps(log), now_ms(), job_id))
    return get_job(job_id, c)


@router.post('/jobs/{job_id}/dismiss')
def dismiss_job(job_id: str, c=Depends(conn)):
    get_job(job_id, c)
    c.execute('UPDATE job SET dismissed=1 WHERE id=?', (job_id,))
    return {'ok': True}
