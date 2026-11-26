"""Pedal marks off (user request 2026-11-26: the "Ped." sign means nothing to them). staffmove.edit_ex hands the op
over, so it is one Edit notes step: preview, Save, Activities and the 24 h Undo.

  {op:'unpedal', staff?}   every <pedal> mark goes (only staff `staff` when given): the <pedal> elements, their
                           direction-types, and a direction left with nothing to show; <sound damper-pedal /
                           soft-pedal / sostenuto-pedal> go with them. Notes, words, dynamics and tempo stay.
"""
import xml.etree.ElementTree as ET

from fastapi import HTTPException

OPS = ('unpedal',)
SOUND_PEDALS = ('damper-pedal', 'soft-pedal', 'sostenuto-pedal')


def strip_pedals(root, staff=None):
    """Removes pedal marks in place; returns how many <pedal> elements went."""
    gone = 0
    for part in root.findall('part'):
        for m in part.findall('measure'):
            for d in m.findall('direction'):
                if staff is not None and (d.findtext('staff') or '1').strip() != str(staff): continue
                had = False
                for dt in d.findall('direction-type'):
                    for p in dt.findall('pedal'): dt.remove(p); gone += 1; had = True
                    if len(dt) == 0: d.remove(dt)
                for s in d.findall('sound'):
                    for a in SOUND_PEDALS:
                        if a in s.attrib: s.attrib.pop(a); had = True
                    if not s.attrib and len(s) == 0: d.remove(s)
                if had and d.find('direction-type') is None and d.find('sound') is None: m.remove(d)
    return gone


def unpedal_op(text: str, op: dict, info=None):
    from .staffmove import _head
    info = {} if info is None else info
    st = op.get('staff')
    try: st = None if st in (None, '') else int(st)
    except (TypeError, ValueError): raise HTTPException(400, 'unpedal: staff is a number')
    root = ET.fromstring(text.encode('utf-8'))
    n = strip_pedals(root, st)
    if not n: raise HTTPException(400, 'No pedal marks here')
    info.setdefault('said', []).append(f'{n} pedal mark{"s" if n != 1 else ""} removed')
    ET.indent(root, space='  ')
    return _head(text) + ET.tostring(root, encoding='unicode') + '\n', [], 0
