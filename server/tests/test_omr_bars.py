"""omr/omr.py: every bar of a read sheet adds up to its time signature; words on the notes are kept."""
import importlib.util
from pathlib import Path

import music21 as m21
import pytest

spec = importlib.util.spec_from_file_location('omr_main', Path(__file__).resolve().parents[2] / 'omr' / 'omr.py')
omr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omr)


def score(*bars, ts='4/4'):
    """bars: lists of (pitch or 'r', quarters, lyric or None)."""
    p = m21.stream.Part()
    for k, notes in enumerate(bars):
        m = m21.stream.Measure(number=k + 1)
        if k == 0: m.insert(0, m21.meter.TimeSignature(ts))
        for name, ql, word in notes:
            n = m21.note.Rest(quarterLength=ql) if name == 'r' else m21.note.Note(name, quarterLength=ql)
            if word: n.lyric = word
            m.append(n)
        p.append(m)
    s = m21.stream.Score(); s.insert(0, p)
    return s


def lyrics(s):
    return [n.lyric for n in s.recurse().notes if n.lyric]


def test_short_long_empty_and_pickup_bars_are_filled():
    s = score([('G4', 1, 'a')],                                       # pickup: 1 beat
              [('C4', 1, 'b'), ('D4', 1, 'c'), ('E4', 1, None)],       # 3 beats: rest added
              [('C4', 2, 'd'), ('E4', 1, None)],                       # last note missing its dot
              [('C4', 2, 'e'), ('D4', 2, None), ('E4', 1, None)],      # 5 beats: too long
              [])                                                      # empty
    assert len(omr.bars_full(s)) == 5
    fixes = omr.fill_bars(s)
    assert omr.bars_full(s) == []
    assert [f['bar'] for f in fixes] == [2, 3, 4, 5]
    first = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    # a pickup stays a pickup: no rests in front (playing starts on its note), written <measure implicit="yes">
    assert [type(n).__name__ for n in first.notesAndRests] == ['Note'] and s.meowsicPickup == 1
    assert lyrics(s) == ['a', 'b', 'c', 'd', 'e']
    x = omr.pickup_bar(m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode())
    assert __import__('re').search(r'<measure[^>]*number="1"[^>]*implicit="yes"', x) and x.count('implicit="yes"') == 1


def test_too_long_bar_is_split_into_voices_no_note_dropped():
    # 3/4: a tune (3 beats) and an under-part (3 beats) read one after the other
    s = score([('F#5', 1.5, 'one'), ('G5', 0.5, None), ('A5', 1, None), ('C#5', 0.5, 'two'), ('A4', 0.5, None), ('F#4', 2, None)], ts='3/4')
    omr.fill_bars(s)
    assert omr.bars_full(s) == []
    assert len([n for n in s.recurse().notes]) == 6
    assert len(list(s.parts[0].getElementsByClass(m21.stream.Measure)[0].voices)) == 2
    assert sorted(lyrics(s)) == ['one', 'two']
    out = m21.converter.parseData(m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode(), format='musicxml')
    assert omr.bars_full(out) == [] and len(list(out.recurse().notes)) == 6  # survives writing MusicXML


def test_unsure_bars_are_kept_in_the_musicxml():
    rep = {'check': [{'page': 2, 'bar': 3, 'why': []}], 'filled': [{'part': 1, 'bar': 1, 'fix': 'pickup: 1-beat rest in front'},
           {'part': 1, 'bar': 5, 'fix': 'x'}], 'taken': [{'page': 1, 'bar': 2}]}
    bars = omr.unsure_bars(rep, [10, 8])
    assert bars == [2, 5, 13]
    x = omr.mark_unsure('<score-partwise><identification><encoding/></identification><part-list/></score-partwise>', bars)
    assert '<miscellaneous-field name="meowsic-check-bars">2 5 13</miscellaneous-field></miscellaneous></identification>' in x


def test_full_bars_untouched():
    s = score([('C4', 1, 'x'), ('D4', 1, None), ('E4', 2, None)], [('r', 4, None)])
    assert omr.fill_bars(s) == []


def test_three_four():
    s = score([('C4', 2, None)], [('C4', 2, None), ('D4', 2, None)], ts='3/4')
    omr.fill_bars(s)
    assert omr.bars_full(s) == []


def test_audiveris_reads_english_and_vietnamese_when_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(omr, 'TESSDATA', tmp_path)
    assert omr.audiveris_languages() == []
    (tmp_path / 'eng.traineddata').write_bytes(b'x')
    (tmp_path / 'vie.traineddata').write_bytes(b'x')
    assert omr.audiveris_languages()[-1].endswith('=eng+vie')


def test_notes_beside_voices_add_up_too():
    s = score([('C4', 4, None)])
    m = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    v = m21.stream.Voice(); v.append(m21.note.Note('E4', quarterLength=2)); m.insert(0, v)
    m.append(m21.note.Note('D4', quarterLength=1))  # bar itself: 5 beats; voice: 2
    omr.fill_bars(s)
    assert omr.bars_full(s) == []


def test_empty_bar_after_a_first_ending_is_dropped_printed_rest_kept():
    s = score([('C4', 4, None)], [('D4', 4, None)], [], [('r', 4, None)])  # bar 3: nothing printed; bar 4: a whole rest
    s.parts[0].getElementsByClass(m21.stream.Measure)[2].insert(0, m21.harmony.ChordSymbol('G7'))  # a chord name read there
    rep = {'check': [{'page': 1, 'bar': 4, 'why': []}], 'notes': []}
    omr.drop_empty_bars(s, 1, rep, {2})  # what empty_bars() finds in homr's file
    ms = list(s.parts[0].getElementsByClass(m21.stream.Measure))
    assert len(ms) == 3 and [n for n in ms[2].notesAndRests if n.isRest]
    assert ms[2].getElementsByClass(m21.harmony.ChordSymbol)[0].figure == 'G7'
    assert rep['check'][0]['bar'] == 3 and rep['dropped'] == [{'page': 1, 'bars': [3]}]


def test_missed_triplet_bracket_is_put_back():
    # Baby Mine bar 2: A half tied, then a quarter triplet A G F that was read as A quarter, G quarter, F eighth
    s = score([('A4', 2, 'mine'), ('A4', 1, None), ('G4', 1, 'don'), ('F4', 0.5, 'you')])
    fixes = omr.fill_bars(s)
    assert 'triplet' in fixes[0]['fix']
    ns = list(s.recurse().notes)
    assert [round(float(n.quarterLength), 4) for n in ns] == [2, 0.6667, 0.6667, 0.6667]
    assert lyrics(s) == ['mine', 'don', 'you']
    assert all(n.duration.tuplets for n in ns[1:]) and omr.bars_full(s) == []
    x = m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode()
    assert x.count('<time-modification>') == 3 and 'tuplet' in x


def test_empty_bars_found_in_homr_file(tmp_path):
    f = tmp_path / 'p.musicxml'
    f.write_text('<score-partwise><part id="P1"><measure number="1"><note><rest/><duration>4</duration></note></measure>'
                 '<measure number="2"><barline location="right"><ending type="stop" number="1"/></barline></measure>'
                 '<measure number="3"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>')
    assert omr.empty_bars(f) == {1}


# ---------- ties and slurs (connection arcs) ----------

def test_tie_and_slur_helpers():
    s = score([('G4', 4, None)], [('G4', 4, None)], [('A4', 2, None), ('B4', 2, None)])
    part = s.parts[0]
    seq = omr._sequence(part)
    g1, g2, a, b = (q[3] for q in seq)
    assert omr.tie(g1, g2) and g1.tie.type == 'start' and g2.tie.type == 'stop' and omr.tied(g1, g2)
    assert not omr.tie(g2, a)  # different pitches: no tie
    assert omr.slur(part, a, b) and not omr.slur(part, a, b)  # once
    # a "slur" over two notes in a row with one pitch is a tie
    s2 = score([('E4', 2, None), ('E4', 2, None)])
    n1, n2 = list(s2.recurse().notes)
    s2.parts[0].insert(0, m21.spanner.Slur(n1, n2))
    assert omr.slurs_to_ties(s2.parts[0]) == 1 and n1.tie.type == 'start' and not s2.parts[0].spanners.getElementsByClass(m21.spanner.Slur)


def test_join_keeps_slurs_of_later_pages():
    a = score([('C4', 4, None)])
    b = score([('D4', 2, None), ('E4', 2, None)])
    d, e = list(b.recurse().notes)
    b.parts[0].insert(0, m21.spanner.Slur(d, e))
    s = omr.join([a, b], 'x')
    x = m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode()
    assert x.count('<slur ') == 2


def test_arcs_seen_on_the_page(tmp_path):
    pytest.importorskip('cv2')
    from PIL import Image, ImageDraw
    # a staff (gap 20) with G4 half, G4 half under a tie, then A4 B4 under a slur
    im = Image.new('L', (900, 300), 255); d = ImageDraw.Draw(im)
    top = 100
    for k in range(5): d.line([(40, top + 20 * k), (860, top + 20 * k)], fill=0, width=2)
    y_g, y_a, y_b = top + 70, top + 60, top + 50
    heads = [(200, y_g), (330, y_g), (520, y_a), (680, y_b)]
    for x, y in heads: d.ellipse([x - 12, y - 9, x + 12, y + 9], fill=0); d.line([(x + 11, y), (x + 11, y - 70)], fill=0, width=2)
    d.arc([212, y_g - 4, 318, y_g + 26], 20, 160, fill=0, width=3)  # the tie, under the heads
    d.arc([530, y_b - 70, 670, y_b - 10], 200, 340, fill=0, width=3)  # the slur, over the stems
    png = tmp_path / 'page1.png'; im.save(png)
    xml = ('<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">'
           '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
           f'<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type><!-- imgpos: 210, {y_g - 30} --></note>'
           f'<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type><!-- imgpos: 340, {y_g - 30} --></note></measure>'
           f'<measure number="2"><note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><type>half</type><!-- imgpos: 525, {y_a - 30} --></note>'
           f'<note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><type>half</type><!-- imgpos: 690, {y_b - 30} --></note></measure></part></score-partwise>')
    (tmp_path / 'page1.musicxml').write_text(xml)
    arcs = omr.page_arcs(png)
    assert len(arcs) == 2 and arcs[0]['under'] and not arcs[1]['under']
    h = m21.converter.parse(str(tmp_path / 'page1.musicxml'))
    rep = {'notes': []}
    omr.place_arcs(h, png, tmp_path / 'page1.musicxml', 1, rep)
    g1, g2, a, b = [q[3] for q in omr._sequence(h.parts[0])]
    assert g1.tie.type == 'start' and g2.tie.type == 'stop' and a.tie is None
    sl = list(h.parts[0].spanners.getElementsByClass(m21.spanner.Slur))
    assert len(sl) == 1 and sl[0].isFirst(a) and sl[0].isLast(b)
    assert rep['arcs'] == [{'page': 1, 'ties': 1, 'slurs': 1}]
    boxes = omr.bar_boxes(png, tmp_path / 'page1.musicxml', 2)
    assert boxes[0][0] < 200 < boxes[0][2] <= boxes[1][0] + 20 and boxes[1][0] < 520 < 680 < boxes[1][2]


def test_other_reading_for_a_bar_and_plain_reasons():
    s = score([('C4', 2, 'hi'), ('D4', 1, None)])  # 3 beats in 4/4
    m = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    x = omr.alt_xml(m, 5, 4.0)
    assert x.startswith('<measure number="5"') and 'lyric' not in x and '<clef' not in x and '<rest' in x  # filled up
    assert omr.plain_reason('three notes made a triplet (1-beat notes)') == 'triplet added to make the bar add up'
    assert omr.plain_reason('1 beats too long: split into voices') == 'bar was too long — split into 2 voices'


# ---------- printed triplets, words checked before they go on the score, bars that need a person ----------

def test_printed_triplet_put_on_the_three_notes_even_when_the_bar_adds_up():
    # Baby Mine bar 11: G half, then a quarter triplet G A B♭ read as quarter + two eighths (adds up to 4 anyway)
    s = score([('G4', 2, 'heart'), ('G4', 1, 'nev'), ('A4', 0.5, 'er'), ('B-4', 0.5, 'to')])
    m = s.parts[0].getElementsByClass(m21.stream.Measure)[0]
    assert omr.apply_triplet(m, [2.0, 3.0, 3.5]) == 'added'
    ns = list(m.notes)
    assert [round(float(n.quarterLength), 3) for n in ns] == [2, 0.667, 0.667, 0.667] and all(n.duration.tuplets for n in ns[1:])
    assert [round(float(n.offset), 3) for n in ns] == [0, 2, 2.667, 3.333] and omr.bars_full(s) == []
    assert ns[3].meowsicOff0 == 3.5  # where the words read off the page were (they still find their note)
    assert omr.apply_triplet(m, [2.0, 2.667, 3.333]) == 'already'
    s2 = score([('C4', 1, None), ('D4', 1, None), ('E4', 1, None), ('F4', 0.5, None)])  # no triplet value fills the bar
    assert omr.apply_triplet(s2.parts[0].getElementsByClass(m21.stream.Measure)[0], [0, 1, 2]) == 'not applied'


def test_a_three_is_told_from_other_digits():
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    def draw(ch):
        im = Image.new('L', (60, 60), 0)
        ImageDraw.Draw(im).text((10, 5), ch, fill=255, font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf', 40))
        a = np.asarray(im) > 128
        ys, xs = np.flatnonzero(a.any(1)), np.flatnonzero(a.any(0))
        return a[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1]
    assert omr._is_three(draw('3'))
    assert not any(omr._is_three(draw(c)) for c in '1258B')


def test_words_are_checked_vietnamese_and_english():
    import sys
    sys.path.insert(0, str(Path(omr.__file__).parent))
    import lyriccheck as L
    assert all(L.word_ok(w) for w in ['người', 'Này', 'yêu', 'khuya', 'giữa', 'quyên', 'friends', "don't", 'Beauty'])
    assert not any(L.word_ok(w) for w in ['V3n', 'muÂn', 'Nàu', 'hữi', 'nưiời', 'Wrng', 'tànNhững'])
    assert L.split_viet('Hômchia') == ['Hôm', 'chia'] and L.split_viet('người') is None
    toks = [[w, 10 * k, False, 1.0, 10 * k, 10 * k + 8, 0, 10] for k, w in enumerate(['Nàu', 'nưiời', 'vêu', 'V3n', 'em'])]
    sc, drop = omr.judge_line(toks)
    assert sc < omr.GOOD_LINE  # a line like this is left off the score, its bars flagged "lyrics unsure"


def test_syllables_go_to_notes_in_order():
    notes = [(0, 0.0, '1', 100, 0), (0, 1.0, '1', 200, 0), (0, 2.0, '1', 300, 0), (1, 0.0, '1', 400, 0)]
    toks = [['a', 104, False, 1, 0, 0, 0, 10], ['b', 296, False, 1, 0, 0, 0, 10], ['c', 410, False, 1, 0, 0, 0, 10]]
    assert omr.place_syllables(toks, notes, 10) == [(0, 0), (1, 2), (2, 3)]  # the note at 200 is held (no syllable)


def test_flags_settled_when_the_evidence_is_clear():
    a = score([('A4', 2, None), ('C5', 2, None)], [('G4', 4, None)], [('C4', 1, None), ('D4', 1, None), ('E4', 1, None), ('F4', 1, None)])
    ms = list(a.parts[0].getElementsByClass(m21.stream.Measure))
    aud = score([('C5', 2, None)], [('G4', 4, None)], [('C4', 1, None), ('D4', 1, None), ('F4', 1, None), ('F4', 1, None)])
    am = list(aud.parts[0].getElementsByClass(m21.stream.Measure))
    ms[0].meowsicFlags, ms[0].meowsicAud, ms[0].meowsicFullRead = ['the two readers disagree'], am[0], True  # second reader missed a note
    ms[1].meowsicFlags, ms[1].meowsicFullRead = ['only one reader found this bar'], True                      # one reader, adds up
    ms[2].meowsicFlags, ms[2].meowsicAud, ms[2].meowsicFullRead = ['the two readers disagree'], am[2], True  # both add up, differ
    ms[2].meowsicLyrics = {'verse': 1, 'meas': [ms[2]]}
    rep = {'filled': [], 'notes': []}
    out = omr.bar_reasons(a, rep)
    assert out == {3: ['the two readers disagree', omr.LYRICS_UNSURE]}
    assert [r['bar'] for r in rep['resolved']] == [1, 2]
