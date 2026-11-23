"""Simple piano (score toolbar → the "Simple piano" button, web/js/views/simplepiano.js): one menu, live preview.

Settings (all optional; defaults() gives what a score starts with):
  level      0–100  smooth rests + rhythm (smoothrhythm.py; when it lengthens a note its staccato goes)
  main       bool   main note only: chords → the main note per hand, extra voices go (arrange.clear, music21)
  staccato   bool   remove staccato (transcriptions mark many plain notes staccato) — on for audio / video scores
  grace      bool   remove grace notes & trills: <grace/>, trill-mark / turn / mordent / shake / wavy-line / tremolo,
                    and the transcription's own grace notes — a note of a 32nd or less (not tied) right before
                    another note of the same hand: it goes and the note after starts there (gets its time)
  marks      bool   remove dynamics & pedal marks (dynamics, wedges, pedal; tempo and words stay)

GET  /api/items/{id}/simplepiano                       -> {allowed, defaults}
POST /api/items/{id}/simplepiano/preview  {settings}   -> {xml, before, after, found, changed, sha, spans}  (nothing saved;
     spans = what changed (changes()): the menu highlights them in the preview)
POST /api/items/{id}/simplepiano  {settings, mode: 'this'|'new', sha?}
     'this': the file before goes to items/<folder>/.history/simple-<ms>-<name> + an Activities 'musicxml' step;
     'new': a new score in the same group, version "Simple piano" (clear), tagged "Simple piano" (Undo → Trash).
Pitches stay (except the grace notes asked to go), every bar stays full, ties stay right.
"""
import hashlib
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from collections import OrderedDict
from fractions import Fraction as Fr
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from . import smoothrhythm as sr
from .db import folder_path, get_item, now_ms, uid, write_item
from .easerests import _beat, _head, _no_staccato
from .items import cfg, conn, item_dir, must_item
from .sheetversion import refresh_staves
from .undolog import _q, record_undo

router = APIRouter(prefix='/api')
TAG = 'Simple piano'
KEYS = ('level', 'main', 'staccato', 'grace', 'marks')
ORNAMENTS = ('trill-mark', 'turn', 'delayed-turn', 'inverted-turn', 'delayed-inverted-turn', 'vertical-turn', 'shake',
             'mordent', 'inverted-mordent', 'wavy-line', 'schleifer', 'tremolo', 'haydn')
GRACE_MAX = Fr(1, 8)  # a 32nd (in quarters)


# ---------- which scores came from a recording ----------

FROM_AUDIO = re.compile(r'^(YouTube|Facebook|Audio file)\b')


def transcribed(c, it, _seen=None) -> bool:
    """The score was transcribed from a video / audio (a 'transcribe' job made it, or its source says so); a score
    saved from one ("as new") counts as its transcription's."""
    if it.get('kind') != 'score': return False
    if c.execute("SELECT 1 FROM job WHERE kind='transcribe' AND result LIKE ?", (f'%"{it["id"]}"%',)).fetchone(): return True
    if not it.get('ai') and FROM_AUDIO.match(it.get('source') or '') and (it.get('sourceUrl') or str(it.get('source')).startswith('Audio file')): return True
    if TAG in (it.get('tags') or []) and it.get('groupId'):
        seen = _seen or {it['id']}
        for (i,) in c.execute('SELECT item_id FROM score WHERE group_id=?', (it['groupId'],)).fetchall():
            if i in seen: continue
            seen.add(i)
            o = get_item(c, i)
            if o and TAG not in (o.get('tags') or []) and transcribed(c, o, seen): return True
    return False


def defaults(c=None, it=None, heard=None) -> dict:
    """What the menu starts with: a transcription gets rhythm smoothing, staccato and grace notes removed."""
    if heard is None: heard = bool(c and it and transcribed(c, it))
    return {'level': 60 if heard else 0, 'main': True,
            'staccato': heard, 'grace': heard, 'marks': False}


def settings(body: dict, base: dict | None = None) -> dict:
    s = dict(base or defaults(heard=False))
    for k in KEYS:
        if k not in body: continue
        if k == 'level':
            try: v = int(body[k])
            except (TypeError, ValueError): raise HTTPException(400, 'level: 0 to 100')
            if not 0 <= v <= 100: raise HTTPException(400, 'level: 0 to 100')
            s[k] = v
        else: s[k] = bool(body[k])
    return s


# ---------- the steps ----------

_MAIN = OrderedDict()  # sha → main-note text (music21 is slow; the slider should not wait for it every time)


def main_note(text: str) -> str:
    from . import arrange
    k = hashlib.sha1(text.encode()).hexdigest()
    if k in _MAIN: _MAIN.move_to_end(k); return _MAIN[k]
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d) / 'in.musicxml', Path(d) / 'out.musicxml'
        src.write_text(text, encoding='utf-8')
        arrange.clear(src).write('musicxml', fp=str(out))
        res = out.read_text(encoding='utf-8')
    _MAIN[k] = res
    while len(_MAIN) > 8: _MAIN.popitem(last=False)
    return res


def _drop(parent, el):
    parent.remove(el)


def _clean_notations(n, tags):
    """Remove tags from <notations> (and in <ornaments> / <articulations>); empty containers go. Returns how many."""
    k = 0
    nt = n.find('notations')
    if nt is None: return 0
    for box in [nt, *nt.findall('ornaments'), *nt.findall('articulations'), *nt.findall('technical')]:
        for e in list(box):
            if e.tag in tags: box.remove(e); k += 1
    for box in [*nt.findall('ornaments'), *nt.findall('articulations'), *nt.findall('technical')]:
        if not len(box) and not (box.tag == 'ornaments' and box.findall('accidental-mark')): nt.remove(box)
    if not len(nt): n.remove(nt)
    return k


def remove_staccato(root) -> int:
    k = 0
    for n in root.iter('note'): k += _clean_notations(n, ('staccato', 'staccatissimo', 'spiccato'))
    return k


def remove_marks(root) -> int:
    """Dynamics, hairpins and pedal marks (directions and note dynamics); tempo marks and words stay."""
    k = 0
    for meas in root.iter('measure'):
        for d in list(meas.findall('direction')):
            for dt in list(d.findall('direction-type')):
                for e in list(dt):
                    if e.tag in ('dynamics', 'wedge', 'pedal'): dt.remove(e); k += 1
                if not len(dt): d.remove(dt)
            snd = d.find('sound')
            if snd is not None:
                for a in ('dynamics', 'damper-pedal', 'soft-pedal', 'sostenuto-pedal'): snd.attrib.pop(a, None)
            if d.find('direction-type') is None: meas.remove(d)
        for n in meas.findall('note'): k += _clean_notations(n, ('dynamics',))
    return k


def remove_grace(root) -> dict:
    """Grace notes, ornaments and the transcription's own grace notes (see the module doc). Counts what went."""
    found = {'grace': 0, 'ornaments': 0, 'short': 0}
    for meas in root.iter('measure'):
        for n in list(meas.findall('note')):
            if n.find('grace') is not None: meas.remove(n); found['grace'] += 1
            else: found['ornaments'] += _clean_notations(n, ORNAMENTS)
    for part in root.findall('part'):
        div, tsig = Fr(1), (4, 4)
        for meas in part.findall('measure'):
            div, tsig = sr._attrs(meas, div, tsig)
            items = sr._runs(meas, div)
            changed = False
            for r in items:
                if not isinstance(r, dict) or not r['ok']: continue
                out = []
                for i, e in enumerate(r['evs']):
                    nx = r['evs'][i + 1] if i + 1 < len(r['evs']) else None
                    if (nx is not None and not e.rest and not nx.rest and not e.tup and not nx.tup and e.q <= GRACE_MAX
                            and not sr._ties(e, 'start') and not sr._ties(e, 'stop') and not sr._ties(nx, 'stop')
                            and sr._writable(e.q + nx.q, div) and sr._pitches(e) != sr._pitches(nx)):
                        nx.q += e.q; nx.touched = True; nx.extra = e.extra + nx.extra
                        if not any(x.find('lyric') is not None for x in nx.notes):
                            for ly in e.notes[0].findall('lyric'): sr._put(nx.notes[0], ly)
                        found['short'] += 1; changed = True; r['changed'] = True
                        continue
                    out.append(e)
                r['evs'] = out
            if changed: sr._rebuild(meas, items, div, _beat(tsig))
    return found


def make(text: str, s: dict):
    """(new MusicXML text, stats before, stats after, found). Nothing changed → the text as it was."""
    out, before, after, found = _make(text, s)
    if _same(out, text): return text, before, before, found
    return out, before, after, found


def _same(a: str, b: str) -> bool:
    def canon(t):
        t = t[t.find('<score-partwise'):]
        return ET.canonicalize(t, strip_text=True)
    try: return canon(a) == canon(b)
    except ET.ParseError: return False


def _make(text: str, s: dict):
    before = sr.stats(text)
    found = {}
    if s.get('main'): text = main_note(text)
    root = ET.fromstring(text.encode('utf-8'))
    if s.get('grace'): found.update(remove_grace(root))
    if s.get('staccato'): found['staccato'] = remove_staccato(root)
    if s.get('marks'): found['marks'] = remove_marks(root)
    ET.indent(root, space='  ')
    text = _head(text) + ET.tostring(root, encoding='unicode') + '\n'
    if s.get('level'): text, _, _ = sr.smooth(text, s['level'])
    return text, before, sr.stats(text), found


# ---------- what changed (the preview's highlights) ----------

MARK_TAGS = ('dynamics', 'wedge', 'pedal')
NOTE_FLAGS = ('staccato', 'staccatissimo', 'spiccato', 'dynamics', *ORNAMENTS)


def _events(text: str) -> dict:
    """{(measure index, staff index in the score): Counter of events}. An event: (onset, length, what, grace, flags)
    in quarters — what = the pitch or 'R' — or a dynamics / pedal mark: (onset, 0, ('mark', kinds…))."""
    from collections import Counter
    root = ET.fromstring(text[text.find('<score-partwise'):].encode('utf-8'))
    out, base = {}, 0
    for part in root.findall('part'):
        div, most = Fr(1), 1
        for mi, meas in enumerate(part.findall('measure')):
            pos = last = Fr(0)
            for el in meas:
                if el.tag == 'attributes':
                    if el.findtext('divisions'): div = Fr(el.findtext('divisions'))
                    if (el.findtext('staves') or '').isdecimal(): most = max(most, int(el.findtext('staves')))
                elif el.tag in ('backup', 'forward'):
                    d = Fr(el.findtext('duration') or 0) / div
                    pos += -d if el.tag == 'backup' else d
                elif el.tag == 'direction':
                    kinds = sorted({e.tag for dt in el.findall('direction-type') for e in dt if e.tag in MARK_TAGS})
                    if kinds:
                        at = pos + Fr(el.findtext('offset') or 0) / div
                        key = (mi, base + int(el.findtext('staff') or 1) - 1)
                        out.setdefault(key, Counter())[(at, Fr(0), ('mark', *kinds))] += 1
                elif el.tag == 'note':
                    grace = el.find('grace') is not None
                    d = Fr(0) if grace else Fr(el.findtext('duration') or 0) / div
                    if el.find('chord') is not None: at = last
                    else: at = last = pos; pos += d
                    p = el.find('pitch')
                    what = 'R' if p is None else f"{p.findtext('step')}{p.findtext('alter') or ''}{p.findtext('octave')}"
                    nt = el.find('notations')
                    flags = tuple(sorted({e.tag for e in nt.iter() if e.tag in NOTE_FLAGS})) if nt is not None else ()
                    key = (mi, base + int(el.findtext('staff') or 1) - 1)
                    out.setdefault(key, Counter())[(at, d, what, grace, flags)] += 1
        base += most
    return out


def changes(before: str, after: str) -> list[dict]:
    """What differs: [{m, s, a, b}] = measure index, staff (0 = the score's top staff), from / to in quarters into the
    bar. An event in only one version marks its time (a mark: the note it sits on); overlapping / touching spans merge."""
    try: x, y = _events(before), _events(after)
    except ET.ParseError: return []
    res = []
    for key in sorted(set(x) | set(y)):
        a, b = x.get(key, {}), y.get(key, {})
        diff = [e for e in set(a) | set(b) if a.get(e, 0) != b.get(e, 0)]
        if not diff: continue
        notes = [e for e in [*a, *b] if e[1]]
        spans = []
        for e in diff:
            lo, hi = e[0], e[0] + e[1]
            if hi == lo:  # a mark / grace note: the note it sits on, else up to the next one
                hi = max((n[0] + n[1] for n in notes if n[0] == lo), default=None) \
                    or min((n[0] for n in notes if n[0] > lo), default=lo + Fr(1, 2))
            spans.append([lo, hi])
        spans.sort()
        merged = [spans[0]]
        for lo, hi in spans[1:]:
            if lo <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], hi)
            else: merged.append([lo, hi])
        res += [{'m': key[0], 's': key[1], 'a': float(lo), 'b': float(hi)} for lo, hi in merged]
    return res


def write_midi(xml: Path, mid: Path):
    """MIDI from a MusicXML file (chord symbols left out: they would sound)."""
    from music21 import converter, harmony
    sc = converter.parse(str(xml))
    for cs in list(sc.recurse().getElementsByClass(harmony.ChordSymbol)): cs.activeSite.remove(cs)
    sc.write('midi', fp=str(mid))


# ---------- API ----------

def _xml_path(cf, it):
    if it['kind'] != 'score' or not it.get('musicxml'): raise HTTPException(400, 'Not a score with MusicXML')
    p = item_dir(cf, it) / it['musicxml']
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    return p


@router.get('/items/{item_id}/simplepiano')
def can_simplify(item_id: str, c=Depends(conn)):
    it = must_item(c, item_id)
    ok = it.get('kind') == 'score' and bool(it.get('musicxml'))
    return {'allowed': ok, 'why': None if ok else 'Not a score with MusicXML', 'defaults': defaults(c, it), 'transcribed': transcribed(c, it)}


@router.post('/items/{item_id}/simplepiano/preview')
def preview(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    from .lyricsedit import sha
    it = must_item(c, item_id)
    text = _xml_path(cf, it).read_text(encoding='utf-8')
    s = settings(body, defaults(c, it))
    out, a, b, found = make(text, s)
    return {'xml': out, 'before': a, 'after': b, 'found': found, 'settings': s, 'changed': out != text, 'sha': sha(text),
            'spans': changes(text, out) if out != text else []}


def keep(d, name):
    (d / '.history').mkdir(exist_ok=True)
    rel = f'.history/simple-{now_ms()}-{name}'
    n = 1
    while (d / rel).exists(): rel = f'.history/simple-{now_ms() + n}-{name}'; n += 1
    shutil.copyfile(d / name, d / rel)
    return rel


@router.post('/items/{item_id}/simplepiano')
def save(item_id: str, body: dict = Body(...), c=Depends(conn), cf=Depends(cfg)):
    from .lyricsedit import sha
    it = must_item(c, item_id)
    p = _xml_path(cf, it)
    text = p.read_text(encoding='utf-8')
    if body.get('sha') and body['sha'] != sha(text):
        raise HTTPException(409, 'This score was changed since the preview — open Simple piano again')
    s = settings(body, defaults(c, it))
    out, a, b, found = make(text, s)
    if out == text: raise HTTPException(422, 'Nothing to change with these settings')
    what = f"{a['rests']} → {b['rests']} rests" + (f", level {s['level']}" if s['level'] else '')
    if body.get('mode') == 'new':
        t = now_ms()
        new = {'id': uid('m'), 'kind': 'score', 'title': it['title'], 'artist': it.get('artist') or '',
               'tags': [*[x for x in it.get('tags', []) if x != TAG], TAG], 'createdAt': t, 'updatedAt': t, 'originAt': t,
               'version': 'clear', 'source': f'From the score {_q(it["title"])}, Simple piano',
               'groupId': it.get('groupId') or uid('g'), 'key': it.get('key') or '', 'bpm': it.get('bpm'), 'ai': it.get('ai') or 0,
               'sourceUrl': it.get('sourceUrl') or ''}
        if not it.get('groupId'): c.execute('UPDATE score SET group_id=? WHERE item_id=?', (new['groupId'], it['id']))
        write_item(c, new, new=True)
        d = folder_path(cf, new['folder'])
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{new["folder"]}.musicxml').write_text(out, encoding='utf-8')
        c.execute('UPDATE score SET musicxml=? WHERE item_id=?', (f'{new["folder"]}.musicxml', new['id']))
        refresh_staves(c, cf, new['id'])
        aid = record_undo(c, 'simple-piano', {'op': 'created', 'ids': [new['id']], 'titles': [new['title']]},
                          f'Simple piano: {it["title"]}', f'New version, {what} (the score it came from is untouched)')
        return {'ok': True, 'mode': 'new', 'item': get_item(c, new['id']), 'activity': aid, 'before': a, 'after': b, 'found': found}
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
    aid = record_undo(c, 'simple-piano', {'op': 'musicxml', 'id': it['id'], 'title': it['title'], 'file': p.name, 'before': hist,
                                          'beforeSha': sha(text), 'afterSha': sha(out), 'what': 'it was made simpler'},
                      f'Simple piano: {it["title"]}', f'{what}; the score before is kept in {hist}')
    return {'ok': True, 'mode': 'this', 'item': get_item(c, it['id']), 'activity': aid, 'history': hist, 'sha': sha(out),
            'before': a, 'after': b, 'found': found}
