"""Heavy, cached stages: fetch, separate, notes (Basic Pitch), lyrics, analyze."""
import functools, os, re, shutil, subprocess, sys
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from .util import ROOT, atomic_write, clean_title, read_json, sha12, slugify, write_json  # noqa: F401 (re-export)

# Bump a version to invalidate that stage's cached output (see run.py manifest).
VERSIONS = {"separate": "htdemucs-4.1/1", "notes": "transkun-2.0/2", "lyrics": "whisper-l3-turbo/2",
            "analyze": "beat-this/1"}
WHISPER = "mlx-community/whisper-large-v3-turbo"


SITES = {"yt": ("youtube.com", "youtu.be", "youtube-nocookie.com"), "fb": ("facebook.com", "fb.watch", "fb.com")}


def site_of(url: str):
    """'yt' or 'fb' for a link the app accepts, else None."""
    from urllib.parse import urlparse
    host = (urlparse(url.strip()).hostname or "").lower()
    for kind, names in SITES.items():
        if any(host == n or host.endswith("." + n) for n in names):
            return kind
    return None


def clean_url(url: str):
    """(link without playlist clutter, video id if it can be read from the link)."""
    if site_of(url) == "yt":
        m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})", url)
        if m:
            return f"https://www.youtube.com/watch?v={m.group(1)}", m.group(1)
    return url, None


def _run(cmd, timeout=600, **kw):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{Path(cmd[0]).name} timed out after {timeout}s")
    if r.returncode:
        err = "\n".join(l for l in (r.stderr or r.stdout).splitlines()
                        if not l.startswith(("WARNING", "         ")))
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {err[-1500:].strip()}")
    return r.stdout


# ---------- 1. resolve + fetch ----------
def _find_uid(uid):
    for m in ROOT.glob("*/meta.json"):
        meta = read_json(m, {})
        if meta.get("uid") == uid or (uid.startswith("yt:") and meta.get("id") == uid[3:]):
            return m.parent


def _new_dir(base: str, uid: str) -> Path:
    tag = re.sub(r"[^a-z0-9]", "", uid.split(":", 1)[1].lower())[:6]
    base = base or f"song-{tag}"
    d = ROOT / base
    if d.exists():
        d = ROOT / f"{base[:53]}-{tag}"
    return d


# Sites that only hand over a video to a signed-in visitor: borrow the login from this browser.
LOGIN_SITES = ("facebook.com", "fb.watch", "fb.com")
LOGIN_BROWSER = os.environ.get("EMI_COOKIES_BROWSER", "chrome")


def _ytdlp(url: str) -> list:
    cmd = ["yt-dlp", "--no-playlist", "--no-warnings"]
    host = (urlparse(url).hostname or "").lower()
    if any(host == s or host.endswith("." + s) for s in LOGIN_SITES):
        cmd += ["--cookies-from-browser", LOGIN_BROWSER]
    return cmd


def resolve_song(src: str) -> Path:
    """Song folder for a URL / local file / existing slug. Identity = uid (yt:<id> | file:<sha12>)."""
    ROOT.mkdir(parents=True, exist_ok=True)
    if re.fullmatch(r"[a-z0-9-]+", src) and (ROOT / src / "meta.json").exists():
        return ROOT / src
    if re.match(r"https?://", src):
        url, vid = clean_url(src)
        if vid and (d := _find_uid(f"yt:{vid}")):
            return d
        out = _run([*_ytdlp(url), "--print", "%(id)s\t%(title)s\t%(duration)s",
                    "--", url], 120)
        vid, title, dur = (out.strip().split("\t") + ["", "", ""])[:3]
        uid = f"{site_of(url) or 'yt'}:{vid}"
        if d := _find_uid(uid):
            return d
        try:
            dur = float(dur)
        except ValueError:
            dur = 0.0
        meta = {"uid": uid, "id": vid, "source": url, "title": title, "duration": dur}
    else:
        p = Path(src).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"No such audio file: {p}")
        uid = f"file:{sha12(p)}"
        if d := _find_uid(uid):
            return d
        meta = {"uid": uid, "source": str(p), "title": p.stem}
    d = _new_dir(slugify(clean_title(meta["title"])) or slugify(meta["title"]), uid)
    d.mkdir(parents=True)
    meta["slug"] = d.name
    write_json(d / "meta.json", meta)
    return d


def fetch(d: Path):
    wav = d / "source.wav"
    if wav.exists():
        return False
    src = read_json(d / "meta.json")["source"]
    for f in d.glob("download.*"):
        f.unlink()
    if src.startswith("http"):
        out = _run([*_ytdlp(src), "-f", "bestaudio/best", "--print", "after_move:filepath",
                    "-o", str(d / "download.%(ext)s"), "--", src], 900)
        src = out.strip().splitlines()[-1]
    tmp = d / "source.tmp.wav"
    _run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", "44100", "-ac", "2", str(tmp)], 600)
    os.replace(tmp, wav)
    for f in d.glob("download.*"):
        f.unlink()
    return True


# ---------- 2. separate ----------
STEMS = {"htdemucs": ["vocals", "no_vocals"], "htdemucs_6s": ["piano", "vocals", "drums", "bass", "guitar", "other"]}


def stem_paths(d: Path, piano_stem: bool):
    vocals = d / "stems/htdemucs/source/vocals.wav"
    piano = d / ("stems/htdemucs_6s/source/piano.wav" if piano_stem else "stems/htdemucs/source/no_vocals.wav")
    return vocals, piano


def piano_source(d: Path, piano_stem: bool, has_vocals: bool):
    """(wav to transcribe, midi file name). Without singing the untouched mix is the cleanest piano."""
    if piano_stem:
        return stem_paths(d, True)[1], "piano-6s.mid"
    if has_vocals:
        return stem_paths(d, False)[1], "piano-accomp.mid"
    return d / "source.wav", "piano-mix.mid"


def _demucs(d: Path, model: str):
    tmp = d / "stems.tmp"
    args = ["-n", model] + (["--two-stems", "vocals"] if model == "htdemucs" else [])
    for dev in ("mps", "cpu"):
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            _run([sys.executable, "-m", "demucs", *args, "-d", dev, "-o", str(tmp), str(d / "source.wav")], 3600)
            break
        except RuntimeError as e:
            if dev == "cpu" or "mps" not in str(e).lower():
                raise
    got = tmp / model / "source"
    missing = [s for s in STEMS[model] if not (got / f"{s}.wav").exists()]
    if missing:
        raise RuntimeError(f"demucs {model} did not produce {missing}")
    dest = d / "stems" / model
    shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(exist_ok=True)
    os.replace(tmp / model, dest)
    shutil.rmtree(tmp, ignore_errors=True)


def separate(d: Path, piano_stem: bool):
    did = False
    for model in ["htdemucs"] + (["htdemucs_6s"] if piano_stem else []):
        src = d / "stems" / model / "source"
        if not all((src / f"{s}.wav").exists() for s in STEMS[model]):
            _demucs(d, model)
            did = True
    return did


def has_vocals(d: Path, thresh_db=-30.0, floor_dbfs=-60.0):
    """Vocal stem energy relative to the mix; a near-silent mix never counts. Cached in meta.json."""
    mp = d / "meta.json"
    meta = read_json(mp)
    if "has_vocals" not in meta or "mix_dbfs" not in meta:
        import soundfile as sf

        def rms(f):
            x, _ = sf.read(str(f), dtype="float32")
            return float(np.sqrt(np.mean(x ** 2)) + 1e-12)
        v, mix = rms(stem_paths(d, False)[0]), rms(d / "source.wav")
        meta["mix_dbfs"] = round(float(20 * np.log10(mix)), 1)
        meta["vocal_db"] = round(float(20 * np.log10(v / mix)), 1)
        meta["has_vocals"] = bool(meta["vocal_db"] > thresh_db and meta["mix_dbfs"] > floor_dbfs)
        write_json(mp, meta)
    return meta["has_vocals"]


# ---------- 3. piano notes (Transkun: a model trained specifically on piano) ----------
def _lead_silence(wav: Path, floor_db=-60.0):
    """Seconds of (near) silence before the first sound."""
    import soundfile as sf
    with sf.SoundFile(str(wav)) as f:
        sr, pos = f.samplerate, 0
        while True:
            x = f.read(sr // 10, dtype="float32")
            if not len(x):
                return 0.0
            if 20 * np.log10(float(np.sqrt(np.mean(x ** 2))) + 1e-12) > floor_db:
                return pos / sr
            pos += len(x)


PEDALS = (64, 66, 67)


def transkun(wav: Path, out_mid: Path):
    if out_mid.exists():
        return False
    import pretty_midi
    tmp = out_mid.with_name(out_mid.stem + ".tmp.mid")
    # the model drops the first note after a long silent lead-in: start just before the music instead
    t0 = max(0.0, _lead_silence(wav) - 0.5)
    src = wav
    if t0 > 0.5:
        src = out_mid.with_name(out_mid.stem + ".trim.wav")
        _run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t0:.3f}", "-i", str(wav), str(src)], 600)
    else:
        t0 = 0.0
    try:
        for dev in ("mps", "cpu"):
            try:
                _run([sys.executable, "-m", "transkun.transcribe", str(src), str(tmp), "--device", dev], 3600)
                break
            except RuntimeError:
                if dev == "cpu":
                    raise
        if not tmp.exists():
            raise RuntimeError("piano transcription produced no MIDI")
        pm = pretty_midi.PrettyMIDI(str(tmp))
        out = pretty_midi.PrettyMIDI()
        ins = pretty_midi.Instrument(0, name="Piano")
        ins.notes = [pretty_midi.Note(n.velocity, n.pitch, n.start + t0, n.end + t0)
                     for i in pm.instruments for n in i.notes]
        # pedals too (sustain CC64, sostenuto 66, soft 67): score.load_notes holds notes under the sustain pedal
        ins.control_changes = sorted((pretty_midi.ControlChange(c.number, c.value, c.time + t0)
                                      for i in pm.instruments for c in i.control_changes if c.number in PEDALS),
                                     key=lambda c: c.time)
        out.instruments.append(ins)
        out.write(str(tmp))
        os.replace(tmp, out_mid)
    finally:
        tmp.unlink(missing_ok=True)
        if src != wav:
            src.unlink(missing_ok=True)
    return True


# ---------- 4. vocal notes (Basic Pitch) ----------
@functools.lru_cache(maxsize=1)
def _bp_model():
    from basic_pitch.inference import Model
    from basic_pitch import ICASSP_2022_MODEL_PATH
    return Model(ICASSP_2022_MODEL_PATH)


def basic_pitch(wav: Path, out_mid: Path, vocal=False):
    if out_mid.exists():
        return False
    import contextlib, io
    from basic_pitch.inference import predict
    kw = dict(minimum_frequency=70, maximum_frequency=1100) if vocal else {}
    with contextlib.redirect_stdout(io.StringIO()):
        _, midi, _ = predict(str(wav), _bp_model(), **kw)
    tmp = out_mid.with_name(out_mid.stem + ".tmp.mid")
    midi.write(str(tmp))
    os.replace(tmp, out_mid)
    return True


# ---------- 5. lyrics ----------
STOCK = {"thank you.", "thank you", "thanks for watching!", "thanks for watching.", "you", "bye.", ".",
         "please subscribe.", "subtitles by the amara.org community"}


def keep_segment(s) -> bool:
    """Drop Whisper hallucinations on music/silence."""
    txt = s.get("text", "").strip().lower()
    if not txt or (txt in STOCK and s.get("no_speech_prob", 0) > 0.2):
        return False
    if s.get("no_speech_prob", 0) > 0.6 and s.get("avg_logprob", 0) < -0.7:
        return False
    return s.get("avg_logprob", 0) > -1.2 and s.get("compression_ratio", 1) < 2.6


def lyrics(d: Path, vocals: Path):
    out = d / "lyrics.json"
    if out.exists():
        return False
    import mlx_whisper
    r = mlx_whisper.transcribe(str(vocals), path_or_hf_repo=WHISPER, word_timestamps=True,
                               condition_on_previous_text=False)
    segs = [s for s in r.get("segments", []) if keep_segment(s)]
    words = [{"w": w["word"].strip(), "t": round(w["start"], 3), "e": round(w["end"], 3)}
             for s in segs for w in s.get("words", []) if w["word"].strip()]
    lines = [f"[{int(s['start'] // 60):02d}:{s['start'] % 60:05.2f}] {s['text'].strip()}" for s in segs]
    atomic_write(d / "lyrics.txt", "\n".join(lines) + "\n")
    write_json(out, {"language": r.get("language"), "words": words,
                     "dropped_segments": len(r.get("segments", [])) - len(segs)})
    return True


# ---------- 6. analyze ----------
NOTE_NAMES = ['C', 'C#', 'D', 'E-', 'E', 'F', 'F#', 'G', 'A-', 'A', 'B-', 'B']


@functools.lru_cache(maxsize=1)
def _beat_model(dev):
    from beat_this.inference import File2Beats
    return File2Beats(checkpoint_path="final0", device=dev, dbn=False)


def track_beats(wav: Path):
    """(beats, downbeats) in seconds from the Beat This model; ([], []) if it cannot run."""
    import contextlib, io
    for dev in ("mps", "cpu"):
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                b, db = _beat_model(dev)(str(wav))
            return [round(float(x), 4) for x in b], [round(float(x), 4) for x in db]
        except Exception:
            if dev == "cpu":
                return [], []
    return [], []


def analyze(d: Path, mix: Path):
    out = d / "analysis.json"
    if out.exists():
        return False
    import librosa
    y, sr = librosa.load(str(mix), sr=22050, mono=True)
    bt, db = track_beats(mix)
    if len(bt) < 8:  # fall back to a plain onset-based tracker
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, trim=False)
        bt, db = librosa.frames_to_time(beats, sr=sr).tolist(), []
    tempo = 60.0 / float(np.median(np.diff(bt))) if len(bt) > 3 else 120.0
    if not (30 <= tempo <= 300) or len(bt) < 4:  # silence / steady tones: no usable beat grid
        tempo, bt, db = 120.0, [], []
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36).mean(axis=1)
    s, tonic, mode = key_from_profile(chroma)
    write_json(out, {"tempo": tempo, "beats": bt, "downbeats": db, "key": f"{tonic} {mode}", "key_conf": s,
                     "duration": len(y) / sr})
    return True


def key_from_profile(pc):
    """Krumhansl key match on a 12-bin pitch-class weight vector → (score, tonic, mode)."""
    KM = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    Km = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    pc = np.asarray(pc, float)
    sc = [(float(np.nan_to_num(np.corrcoef(pc, np.roll(K, i))[0, 1])), NOTE_NAMES[i], m)
          for i in range(12) for K, m in ((KM, "major"), (Km, "minor"))]
    return max(sc)


# ---------- lyrics from text (for instrumentals, or to replace what was heard) ----------
def find_lyrics(d: Path):
    """Look the song up on LRCLIB (open lyrics database) by its title → writes lyrics_found.txt.
    Returns info dict, or raises if nothing suitable is found."""
    import json as _json
    import urllib.parse
    import urllib.request
    out = d / "lyrics_found.txt"
    src = d / "lyrics_found.json"
    if out.exists() and "timed" in (read_json(src, {}) or {}):
        return False
    title = clean_title(read_json(d / "meta.json")["title"])
    q = re.sub(r"[^\w\s']", " ", title)
    q = re.sub(r"\b(piano|tutorial|cover|easy|pop song|ost|instrumental|karaoke)\b", " ", q, flags=re.I)
    q = re.sub(r"\s+", " ", q).strip()
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": q})
    req = urllib.request.Request(url, headers={"User-Agent": "transcribe-local/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            hits = _json.loads(r.read().decode())
    except Exception as e:
        raise RuntimeError(f"lyrics lookup failed: {e}")
    want = set(q.lower().split())

    def score_hit(h):
        have = set(re.sub(r"[^\w\s]", " ", f"{h.get('trackName', '')} {h.get('artistName', '')} {h.get('albumName', '')}").lower().split())
        name = set(re.sub(r"[^\w\s]", " ", h.get("trackName", "")).lower().split())
        return len(want & have) / max(1, len(want)) + 0.5 * len(want & name) / max(1, len(name))
    # only lyrics that say when each line is sung: without timings the fit is guesswork, so none are added
    hits = [h for h in hits if (h.get("syncedLyrics") or "").strip() and not h.get("instrumental")]
    if not hits:
        raise RuntimeError(f"no timed lyrics found for '{q}', so none were added")
    # same title match: prefer an entry that says when each line is sung
    best = max(hits, key=lambda h: (round(score_hit(h), 2), bool((h.get("syncedLyrics") or "").strip())))
    if score_hit(best) < 0.6:
        raise RuntimeError(f"no confident lyrics match for '{q}', so none were added")
    timed = bool((best.get("syncedLyrics") or "").strip())
    atomic_write(out, (best["syncedLyrics"] if timed else best["plainLyrics"]).strip() + "\n")
    info = {"source": "lrclib.net", "track": best.get("trackName"), "artist": best.get("artistName"),
            "album": best.get("albumName"), "query": q, "timed": timed}
    write_json(src, info)
    return info
