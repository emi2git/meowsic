"""Every score Meowsic makes is credited to "Meowsic"."""
from meowsic.runners import credit_meowsic


def test_credit_replaces_creators(tmp_path):
    p = tmp_path / 'a.musicxml'
    p.write_text('<score-partwise><identification><creator type="composer">transcribed by Emi Music Note</creator><creator type="lyricist">X</creator></identification><part-list/></score-partwise>')
    credit_meowsic(p)
    x = p.read_text()
    assert x.count('<creator') == 1 and '<creator type="composer">Meowsic</creator>' in x


def test_credit_added_when_missing(tmp_path):
    p = tmp_path / 'b.musicxml'
    p.write_text('<score-partwise><part-list></part-list></score-partwise>')
    credit_meowsic(p)
    assert '<identification><creator type="composer">Meowsic</creator></identification><part-list>' in p.read_text()
