"""Every score is credited to "Meowsic" (one-off, safe to run again: does nothing once done).

For each score item (the Trash too):
  artist   'Meowsic AI' or empty      -> 'Meowsic'   (a song's real artist, e.g. "Les Miserables", stays)
  source   'Meowsic AI' (or an AI piece's empty one) -> 'Meowsic'
  MusicXML (musicxml, musicxml_original): one <creator type="composer">Meowsic</creator> (db.credit_xml)
Old activity texts that name "Meowsic AI" read "Meowsic".
History: each changed file is first copied to items/<folder>/.history/credit-<ts>-<file>; every change goes to
<data>/history/credit-meowsic-<ts>.json (never removed); one Activities row, undoable (op 'credit', undo.py).

  python -m meowsic.creditfix [--data ~/Documents/Meowsic] [--dry-run]
"""
import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

from .db import AI_SOURCE, OLD_CREDITS, Config, connect, credit_xml, folder_path, log_event, now_ms

XML_COLS = ('musicxml', 'musicxml_original')


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def plan(c, cf):
    out = []
    rows = c.execute("""SELECT i.id, i.title, i.artist, i.folder, s.source, s.ai, s.musicxml, s.musicxml_original
                        FROM item i JOIN score s ON s.item_id = i.id ORDER BY i.created_at""").fetchall()
    for r in rows:
        old, new = {}, {}
        if (r['artist'] or '').strip() in ('', *OLD_CREDITS): old['artist'], new['artist'] = r['artist'], AI_SOURCE
        if r['source'] in OLD_CREDITS or (r['ai'] and not (r['source'] or '').strip()): old['source'], new['source'] = r['source'], AI_SOURCE
        files = []
        d = folder_path(cf, r['folder']) if r['folder'] else None
        for col in XML_COLS:
            if not d or not r[col]: continue
            p = d / r[col]
            try: x = p.read_text(encoding='utf-8')
            except (OSError, UnicodeDecodeError): continue
            y = credit_xml(x)
            if y != x: files.append({'col': col, 'file': r[col], 'path': p, 'text': y})
        if old or files:
            out.append({'id': r['id'], 'title': r['title'], 'folder': r['folder'], 'old': old, 'new': new, 'files': files})
    return out


def run(data=None, *, dry_run=False, log=print) -> dict:
    cf = Config.from_env(data)
    c = connect(cf)
    p = plan(c, cf)
    acts = [r for r in c.execute("SELECT id, title, detail FROM activity WHERE title LIKE '%Meowsic AI%' OR detail LIKE '%Meowsic AI%'")]
    res = {'items': len(p), 'fields': sum(len(x['old']) for x in p), 'files': sum(len(x['files']) for x in p), 'activities': len(acts), 'log': None}
    if dry_run or not (p or acts):
        for x in p: log(f"{x['id']} {x['title']}: {x['old']} -> {x['new']}, files {[f['file'] for f in x['files']]}")
        c.close()
        return res
    stamp, t = time.strftime('%Y%m%d-%H%M%S'), now_ms()
    h = cf.data / 'history'
    h.mkdir(exist_ok=True)
    name = f'credit-meowsic-{stamp}.json'
    changes, steps = [], []
    for x in p:
        files = []
        for f in x['files']:
            hd = f['path'].parent / '.history'
            hd.mkdir(exist_ok=True)
            keep = hd / f'credit-{stamp}-{f["file"]}'
            shutil.copy2(f['path'], keep)  # the old version first
            f['path'].write_text(f['text'], encoding='utf-8')
            files.append({'col': f['col'], 'file': f['file'], 'history': f'.history/{keep.name}', 'sha': sha(f['path'])})
        if 'artist' in x['new']: c.execute('UPDATE item SET artist=? WHERE id=?', (x['new']['artist'], x['id']))
        if 'source' in x['new']: c.execute('UPDATE score SET source=? WHERE item_id=?', (x['new']['source'], x['id']))
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (t, x['id']))
        step = {'op': 'credit', 'id': x['id'], 'title': x['title'], 'old': x['old'], 'new': x['new'], 'files': files}
        steps.append(step)
        changes.append({'at': t, 'id': x['id'], 'title': x['title'], 'folder': x['folder'], 'before': x['old'], 'after': x['new'],
                        'files': files, 'via': 'creditfix'})
    act_changes = []
    for a in acts:
        nt, nd = a['title'].replace('Meowsic AI', 'Meowsic'), a['detail'].replace('Meowsic AI', 'Meowsic')
        c.execute('UPDATE activity SET title=?, detail=? WHERE id=?', (nt, nd, a['id']))
        act_changes.append({'id': a['id'], 'before': {'title': a['title'], 'detail': a['detail']}, 'after': {'title': nt, 'detail': nd}})
    (h / name).write_text(json.dumps({'what': 'Scores credited to Meowsic', 'at': t, 'scores': changes, 'activities': act_changes},
                                     ensure_ascii=False, indent=1))
    if steps:
        log_event(c, 'credit', 'Scores credited to Meowsic',
                  f'{len(steps)} score(s): composer, artist, source → Meowsic; {res["files"]} MusicXML file(s) (log: history/{name})',
                  undo={'steps': steps})
    c.commit()
    c.close()
    res['log'] = str(h / name)
    log(json.dumps(res))
    return res


def undo_step(c, cf, s, mode):
    """Activities Undo of one 'credit' step: artist / source and the MusicXML files back (current files kept in .history)."""
    from .db import get_item
    from .undolog import _q
    it = get_item(c, s['id'])
    what = _q(it['title'] if it else s.get('title', s['id']))
    if not it: return [{'status': 'skip', 'what': what, 'why': 'deleted for good since'}]
    d = folder_path(cf, it['folder']) if it.get('folder') else None
    cur = {k: it.get(k) or '' for k in s['new']}
    fields_back = all(cur[k] == (s['old'][k] or '') for k in s['new'])
    fields_new = all(cur[k] == s['new'][k] for k in s['new'])
    todo, changed = [], []
    for f in s.get('files') or []:
        p, keep = (d / f['file'], d / f['history']) if d else (None, None)
        if not p or not keep.is_file(): changed.append(f'{f["file"]} (its old copy is gone)'); continue
        if not p.is_file() or sha(p) != f['sha']:
            if p.is_file() and sha(p) == sha(keep): continue  # already back
            changed.append(f['file'])
        todo.append((p, keep))
    if fields_back and not todo and not changed: return [{'status': 'skip', 'what': what, 'why': 'already back'}]
    if not fields_new and not fields_back: changed[:0] = [k for k in s['new'] if cur[k] != s['new'][k]]
    if changed and mode != 'force':
        return [{'status': 'conflict', 'what': what, 'why': f'{", ".join(changed)} changed since'}]
    if mode != 'check':
        stamp = time.strftime('%Y%m%d-%H%M%S')
        for p, keep in todo:
            if p.is_file(): shutil.copy2(p, p.parent / '.history' / f'credit-undo-{stamp}-{p.name}')  # history only grows
            shutil.copy2(keep, p)
        if 'artist' in s['old']: c.execute('UPDATE item SET artist=? WHERE id=?', (s['old']['artist'], s['id']))
        if 'source' in s['old']: c.execute('UPDATE score SET source=? WHERE item_id=?', (s['old']['source'], s['id']))
        c.execute('UPDATE item SET updated_at=? WHERE id=?', (now_ms(), s['id']))
    return [{'status': 'ok', 'what': what}]


def main():
    ap = argparse.ArgumentParser(description='Credit every score to "Meowsic".')
    ap.add_argument('--data', default=None)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    run(a.data, dry_run=a.dry_run)


if __name__ == '__main__':
    main()
