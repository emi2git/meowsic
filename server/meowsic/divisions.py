"""Finer <divisions> when an edit needs them (Edit notes: a 32nd note in a score written in 16ths, a pasted dotted
32nd …). MusicXML durations are whole numbers of divisions per quarter, so a score with <divisions>2</divisions>
cannot hold a 1/8-quarter note. fit_divisions(root, qs) multiplies every <divisions> of every part, and everything
counted in divisions (<duration> of notes / backup / forward / figured bass, <offset>, a note's attack / release),
by the smallest whole number that makes each length in qs (quarters) a whole number of divisions. Nothing sounds or
looks different: only the unit gets finer. Returns the factor (1: nothing changed)."""
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr

MAX_DIV = 3840  # never finer than this (1/64 triplets fit well inside it)


def factor_for(divs, qs):
    """The smallest k so that q * d * k is whole for every divisions value d and length q."""
    k = 1
    for d in divs:
        for q in qs:
            den = (Fr(q) * d * k).denominator
            if den != 1: k *= den
    return k


def _divs(root):
    out = set()
    for e in root.iter('divisions'):
        try: out.add(Fr(int(float((e.text or '').strip()))))
        except ValueError: pass
    return out or {Fr(1)}


def fit_divisions(root, qs):
    qs = [Fr(q) for q in qs if q is not None]
    if not qs: return 1
    divs = _divs(root)
    k = factor_for(divs, qs)
    if k == 1 or max(divs) * k > MAX_DIV: return 1
    for e in root.iter():
        if e.tag in ('divisions', 'duration', 'offset'):
            t = (e.text or '').strip()
            try: e.text = str(int(round(float(t) * k)))
            except ValueError: continue
        if e.tag == 'note':
            for a in ('attack', 'release'):
                if e.get(a) not in (None, ''):
                    try: e.set(a, str(int(round(float(e.get(a)) * k))))
                    except ValueError: pass
    return k


def fit_text(text, qs):
    """fit_divisions on a MusicXML string -> (text, factor); the text is unchanged when no factor is needed."""
    from .staffmove import _head
    root = ET.fromstring(text.encode('utf-8'))
    k = fit_divisions(root, qs)
    if k == 1: return text, 1
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', k
