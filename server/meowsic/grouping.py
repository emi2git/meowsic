"""Which photos are one song: given the pages in order (capture time, then file name), say where a new
song starts. Used by Add music → From Photos and by Manage library → Split songs.

Signs, each adding to (new song) or taking from (same song) a score for "a new song starts on this page":
  · page dots of a reader app (trim._dots): lit dot 1 of n = a first page; lit k = page k of the same song
  · a title at the top (titles.detect, with its confidence) = a first page; no title and the music right at
    the top of the page = a page that goes on
  · time between the shots (the old Meowsic app: < 30 s same song, > 2 min a new one)
  · the same layout (page size, where the staves start and end) as the page before = likely the same song
A score above 0 = a new song. |score| < UNSURE = "not sure" (the preview shows it).
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps

SAME_GAP = 30_000       # ms: shots this close are one song (old Meowsic GroupingEngine.sameSongGap)
NEW_GAP = 120_000       # ms: shots further apart start a new song (GroupingEngine.newSongGap)
LONG_GAP = 15 * 60_000  # ms: a long break: almost surely another song
TITLE_MIN = 0.5         # a title this sure counts as a first page
UNSURE = 1.5


def layout(path) -> dict | None:
    """Where the staves are: left / right end of the staff lines and the top of the first one (fractions)."""
    try:
        im = ImageOps.exif_transpose(Image.open(path)).convert('L')
    except Exception:
        return None
    w0 = 500
    im = im.resize((w0, max(1, round(im.height * w0 / im.width))))
    g = np.asarray(im, dtype=np.int16)
    h, w = g.shape
    dark = g < min(170, int(np.median(g)) - 40)
    rows = np.flatnonzero(dark.sum(axis=1) > 0.35 * w)
    if len(rows) < 5: return {'l': None, 'r': None, 'top': None, 'aspect': round(w / h, 3)}
    ls, rs = [], []
    for r in rows:
        cols = np.flatnonzero(dark[r])
        ls.append(cols[0] / w); rs.append((cols[-1] + 1) / w)
    return {'l': round(float(np.median(ls)), 3), 'r': round(float(np.median(rs)), 3), 'top': round(float(rows[0] / h), 3), 'aspect': round(w / h, 3)}


def _same_layout(a: dict | None, b: dict | None) -> bool | None:
    if not a or not b: return None
    if abs((a.get('aspect') or 0) - (b.get('aspect') or 0)) > 0.06: return False
    if a.get('l') is None or b.get('l') is None: return None
    return abs(a['l'] - b['l']) < 0.03 and abs(a['r'] - b['r']) < 0.03


def score(prev: dict, page: dict) -> tuple[float, list[str]]:
    """How much `page` looks like the first page of a new song after `prev` (> 0 = new song) and why."""
    s, why = 0.0, []
    d, pd = page.get('dots') or {}, prev.get('dots') or {}
    if d.get('lit') == 1 and (d.get('count') or 0) > 1:
        s += 3; why.append(f'page dots: page 1 of {d["count"]}')
    elif d.get('lit') and d['lit'] > 1:
        if pd.get('lit') == d['lit'] - 1 and pd.get('count') == d.get('count'):
            s -= 3.5; why.append(f'page dots: page {d["lit"]} of {d["count"]}, right after page {pd["lit"]}')
        else:
            s -= 1.5; why.append(f'page dots: page {d["lit"]} of {d.get("count")}')
    elif d.get('count') == 1:
        s += 1.5; why.append('page dots: a one-page song')
    if pd.get('count') and d.get('count') and pd['count'] != d['count']:
        s += 1.5; why.append(f'page dots change ({pd["count"]} → {d["count"]} pages)')
    t = page.get('title') or {}
    conf = t.get('confidence') or 0
    if t.get('title') and conf >= TITLE_MIN:
        if t.get('title') and (prev.get('title') or {}).get('title') == t['title'] and (prev.get('title') or {}).get('confidence', 0) >= TITLE_MIN:
            s -= 1; why.append(f'same heading as the page before (“{t["title"]}”)')
        else:
            s += 1 + 2 * conf; why.append(f'title “{t["title"]}”')
    else:
        staff = page.get('staff')
        if staff is not None and staff < 0.14:
            s -= 1.5; why.append('no title, the music starts at the top')
        elif not t.get('title'):
            s -= 0.5; why.append('no title')
    gap = (page.get('date') or 0) - (prev.get('date') or 0)
    if prev.get('date') is not None and page.get('date') is not None:
        if gap > LONG_GAP: s += 2.5; why.append(f'{gap // 60000} min after the photo before')
        elif gap > NEW_GAP: s += 1.2; why.append(f'{gap // 60000} min after the photo before')
        elif 0 <= gap < SAME_GAP: s -= 1; why.append(f'{gap // 1000} s after the photo before')
    same = _same_layout(prev.get('layout'), page.get('layout'))
    if same is True: s -= 0.5; why.append('same layout as the page before')
    elif same is False: s += 0.8; why.append('different layout from the page before')
    return round(s, 2), why


def propose(pages: list[dict]) -> list[dict]:
    """Per page: {start, score, sure, why}. The first page always starts a song."""
    out = []
    for k, p in enumerate(pages):
        if k == 0:
            out.append({'start': True, 'score': 9.0, 'sure': True, 'why': ['first photo']}); continue
        s, why = score(pages[k - 1], p)
        out.append({'start': s > 0, 'score': s, 'sure': abs(s) >= UNSURE, 'why': why})
    return out


def songs(pages: list[dict], starts: list[bool]) -> list[dict]:
    """[{first, pages: [indexes], title, confidence}] from the start marks (title from the first page)."""
    out = []
    for k, p in enumerate(pages):
        if starts[k] or not out:
            t = p.get('title') or {}
            ok = bool(t.get('title')) and (t.get('confidence') or 0) >= TITLE_MIN
            out.append({'first': k, 'pages': [], 'title': t.get('title') if ok else 'Untitled', 'confidence': t.get('confidence', 0) if ok else 0,
                        'detected': ok})
        out[-1]['pages'].append(k)
    return out


def several_songs(pages: list[dict]) -> list[int]:
    """Pages (1-based) of a sheet where a new song probably starts (after page 1): a sure proposal only."""
    return [k + 1 for k, r in enumerate(propose(pages)) if k and r['start'] and r['sure']]
