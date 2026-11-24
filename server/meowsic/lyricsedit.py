"""Fit lyrics by hand (score ⋯ → "Fit lyrics…", web/js/views/fitlyrics.js).

GET  /api/items/{id}/lyrics?line=           the melody lines of the score (part / staff / voice), the chosen line's
                                            notes and bars, and the words already under them, per verse
POST /api/items/{id}/lyrics/sheet           {sheetId, line}: the words of a sheet (OMR, lyricsfit.read_sheet, cached)
                                            lined up with this score's notes (lyricsfit.place). Reading takes a while:
                                            the first call starts it, later calls return {status, progress} until done
POST /api/items/{id}/lyrics/preview         {line, verse, notes, holds} -> the MusicXML with those words (nothing saved)
POST /api/items/{id}/lyrics                 {line, verse, notes, holds, mode: 'this'|'new'} -> saved

notes = [{ref, text, syllabic}] (ref = the note's index among the part's <note> elements, as GET gives it);
holds = [ref, …]: notes that carry on the syllable before them (melisma; that syllable gets <extend/>).
Saving into this score keeps the MusicXML it replaces in items/<folder>/.history/lyrics-<ms>-<name> and logs an
Activities row ('musicxml' step) whose Undo puts it back; "Save as new score" makes a new entry in the same group
(Undo moves it to the Trash). Nothing in .history is ever removed.
"""
import hashlib
import shutil
import threading
import xml.etree.ElementTree as ET
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from .autofill import fill_from_library, log_fill, recredit
from . import lyricsfit as lf
from .db import folder_path, get_item, now_ms, uid, write_item
from .items import cfg, conn, item_dir, must_item, safe_file
from .sheetversion import refresh_staves
from .undolog import _q, record_undo

router = APIRouter(prefix='/api')
SYLLABIC = ('single', 'begin', 'middle', 'end')
TAG = lf.TAG  # "Lyrics added"


# ---------- reading ----------

def _parse(text: str):
    return ET.fromstring(text.encode('utf-8'))


def _head(text: str) -> str:
    i = text.find('<score-partwise')
    return text[:i] if i > 0 else '<?xml version="1.0" encoding="UTF-8"?>\n'


def _staff(e): return (e.findtext('staff') or '1').strip()
def _voice(e): return (e.findtext('voice') or '1').strip()


def lines_of(root):
    """Every melody line a score has: [{key, part, staff, voice, label, notes, lyrics}]. voice 'top' = the highest
    note at each onset of the staff (all its voices); a staff with more than one voice also lists each voice."""
    names = {sp.get('id'): (sp.findtext('part-name') or '').strip() for sp in root.iter('score-part')}
    out = []
    for p in root.findall('part'):
        pid = p.get('id') or ''
        staves, voices, lyr = {}, {}, {}
        for e in p.iter('note'):
            if e.find('pitch') is None or e.find('grace') is not None: continue
            s, v = _staff(e), _voice(e)
            staves[s] = staves.get(s, 0) + 1
            voices.setdefault(s, {})[v] = voices.get(s, {}).get(v, 0) + 1
            if e.find('lyric') is not None:
                lyr[(s, 'top')] = lyr.get((s, 'top'), 0) + 1
                lyr[(s, v)] = lyr.get((s, v), 0) + 1
        many = len(staves) > 1
        pname = names.get(pid) or pid or 'Part'
        for s in sorted(staves, key=lambda x: (len(x), x)):
            sname = pname + ((' · upper staff' if s == '1' else ' · lower staff' if s == '2' and len(staves) == 2 else f' · staff {s}') if many else '')
            vs = voices.get(s, {})
            out.append({'key': f'{pid}/{s}/top', 'part': pid, 'staff': s, 'voice': 'top', 'label': sname + (' · top notes' if len(vs) > 1 else ''),
                        'notes': staves[s], 'lyrics': lyr.get((s, 'top'), 0)})
            if len(vs) > 1:
                for v in sorted(vs, key=lambda x: (len(x), x)):
                    out.append({'key': f'{pid}/{s}/{v}', 'part': pid, 'staff': s, 'voice': v, 'label': f'{sname} · voice {v}', 'notes': vs[v], 'lyrics': lyr.get((s, v), 0)})
    return out


def default_line(root, lines):
    """The line with the most words already; else the part named Voice / Melody…, else the first part's top staff."""
    if not lines: return None
    best = max(lines, key=lambda l: (l['lyrics'], l['voice'] == 'top'))
    if best['lyrics']: return best['key']
    part, _ = lf._melody_part(root)
    pid = part.get('id') if part is not None else None
    return next((l['key'] for l in lines if l['part'] == pid and l['voice'] == 'top'), lines[0]['key'])


def _line(root, key):
    lines = lines_of(root)
    if not lines: raise HTTPException(400, 'This score has no notes to put words under')
    key = key or default_line(root, lines)
    line = next((l for l in lines if l['key'] == key), None)
    if not line: raise HTTPException(400, 'No such melody line in this score')
    part = next(p for p in root.findall('part') if (p.get('id') or '') == line['part'])
    return line, part, lines


def _in_line(e, line):
    return _staff(e) == line['staff'] and (line['voice'] == 'top' or _voice(e) == line['voice'])


def read_line(part, line):
    """The line's notes (ties joined, the top note of a chord), its bars, and every <note> of the part by index."""
    raw, start, div, bars = [], 0.0, 1, []
    all_notes = list(part.iter('note'))
    ref = {id(e): k for k, e in enumerate(all_notes)}
    for bi, meas in enumerate(part.findall('measure')):
        t = last = longest = 0.0
        for e in meas:
            if e.tag == 'attributes' and e.find('divisions') is not None:
                div = int(float(e.findtext('divisions')))
            elif e.tag == 'backup':
                t -= float(e.findtext('duration') or 0) / div
            elif e.tag == 'forward':
                t += float(e.findtext('duration') or 0) / div
                longest = max(longest, t)
            elif e.tag == 'note':
                if e.find('grace') is not None or e.find('cue') is not None: continue
                d = float(e.findtext('duration') or 0) / div
                chord = e.find('chord') is not None
                at = last if chord else t
                if not chord:
                    last, t = t, t + d
                    longest = max(longest, t)
                if not _in_line(e, line): continue
                m = lf._midi(e)
                if m is None or d <= 0: continue
                raw.append([start + at, start + at + d, m, e, bi, any(x.get('type') == 'stop' for x in e.findall('tie'))])
        bars.append({'i': bi, 'number': meas.get('number', str(bi + 1)), 'start': round(start, 4), 'len': round(longest, 4)})
        start += longest
    raw.sort(key=lambda r: (r[0], -r[2]))
    notes, open_ = [], {}
    for on, end, m, e, bi, tied in raw:
        prev = open_.get(m)
        if tied and prev is not None and abs(prev[1] - on) < 0.05:
            prev[1] = end
            continue
        r = [on, end, m, e, bi]
        open_[m] = r
        notes.append(r)
    by = {}
    for r in notes: by.setdefault(round(r[0], 4), []).append(r)
    out, sounding = [], []
    for on in sorted(by):
        grp = sorted(by[on], key=lambda r: -r[2])
        top = grp[0]
        sounding = [r for r in sounding if r[1] > on + lf.EPS]
        if any(r[2] > top[2] for r in sounding):
            sounding += grp
            continue
        sounding += grp
        out.append({'on': on, 'end': top[1], 'midi': top[2], 'el': top[3], 'els': [r[3] for r in grp], 'bar': top[4]})
    for a, b in zip(out, out[1:]): a['end'] = min(a['end'], b['on'])
    return out, bars, ref


def _lyrics_on(els):
    """{verse: {text, syllabic, extend}} of a note (the first lyric of each verse number on any of its elements)."""
    out = {}
    for e in els:
        for ly in e.findall('lyric'):
            v = (ly.get('number') or '1').strip()
            text = ''.join(x.text or '' for x in ly.findall('text')).strip()
            ext = ly.find('extend') is not None
            if v in out: continue
            if not text and not ext: continue
            out[v] = {'text': text, 'syllabic': (ly.findtext('syllabic') or 'single').strip() if text else '', 'extend': ext}
    return out


def _vkey(v):
    try: return (0, int(v))
    except ValueError: return (1, v)


def melody(text: str, key=None) -> dict:
    root = _parse(text)
    line, part, lines = _line(root, key)
    notes, bars, ref = read_line(part, line)
    out, verses = [], set()
    for n in notes:
        e = n['el']
        ly = _lyrics_on(n['els'])
        verses.update(ly)
        p = e.find('pitch')
        alter = round(float(p.findtext('alter') or 0))
        out.append({'ref': ref[id(e)], 'bar': n['bar'], 'on': round(n['on'], 4), 'dur': round(n['end'] - n['on'], 4), 'midi': n['midi'],
                    'name': p.findtext('step').strip() + {1: '♯', -1: '♭', 2: '𝄪', -2: '𝄫'}.get(alter, '') + p.findtext('octave').strip(),
                    'type': (e.findtext('type') or '').strip(), 'dots': len(e.findall('dot')), 'lyrics': ly})
    return {'line': line['key'], 'lines': [{k: l[k] for k in ('key', 'label', 'notes', 'lyrics')} for l in lines],
            'verses': sorted(verses, key=_vkey) or ['1'], 'notes': out, 'bars': bars, 'sha': sha(text)}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


# ---------- writing ----------

def _insert(note_el, ly, verse):
    kids = list(note_el)
    after = [k for k, c in enumerate(kids) if c.tag == 'lyric' and _vkey((c.get('number') or '1').strip()) < _vkey(verse)]
    before = [k for k, c in enumerate(kids) if c.tag == 'lyric' and _vkey((c.get('number') or '1').strip()) > _vkey(verse)]
    if after: at = after[-1] + 1
    elif before: at = before[0]
    else: at = next((k for k, c in enumerate(kids) if c.tag in ('play', 'listen')), len(kids))
    note_el.insert(at, ly)


def apply(text: str, key, verse, notes, holds=()) -> str:
    """The MusicXML text with verse `verse` of line `key` replaced by `notes` (+ melisma holds)."""
    verse = '1' if verse in (None, '') else str(verse).strip()
    if not verse.isdigit() or not 1 <= int(verse) <= 12: raise HTTPException(400, 'Verse must be 1–12')
    root = _parse(text)
    line, part, _ = _line(root, key)
    mel, _, ref = read_line(part, line)
    by_ref = {ref[id(n['el'])]: k for k, n in enumerate(mel)}
    all_notes = list(part.iter('note'))
    want = {}
    for n in notes or []:
        try: r = int(n.get('ref'))
        except (TypeError, ValueError): raise HTTPException(400, 'Each syllable needs the ref of its note')
        if r not in by_ref: raise HTTPException(400, f'Note {r} is not in this melody line')
        t = str(n.get('text') or '').strip()
        if not t: raise HTTPException(400, 'A syllable has no text')
        s = n.get('syllabic') or 'single'
        if s not in SYLLABIC: raise HTTPException(400, f'syllabic must be one of {", ".join(SYLLABIC)}')
        if r in want: raise HTTPException(400, f'Two syllables on note {r}')
        want[r] = (t, s)
    held = set()
    for h in holds or []:
        try: held.add(by_ref[int(h)])
        except (TypeError, ValueError, KeyError): raise HTTPException(400, f'Hold on a note that is not in this line: {h}')
    # out with this verse's words on the line (and the "check lyrics" marks of an automatic fit: looked at now)
    for e in all_notes:
        if not _in_line(e, line): continue
        for ly in e.findall('lyric'):
            if (ly.get('number') or '1').strip() == verse: e.remove(ly)
    for m in part.findall('measure'):
        for d in [d for d in m.findall('direction') if any((w.text or '') == lf.CHECK for w in d.iter('words'))]:
            m.remove(d)
    for r, (t, s) in want.items():
        k = by_ref[r]
        ly = ET.Element('lyric', {'number': verse})
        ET.SubElement(ly, 'syllabic').text = s
        ET.SubElement(ly, 'text').text = t
        if k + 1 in held and s in ('single', 'end'): ET.SubElement(ly, 'extend')
        _insert(all_notes[r], ly, verse)
    return _head(text) + ET.tostring(root, encoding='unicode')


def _verses(body):
    """{verse: {notes, holds}} of a request: `verses` (several at once) or one `verse` + `notes` + `holds`."""
    vs = body.get('verses')
    if isinstance(vs, dict) and vs: return {str(k): v or {} for k, v in vs.items()}
    v = '1' if body.get('verse') in (None, '') else str(body['verse']).strip()
    return {v: {'notes': body.get('notes'), 'holds': body.get('holds')}}


def apply_body(text, body):
    vs = _verses(body)
    for v, x in vs.items(): text = apply(text, body.get('line'), v, x.get('notes'), x.get('holds'))
    return text, vs


# ---------- the endpoints ----------

def _xml_path(cf, it) -> Path:
    if it['kind'] != 'score': raise HTTPException(400, 'Not a score')
    p = safe_file(item_dir(cf, it), it['musicxml'] or f'{it["folder"]}.musicxml')
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    return p


@router.get('/items/{item_id}/lyrics')
def get_lyrics(item_id: str, line: str | None = None, c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    return melody(_xml_path(cf, it).read_text(encoding='utf-8'), line)


@router.post('/items/{item_id}/lyrics/preview')
def preview(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    from fastapi.responses import PlainTextResponse
    it = must_item(c, item_id)
    out, _ = apply_body(_xml_path(cf, it).read_text(encoding='utf-8'), body)
    return PlainTextResponse(out, media_type='application/vnd.recordare.musicxml+xml')


def keep(d: Path, name: str) -> str | None:
    """Copy items/<folder>/<name> into .history/lyrics-<ms>-<name>; returns that path (relative)."""
    if not name or not (d / name).is_file(): return None
    (d / '.history').mkdir(exist_ok=True)
    rel = f'.history/lyrics-{now_ms()}-{name}'
    while (d / rel).exists(): rel = f'.history/lyrics-{now_ms() + 1}-{name}'
    shutil.copyfile(d / name, d / rel)
    return rel


def _count(notes): return len([n for n in notes or [] if str(n.get('text') or '').strip()])


@router.post('/items/{item_id}/lyrics')
def save(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    p = _xml_path(cf, it)
    text = p.read_text(encoding='utf-8')
    if body.get('sha') and body['sha'] != sha(text):
        raise HTTPException(409, 'This score was changed since the editor opened it — close the editor and open it again')
    out, vs = apply_body(text, body)
    n = sum(_count(x.get('notes')) for x in vs.values())
    what = f'{n} syllable{"s" if n != 1 else ""}, verse{"s" if len(vs) > 1 else ""} {", ".join(sorted(vs, key=_vkey))}'
    if body.get('mode') == 'new':
        t = now_ms()
        new = {'id': uid('m'), 'kind': 'score', 'title': it['title'], 'artist': it.get('artist') or '',
               'tags': [*[x for x in it.get('tags', []) if x != TAG], TAG], 'createdAt': t, 'updatedAt': t, 'originAt': t,
               'version': it.get('version') or 'original', 'source': f'From the score {_q(it["title"])} + lyrics fitted by hand',
               'groupId': it.get('groupId') or uid('g'), 'key': it.get('key') or '', 'bpm': it.get('bpm'), 'ai': it.get('ai') or 0,
               'sourceUrl': it.get('sourceUrl') or ''}
        if not it.get('groupId'): c.execute('UPDATE score SET group_id=? WHERE item_id=?', (new['groupId'], it['id']))
        filled = fill_from_library(c, new)  # Album (and an empty Artist) from the library; never the key
        if filled.get('artist'): out = recredit(out, new['artist'])
        write_item(c, new, new=True)
        log_fill(c, [(new, filled)])
        d = folder_path(cf, new['folder'])
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{new["folder"]}.musicxml').write_text(out, encoding='utf-8')
        cols = {'musicxml': f'{new["folder"]}.musicxml'}
        if it.get('midi') and (item_dir(cf, it) / it['midi']).is_file():
            shutil.copyfile(item_dir(cf, it) / it['midi'], d / f'{new["folder"]}.mid')
            cols['midi'] = f'{new["folder"]}.mid'
        c.execute(f'UPDATE score SET {",".join(f"{k}=?" for k in cols)} WHERE item_id=?', [*cols.values(), new['id']])
        refresh_staves(c, cf, new['id'])
        aid = record_undo(c, 'lyrics-fit', {'op': 'created', 'ids': [new['id']], 'titles': [new['title']]},
                          f'Fitted lyrics: {it["title"]}', f'New score with {what} (the score it came from is untouched)')
        return {'ok': True, 'mode': 'new', 'item': get_item(c, new['id']), 'activity': aid}
    d = p.parent
    hist = keep(d, p.name)
    orig = it.get('musicxmlOriginal')
    if not orig:  # like note edits: the first change keeps the untouched file ("Revert")
        orig = f'{it["folder"]} (original).musicxml'
        if not (d / orig).exists(): shutil.copyfile(p, d / orig)
    p.write_text(out, encoding='utf-8')
    c.execute('UPDATE score SET musicxml=?, musicxml_original=? WHERE item_id=?', (p.name, orig, it['id']))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    refresh_staves(c, cf, it['id'])
    aid = record_undo(c, 'lyrics-fit', {'op': 'musicxml', 'id': it['id'], 'title': it['title'], 'file': p.name, 'before': hist,
                                        'beforeSha': sha(text), 'afterSha': sha(out), 'what': 'lyrics'},
                      f'Fitted lyrics: {it["title"]}', f'{what}; the score before is kept in {hist}')
    return {'ok': True, 'mode': 'this', 'item': get_item(c, it['id']), 'activity': aid, 'history': hist, 'sha': sha(out)}


def undo_musicxml(c, cf, s, mode):
    """Activities → Undo of a 'Fitted lyrics' row: the MusicXML before (from .history). What is there now is kept
    in .history too. Conflict when the score was changed again since."""
    it = get_item(c, s['id'])
    what = _q(it['title'] if it else s.get('title', ''))
    if not it or it.get('deleted'): return [{'status': 'skip', 'what': what, 'why': 'the score is gone'}]
    d = folder_path(cf, it['folder'])
    p = d / s['file']
    src = d / (s.get('before') or '')
    if not s.get('before') or not src.is_file(): return [{'status': 'conflict', 'what': what, 'why': 'the earlier file is missing from .history'}]
    now = sha(p.read_text(encoding='utf-8')) if p.is_file() else None
    if now == s.get('beforeSha'): return [{'status': 'skip', 'what': what, 'why': 'already back'}]
    if now != s.get('afterSha') and mode != 'force': return [{'status': 'conflict', 'what': what, 'why': 'the score was changed since'}]
    if mode != 'check':
        keep(d, s['file'])
        shutil.copyfile(src, p)
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
        refresh_staves(c, cf, it['id'])
    return [{'status': 'ok', 'what': what}]


# ---------- the words of a sheet ----------

_reads: dict = {}  # (sheet id, updatedAt) -> {status, progress, error, path}
_lock = threading.Lock()


def _read_bg(cf, sheet, k):
    def ev(e):
        _reads[k]['progress'] = round(lf.OMR_STEP.get(e.get('step'), 0) * 0.9 + 0.1 * (e.get('progress') or 0), 3)
    try:
        _reads[k].update(status='done', path=str(lf.read_sheet(cf, sheet, ev)), progress=1)
    except Exception as e:  # shown in the editor
        _reads[k].update(status='failed', error=str(e))


def sheet_fit(score_text, sheet_text, key):
    """The sheet's syllables on this line's notes: {assign: [{ref, text, syllabic, sure}], unplaced: [{text, syllabic, after}]}.
    `after` = the ref of the placed syllable it follows (None: before the first)."""
    root = _parse(score_text)
    line, part, _ = _line(root, key)
    mel, _, ref = read_line(part, line)
    T = [lf.Note(n['on'], n['end'] - n['on'], n['midi'], '', [n['el']]) for n in mel]
    S = lf.read_tune(_parse(sheet_text), lyrics=True)
    if not any(s.text for s in S): raise HTTPException(422, 'No words were found on that sheet')
    placed, info = lf.place(S, T)
    done = {i for i, _, _ in placed}
    of = {i: j for i, j, _ in placed}
    assign = [{'ref': ref[id(mel[j]['el'])], 'text': S[i].text, 'syllabic': S[i].syllabic or 'single', 'sure': bool(sure)} for i, j, sure in placed]
    unplaced, last = [], None
    for i, s in enumerate(S):
        if not s.text: continue
        if i in done: last = ref[id(mel[of[i]]['el'])]; continue
        unplaced.append({'text': s.text, 'syllabic': s.syllabic or 'single', 'after': last})
    return {'assign': assign, 'unplaced': unplaced, 'syllables': sum(1 for s in S if s.text), 'shift': info.get('shift', 0)}


@router.post('/items/{item_id}/lyrics/sheet')
def from_sheet(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    sh = get_item(c, str(body.get('sheetId') or ''))
    if not sh or sh['kind'] != 'sheet': raise HTTPException(404, 'No such sheet')
    k = (sh['id'], sh.get('updatedAt') or 0)
    cache = cf.work_dir / 'lyricsfit' / f"{sh['id']}-{sh.get('updatedAt') or 0}" / 'out' / 'score.musicxml'
    with _lock:
        st = _reads.get(k)
        if cache.is_file(): st = _reads[k] = {'status': 'done', 'path': str(cache), 'progress': 1}
        elif st and st['status'] == 'failed':
            _reads.pop(k, None)  # said once; the next call reads it again
            raise HTTPException(422, st.get('error') or 'Could not read the sheet')
        elif not st:
            if not sh.get('pageFiles'): raise HTTPException(400, 'That sheet has no pages')
            if not lf.omr_python(): raise HTTPException(503, 'Reading sheets is not set up on this Mac (omr/.venv missing)')
            st = _reads[k] = {'status': 'running', 'progress': 0}
            threading.Thread(target=_read_bg, args=(cf, sh, k), daemon=True).start()
    if st['status'] != 'done': return {'status': 'running', 'progress': st.get('progress', 0)}
    res = sheet_fit(_xml_path(cf, it).read_text(encoding='utf-8'), Path(st['path']).read_text(encoding='utf-8'), body.get('line'))
    return {'status': 'done', **res}
