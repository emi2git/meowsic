"""Runs Emi Music Note's pipeline for Meowsic. Started with THAT project's venv python, never imported by the server.

usage: python musicnote_driver.py <emi-music-note dir> <src> <versions JSON> <opts JSON>
env:   TRANSCRIBE_ROOT = the job's work dir (the pipeline writes only there)
stdout: one line per event, '@@ ' + JSON:
  {"ev": "stages", "version": v, "stages": [...]}       progress of one pipeline run
  {"ev": "made", "version": v, "dir": d, "has_vocals": b} one version finished
  {"ev": "error", "error": msg}
"""
import json
import os
import sys


def emit(obj):
    print('@@ ' + json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    root, src, versions, opts = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])
    sys.path.insert(0, root)
    from pipeline.run import run
    for v in versions:
        def report(job, v=v):
            emit({'ev': 'stages', 'version': v, 'stages': [{k: s.get(k) for k in ('name', 'status', 'secs', 'info')} for s in job['stages']]})
        job = run(src, {**opts, 'version': v}, report)
        if job['status'] == 'error':
            emit({'ev': 'error', 'error': job.get('error') or 'the transcription failed', 'trace': job.get('trace', '')[-1500:]})
            sys.stdout.flush()
            os._exit(1)
        from pipeline.util import ROOT
        emit({'ev': 'made', 'version': v, 'dir': str(ROOT / job['slug']), 'title': job.get('title'), 'has_vocals': job.get('has_vocals')})


if __name__ == '__main__':
    main()
    # skip interpreter teardown: MLX / torch threads can abort the process there ("recursive_mutex lock failed")
    sys.stdout.flush()
    os._exit(0)
