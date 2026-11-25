"""Bars to check of a score made from a sheet ("Make it a score", omr/omr.py).

omr.py writes check.json beside the score; the job keeps it in the score's folder as "<folder> check.json" with the
pages it read as "<folder> check p<k>.jpg" (the bar boxes are in those images' pixels):

  {version: 1, sheetId, pages: [{page, file, width, height}],
   bars: [{bar, page, box: [x0, y0, x1, y1] | null, reasons: ["the two readers disagree", ...],
           alternatives: [{id: "audiveris" | "homr", label, musicxml: "<measure number=..>…</measure>"}]}],
   decisions: [{bar, action: "ok" | "use", alt, at}]}   (a log; nothing in it is ever removed)

A bar is still open while its number is in the score's <miscellaneous-field name="meowsic-check-bars">, so an
Activities undo (the MusicXML before, from .history) opens it again by itself.

GET  /api/items/{id}/check  → the above + open, url per page, sha of the score
POST /api/items/{id}/check  {bar, action: "ok" | "use", alt?: id, sha?, act?} → the bar marked fine, or the other
     reading put in (its notes; the bar keeps its chord names, words — by time, carry_lyrics — and marks). Logged with Undo.
     {bars: "all" | [n, ...], action: "ok"} → those bars (all still open) marked fine at once: one Undo.
"""
import json
import math
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from .db import now_ms
from .items import cfg, conn, item_dir, must_item, safe_file
from .lyricsedit import _head, _xml_path, sha
from .sheetversion import refresh_staves
from .undolog import record_undo

router = APIRouter(prefix='/api')
FIELD = 'meowsic-check-bars'


def check_file(d: Path, folder: str) -> Path | None:
    p = d / f'{folder} check.json'
    if p.is_file(): return p
    return next(iter(sorted(d.glob('* check.json'))), None)


def page_file(d: Path, folder: str, k: int) -> Path | None:
    p = d / f'{folder} check p{k}.jpg'
    if p.is_file(): return p
    return next(iter(sorted(d.glob(f'* check p{k}.jpg'))), None)


def keep_check(d: Path, folder: str, src_dir: Path, sheet_id: str | None = None):
    """Called by the omr job: src_dir/check.json and the pages it names → the score's folder."""
    src = src_dir / 'check.json'
    if not src.is_file(): return None
    data = json.loads(src.read_text(encoding='utf-8'))
    from PIL import Image
    for pg in data.get('pages', []):
        f = src_dir / pg.get('file', '')
        if not f.is_file(): continue
        name = f'{folder} check p{pg["page"]}.jpg'
        with Image.open(f) as im: im.convert('RGB').save(d / name, quality=85)
        pg['file'] = name
    data['sheetId'] = sheet_id
    data.setdefault('decisions', [])
    p = d / f'{folder} check.json'
    p.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return p


def open_bars(text: str) -> list[int]:
    m = re.search(rf'<miscellaneous-field name="{FIELD}">([^<]*)<', text)
    return [int(x) for x in m.group(1).split()] if m else []


# ---------- changing one bar ----------

def _measure(part, bar):
    return next((m for m in part.findall('measure') if m.get('number') == str(bar)), None)


def _divisions_at(part, meas):
    div = 1
    for m in part.findall('measure'):
        for at in m.findall('attributes'):
            if at.findtext('divisions'): div = int(at.findtext('divisions'))
        if m is meas: break
    return div


def _timed(meas):
    """[(element, onset in divisions)] of what sits in the bar, walking notes / backup / forward."""
    t = last = 0
    out = []
    for e in meas:
        if e.tag == 'backup': t -= int(e.findtext('duration') or 0)
        elif e.tag == 'forward': t += int(e.findtext('duration') or 0)
        elif e.tag == 'note':
            d = int(e.findtext('duration') or 0)
            if e.find('chord') is not None: out.append((e, last)); continue
            out.append((e, t)); last = t
            if e.find('grace') is None: t += d
        else: out.append((e, t))
    return out


def _unmark(meas):
    """The red "⚠ check" text above the bar goes."""
    for e in list(meas.findall('direction')):
        if any('⚠' in (w.text or '') for w in e.iter('words')): meas.remove(e)


def _drop_from_field(root, bar):
    for f in root.iter('miscellaneous-field'):
        if f.get('name') == FIELD:
            left = [x for x in (f.text or '').split() if x != str(bar)]
            f.text = ' '.join(left)
            if not left:
                misc = next((m for m in root.iter('miscellaneous') if f in list(m)), None)
                if misc is not None:
                    misc.remove(f)
                    if not len(misc):
                        ident = next((i for i in root.iter('identification') if misc in list(i)), None)
                        if ident is not None: ident.remove(misc)


def _sv(e):
    return (e.findtext('staff') or '1').strip(), (e.findtext('voice') or '1').strip()


def _tied(e, kind):
    return any(x.get('type') == kind for x in e.findall('tie')) or any(x.get('type') == kind for x in e.findall('notations/tied'))


def carry_lyrics(old, new, cur, unit):
    """The bar's old words onto its new notes BY TIME, not by order (an inserted fill note must not shift them).

    old: _timed(meas) of the bar before (onsets in the score's unit `cur`); new: the other reading's note / backup /
    forward elements, durations already in `unit`. Each <lyric> (every verse line, with its syllabic and extend) moves
    on its own, keyed by (staff, voice, onset, line number):
      1. onto the new note of the same staff and voice that is struck at that onset (a chord: its first note);
      2. else onto the struck note still sounding there (a tie chain sounds from the note that starts it to its
         last note), if that line is free on it;
      3. else (a rest covers the onset, or the sounding note has its own word on that line) onto the next struck
         note after the onset in that voice whose line is free; else the word is dropped (no note is left for it).
    A tied-into note is not struck, so it never gets a word of its own. When the new bar has no notes at all in a
    staff/voice that had words, that staff's notes (any voice) stand in for it. New notes at onsets without an old
    word get none. When the old bar had no words at all, the new notes keep their own; otherwise theirs go."""
    ann = {}  # (staff, voice, onset in unit, number) -> <lyric>; a chord's notes share one onset: the first wins
    for e, t in old:
        if e.tag != 'note' or e.find('rest') is not None or e.find('grace') is not None: continue
        st, vo = _sv(e)
        for ly in e.findall('lyric'):
            ann.setdefault((st, vo, t * unit // cur, ly.get('number') or '1'), ly)
    if not ann: return
    t = 0
    struck, chain = [], {}  # struck: [{e, sv, on, end, got}]; chain: (staff, voice) -> the head a tie would go on from
    for e in new:
        if e.tag == 'backup': t -= int(e.findtext('duration') or 0); continue
        if e.tag == 'forward': t += int(e.findtext('duration') or 0); continue
        for ly in e.findall('lyric'): e.remove(ly)
        if e.find('grace') is not None or e.find('chord') is not None: continue
        on = t
        t += int(e.findtext('duration') or 0)
        sv = _sv(e)
        if e.find('rest') is not None or e.find('pitch') is None and e.find('unpitched') is None:
            chain.pop(sv, None); continue
        h = chain.get(sv)
        if _tied(e, 'stop') and h is not None and h['end'] == on and _tied(h['last'], 'start'):
            h['end'], h['last'] = t, e  # held on: the chain's head sounds on
            continue
        h = {'e': e, 'sv': sv, 'on': on, 'end': t, 'last': e, 'got': set()}
        chain[sv] = h
        if not _tied(e, 'stop'): struck.append(h)  # tied in from the bar before: sounds, but is not struck here
    have = {h['sv'] for h in struck}
    staves = {h['sv'][0] for h in struck}

    def mine(sv):
        if sv in have: return [h for h in struck if h['sv'] == sv]
        return [h for h in struck if h['sv'][0] == sv[0]]

    def put(h, num, ly):
        h['got'].add(num); h['e'].append(ly)

    later = []
    for (st, vo, on, num), ly in sorted(ann.items(), key=lambda kv: (kv[0][2], kv[0][3])):
        hs = mine((st, vo)) if (st, vo) in have or st in staves else []
        h = next((h for h in hs if h['on'] == on and num not in h['got']), None)
        if h is not None: put(h, num, ly)
        else: later.append((hs, on, num, ly))
    for hs, on, num, ly in later:  # after every exact match, so a moved word never takes another word's note
        h = next((h for h in hs if h['on'] < on < h['end'] and num not in h['got']), None)
        if h is None: h = next((h for h in hs if h['on'] > on and num not in h['got']), None)
        if h is not None: put(h, num, ly)
    for h in struck:  # each note's lines in number order
        lys = h['e'].findall('lyric')
        if len(lys) > 1:
            for ly in lys: h['e'].remove(ly)
            lys.sort(key=lambda x: int(x.get('number')) if (x.get('number') or '').isdigit() else 1)
            for ly in lys: h['e'].append(ly)


def use_alternative(part, meas, alt_xml: str):
    """Put the other reading's notes into meas; the bar keeps its attributes, chord names, marks and words (the
    words by time: carry_lyrics)."""
    alt = ET.fromstring(alt_xml)
    cur = _divisions_at(part, meas)
    ad = next((int(a.findtext('divisions')) for a in alt.findall('attributes') if a.findtext('divisions')), cur)
    new = [e for e in alt if e.tag in ('note', 'backup', 'forward')]
    durs = [e.find('duration') for e in new if e.find('duration') is not None]
    unit = cur
    if any((int(d.text) * cur) % ad for d in durs):  # the score's unit can't hold these lengths: a finer one for this bar
        unit = cur * ad // math.gcd(cur, ad)
    for d in durs: d.text = str(int(d.text) * unit // ad)
    old = _timed(meas)
    carry_lyrics(old, new, cur, unit)
    lead = [e for e, t in old if e.tag == 'attributes' and t == 0]
    others = [(e, t * unit // cur) for e, t in old if e.tag not in ('note', 'backup', 'forward') and e not in lead and e.tag != 'barline']
    bars = [e for e in meas if e.tag == 'barline']
    for e in list(meas): meas.remove(e)
    if unit != cur:  # this bar counts in a finer unit; the next bar goes back to the score's
        at = lead[0] if lead else ET.Element('attributes')
        dv = at.find('divisions')
        if dv is None: dv = ET.Element('divisions'); at.insert(0, dv)
        dv.text = str(unit)
        if not lead: lead = [at]
        nxt = _next_measure(part, meas)
        if nxt is not None:
            a2 = next((a for a in nxt.findall('attributes')), None)
            if a2 is None or a2.find('divisions') is None:
                a2 = a2 if a2 is not None else ET.Element('attributes')
                dv2 = ET.Element('divisions'); dv2.text = str(cur); a2.insert(0, dv2)
                if a2 not in list(nxt): nxt.insert(0, a2)
    left = [b for b in bars if b.get('location') == 'left']
    for e in left + lead: meas.append(e)
    # notes of the first voice in order, with the chord names / marks at their onsets put just before them
    t = 0
    pending = sorted(others, key=lambda q: q[1])
    in_first = True
    for e in new:
        if e.tag == 'backup': in_first = False
        if in_first and e.tag == 'note' and e.find('chord') is None:
            while pending and pending[0][1] <= t: meas.append(pending.pop(0)[0])
        meas.append(e)
        if in_first and e.tag == 'note' and e.find('chord') is None and e.find('grace') is None: t += int(e.findtext('duration') or 0)
        if in_first and e.tag == 'forward': t += int(e.findtext('duration') or 0)
    for e, _ in pending: meas.append(e)
    for b in bars:
        if b.get('location') != 'left': meas.append(b)


def _next_measure(part, meas):
    ms = part.findall('measure')
    i = next((k for k, m in enumerate(ms) if m is meas), None)
    return ms[i + 1] if i is not None and i + 1 < len(ms) else None


def apply_check(text: str, bar: int, action: str, alt_xml: str | None = None) -> str:
    root = ET.fromstring(text.encode('utf-8'))
    for part in root.findall('part'):
        meas = _measure(part, bar)
        if meas is None: continue
        _unmark(meas)
        if action == 'use' and part is root.find('part'): use_alternative(part, meas, alt_xml)
    _drop_from_field(root, bar)
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n'


# ---------- API ----------

def _load(cf, it):
    d = item_dir(cf, it)
    p = check_file(d, it['folder'])
    if not p: raise HTTPException(404, 'This score has no bars to check')
    return d, p, json.loads(p.read_text(encoding='utf-8'))


@router.get('/items/{item_id}/check')
def get_check(item_id: str, c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    d, _, data = _load(cf, it)
    text = _xml_path(cf, it).read_text(encoding='utf-8')
    still = set(open_bars(text))
    for pg in data.get('pages', []):
        f = page_file(d, it['folder'], pg['page'])
        pg['url'] = f'/api/items/{item_id}/file/{f.name}' if f else None
    last = {}
    for x in data.get('decisions', []): last[x['bar']] = x
    for b in data.get('bars', []):
        b['open'] = b['bar'] in still
        b['decision'] = last.get(b['bar']) if not b['open'] else None
    data['open'] = sorted(still)
    data['sha'] = sha(text)
    return data


def _keep(d: Path, name: str) -> str:
    (d / '.history').mkdir(exist_ok=True)
    rel = f'.history/check-{now_ms()}-{name}'
    while (d / rel).exists(): rel = f'.history/check-{now_ms() + 1}-{name}'
    shutil.copyfile(d / name, d / rel)
    return rel


@router.post('/items/{item_id}/check')
def post_check(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    it = must_item(c, item_id)
    d, cp, data = _load(cf, it)
    action = body.get('action')
    if action not in ('ok', 'use'): raise HTTPException(400, 'action is ok or use')
    p = _xml_path(cf, it)
    text = p.read_text(encoding='utf-8')
    if body.get('sha') and body['sha'] != sha(text): raise HTTPException(409, 'This score was changed since — open the check again')
    many = body.get('bars')
    if many is not None:  # "Mark all as looks right"
        if action != 'ok': raise HTTPException(400, 'Several bars at once: action ok only')
        try: want = open_bars(text) if many == 'all' else [int(b) for b in many]
        except (TypeError, ValueError): raise HTTPException(400, 'bars is "all" or a list of bar numbers')
        bars = [b for b in want if b in open_bars(text)]
        if not bars: raise HTTPException(409, 'No bars are waiting for a check')
    else:
        try: bars = [int(body.get('bar'))]
        except (TypeError, ValueError): raise HTTPException(400, 'bar (a number) is required')
        if bars[0] not in open_bars(text): raise HTTPException(409, f'Bar {bars[0]} is not waiting for a check')
    bar = bars[0]
    entry = next((b for b in data.get('bars', []) if b['bar'] == bar), None)
    alt = None
    if action == 'use':
        alt = next((a for a in (entry or {}).get('alternatives', []) if a['id'] == body.get('alt')), None)
        if not alt: raise HTTPException(400, 'No such other reading for this bar')
    out = text
    for b in bars: out = apply_check(out, b, action, alt['musicxml'] if alt else None)
    hist = _keep(d, p.name)
    orig = it.get('musicxmlOriginal')
    if not orig:  # like note edits: the first change keeps the untouched file ("Revert")
        orig = f'{it["folder"]} (original).musicxml'
        if not (d / orig).exists(): shutil.copyfile(p, d / orig)
    p.write_text(out, encoding='utf-8')
    c.execute('UPDATE score SET musicxml=?, musicxml_original=? WHERE item_id=?', (p.name, orig, it['id']))
    c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), it['id']))
    refresh_staves(c, cf, it['id'])
    for b in bars: data.setdefault('decisions', []).append({'bar': b, 'action': action, 'alt': alt['id'] if alt else None, 'at': now_ms()})
    cp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    what = (f'{len(bars)} bars marked OK' if len(bars) > 1 else f'bar {bar}: ' + ('marked OK' if action == 'ok' else f'{alt["label"]} put in'))
    aid = record_undo(c, body.get('act') or 'bar-check',
                      {'op': 'musicxml', 'id': it['id'], 'title': it['title'], 'file': p.name, 'before': hist,
                       'beforeSha': sha(text), 'afterSha': sha(out), 'what': 'bar check'},
                      f'Checked a bar: {it["title"]}', f'{what}; the score before is kept in {hist}')
    return {'ok': True, 'activity': aid, 'history': hist, 'sha': sha(out), 'open': open_bars(out)}
