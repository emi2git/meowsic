"""Make it sing (beta): a score with English, Vietnamese or Chinese lyrics -> a sung vocal + soft piano, saved with the score.

POST /api/items/{id}/sing   -> a 'sing' job (sing/sing.py in SoulX-Singer's own venv, in a subprocess);
                               optional body {voice, octave}: the singer (default zh_target, a low male voice, for
                               every language: the user's pick, take C) and octaves to move the melody (default:
                               the auto octave, nearest the singer's own range)
GET  /api/items/{id}/vocal  -> the rendered audio (m4a; Range requests, so Safari can seek)
The score keeps the file name in score.vocal_audio ('<folder> vocal.m4a') and the tempo it was sung at in
score.vocal_bpm: the player's Voice toggle plays it in place of the piano and maps the playhead with that tempo.
"""
import hashlib
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from . import singscore
from .db import connect, folder_path, get_item, now_ms
from .items import cfg, conn, item_dir, must_item, safe_file
from .jobs import Cancelled, JobContext, start_job
from .undolog import record_undo

router = APIRouter(prefix='/api')

REPO = Path(__file__).resolve().parents[2]
SING = REPO / 'sing' / 'sing.py'
SOULX = Path(os.environ.get('MEOWSIC_SOULX', Path.home() / 'ai' / 'SoulX-Singer'))
STAGES = ['Read the score', 'Load the voice', 'Sing', 'Piano and mix', 'Check']


def sing_python() -> Path:
    return Path(os.environ.get('MEOWSIC_SING_PYTHON', SOULX / '.venv' / 'bin' / 'python'))


def score_xml(cf, it) -> Path:
    if it['kind'] != 'score': raise HTTPException(400, 'Not a score')
    p = safe_file(item_dir(cf, it), it['musicxml'] or f'{it["folder"]}.musicxml')
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    return p


@router.post('/items/{item_id}/sing', status_code=201)
def make_it_sing(item_id: str, request: Request, body: dict | None = Body(None), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    xml = score_xml(cf, it)
    if not singscore.has_lyrics(xml.read_text(encoding='utf-8')):
        raise HTTPException(400, 'This score has no lyrics to sing')
    body = body if isinstance(body, dict) else {}
    params = {'fromItemId': item_id}
    voice = body.get('voice')
    if voice:  # sing.py checks it against the installed voices
        if not isinstance(voice, str) or not re.fullmatch(r'[a-z][a-z0-9_]{1,30}', voice): raise HTTPException(400, 'Unknown voice')
        params['voice'] = voice
    if body.get('octave') is not None:
        if not isinstance(body['octave'], int) or isinstance(body['octave'], bool) or not -2 <= body['octave'] <= 2:
            raise HTTPException(400, 'octave must be a whole number from -2 to 2')
        params['octave'] = body['octave']
    return start_job(request.app, 'sing', it['title'], 'Singing voice', ['voice'], params)


@router.get('/items/{item_id}/vocal')
def vocal_audio(item_id: str, c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    if not it.get('vocalAudio'): raise HTTPException(404, 'This score has not been sung yet')
    p = safe_file(item_dir(cf, it), it['vocalAudio'])
    if not p.is_file(): raise HTTPException(404, 'The sung audio file is missing')
    media = {'.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'}.get(p.suffix.lower(), 'application/octet-stream')
    return FileResponse(p, media_type=media, headers={'Cache-Control': 'no-cache'})


def _keep(d: Path, name: str | None) -> str | None:
    """Copy items/<folder>/<name> (+ its .wav) into .history/vocal-<ms>-<name>; returns that path (relative) or None."""
    if not name or not (d / name).is_file(): return None
    h = d / '.history'
    h.mkdir(exist_ok=True)
    stamp = now_ms()
    rel = f'.history/vocal-{stamp}-{name}'
    shutil.copyfile(d / name, d / rel)
    wav = d / (Path(name).stem + '.wav')
    if wav.is_file(): shutil.copyfile(wav, h / f'vocal-{stamp}-{wav.name}')
    return rel


def _sha(p: Path) -> str | None:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.is_file() else None


def save_vocal(cf, c, it, m4a: Path, wav: Path | None, bpm: float) -> str:
    """Copy the render into the score's folder and point the score at it (a take it replaces is kept in .history/).
    Logs an Activities row whose Undo puts the score back as it was. Returns the m4a's name."""
    d = folder_path(cf, it['folder'])
    d.mkdir(parents=True, exist_ok=True)
    name = f'{it["folder"]} vocal.m4a'
    before = {'audio': it.get('vocalAudio'), 'bpm': it.get('vocalBpm'), 'history': _keep(d, it.get('vocalAudio'))}
    shutil.copyfile(m4a, d / name)
    if wav and wav.is_file(): shutil.copyfile(wav, d / f'{it["folder"]} vocal.wav')
    c.execute('UPDATE score SET vocal_audio=?, vocal_bpm=? WHERE item_id=?', (name, bpm, it['id']))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    record_undo(c, 'sing', {'op': 'vocal', 'id': it['id'], 'title': it['title'], 'before': before, 'after': {'audio': name, 'bpm': bpm, 'sha': _sha(d / name)}},
                f'Made “{it["title"]}” sing', f'Voice sung at {bpm:g} bpm (Make it sing, beta)')
    c.commit()
    return name


def undo_vocal(c, cf, s, mode):
    """Activities → Undo of a 'Make it sing' row: the score goes back to its earlier take (or none); the take being
    undone stays in items/<folder>/.history/. Conflict when it was sung again since."""
    from .undolog import _q
    it = get_item(c, s['id'])
    what = _q(it['title'] if it else s.get('title', ''))
    if not it or it.get('deleted'): return [{'status': 'skip', 'what': what, 'why': 'the score is gone'}]
    b, a = s.get('before') or {}, s.get('after') or {}
    d = folder_path(cf, it['folder'])
    now = (it.get('vocalAudio'), it.get('vocalBpm'))
    if now == (b.get('audio'), b.get('bpm')) and not b.get('history'): return [{'status': 'skip', 'what': what, 'why': 'already back'}]
    same = now == (a.get('audio'), a.get('bpm')) and (not a.get('sha') or _sha(d / a['audio']) == a['sha'])
    if not same and mode != 'force': return [{'status': 'conflict', 'what': what, 'why': 'sung again since'}]
    if mode != 'check':
        _keep(d, it.get('vocalAudio'))
        if b.get('history') and b.get('audio') and (d / b['history']).is_file():
            shutil.copyfile(d / b['history'], d / b['audio'])
            old_wav = d / b['history'].replace(b['audio'], Path(b['audio']).stem + '.wav')
            if old_wav.is_file(): shutil.copyfile(old_wav, d / (Path(b['audio']).stem + '.wav'))
        c.execute('UPDATE score SET vocal_audio=?, vocal_bpm=? WHERE item_id=?', (b.get('audio'), b.get('bpm'), it['id']))
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    return [{'status': 'ok', 'what': what}]


def sing_runner(ctx: JobContext):
    item_id = ctx.params.get('fromItemId')
    c = connect(ctx.cfg)
    try: it = get_item(c, item_id)
    finally: c.close()
    if not it or it['kind'] != 'score': raise RuntimeError('The score is gone')
    xml = score_xml(ctx.cfg, it)
    py = sing_python()
    if not py.exists(): raise RuntimeError('The singing voice is not set up on this Mac (~/ai/SoulX-Singer/.venv missing)')
    out = ctx.work / 'sing'
    cmd = [str(py), str(SING), '--xml', str(xml), '--out', str(out), '--name', 'vocal', '--check']
    if it.get('bpm'): cmd += ['--bpm', str(it['bpm'])]
    if ctx.params.get('voice'): cmd += ['--voice', str(ctx.params['voice'])]
    if ctx.params.get('octave') is not None: cmd += ['--octave', str(int(ctx.params['octave']))]
    ctx.update(stage=0, progress=0)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(REPO),
                            env={**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
    done, tail = None, []
    stop = threading.Event()

    def watch():  # cancel kills the render
        while not stop.wait(1):
            if ctx.cancelled():
                proc.kill(); return
    threading.Thread(target=watch, daemon=True).start()
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith('{'):
                if line: tail = (tail + [line])[-5:]
                continue
            try: ev = json.loads(line)
            except ValueError: continue
            if ev.get('done'): done = ev; continue
            ctx.update(stage=ev.get('stage'), progress=ev.get('progress'), msg=ev.get('msg'))
        proc.wait()
    finally:
        stop.set()
        if proc.poll() is None: proc.kill()
    if ctx.cancelled(): raise Cancelled()
    if proc.returncode or not done:
        raise RuntimeError((tail[-1] if tail else f'the voice stopped (exit {proc.returncode})')[:300])
    c = connect(ctx.cfg)
    try: name = save_vocal(ctx.cfg, c, it, Path(done['m4a']), Path(done['wav']), float(done['bpm']))
    finally: c.close()
    rep = done.get('report') or {}
    msg = f'Done — sung at {done["bpm"]:g} bpm'
    if rep: msg += f'; {rep["within50cPct"]}% of {rep["notes"]} notes within 50 cents, {rep["notesSilent"]} silent'
    if rep.get('voice'): msg += f'; voice {rep["voice"]}, octave {rep.get("octaveShift", 0) // 12:+d}'
    ctx.update(stage=len(STAGES) - 1, progress=1, msg=msg, status='done', result=[item_id])
    return name
