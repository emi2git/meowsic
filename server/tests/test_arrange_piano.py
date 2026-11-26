"""server/scripts/arrange_piano.py: voice + piano -> piano solo (melody on top of the RH, LH as it was)."""
import importlib.util
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location('arrange_piano', Path(__file__).parents[1] / 'scripts' / 'arrange_piano.py')
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)


def n(step, octv, dur, typ, voice, staff=None, chord=False, lyric=False):
    return (f'<note>{"<chord/>" if chord else ""}<pitch><step>{step}</step><octave>{octv}</octave></pitch><duration>{dur}</duration>'
            f'<voice>{voice}</voice><type>{typ}</type>{f"<staff>{staff}</staff>" if staff else ""}'
            f'{"<lyric><text>la</text></lyric>" if lyric else ""}</note>')


ATTR = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>{}</attributes>'
XML = ('<?xml version="1.0"?><score-partwise version="4.0"><identification><creator type="composer">C</creator></identification>'
       '<part-list><score-part id="V"><part-name>Voice</part-name></score-part><score-part id="P"><part-name>Piano</part-name></score-part></part-list>'
       '<part id="V"><measure number="1">' + ATTR.format('<clef><sign>G</sign><line>2</line></clef>')
       + '<direction><direction-type><words>SINGER:</words></direction-type></direction>'
       + n('E', 5, 4, 'half', 1, lyric=True) + n('D', 5, 4, 'half', 1, lyric=True) + '</measure></part>'
       '<part id="P"><measure number="1">' + ATTR.format('<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>')
       + '<direction><direction-type><words>a tempo</words></direction-type><staff>1</staff></direction>'
       + n('C', 5, 8, 'whole', 1, 1) + n('G', 4, 8, 'whole', 1, 1, chord=True) + n('E', 5, 8, 'whole', 1, 1, chord=True)
       + '<backup><duration>8</duration></backup>' + n('C', 3, 8, 'whole', 5, 2) + n('G', 3, 8, 'whole', 5, 2, chord=True)
       + '</measure></part></score-partwise>')


def test_arrange_melody_on_top(tmp_path):
    out, log = ap.arrange(XML)
    root = ET.fromstring(out.encode())
    assert [p.get('id') for p in root.findall('part')] == ['P1'] and log['mel_notes'] == 2
    notes = root.findall('.//note')
    rh = [x for x in notes if x.findtext('staff') == '1' and x.find('pitch') is not None]
    lh = [x for x in notes if x.findtext('staff') == '2' and x.find('pitch') is not None]
    mel = [x.findtext('pitch/step') + x.findtext('pitch/octave') for x in rh if x.findtext('voice') == '1']
    assert mel == ['E5', 'D5']
    acc = sorted(ap.midi(x) for x in rh if x.findtext('voice') != '1')
    assert 76 not in acc and acc and max(acc) < 74  # the E5 doubling the melody went; the rest sits under it
    assert sorted(ap.midi(x) for x in lh) == [48, 55]  # LH unchanged
    words = [w.text for w in root.iter('words')]
    assert 'a tempo' in words and 'SINGER:' not in words and not list(root.iter('lyric'))
    assert '<creator type="composer">C</creator>' in out
    # CLI: input, output
    i, o = tmp_path / 'in.musicxml', tmp_path / 'out.musicxml'
    i.write_text(XML)
    ap.main([str(i), str(o), '--shift', '1-1=12', '--log', str(tmp_path / 'log.json')])
    assert '<octave>6</octave>' in o.read_text() and (tmp_path / 'log.json').exists()
