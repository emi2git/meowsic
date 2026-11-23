"""The chords of a score for the ukulele panel (web/js/ukepanel.js).

GET /api/items/{id}/score-chords -> {chords: [name, …] in order of first use, from: 'symbols' | 'notes' | 'none'}
A score with chord symbols (<harmony>) lists those (the app reads them off the drawn score, so they follow transpose);
one without has them worked out from its notes by the chord finder (chordfind.py), nothing saved.
"""
from fastapi import APIRouter, Depends, HTTPException

from . import chordfind as cf
from .items import cfg, conn, item_dir, must_item

router = APIRouter(prefix='/api')


def chords_of(data: bytes) -> tuple[list[str], str]:
    notes, bars, fifths, r = cf.read_xml(data)
    seen = []
    if r.harmonies:
        for h in r.harmonies:
            if h[4] and h[4] not in seen and h[4] != 'N.C.': seen.append(h[4])
        return seen, 'symbols'
    if not notes: return [], 'none'
    for c in cf.find_chords(notes, bars, fifths):
        if c.name and c.name not in seen: seen.append(c.name)
    return seen, 'notes' if seen else 'none'


@router.get('/items/{item_id}/score-chords')
def score_chords(item_id: str, c=Depends(conn), cf_=Depends(cfg)):
    it = must_item(c, item_id)
    if it['kind'] != 'score' or not it.get('musicxml'): raise HTTPException(400, 'Not a score with MusicXML')
    p = item_dir(cf_, it) / it['musicxml']
    if not p.is_file(): raise HTTPException(404, 'No MusicXML')
    names, src = chords_of(p.read_bytes())
    return {'chords': names, 'from': src}
