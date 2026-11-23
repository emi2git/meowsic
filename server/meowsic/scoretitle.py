"""The title drawn on a score is the item's Info title.

MusicXML from a YouTube transcription carries the video's name ("Home (Kit Chan) Easy Piano with Paranoma Score
View, Singapore NDP Song 1998") in <work-title>, <movement-title> and maybe <credit-words>. Here:

  title_xml(x, title)  the MusicXML with <work-title> / <movement-title> / the title credit = `title`, and the other
                       credit lines (subtitle, …) cleaned of video junk (junk()); a line left empty, or saying the
                       title again, goes. Text edits only: every other byte stays.
  apply(c, cf, it)     the item's MusicXML file brought in line with its title; the file before is kept in
                       items/<folder>/.history/title-<ms>-<name>. Returns an Activities 'musicxml' step (undo.py →
                       lyricsedit.undo_musicxml) or None when nothing changed. Info → rename calls it (items.update_item),
                       and so does a new transcription (runners.save_outputs).
  run(data, dry_run)   the one-time pass over every score: db backup first, history files, one undoable Activities row.

  python -m meowsic.scoretitle [--data ~/Documents/Meowsic] [--dry-run]
"""
import argparse
import hashlib
import html
import json
import re
import shutil
import time
from pathlib import Path

from .db import Config, connect, folder_path, log_event, now_ms

# video-name junk: "with Panorama Score View", "Singapore NDP Song 1998", "Piano Tutorial", "Easy Piano", "(Official
# Lyric Video)", "Synthesia", "| Sheet Music", "HD"…  (case-insensitive; Panorama is often spelt "Paranoma")
_J = [
    r'(?:with\s+(?:a\s+)?)?(?:pa[nr]\w{0,4}ma\w*\s+)?score\s+view',
    r'(?:singapore\s+)?(?:ndp|national\s+day)(?:\s+\d{4})?\s+(?:theme\s+)?song(?:\s*(?:of\s+)?\d{4})?', r'\bndp\s+\d{4}\b',
    r'(?:easy\s+|simple\s+|beginner\s+)?piano\s+(?:tutorial|cover|lesson|version|solo|arrangement|sheet\s+music|sheets?|score)',
    r'(?:easy|simple|beginner)\s+piano', r'\btutorial\b', r'synthesia', r'sheet\s+music', r'\bfree\s+sheets?\b', r'\bmidi\b',
    r'\(?\s*official\s+(?:music\s+|lyrics?\s+)?video\s*\)?', r'\(?\s*lyrics?\s+video\s*\)?', r'\(\s*lyrics?\s*\)', r'\bwith\s+lyrics\b',
    r'\b(?:hd|hq|4k)\b', r'\bfor\s+(?:kids|beginners)\b', r'\bpiano\b(?=\s*$)',
]
JUNK = re.compile(r'|'.join(f'(?:{p})' for p in _J), re.I)


def junk(text: str) -> str:
    """A credit / subtitle line without the video junk ('' when nothing is left)."""
    t = JUNK.sub(' ', text or '')
    t = re.sub(r'\(\s*\)|\[\s*\]', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'^[\s,;:|\-–—/]+|[\s,;:|\-–—/]+$', '', t).strip()
    return t


def sha(text: str) -> str:  # as lyricsedit.sha (its undo_musicxml checks these)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def _text(inner: str) -> str:
    return html.unescape(re.sub(r'<[^>]+>', '', inner)).strip()


def title_xml(x: str, title: str) -> str:
    """See the module doc. `title` empty: unchanged."""
    title = (title or '').strip()
    if not title or '<score-partwise' not in x and '<score-timewise' not in x: return x
    t = _esc(title)
    olds = {_text(m[1]) for m in re.finditer(r'<(?:work-title|movement-title)>([\s\S]*?)</(?:work-title|movement-title)>', x)}
    x = re.sub(r'<(work-title|movement-title)>[\s\S]*?</\1>', lambda m: f'<{m[1]}>{t}</{m[1]}>', x)
    x = re.sub(r'<(work-title|movement-title)\s*/>', lambda m: f'<{m[1]}>{t}</{m[1]}>', x)
    if '<movement-title>' not in x and '<work-title>' not in x:
        if re.search(r'<work>', x): x = re.sub(r'<work>', f'<work><work-title>{t}</work-title>', x, count=1)
        else:
            m = re.search(r'<score-(?:partwise|timewise)\b[^>]*>', x)
            x = x[:m.end()] + f'\n  <movement-title>{t}</movement-title>' + x[m.end():]

    def credit(m):
        body = m[0]
        kind = (re.search(r'<credit-type>([^<]*)</credit-type>', body) or [None, ''])[1].strip().lower()
        words = list(re.finditer(r'(<credit-words\b[^>]*>)([\s\S]*?)(</credit-words>)', body))
        if not words: return body
        said = ' '.join(_text(w[2]) for w in words)
        if kind == 'title' or (not kind and said in olds):
            first = True
            def one(w):
                nonlocal first
                out = f'{w[1]}{t}{w[3]}' if first else ''
                first = False
                return out
            return re.sub(r'(<credit-words\b[^>]*>)([\s\S]*?)(</credit-words>)', one, body)
        if kind in ('composer', 'lyricist', 'arranger', 'rights', 'page number', 'part name'): return body
        new = re.sub(r'(<credit-words\b[^>]*>)([\s\S]*?)(</credit-words>)', lambda w: f'{w[1]}{_esc(junk(_text(w[2])))}{w[3]}', body)
        left = ' '.join(_text(w[2]) for w in re.finditer(r'(<credit-words\b[^>]*>)([\s\S]*?)(</credit-words>)', new)).strip()
        if not left or left.casefold() == title.casefold() or left in olds: return ''
        return new
    return re.sub(r'[ \t]*<credit(?=[\s>])[^>]*>[\s\S]*?</credit>\n?', credit, x)


def keep(d: Path, name: str, tag='title') -> str:
    (d / '.history').mkdir(exist_ok=True)
    rel = f'.history/{tag}-{now_ms()}-{name}'
    n = 1
    while (d / rel).exists(): rel = f'.history/{tag}-{now_ms() + n}-{name}'; n += 1
    shutil.copyfile(d / name, d / rel)
    return rel


def _file(cf, it):
    if it.get('kind') != 'score' or not it.get('folder') or not it.get('musicxml'): return None
    p = folder_path(cf, it['folder']) / it['musicxml']
    return p if p.is_file() else None


def apply(c, cf, it, title=None):
    """Bring the item's MusicXML in line with its (new) title; returns a 'musicxml' step or None."""
    p = _file(cf, it)
    title = title if title is not None else it.get('title')
    if not p or not (title or '').strip(): return None
    try: text = p.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError): return None
    out = title_xml(text, title)
    if out == text: return None
    hist = keep(p.parent, p.name)
    p.write_text(out, encoding='utf-8')
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    return {'op': 'musicxml', 'id': it['id'], 'title': title, 'file': p.name, 'before': hist,
            'beforeSha': sha(text), 'afterSha': sha(out), 'what': 'title change'}


def set_file_title(path, title):
    """A new transcription's file: its titles = the item's (runners.save_outputs; no history, the file is new)."""
    p = Path(path)
    try: x = p.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError): return
    y = title_xml(x, title)
    if y != x: p.write_text(y, encoding='utf-8')


# ---------- the one-time pass ----------

def plan(c, cf):
    from .db import get_item
    out = []
    for (i,) in c.execute("SELECT i.id FROM item i JOIN score s ON s.item_id=i.id WHERE i.kind='score' ORDER BY i.created_at").fetchall():
        it = get_item(c, i)
        p = _file(cf, it)
        if not p: continue
        try: x = p.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError): continue
        if title_xml(x, it['title']) != x:
            old = (re.search(r'<movement-title>([\s\S]*?)</movement-title>', x) or re.search(r'<work-title>([\s\S]*?)</work-title>', x))
            out.append({'it': it, 'old': _text(old[1]) if old else ''})
    return out


def run(data=None, *, dry_run=False, log=print) -> dict:
    from . import backup
    cf = Config.from_env(data)
    c = connect(cf)
    todo = plan(c, cf)
    res = {'scores': len(todo), 'changed': [(x['it']['id'], x['old'], x['it']['title']) for x in todo], 'backup': None, 'activity': None}
    for x in todo: log(f"{x['it']['id']}: {x['old']!r} -> {x['it']['title']!r}")
    if dry_run or not todo:
        c.close()
        return res
    res['backup'] = str(backup.snapshot(cf, f'meowsic-before-title-sync-{time.strftime("%Y%m%d-%H%M%S")}.db'))
    steps = [s for x in todo if (s := apply(c, cf, x['it']))]
    if steps:
        res['activity'] = log_event(c, 'title-sync', 'Score titles = Info titles',
                                    f'{len(steps)} score(s): the title drawn on the score now reads its Info title; '
                                    f'the files before are in .history (db backup: {Path(res["backup"]).name})', undo={'steps': steps})
    h = cf.data / 'history'
    h.mkdir(exist_ok=True)
    (h / f'title-sync-{time.strftime("%Y%m%d-%H%M%S")}.json').write_text(json.dumps(
        {'what': 'Score titles = Info titles', 'at': now_ms(), 'steps': steps}, ensure_ascii=False, indent=1))
    c.commit()
    c.close()
    log(json.dumps({k: v for k, v in res.items() if k != 'changed'}))
    return res


def main():
    ap = argparse.ArgumentParser(description='Make the title drawn on every score its Info title.')
    ap.add_argument('--data', default=None)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    run(a.data, dry_run=a.dry_run)


if __name__ == '__main__':
    main()
