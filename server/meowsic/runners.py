"""The real job runners.

transcribe: Emi Music Note's pipeline (its own venv, in a subprocess) turns a link or an audio file into
            original / vocal / lead; other versions are arranged from that with music21 (arrange.py).
version:    arrange an existing score item into other versions (music21, rule-based).
Every finished version becomes its own score item (tag = the version's name), all sharing one group id.
"""
import collections
import json
import logging
import math
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import arrange
from .arrange import VERSION_TAGS
from .db import connect, folder_path, get_item, now_ms, uid, write_item
from .jobs import Cancelled, JobContext

log = logging.getLogger('meowsic')

MUSICNOTE = Path(os.environ.get('MEOWSIC_MUSICNOTE', Path.home() / 'git' / 'apps' / 'emi-music-note'))
DRIVER = Path(__file__).with_name('musicnote_driver.py')
STAGES = ['Download audio', 'Separate voice and instruments', 'Find the notes', 'Read the lyrics',
          'Find key, beat and chords', 'Write the score', 'Draw the pages']
GEN_STAGES = ['Read the score', 'Arrange', 'Write the score', 'Draw the pages']
PIPE_TO_UI = {'fetch': 0, 'separate': 1, 'piano notes': 2, 'vocal notes': 2, 'lyrics': 3, 'analyze': 4, 'score': 5, 'pdf': 6}
EXPECT = [30, 90, 90, 40, 20, 15, 5]  # rough seconds per UI stage, only to move the progress bar
DIRECT = ('original', 'vocal', 'lead')  # versions the pipeline writes itself
LINK = re.compile(r'(https?://)?((www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com|facebook\.com|fb\.watch|fb\.com)/\S+)', re.I)


def pdf_on() -> bool:
    return os.environ.get('MEOWSIC_PDF', '1') != '0'


def dispatch(ctx: JobContext):
    {'version': version_runner, 'omr': omr_runner}.get(ctx.job['kind'], transcribe_runner)(ctx)


# ---------- saving results as items ----------

def save_outputs(ctx: JobContext, outs, *, title, source, artist='', tags=(), group_id=None, key='', bpm=None):
    """outs: [(version, musicxml, mid|None, pdf|None, {key, bpm})] -> one score item each, in one transaction.
    Files: items/<id> <title>/<id> <title>.musicxml|.mid|.pdf. Returns the new item ids."""
    cfg, t, made = ctx.cfg, now_ms(), []
    gid = group_id or uid('g')
    c = connect(cfg)
    try:
        if ctx.cancelled(): raise Cancelled()
        for v, xml, mid, pdf, extra in outs:
            it = {'id': uid('m'), 'kind': 'score', 'title': title, 'artist': artist or '',
                  'tags': [VERSION_TAGS[v], *[x for x in tags if x not in VERSION_TAGS.values()]],
                  'createdAt': t, 'updatedAt': t, 'originAt': t, 'version': v, 'source': source, 'groupId': gid,
                  'key': extra.get('key') or key or '', 'bpm': extra.get('bpm') or bpm}
            write_item(c, it, new=True)
            d = folder_path(cfg, it['folder'])
            d.mkdir(parents=True, exist_ok=True)
            made.append((d, it['id']))
            names = {}
            for col, src, ext in (('musicxml', xml, '.musicxml'), ('midi', mid, '.mid'), ('pdf', pdf, '.pdf')):
                if src and Path(src).is_file():
                    names[col] = it['folder'] + ext
                    shutil.copyfile(src, d / names[col])
            c.execute(f'UPDATE score SET {",".join(f"{k}=?" for k in names)} WHERE item_id=?', [*names.values(), it['id']])
        c.commit()
    except BaseException:
        c.rollback()
        for d, _ in made:
            shutil.rmtree(d, ignore_errors=True)
        raise
    finally:
        c.close()
    return [i for _, i in made]


def finish(ctx, ids, versions):
    ctx.update(progress=1, msg='Done — added ' + ', '.join(VERSION_TAGS[v] for v in versions), status='done', result=ids)


# ---------- arranging (shared by both runners) ----------

def arrange_versions(ctx, base_xml: Path, versions, out_dir: Path, *, title, artist, stage_arrange, stage_write, stage_pdf):
    """music21 versions of base_xml into out_dir. Returns [(version, xml, mid, pdf, {})]."""
    out_dir.mkdir(parents=True, exist_ok=True)
    tune = arrange.read(base_xml)
    scores = []
    for i, v in enumerate(versions):
        ctx.update(stage=stage_arrange, progress=i / len(versions))
        scores.append((v, arrange.arrange(tune, v, title=title, artist=artist)))
        ctx.update(msg=f'{VERSION_TAGS[v]} — arranged')
    outs = []
    for i, (v, sc) in enumerate(scores):
        ctx.update(stage=stage_write, progress=i / len(scores))
        xml, mid = out_dir / f'{v}.musicxml', out_dir / f'{v}.mid'
        arrange.write_files(sc, xml, mid)
        outs.append([v, xml, mid, None, {}])
    if stage_write != stage_arrange:
        ctx.update(msg=f'{STAGES[5] if stage_write == 5 else GEN_STAGES[2]} — done')
    if pdf_on():
        for i, o in enumerate(outs):
            ctx.update(stage=stage_pdf, progress=i / len(outs))
            pdf = out_dir / f'{o[0]}.pdf'
            if arrange.render_pdf(o[1], pdf): o[3] = pdf
            else: ctx.update(msg=f'{VERSION_TAGS[o[0]]} — no PDF (MuseScore is not available)')
    return [tuple(o) for o in outs]


# ---------- version runner ----------

def version_runner(ctx: JobContext):
    job, p = ctx.job, ctx.params
    want = [v for v in dict.fromkeys(job['outputs']) if v in arrange.ARRANGED]
    skipped = [v for v in job['outputs'] if v not in arrange.ARRANGED]
    if not p.get('fromItemId'): raise RuntimeError('No score to start from (fromItemId is missing)')
    c = connect(ctx.cfg)
    try: src = get_item(c, p['fromItemId'])
    finally: c.close()
    if not src or src['kind'] != 'score': raise RuntimeError('The score to start from is gone')
    if not src.get('musicxml') or not src.get('folder'): raise RuntimeError('That score has no MusicXML file')
    xml = folder_path(ctx.cfg, src['folder']) / src['musicxml']
    if not xml.is_file(): raise RuntimeError('That score has no MusicXML file')
    for v in skipped: ctx.update(msg=f'{VERSION_TAGS.get(v, v)} — cannot be made from a score, skipped')
    if not want: raise RuntimeError('No version to make')
    ctx.update(stage=0, progress=0)
    work = ctx.work
    shutil.copyfile(xml, work / 'from.musicxml')
    ctx.update(stage=1, progress=0, msg=f'{GEN_STAGES[0]} — done')
    outs = arrange_versions(ctx, work / 'from.musicxml', want, work / 'out', title=job['title'], artist=p.get('artist', src['artist']),
                            stage_arrange=1, stage_write=2, stage_pdf=3)
    ctx.update(stage=3, progress=1)
    tags = p['tags'] if isinstance(p.get('tags'), list) else src['tags']
    ids = save_outputs(ctx, outs, title=job['title'], source=job['source'] or f'From the score “{src["title"]}”',
                       artist=p.get('artist', src['artist']), tags=tags, group_id=src.get('groupId'),
                       key=src.get('key', ''), bpm=src.get('bpm'))
    if pdf_on(): ctx.update(msg=f'{GEN_STAGES[3]} — done')
    finish(ctx, ids, want)


# ---------- photo → score (beta) ----------
OMR_DIR = Path(__file__).resolve().parents[2] / 'omr'
OMR_STAGES = ['Read the notes', 'Read chord names and words', 'Check every bar', 'Write the score']
OMR_STEP = {'notes': 0, 'lyrics': 1, 'chords': 1, 'words': 1, 'check': 2, 'done': 3}


def omr_runner(ctx: JobContext):
    """Sheet pages → one score: junk trimmed off each page, then omr/omr.py (homr + Audiveris + Vision)."""
    from . import trim
    job, p = ctx.job, ctx.params
    c = connect(ctx.cfg)
    try: src = get_item(c, p.get('fromItemId', ''))
    finally: c.close()
    if not src or src['kind'] != 'sheet' or not src.get('pageFiles'): raise RuntimeError('That sheet has no pages')
    py = OMR_DIR / '.venv' / 'bin' / 'python'
    if not py.exists(): raise RuntimeError('Photo → score is not set up on this Mac (omr/.venv missing)')
    d = folder_path(ctx.cfg, src['folder'])
    work = ctx.work
    pages = []
    ctx.update(stage=0, progress=0, msg=f'{len(src["pageFiles"])} page(s)')
    for k, f in enumerate(src['pageFiles'], 1):
        dst = work / f'in{k}.png'
        r = trim.analyze(d / f)
        box = r['trim'] or {}
        trim.crop(d / f, dst, box.get('top', 0), box.get('bottom', 1))
        pages.append(str(dst))
    out = work / 'out'
    proc = subprocess.Popen([str(py), str(OMR_DIR / 'omr.py'), '--out', str(out), '--title', job['title'], *pages],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(OMR_DIR))
    report, tail = None, []
    for line in proc.stdout:
        line = line.strip()
        if ctx.cancelled(): proc.kill(); raise Cancelled()
        try: ev = json.loads(line)
        except ValueError: tail = (tail + [line])[-5:]; continue
        st = OMR_STEP.get(ev.get('step'), 0)
        ctx.update(stage=st, progress=ev.get('progress', 0), msg=ev.get('msg'))
        if ev.get('step') == 'done': report = ev.get('report')
    if proc.wait() != 0 or not (out / 'score.musicxml').is_file():
        raise RuntimeError('Could not read the sheet: ' + (tail[-1] if tail else 'unknown error'))
    checks = report.get('check', []) if report else []
    ids = save_outputs(ctx, [('original', str(out / 'score.musicxml'), None, None, {})], title=job['title'],
                       source=f'From the sheet “{src["title"]}” (photo → score, beta)', artist=src.get('artist', ''),
                       tags=[*src.get('tags', []), 'From a sheet'])
    where = ', '.join(f"p{x['page']} bar {x['bar']}" for x in checks[:12])
    ctx.update(progress=1, status='done', result=ids,
               msg=f"Done — {report.get('bars', '?')} bars" + (f'; please check {len(checks)}: {where}' if checks else '; no bars to check'))


# ---------- transcription runner ----------

def link_of(job, params) -> str | None:
    """The YouTube / Facebook link: `url`, else the one in `source` ('YouTube · youtu.be/…')."""
    for s in (params.get('url'), job.get('source')):
        m = LINK.search(s or '')
        if m: return (m.group(1) or 'https://') + m.group(2)
    return None


def driver_env(work: Path) -> dict:
    env = dict(os.environ)
    env['TRANSCRIBE_ROOT'] = str(work)
    env.setdefault('HF_HUB_CACHE', str(Path.home() / 'ai' / 'models' / 'huggingface'))
    env.setdefault('TORCH_HOME', str(Path.home() / 'ai' / 'models' / 'torch'))
    env['PATH'] = os.pathsep.join([str(MUSICNOTE / '.venv' / 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.get('PATH', '/usr/bin:/bin')])
    env.pop('PYTHONPATH', None)
    env.pop('VIRTUAL_ENV', None)
    return env


class Progress:
    """Turns the pipeline's stage reports into the UI's 7-stage list, log lines and a moving bar."""

    def __init__(self, ctx):
        self.ctx, self.stage, self.since, self.logged = ctx, 0, time.time(), set()

    def stages(self, sts):
        by = collections.defaultdict(list)
        for s in sts:
            by[PIPE_TO_UI[s['name']]].append(s)
        for i in range(len(STAGES)):
            ss = by.get(i, [])
            if not ss or i in self.logged: continue
            if all(s['status'] in ('done', 'cached', 'skipped') for s in ss):
                self.logged.add(i)
                if all(s['status'] == 'skipped' for s in ss):
                    why = next((s['info'] for s in ss if isinstance(s.get('info'), str)), '')
                    self.ctx.update(msg=f'{STAGES[i]} — skipped' + (f' ({why})' if why else ''))
                else:
                    secs = sum(s.get('secs') or 0 for s in ss)
                    self.ctx.update(msg=f'{STAGES[i]} — done' + (f' ({secs:g} s)' if secs >= 1 else ' (kept from before)' if any(s['status'] == 'cached' for s in ss) else ''))
        now = next((i for i in range(len(STAGES)) if by.get(i) and any(s['status'] in ('pending', 'running') for s in by[i])), None)
        if now is not None and now > self.stage:
            self.stage, self.since = now, time.time()
            self.ctx.update(stage=now, progress=0)

    def tick(self):
        e = time.time() - self.since
        self.ctx.update(progress=round(0.95 * (1 - math.exp(-e / EXPECT[min(self.stage, 6)])), 3))


def run_driver(ctx, work, src, versions, opts, prog: Progress):
    """Run the pipeline for `versions` in Music Note's venv; returns {version: song dir}. Cancel kills it."""
    py = MUSICNOTE / '.venv' / 'bin' / 'python'
    if not py.exists(): raise RuntimeError(f'Emi Music Note is not installed ({py} is missing)')
    proc = subprocess.Popen([str(py), str(DRIVER), str(MUSICNOTE), src, json.dumps(versions), json.dumps(opts)],
                            cwd=str(MUSICNOTE), env=driver_env(work), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, start_new_session=True)
    lines, tail, made, err = queue.Queue(), collections.deque(maxlen=20), {}, None

    def read():
        for line in proc.stdout: lines.put(line)
        lines.put(None)
    threading.Thread(target=read, daemon=True).start()
    last_tick = 0
    try:
        while True:
            try: line = lines.get(timeout=0.5)
            except queue.Empty: line = ''
            if line is None: break
            if line.startswith('@@ '):
                ev = json.loads(line[3:])
                if ev['ev'] == 'stages':
                    prog.stages(ev['stages'])
                elif ev['ev'] == 'made':
                    made[ev['version']] = ev
                elif ev['ev'] == 'error':
                    err = ev['error']
                    log.warning('transcription %s failed: %s\n%s', ctx.id, err, ev.get('trace', ''))
            elif line.strip():
                tail.append(line.rstrip())
            if time.time() - last_tick > 1:  # also notices a cancel (update raises Cancelled)
                last_tick = time.time()
                prog.tick()
        if proc.wait() != 0:
            raise RuntimeError(err or ('the transcription stopped: ' + ' | '.join(list(tail)[-3:]) if tail else 'the transcription stopped'))
    finally:
        if proc.poll() is None:
            try: os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: proc.wait(5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
    return made


def snapshot(ev, v):
    """Files of one pipeline version, kept by the pipeline in <song>/versions/<v>/."""
    d = Path(ev['dir']) / 'versions' / v
    info = {}
    try: info = json.loads((d / 'score.json').read_text())
    except (OSError, ValueError): pass
    if not (d / 'score.musicxml').is_file(): raise RuntimeError(f'The pipeline wrote no {VERSION_TAGS[v]} score')
    extra = {'key': info.get('key') or '', 'bpm': info.get('bpm')}
    return (v, d / 'score.musicxml', d / 'score.mid', (d / 'score.pdf') if pdf_on() else None, extra)


def transcribe_runner(ctx: JobContext):
    job, p = ctx.job, ctx.params
    outputs = [v for v in dict.fromkeys(job['outputs'] or ['original']) if v in VERSION_TAGS]
    if not outputs: raise RuntimeError('No version to make')
    up = p.get('upload')
    src = up if up and Path(up).is_file() else link_of(job, p)
    if not src: raise RuntimeError('No YouTube / Facebook link or audio file to transcribe')
    work = ctx.work
    direct = [v for v in outputs if v in DIRECT]
    arranged = [v for v in outputs if v not in DIRECT]
    runs = list(direct) or ['original']
    if arranged and 'original' not in runs: runs.append('original')
    prog = Progress(ctx)
    ctx.update(stage=0, progress=0, msg='Reading ' + ('the audio file' if src == up else src))
    opts = {'lyrics': 'auto'}
    made = run_driver(ctx, work, src, runs, opts, prog)
    outs = [snapshot(made[v], v) for v in direct]
    if arranged:
        ev = made['original']
        base = snapshot(ev, 'original')[1]
        if ev.get('has_vocals'):  # the tune is the singing: arrange from the piano + vocals sheet
            if 'vocal' not in made: made.update(run_driver(ctx, work, src, ['vocal'], opts, prog))
            base = snapshot(made['vocal'], 'vocal')[1]
        ctx.update(stage=5, progress=0)
        outs += arrange_versions(ctx, base, arranged, work / 'arranged', title=job['title'], artist=p.get('artist', ''),
                                 stage_arrange=5, stage_write=5, stage_pdf=6)
    ctx.update(stage=6, progress=1, msg=f'{STAGES[6]} — done' if 6 not in prog.logged else None)
    outs.sort(key=lambda o: outputs.index(o[0]))
    key = next((o[4]['key'] for o in outs if o[4].get('key')), '')
    bpm = next((o[4]['bpm'] for o in outs if o[4].get('bpm')), None)
    ids = save_outputs(ctx, outs, title=job['title'], source=job['source'] or ('Audio file' if src == up else src),
                       artist=p.get('artist', ''), tags=p.get('tags') or [], key=key, bpm=bpm)
    finish(ctx, ids, [o[0] for o in outs])
