"""Orchestrates stages with caching + timings. Used by both the CLI and the web server."""
import copy, fcntl, hashlib, json, shutil, time, traceback
from pathlib import Path

from . import stages, score
from .util import ROOT, atomic_write, read_json, write_json

LAYOUTS = ["auto", "piano", "piano-vocal", "lead"]
MODES = ["auto", "direct", "arrange", "accomp"]
LYRICS = ["auto", "find", "paste", "none"]   # from the singing | look up online | pasted text | none
STAGES = ["fetch", "separate", "piano notes", "vocal notes", "lyrics", "analyze", "score", "pdf"]
# --force <name> / version bump deletes these outputs
OUTPUTS = {"fetch": ["source.wav"], "separate": ["stems"], "notes": ["midi"],
           "lyrics": ["lyrics.json", "lyrics.txt"], "analyze": ["analysis.json"]}


# ---- versions of a sheet (original, easy, ...): each one made is kept, so switching back is instant
# and notes changed by hand stay with the version they were changed in.
def _snap_files(d: Path):
    s = d.name
    return {f"{s}.musicxml": "score.musicxml", f"{s}.pdf": "score.pdf", f"{s}-score.mid": "score.mid",
            f"{s}-piano.mid": "piano.mid", "score.json": "score.json", f"{s}.auto.musicxml": "auto.musicxml"}


def fingerprint(d: Path, opts: dict) -> str:
    """Changes whenever a rebuild would give a different sheet: the options, the notes and words the
    sheet is made from, and the code that makes it."""
    skip = {"force", "fresh", "lyrics_text", "piano_only", "piano_stem"}
    stamp = lambda f: [f.name, f.stat().st_size, int(f.stat().st_mtime)] if f.exists() else [f.name]   # noqa: E731
    here = Path(__file__).parent
    data = {"opts": {k: v for k, v in sorted(opts.items()) if k not in skip and v not in (None, "", False)},
            "in": [stamp(d / n) for n in ("analysis.json", "lyrics.json", "lyrics_user.txt", "lyrics_found.txt", "meta.json")]
                  + [stamp(f) for f in sorted((d / "midi").glob("*.mid"))],
            "code": [stamp(here / n) for n in ("score.py", "rhythm.py", "lyricfit.py")]}
    return hashlib.sha1(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def save_snapshot(d: Path, version: str, fp: str | None = None):
    """Keep the sheet that is in the song folder now as this version's copy."""
    snap = d / "versions" / version
    snap.mkdir(parents=True, exist_ok=True)
    for main, kept in _snap_files(d).items():
        if (d / main).exists():
            shutil.copy2(d / main, snap / kept)
        else:
            (snap / kept).unlink(missing_ok=True)
    if fp:
        write_json(snap / "fp.json", {"fp": fp})


def restore_snapshot(d: Path, version: str, fp: str) -> bool:
    """Bring a kept version back as the song's sheet, if it was made from the same notes and options."""
    snap = d / "versions" / version
    if (read_json(snap / "fp.json", {}) or {}).get("fp") != fp or not (snap / "score.musicxml").exists():
        return False
    for main, kept in _snap_files(d).items():
        if (snap / kept).exists():
            shutil.copy2(snap / kept, d / main)
        else:
            (d / main).unlink(missing_ok=True)
    return True


def _rm(d: Path, names):
    for n in names:
        p = d / n
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)


def _source_fp(d: Path):
    s = (d / "source.wav").stat()
    return f"{s.st_size}:{int(s.st_mtime)}"


def invalidate(d: Path, force=()):
    """Drop cached outputs whose stage version or source fingerprint no longer matches."""
    man = read_json(d / "manifest.json", {})
    for f in force:
        _rm(d, OUTPUTS.get(f, []))
        if f == "separate":
            _rm(d, ["midi", "lyrics.json", "lyrics.txt", "analysis.json"])
    for stage, ver in stages.VERSIONS.items():
        if man.get(stage) not in (None, ver):
            _rm(d, OUTPUTS[stage])
    if (d / "source.wav").exists() and man.get("source_fp") not in (None, _source_fp(d)):
        _rm(d, [n for k, v in OUTPUTS.items() if k != "fetch" for n in v])


def _save_manifest(d: Path):
    man = {"source_fp": _source_fp(d)}
    for stage, ver in stages.VERSIONS.items():
        if all((d / n).exists() for n in OUTPUTS[stage]):
            man[stage] = ver
    write_json(d / "manifest.json", man)


def run(src: str, opts: dict, report=lambda job: None):
    opts = score.with_version(opts)
    lyr_text = (opts.pop("lyrics_text", None) or "").strip()      # kept out of logs and job files
    if lyr_text:
        opts["lyrics"] = "paste"
    job = {"status": "running", "stages": [{"name": s, "status": "pending"} for s in STAGES],
           "src": src, "opts": dict(opts)}
    rep = lambda: report(copy.deepcopy(job))  # noqa: E731
    rep()

    def stage(i, fn):
        st = job["stages"][i]
        st["status"] = "running"
        rep()
        t = time.time()
        res = fn()
        st["secs"] = round(time.time() - t, 1)
        st["status"] = "done" if res is not False else "cached"
        if isinstance(res, dict):
            st["info"] = res
        rep()
        return res

    d = lock = None
    try:
        d = stages.resolve_song(src)
        meta = read_json(d / "meta.json")
        job["slug"], job["title"] = d.name, stages.clean_title(meta["title"])
        lock = open(d / ".lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("This song is already being processed (CLI or another job). Try again shortly.")
        invalidate(d, opts.get("force") or [])
        mode, lay = opts.get("mode") or "auto", opts.get("layout") or "auto"
        if opts.get("piano_only") and lay == "auto":
            lay = "piano"
        want6 = bool(opts.get("piano_stem")) or mode == "direct"
        (d / "midi").mkdir(exist_ok=True)
        stage(0, lambda: stages.fetch(d))
        for p in {str(meta["source"]), src}:  # uploads are not needed once source.wav exists
            if p.startswith(str(ROOT / "_uploads") + "/"):
                Path(p).unlink(missing_ok=True)
        def sep():
            did = stages.separate(d, False)
            if want6 and (stages.has_vocals(d) or opts.get("piano_stem")):
                did = stages.separate(d, True) or did
            return did
        stage(1, sep)
        hv = stages.has_vocals(d)
        job["has_vocals"] = hv
        vocals = stages.stem_paths(d, False)[0]
        if mode == "auto":
            mode = "accomp" if hv else "direct"
        ps = want6 and (hv or bool(opts.get("piano_stem")))   # solo piano needs no isolating
        pwav, pname = stages.piano_source(d, ps, hv)
        opts = {**opts, "mode": mode, "layout": lay, "piano_midi": pname}
        lyr = opts.get("lyrics") or "auto"
        if lyr_text:
            atomic_write(d / "lyrics_user.txt", lyr_text + "\n")

        def lookup():
            try:
                return stages.find_lyrics(d)
            except RuntimeError as e:        # no match must not sink the whole job
                return {"note": str(e)}
        if not hv:
            opts["no_vocals"] = True
            job["stages"][3].update(status="skipped", info="no vocals detected")
            if lyr == "find":
                stage(4, lookup)
            else:
                job["stages"][4].update(status="skipped", info="pasted text" if lyr == "paste" else "no vocals detected")
        stage(2, lambda: stages.transkun(pwav, d / "midi" / pname))
        if hv:
            stage(3, lambda: stages.basic_pitch(vocals, d / "midi/vocals.mid", vocal=True))
            if lyr == "find":
                stage(4, lookup)
            elif lyr in ("paste", "none") or opts.get("no_lyrics") or lay == "piano" or (lay == "auto" and mode == "arrange"):
                job["stages"][4].update(status="skipped", info="not needed for this output")
            else:
                stage(4, lambda: stages.lyrics(d, vocals))
        stage(5, lambda: stages.analyze(d, d / "source.wav"))
        _save_manifest(d)
        ver = opts.get("version") if opts.get("version") in score.VERSIONS else None
        fp = fingerprint(d, opts) if ver else None
        if ver and not opts.get("fresh") and restore_snapshot(d, ver, fp):
            job["stages"][6].update(status="cached", info="kept version")
            job["stages"][7].update(status="cached")
        else:
            (d / f"{d.name}.auto.musicxml").unlink(missing_ok=True)      # backup of an older sheet's hand edits
            stage(6, lambda: score.build(d, opts))
            stage(7, lambda: {"renderer": score.render_pdf(d)})
            if ver:
                save_snapshot(d, ver, fp)
        job["status"] = "done"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e) or type(e).__name__
        job["trace"] = traceback.format_exc()[-3000:]
        for st in job["stages"]:
            if st["status"] == "running":
                st["status"] = "error"
    finally:
        if d is not None and d.exists():
            entry = {"ts": time.strftime("%F %T"), "status": job["status"], "error": job.get("error"),
                     "opts": opts, "stages": job["stages"]}
            with (d / "run.log").open("a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        if lock:
            lock.close()
    rep()
    return job
