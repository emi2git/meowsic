"""Small shared helpers: paths, atomic writes, naming."""
import hashlib, json, os, re, unicodedata
from pathlib import Path

# all app data (one folder per song, plus _jobs and _uploads)
ROOT = Path(os.environ.get("TRANSCRIBE_ROOT", Path.home() / "Documents" / "Meowsic" / "work" / "transcribe"))  # the job sets it
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


def atomic_write(path: Path, data, binary=False):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    if binary:
        tmp.write_bytes(data)
    else:
        tmp.write_text(data)
    os.replace(tmp, path)


def write_json(path: Path, obj):
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=1))


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def sha12(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:12]


def slugify(s: str) -> str:
    s = s.replace("đ", "d").replace("Đ", "D")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()[:60].strip("-")


_KW = r"(?:easy |advanced |intermediate |beginner )?(?:piano )?(?:tutorial|cover|sheet music|synthesia|lyrics?|lyric video|official (?:music )?video|official audio|audio|mv|hd|4k)"


def clean_title(t: str) -> str:
    orig = t.strip()
    t = re.sub(r"\s*[\(\[][^\)\]]*\b(?:tutorial|cover|lyrics?|official|audio|video|sheet|synthesia|mv)\b[^\)\]]*[\)\]]", "", orig, flags=re.I)
    for _ in range(3):  # trailing "- Easy Piano Tutorial", "| Lyrics" ... (whole trailing phrase only)
        t = re.sub(r"\s*(?:[-|–:]\s*|\s{2,})" + _KW + r"\s*$", "", t, flags=re.I).strip()
        t = re.sub(r"\s+" + _KW + r"\s*$", "", t, flags=re.I).strip() if len(t.split()) > 3 else t
    t = re.sub(r"\s{2,}", " – ", t).strip(" -–|")
    if len(t) > 45:
        t = re.split(r" – | \| | from the ", t, flags=re.I)[0]
    return t or orig


def pretty_key(k: str | None) -> str | None:
    if not k:
        return k
    tonic, *mode = k.split()
    return tonic.replace("-", "b") + (" " + mode[0] if mode else "")
