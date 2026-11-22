"""Offline AI tag suggestions: a local LLM (MLX, ~/ai/models) plus simple rules. Nothing leaves the Mac.

POST /api/ai/autotag      {ids, wait?}                 -> job kind 'tags'; result {suggestions: [{id, add, remove, why}]}
POST /api/ai/collections  {scope, look, wait?}         -> job kind 'tags'; result {groups: [{name, look, why, ids, existing}]}
GET  /api/ai/status                                     -> {model, loaded, available}

Both run as a job (progress + log lines on /api/jobs/<id>); pass `wait: true` to get the result in the response instead.
They only suggest: tags are saved later by the UI through /api/tags/set.
"""
import gc
import json
import logging
import os
import re
import threading
import time
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request

from .db import connect, folder_path

os.environ.setdefault('HF_HUB_CACHE', str(Path.home() / 'ai' / 'models' / 'huggingface'))

log = logging.getLogger('meowsic')
router = APIRouter(prefix='/api/ai')

MODELS = ('mlx-community/Qwen2.5-7B-Instruct-4bit', 'mlx-community/Qwen2.5-3B-Instruct-4bit')  # first one found locally wins
IDLE_UNLOAD_S = 600
SYSTEM = 'You are a careful music librarian. You answer with JSON only. When you are not sure, you leave the field out.'


class ModelMissing(RuntimeError):
    pass


class LocalLLM:
    """Loaded on first use, kept in memory, unloaded after IDLE_UNLOAD_S without use. One generation at a time."""

    def __init__(self, idle=IDLE_UNLOAD_S):
        self.idle, self.model, self.tok, self.name = idle, None, None, None
        self.lock, self.timer = threading.Lock(), None

    @staticmethod
    def find():
        """(repo, local path) of the first model already in HF_HUB_CACHE. Never downloads."""
        from huggingface_hub import snapshot_download
        for repo in MODELS:
            try: return repo, snapshot_download(repo, local_files_only=True)
            except Exception: continue
        raise ModelMissing(f'No local model found in {os.environ["HF_HUB_CACHE"]}; run: .venv/bin/python -m meowsic.ai download')

    def _load(self):
        if self.model is None:
            from mlx_lm import load
            self.name, path = self.find()
            t = time.time()
            self.model, self.tok = load(path)
            log.info('AI model %s loaded in %.1fs', self.name, time.time() - t)

    def _arm(self):
        if self.timer: self.timer.cancel()
        self.timer = threading.Timer(self.idle, self.unload)
        self.timer.daemon = True
        self.timer.start()

    def unload(self):
        with self.lock:
            if self.model is None: return
            self.model = self.tok = None
            gc.collect()
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception: pass
            log.info('AI model unloaded (idle)')

    def complete_many(self, prompts: list[str], max_tokens=1500) -> list[str]:
        """One chat turn per prompt, generated together (batched), greedy."""
        with self.lock:
            try:
                self._load()
                from mlx_lm import batch_generate, generate
                toks = [self.tok.apply_chat_template([{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': p}],
                                                     add_generation_prompt=True, tokenize=True) for p in prompts]
                if len(toks) == 1:
                    return [generate(self.model, self.tok, toks[0], max_tokens=max_tokens)]
                return list(batch_generate(self.model, self.tok, toks, max_tokens=max_tokens).texts)
            finally:
                self._arm()

    def status(self):
        try: avail = self.find()[0]
        except ModelMissing: avail = None
        return {'model': self.name or avail, 'loaded': self.model is not None, 'available': avail is not None}


LLM = LocalLLM()


def complete_many(prompts, max_tokens=1500):  # tests replace this
    return LLM.complete_many(prompts, max_tokens)


# ---------- helpers ----------

def norm(s: str) -> str:
    """'Les Misérables' == 'les miserables' == 'Les Miserables (musical)'; 'The Phantom…' == 'Phantom…'."""
    s = re.sub(r'\([^)]*\)', ' ', s or '')
    s = ''.join(ch for ch in unicodedata.normalize('NFKD', s) if not unicodedata.combining(ch)).replace('đ', 'd').replace('Đ', 'D')
    s = re.sub(r'[^\w]+', ' ', s.casefold()).strip()
    return re.sub(r'^the ', '', s)


def parse_json(text: str):
    """The model's JSON object (code fences and chatter around it ignored); a cut-off reply keeps its complete entries."""
    text = re.sub(r'```(?:json)?', '', text or '')
    a = text.find('{')
    if a < 0: return {}
    body = text[a:]
    for end in [len(body)] + [m.end() for m in reversed(list(re.finditer(r'\}', body)))]:
        chunk = body[:end]
        try: return json.loads(chunk)
        except ValueError:
            try: return json.loads(chunk + '}')
            except ValueError: continue
    return {}


JUNK = {'', 'unknown', 'none', 'null', 'n/a', 'na', 'various', 'traditional', 'anonymous', 'unknown artist', '-', '?'}


def clean_val(v):
    if not isinstance(v, str): return None
    v = re.sub(r'\s+', ' ', v).strip().strip('"').strip()
    return None if v.casefold() in JUNK or len(v) > 80 else v


def short_title(t: str) -> str:
    return re.sub(r'\s+', ' ', t or '').strip()[:110]


# ---------- language by script (before the LLM) ----------

VI_CHARS = set('ăâđêôơưĂÂĐÊÔƠƯ') | set('ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ')


def script_language(text: str):
    t = text or ''
    if re.search(r'[぀-ヿ]', t): return 'Japanese'
    if re.search(r'[가-힯ᄀ-ᇿ]', t): return 'Korean'
    if re.search(r'[一-鿿㐀-䶿]', t): return 'Chinese'
    if re.search(r'[Ѐ-ӿ]', t): return 'Russian'
    if re.search(r'[؀-ۿ]', t): return 'Arabic'
    if re.search(r'[฀-๿]', t): return 'Thai'
    if any(ch in VI_CHARS for ch in unicodedata.normalize('NFC', t)): return 'Vietnamese'
    return None


LANG_ALIASES = {'Japanese': ('Japan',), 'Korean': ('Korea',), 'Chinese': ('China', 'Mandarin'), 'Vietnamese': ('VN', 'Vietnam'),
                'Russian': ('Russia',), 'English': ()}


# ---------- library rows ----------

def library_rows(c, scope='all', ids=None):
    """[{id, kind, title, artist, version, printed, tags, page}] for items not in Trash.
    scope: all | untagged | sheet | chords | score. `page` = first page's OCR text when there is any."""
    q = '''SELECT item.id, item.kind, item.title, item.artist, item.printed_at, score.version,
                  (SELECT ocr_text FROM sheet_page p WHERE p.item_id = item.id AND COALESCE(ocr_text,'') != '' ORDER BY page LIMIT 1) AS page
           FROM item LEFT JOIN score ON score.item_id = item.id WHERE item.deleted_at IS NULL'''
    args = []
    if ids is not None:
        q += f' AND item.id IN ({",".join("?" * len(ids))})'
        args += list(ids)
    elif scope in ('sheet', 'chords', 'score'):
        q += ' AND item.kind = ?'
        args.append(scope)
    q += ' ORDER BY item.created_at'
    tags = {}
    for i, t in c.execute('SELECT item_id, tag FROM item_tag'):
        tags.setdefault(i, []).append(t)
    rows = [{'id': r['id'], 'kind': r['kind'], 'title': r['title'], 'artist': r['artist'] or '', 'version': r['version'] or '',
             'printed': r['printed_at'] is not None, 'tags': tags.get(r['id'], []), 'page': r['page'] or ''} for r in c.execute(q, args)]
    if scope == 'untagged' and ids is None:
        rows = [r for r in rows if not r['tags']]
    return rows


def vocabulary(c):
    return [r[0] for r in c.execute('SELECT name FROM tag ORDER BY rowid')]


# ---------- Apple Vision OCR (page 1 of a sheet, only when it has no text yet) ----------

def vision_ocr(path: Path) -> str:
    """Text on an image via Apple Vision (on-device). '' when Vision is not available or finds nothing."""
    try:
        import Vision
        from Foundation import NSURL
    except ImportError:
        return ''
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(['en-US', 'vi-VN', 'zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR', 'ru-RU', 'fr-FR', 'de-DE'])
    req.setUsesLanguageCorrection_(True)
    h = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), None)
    ok, _ = h.performRequests_error_([req], None)
    if not ok: return ''
    lines = [o.topCandidates_(1)[0].string() for o in (req.results() or []) if o.topCandidates_(1)]
    return '\n'.join(lines).strip()


def ensure_page_text(cfg, row, save=True) -> str:
    """OCR page 1 when the sheet has no page text; the text is kept in sheet_page.ocr_text (not a tag)."""
    if row['page'] or row['kind'] != 'sheet': return row['page']
    c = connect(cfg)
    try:
        r = c.execute('SELECT item.folder, p.file FROM sheet_page p JOIN item ON item.id = p.item_id WHERE p.item_id=? ORDER BY page LIMIT 1',
                      (row['id'],)).fetchone()
        if not r or not r['folder']: return ''
        f = folder_path(cfg, r['folder']) / r['file']
        if not f.is_file(): return ''
        try: text = vision_ocr(f)
        except Exception as e:
            log.warning('OCR failed on %s: %s', f, e)
            return ''
        if text and save:
            c.execute('UPDATE sheet_page SET ocr_text=? WHERE item_id=? AND page=(SELECT MIN(page) FROM sheet_page WHERE item_id=?)',
                      (text, row['id'], row['id']))
            c.commit()
        row['page'] = text
        return text
    finally:
        c.close()


# ---------- auto-tag ----------

AUTOTAG_BATCH = 8


def autotag_prompt(vocab, batch):
    lines = []
    for n, r in enumerate(batch, 1):
        bits = [f'{n}. "{short_title(r["title"])}"', f'kind: {r["kind"]}']
        if r['artist']: bits.append(f'artist: {r["artist"]}')
        if r['version']: bits.append(f'version: {r["version"]}')
        if r['tags']: bits.append(f'already tagged: {", ".join(r["tags"])}')
        if r['page']: bits.append(f'page text: {re.sub(r"\s+", " ", r["page"])[:300]}')
        lines.append(' | '.join(bits))
    return ('Tag list (use ONLY these exact tags, never invent new ones):\n' + json.dumps(vocab, ensure_ascii=False) +
            '\n\nFor each numbered song, pick the tags from the list that clearly fit it: the movie or musical it is from, '
            'the composer or performer, the language of its lyrics, its genre or style, an occasion such as Christmas. '
            'Use what you know about the song from its title, plus the artist and page text when given. '
            'Pick nothing rather than guess.\n\n' + '\n'.join(lines) +
            '\n\nReply with one JSON object: {"1": {"add": ["Tag", ...], "why": "few words"}, "2": ...}')


def printed_state(r):
    want, other = ('Printed', 'Never printed') if r['printed'] else ('Never printed', 'Printed')
    return ([] if want in r['tags'] else [want]), ([other] if other in r['tags'] else [])


def autotag(rows, vocab, progress=lambda done, total, msg: None, ocr=None):
    """rows from library_rows -> [{id, add, remove, why}]. Tags outside `vocab` are dropped; Printed / Never printed by rule."""
    canon = {norm(t): t for t in vocab if t not in ('Printed', 'Never printed')}
    llm_vocab = list(canon.values())
    out = {r['id']: {'id': r['id'], 'add': [], 'remove': [], 'why': ''} for r in rows}
    if ocr:
        for r in rows: ocr(r)
    batches = [rows[i:i + AUTOTAG_BATCH] for i in range(0, len(rows), AUTOTAG_BATCH)] if llm_vocab else []
    for k, b in enumerate(batches):
        progress(k, len(batches), f'Reading songs {k * AUTOTAG_BATCH + 1}–{k * AUTOTAG_BATCH + len(b)} of {len(rows)}')
        reply = parse_json(complete_many([autotag_prompt(llm_vocab, b)], max_tokens=60 * len(b) + 100)[0])
        for n, r in enumerate(b, 1):
            v = reply.get(str(n)) if isinstance(reply, dict) else None
            if not isinstance(v, dict): continue
            have = {norm(t) for t in r['tags']}
            add = [canon[norm(t)] for t in v.get('add') or [] if isinstance(t, str) and norm(t) in canon and norm(t) not in have]
            out[r['id']]['add'] = list(dict.fromkeys(add))
            if add and isinstance(v.get('why'), str): out[r['id']]['why'] = v['why'].strip()[:200]
    for r in rows:
        add, remove = printed_state(r)
        s = out[r['id']]
        s['add'] += add
        s['remove'] += remove
        if add or remove:
            s['why'] = '; '.join(x for x in (s['why'], 'printed before' if r['printed'] else 'never printed') if x)
    progress(len(batches), len(batches), f'Suggested tags for {sum(1 for s in out.values() if s["add"] or s["remove"])} of {len(rows)} songs')
    return [out[r['id']] for r in rows]


# ---------- collections ("Make tags…") ----------

LOOKS = ('work', 'singer', 'composer', 'language', 'occasion', 'printed')
LLM_FIELDS = {'work': ('w', 'the movie, musical, opera, ballet, TV show, anime or video game the song was written for or made famous by '
                            '(its usual English name). Leave it out for ordinary pop songs, folk songs and classical pieces'),
              'singer': ('s', 'the ONE singer or band best known for the song (a single name). Leave it out for instrumental pieces'),
              'composer': ('c', 'who wrote or composed it (one name, or a songwriting team joined with "&")'),
              'occasion': ('o', 'only for songs meant for an occasion or season: Christmas, Birthday, Wedding, Halloween, Easter, New Year, '
                                'Lunar New Year, Mid-Autumn, Lullaby'),
              'language': ('l', 'the language of the lyrics, if it has lyrics')}
EXAMPLE_IN = '1. Let It Go (C)\n2. Für Elise\n3. Silent Night Arr. Hal Leonard\n4. Hello Vietnam\n5. Untitled 3'
EXAMPLE_OUT = {'1': {'t': 'Let It Go', 'w': 'Frozen', 's': 'Idina Menzel', 'c': 'Kristen Anderson-Lopez & Robert Lopez', 'l': 'English'},
               '2': {'t': 'Für Elise', 'c': 'Ludwig van Beethoven'},
               '3': {'t': 'Silent Night', 'c': 'Franz Xaver Gruber', 'o': 'Christmas', 'l': 'English'},
               '4': {'t': 'Hello Vietnam', 's': 'Phạm Quỳnh Anh', 'l': 'English'}}
COLLECT_BATCH = 20
PARALLEL = 4  # prompts generated together
OCCASIONS = {norm(x): x for x in ('Christmas', 'Birthday', 'Wedding', 'Halloween', 'Easter', 'New Year', 'Lunar New Year', 'Mid-Autumn',
                                   'Lullaby', 'Christmas carol', 'Carols', 'Christmas carols', 'Tết')}
OCCASION_OF = {'christmas carol': 'Christmas', 'carols': 'Christmas', 'christmas carols': 'Christmas', 'tet': 'Lunar New Year'}
VAGUE = re.compile(r'\b(many|various|others|several|unknown|traditional|folk song|n/a|anonymous)\b', re.I)


def collections_prompt(batch, fields, dup_titles, vocab=()):
    lines = []
    for n, r in enumerate(batch, 1):
        s = f'{n}. {short_title(r["title"])[:80]}'
        if r['artist']: s += f' | artist: {r["artist"]}'
        if r['page'] and norm(r['title']) in dup_titles: s += f' | page text: {re.sub(r"\s+", " ", r["page"])[:150]}'
        lines.append(s)
    keys = '\n'.join(f'  "{k}": {desc}' for k, desc in [('t', 'the first words of the title, copied exactly (always give it)')] + fields)
    ks = {k for k, _ in fields} | {'t'}
    ex = {n: {k: v for k, v in e.items() if k in ks} for n, e in EXAMPLE_OUT.items()}
    ex = {n: e for n, e in ex.items() if len(e) > 1}
    return ('Song titles from a piano player\'s library. Titles are correct, but may end with a key such as "(C)" or with publisher text; ignore that.\n'
            'For each numbered song, give what you know. Fields:\n' + keys +
            '\nLeave a field out when you are not sure; leave a song out when you know nothing about it. Never write "Unknown" or "various".\n\n'
            + (f'Names this library already uses as tags (use the same spelling when one fits): {", ".join(vocab)}\n\n' if vocab else '') +
            'Example songs:\n' + EXAMPLE_IN + '\nExample reply:\n' + json.dumps(ex, ensure_ascii=False) +
            '\n\nSongs:\n' + '\n'.join(lines) + '\n\nReply with one JSON object keyed by song number.')


def same_title(echo, title):
    """The model copied the right title back (guards against answers shifted to the wrong number)."""
    a, b = norm(echo if isinstance(echo, str) else ''), norm(title)
    if not a: return False
    n = min(len(a), len(b), 12)
    return n >= 2 and a[:n] == b[:n]


FAMILIES = (('work', 'occasion', 'language'), ('singer', 'composer'))  # asked in separate prompts: fewer fields = fewer made-up answers


def copied_runs(reply, f, run=4):
    """Song numbers whose field f repeats the same value on `run`+ consecutive songs: the model copying the line above."""
    nums = sorted(int(k) for k, v in reply.items() if str(k).isdigit() and isinstance(v, dict))
    bad, start = set(), 0
    for i in range(1, len(nums) + 1):
        same = i < len(nums) and nums[i] == nums[i - 1] + 1 and \
            norm(str(reply[str(nums[i])].get(f) or '')) == norm(str(reply[str(nums[i - 1])].get(f) or '')) != ''
        if not same:
            if i - start >= run: bad |= set(nums[start:i])
            start = i
    return bad


def collections(rows, look=LOOKS, vocab=(), progress=lambda done, total, msg: None, cancelled=lambda: False):
    """rows from library_rows -> [{name, look, why, ids, existing}], biggest first.
    Language comes from the script (accents, CJK, Cyrillic…) first; the model answers per title, 20 titles per prompt."""
    look = [x for x in LOOKS if x in (look or LOOKS)]
    by_id = {r['id']: r for r in rows}
    found = {x: {} for x in LOOKS}  # look -> norm name -> {names: {raw: n}, ids: [...]}

    def put(lk, name, rid):
        name = clean_val(name)
        if not name or not norm(name) or VAGUE.search(name): return
        if lk in ('singer', 'composer', 'work') and (re.fullmatch(r'[A-G][#b♭♯]?m?\d*', name) or re.search(r'\.(net|com|vn|org)\b', name, re.I)):
            return  # a chord / key ("Am") or a website, not a person or show
        if lk == 'work' and norm(name) in OCCASIONS: lk = 'occasion'  # "Christmas" is not a movie
        if lk == 'occasion':
            if norm(name) not in OCCASIONS: return
            name = OCCASION_OF.get(norm(name), OCCASIONS[norm(name)])
        if lk not in look: return
        g = found[lk].setdefault(norm(name), {'names': {}, 'ids': []})
        g['names'][name] = g['names'].get(name, 0) + 1
        for i in twins.get(rid, [rid]):
            if i not in g['ids']: g['ids'].append(i)

    twins = {}
    for r in rows:
        if 'printed' in look: put('printed', 'Printed' if r['printed'] else 'Never printed', r['id'])
        if 'language' in look and (lang := script_language(r['title'] + ' ' + r['artist'])): put('language', lang, r['id'])

    # one question per distinct song: same title + artist (and no page text to tell them apart) = the same song
    seen, dup_titles = set(), set()
    for r in rows:
        (dup_titles if norm(r['title']) in seen else seen).add(norm(r['title']))
    same, uniq = {}, []
    for r in rows:
        k = (norm(re.sub(r'\((?:[A-G][#b♭♯]?m?)\)\s*$', '', r['title'])), norm(r['artist']), r['page'][:200])
        if k not in same: uniq.append(r)
        same.setdefault(k, []).append(r['id'])
    twins = {same[k][0]: same[k] for k in same}
    batches = [uniq[i:i + COLLECT_BATCH] for i in range(0, len(uniq), COLLECT_BATCH)]
    names = [t for t in vocab if t not in ('Printed', 'Never printed')]
    families = [[x for x in fam if x in look] for fam in FAMILIES]
    families = [fam for fam in families if fam]
    total, done, t0 = len(batches) * len(families), 0, time.time()
    for fam in families:
        fields = [LLM_FIELDS[x] for x in fam]
        key_look = {LLM_FIELDS[x][0]: x for x in fam}
        for k in range(0, len(batches), PARALLEL):
            if cancelled(): return []
            group = batches[k:k + PARALLEL]
            eta = f' (about {int((time.time() - t0) / done * (total - done) / 60) + 1} min left)' if done else ''
            progress(done, total, f'Asking about {" / ".join(fam)}: songs {k * COLLECT_BATCH + 1}–{min(len(uniq), (k + len(group)) * COLLECT_BATCH)} of {len(uniq)}{eta}')
            replies = complete_many([collections_prompt(b, fields, dup_titles, names) for b in group], max_tokens=(12 + 14 * len(fields)) * COLLECT_BATCH + 200)
            done += len(group)
            for b, text in zip(group, replies):
                reply = parse_json(text)
                if not isinstance(reply, dict): continue
                copied = {f: copied_runs(reply, f) for f in key_look if f != 'l'}
                for key, v in reply.items():
                    if not str(key).isdigit() or not 1 <= int(key) <= len(b) or not isinstance(v, dict): continue  # hallucinated number
                    r = b[int(key) - 1]
                    if not same_title(v.get('t'), r['title']): continue  # answer shifted onto the wrong song
                    for f, val in v.items():
                        lk = key_look.get(f)
                        if not lk or int(key) in copied.get(f, ()): continue
                        if lk == 'language':
                            if script_language(r['title']): continue  # the script already decided
                            val = clean_val(val)
                            val = val and val.title()
                        put(lk, val, r['id'])
    if families: progress(total, total, f'Read {len(uniq)} distinct titles ({len(rows)} items) in {time.time() - t0:.0f}s')

    tags = {norm(t): t for t in vocab}
    for lang, al in LANG_ALIASES.items():
        for a in al:
            if norm(a) in tags and norm(lang) not in tags: tags[norm(lang)] = tags[norm(a)]
    groups, by_name = [], {}
    for lk in look:
        for key, g in found[lk].items():
            ids = [i for i in g['ids'] if i in by_id]  # drop anything not asked about
            if len(ids) < (1 if lk in ('work', 'occasion') else 2): continue
            if lk == 'work' and key not in tags and key in found['singer']: continue  # a band or singer, not a show
            if lk == 'work' and key not in tags and all(norm(by_id[i]['title']) == key for i in ids): continue  # just the song's own name
            name = tags.get(key) or max(g['names'], key=lambda n: (g['names'][n], -len(n)))
            if norm(name) in by_name:  # same name from two looks (singer-songwriter): one group
                o = by_name[norm(name)]
                o['ids'] += [i for i in ids if i not in o['ids']]
                o['why'] = why(o['look'], o['name'], len(o['ids']))
                continue
            grp = {'name': name, 'look': lk, 'why': why(lk, name, len(ids)), 'ids': ids, 'existing': key in tags}
            by_name[norm(name)] = grp
            groups.append(grp)
    groups.sort(key=lambda g: (LOOKS.index(g['look']), -len(g['ids']), g['name'].casefold()))
    return groups


def why(lk, name, n):
    s = f'{n} song' + ('s' if n != 1 else '')
    return {'work': f'{s} from {name} (by title)', 'singer': f'{s} sung by {name}', 'composer': f'{s} written by {name}',
            'language': f'{s} in {name}', 'occasion': f'{s} for {name}', 'printed': f'{s} {name.lower()}'}[lk]


# ---------- endpoints (jobs of kind 'tags') ----------

def _run(app, title, params, work, wait):
    from . import jobs

    def runner(ctx):
        def progress(done, total, msg):
            ctx.update(progress=round(0.95 * done / max(total, 1), 3), msg=msg)
        result = work(ctx, progress)
        ctx.update(progress=1, msg='Done — review the suggestions', status='done', result=result)

    job = jobs.start_job(app, 'tags', title, 'On this Mac', [], params, runner=runner, thread=not wait)
    if not wait: return job
    j = jobs.get_job_row(app, job['id'])
    if j['status'] != 'done':
        raise HTTPException(500, (j['log'] or [{}])[-1].get('msg', 'Failed'))
    return {**j['result'], 'job': j['id']}


@router.get('/status')
def status():
    return LLM.status()


@router.post('/autotag', status_code=201)
def autotag_endpoint(request: Request, body: dict = Body(...)):
    """{ids: [...], wait?: bool, ocr?: bool (default true)}"""
    ids = body.get('ids') or []
    if isinstance(ids, str): ids = [ids]
    if not ids: raise HTTPException(400, 'ids are required')
    cfg = request.app.state.cfg

    def work(ctx, progress):
        c = connect(cfg)
        try: rows, vocab = library_rows(c, ids=ids), vocabulary(c)
        finally: c.close()
        ocr = (lambda r: ensure_page_text(cfg, r)) if body.get('ocr', True) else None
        return {'suggestions': autotag(rows, vocab, progress, ocr=ocr)}

    return _run(request.app, f'Auto-tag {len(ids)} item' + ('s' if len(ids) != 1 else ''), {'ids': ids}, work, body.get('wait'))


@router.post('/collections', status_code=201)
def collections_endpoint(request: Request, body: dict = Body(...)):
    """{scope: all|untagged|sheet|chords|score, look: [work, singer, composer, language, occasion, printed], wait?: bool}"""
    scope = body.get('scope') or 'all'
    look = body.get('look') or list(LOOKS)
    if scope not in ('all', 'untagged', 'sheet', 'chords', 'score') or not set(look) <= set(LOOKS):
        raise HTTPException(400, f'scope: all|untagged|sheet|chords|score; look: any of {", ".join(LOOKS)}')
    cfg = request.app.state.cfg

    def work(ctx, progress):
        c = connect(cfg)
        try: rows, vocab = library_rows(c, scope), vocabulary(c)
        finally: c.close()
        return {'groups': collections(rows, look, vocab, progress, cancelled=ctx.cancelled)}

    return _run(request.app, 'Make tags by collection', {'scope': scope, 'look': look}, work, body.get('wait'))


if __name__ == '__main__':  # .venv/bin/python -m meowsic.ai download
    import sys
    if sys.argv[1:] == ['download']:
        from huggingface_hub import snapshot_download
        print(snapshot_download(MODELS[0]))
    else:
        print(LLM.status())
