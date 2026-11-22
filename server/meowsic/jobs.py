"""Jobs (transcriptions, "make another version") with a pluggable runner.

A runner is `fn(ctx: JobContext)`, run on its own thread. Real transcription plugs in later via
`app.state.job_runner = fn`; the default stub just says the engine is not installed yet.
"""
import json
import threading

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from .db import connect, job_json, now_ms, uid
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


def run_job(app, job_id):
    ctx = JobContext(app.state.cfg, job_id)
    try:
        ctx.update(status='running')
        app.state.job_runner(ctx)
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


@router.post('/jobs', status_code=201)
def create_job(request: Request, body: dict = Body(...)):
    """{kind: transcribe|version, title, source, outputs: [...]} -> queued, then runs on a thread."""
    kind = body.get('kind') or ('version' if body.get('gen') else 'transcribe')
    if kind not in ('transcribe', 'version') or not body.get('title'):
        raise HTTPException(400, 'kind (transcribe|version) and title are required')
    jid, t = uid('job'), now_ms()
    c = request.app.state.connect()
    c.execute("INSERT INTO job(id, kind, title, source, outputs, status, log, started_at) VALUES (?,?,?,?,?,'queued',?,?)",
              (jid, kind, body['title'], body.get('source', ''), json.dumps(body.get('outputs', [])),
               json.dumps([{'t': t, 'msg': 'Started'}]), t))
    c.commit()
    job = job_json(c.execute('SELECT * FROM job WHERE id=?', (jid,)).fetchone())
    c.close()
    threading.Thread(target=run_job, args=(request.app, jid), daemon=True).start()
    return job


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
