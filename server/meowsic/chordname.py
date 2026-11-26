"""Chord names (chord symbols) — the grammar of omr/omr.py (chord_parse), here without music21 so the server can use
it: parse a name typed in Edit notes, write it as a MusicXML <harmony>, and the notes it stands for.
tests/test_chordops.py checks the grammar here is still omr.py's.

parse(text)  -> 'Bbm7' | 'C/E' | 'N.C.' (the plain spelling) or None when it is not a chord name
harmony(name, staff=None) -> a <harmony> element
tones(name)  -> (root pc, [intervals above the root], bass pc) for the realizer (chordops.py); None for N.C.
"""
import re
import xml.etree.ElementTree as ET

# the chord grammar (omr.py _CHORD_RE): root, accidental, quality, extension, alterations / added notes, bass
_CHORD_RE = re.compile(r"""^(?P<root>[A-G])(?P<acc>[#b]?)
    (?P<qual>maj|ma|M|Δ|min|mi|m|dim|°|o|aug|\+|ø|sus)?
    (?P<ext>6/9|69|13|11|9|7|6|5|4|2)?
    (?P<alt>(?:\(?(?:add|sus|maj|M|b|\#|\+)?(?:13|11|9|7|6|5|4|2)\)?|sus)*)
    (?:/(?P<bass>[A-G][#b]?))?$""", re.X)
_QUAL = {'maj': 'maj', 'ma': 'maj', 'M': 'maj', 'Δ': 'maj', 'min': 'm', 'mi': 'm', 'm': 'm', 'dim': 'dim', '°': 'dim',
         'o': 'dim', 'aug': 'aug', '+': 'aug', 'ø': 'm7b5', 'sus': 'sus'}
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
_NAME = re.compile(r'^(?P<root>[A-G])(?P<acc>[#b]?)(?P<q>m7b5|mmaj7|maj|m|dim|aug|sus2|sus4)?(?P<ext>69|13|11|9|7|6|5)?(?P<alt>.*?)(?:/(?P<bass>[A-G][#b]?))?$')


def parse(tok):
    """A chord name in the grammar → its plain spelling ('Bbm7', 'C/E', 'Fmaj7', 'N.C.'); None if it is not one."""
    t = (tok or '').replace('♭', 'b').replace('♯', '#').replace(' ', '')
    if re.fullmatch(r'N\.?C\.?', t): return 'N.C.'
    m = _CHORD_RE.match(t)
    if not m: return None
    q, ext, alt = _QUAL.get(m['qual'] or '', ''), (m['ext'] or '').replace('6/9', '69'), m['alt'] or ''
    alt = alt.replace('(', '').replace(')', '').replace('+', '#')
    if q == 'maj' and not ext and not alt: q = ''  # "CM" / "Cmaj" = C
    if q == 'm7b5': q, ext = 'm7b5', '' if ext == '7' else ext
    if q == 'aug' and ext: q, ext = '', ext + '#5'  # C+7 → C7#5
    if q == 'sus' and ext in ('2', '4'): q, ext = 'sus' + ext, ''  # Csus4
    if q == 'sus' and ext and not alt.startswith('sus'): q, ext, alt = '', ext, 'sus4' + alt  # Csus7 → C7sus4
    if ext == '5' and not q and not alt: return None  # a power chord is not printed on lead sheets: a misread ♭
    return m['root'] + m['acc'] + q + ext + alt + ('/' + m['bass'] if m['bass'] else '')


# quality + extension → (MusicXML kind, intervals)
KINDS = {'': ('major', (0, 4, 7)), 'm': ('minor', (0, 3, 7)), '7': ('dominant', (0, 4, 7, 10)), 'maj7': ('major-seventh', (0, 4, 7, 11)),
         'm7': ('minor-seventh', (0, 3, 7, 10)), 'dim': ('diminished', (0, 3, 6)), 'dim7': ('diminished-seventh', (0, 3, 6, 9)),
         'm7b5': ('half-diminished', (0, 3, 6, 10)), 'aug': ('augmented', (0, 4, 8)), 'sus4': ('suspended-fourth', (0, 5, 7)),
         'sus2': ('suspended-second', (0, 2, 7)), '6': ('major-sixth', (0, 4, 7, 9)), 'm6': ('minor-sixth', (0, 3, 7, 9)),
         '9': ('dominant-ninth', (0, 4, 7, 10, 14)), 'maj9': ('major-ninth', (0, 4, 7, 11, 14)), 'm9': ('minor-ninth', (0, 3, 7, 10, 14)),
         '11': ('dominant-11th', (0, 4, 7, 10, 14, 17)), '13': ('dominant-13th', (0, 4, 7, 10, 14, 21)),
         'mmaj7': ('major-minor', (0, 3, 7, 11)), '5': ('power', (0, 7)), '69': ('major-sixth', (0, 4, 7, 9, 14)),
         'm69': ('minor-sixth', (0, 3, 7, 9, 14)), 'maj': ('major', (0, 4, 7)), 'dim9': ('diminished-seventh', (0, 3, 6, 9)),
         'm11': ('minor-11th', (0, 3, 7, 10, 14, 17)), 'm13': ('minor-13th', (0, 3, 7, 10, 14, 21)), 'maj13': ('major-13th', (0, 4, 7, 11, 14, 21)),
         'maj11': ('major-11th', (0, 4, 7, 11, 14, 17)), 'aug7': ('augmented-seventh', (0, 4, 8, 10))}
_ALT = re.compile(r'(add|sus|b|#)?(13|11|9|7|6|5|4|2)')


_DEG = {9: (6, 0), 10: (7, 0), 11: (7, 1), 13: (9, -1), 14: (9, 0), 15: (9, 1), 17: (11, 0), 18: (11, 1), 20: (13, -1), 21: (13, 0)}


def _suspended(iv, degrees):
    """A chord with its third replaced by a sus tone as MusicXML spells it: kind suspended-fourth / -second and the
    other tones as degrees (C7sus4 = suspended-fourth + 7), so a player reading the kind plays no third."""
    base = (0, 5, 7) if 5 in iv else (0, 2, 7)
    kind = 'suspended-fourth' if 5 in iv else 'suspended-second'
    out = [d for d in degrees if d[2] == 'alter']
    pcs = {x % 12 for x in base}
    for x in iv:
        if x % 12 in pcs or x in (6, 8): continue
        if x in _DEG: out.append((*_DEG[x], 'add')); pcs.add(x % 12)
    return kind, out


def _split(name):
    name = re.sub(r'sus(?!\d)', 'sus4', name)  # a bare "sus" is sus4 (Csus, C7sus, C9sus)
    m = _NAME.match(name)
    if not m: return None
    root = STEP[m['root']] + {'#': 1, 'b': -1}.get(m['acc'], 0)
    key = (m['q'] or '') + (m['ext'] or '')
    if key not in KINDS: key = (m['q'] or '') if (m['q'] or '') in KINDS else ''
    kind, iv = KINDS[key]
    iv = list(iv)
    degrees = []
    for how, n in _ALT.findall(m['alt'] or ''):
        n = int(n)
        semis = {2: 2, 4: 5, 5: 7, 6: 9, 7: 10, 9: 14, 11: 17, 13: 21}[n]
        if how == 'sus':
            iv = [x for x in iv if x not in (3, 4)] + [semis]; degrees.append((n, 0, 'add'))
        elif how in ('b', '#'):
            d = -1 if how == 'b' else 1
            if n == 5 and 7 in iv: iv[iv.index(7)] = 7 + d; degrees.append((5, d, 'alter'))
            else: iv.append(semis + d); degrees.append((n, d, 'add'))
        else:
            iv.append(semis); degrees.append((n, 0, 'add'))
    bass = STEP[m['bass'][0]] + {'#': 1, 'b': -1}.get(m['bass'][1:], 0) if m['bass'] else None
    iv = sorted(set(iv))
    if any(how == 'sus' for how, _ in _ALT.findall(m['alt'] or '')) and 3 not in iv and 4 not in iv:
        kind, degrees = _suspended(iv, degrees)
    return m, kind, key, iv, degrees, bass


def tones(name):
    """(root pc, intervals above the root, bass pc) of a chord name; None for N.C. / not a chord."""
    if not name or name == 'N.C.': return None
    s = _split(name)
    if not s: return None
    m, kind, key, iv, degrees, bass = s
    root = (STEP[m['root']] + {'#': 1, 'b': -1}.get(m['acc'], 0)) % 12
    return root, iv, (bass % 12 if bass is not None else root)


def harmony(name, staff=None):
    """A MusicXML <harmony> for the chord name (its suffix as the kind's text, so it is drawn as typed)."""
    h = ET.Element('harmony')
    if name == 'N.C.':
        r = ET.SubElement(h, 'root'); ET.SubElement(r, 'root-step', text='').text = 'C'
        k = ET.SubElement(h, 'kind', text='N.C.'); k.text = 'none'
    else:
        m, kind, key, iv, degrees, bass = _split(name)
        r = ET.SubElement(h, 'root')
        ET.SubElement(r, 'root-step').text = m['root']
        if m['acc']: ET.SubElement(r, 'root-alter').text = '1' if m['acc'] == '#' else '-1'
        suffix = name[len(m['root']) + len(m['acc']):].split('/')[0]
        k = ET.SubElement(h, 'kind', text=suffix.replace('b', '♭').replace('#', '♯') if suffix else '')
        k.text = kind
        if m['bass']:
            b = ET.SubElement(h, 'bass')
            ET.SubElement(b, 'bass-step').text = m['bass'][0]
            if m['bass'][1:]: ET.SubElement(b, 'bass-alter').text = '1' if m['bass'][1:] == '#' else '-1'
        for n, d, how in degrees:
            dg = ET.SubElement(h, 'degree')
            ET.SubElement(dg, 'degree-value').text = str(n)
            ET.SubElement(dg, 'degree-alter').text = str(d)
            ET.SubElement(dg, 'degree-type').text = how
    if staff: ET.SubElement(h, 'staff').text = str(staff)
    return h


def name_of(h):
    """The chord name a <harmony> shows (its kind's text when it has one)."""
    rs = (h.findtext('root/root-step') or '').strip()
    k = h.find('kind')
    if k is not None and (k.text or '').strip() == 'none': return 'N.C.'
    if not rs: return ''
    acc = {1: '#', -1: 'b'}.get(round(float(h.findtext('root/root-alter') or 0)), '')
    if k is not None and k.get('text') is not None: suf = k.get('text').replace('♭', 'b').replace('♯', '#')
    else:
        from .chordfind import KIND_SUFFIX
        suf = KIND_SUFFIX.get((k.text or '').strip() if k is not None else 'major', '')
    bs = (h.findtext('bass/bass-step') or '').strip()
    bacc = {1: '#', -1: 'b'}.get(round(float(h.findtext('bass/bass-alter') or 0)), '')
    return rs + acc + suf + (f'/{bs}{bacc}' if bs else '')
