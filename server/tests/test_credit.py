"""Score credits: composer = the song's real artist, plus what Meowsic did ("Transcribed by Meowsic" …)."""
from meowsic.db import credit_xml, score_byline
from meowsic.runners import credit_meowsic


def test_credit_replaces_creators(tmp_path):
    p = tmp_path / 'a.musicxml'
    p.write_text('<score-partwise><identification><creator type="composer">transcribed by Emi Music Note</creator><creator type="lyricist">X</creator></identification><part-list/></score-partwise>')
    credit_meowsic(p, 'Dick Lee', 'Transcribed by Meowsic')
    x = p.read_text()
    assert x.count('<creator') == 2 and '<creator type="composer">Dick Lee</creator><creator type="arranger">Transcribed by Meowsic</creator>' in x


def test_credit_added_when_missing(tmp_path):
    p = tmp_path / 'b.musicxml'
    p.write_text('<score-partwise><part-list></part-list></score-partwise>')
    credit_meowsic(p, '')
    assert '<identification><creator type="arranger">Made by Meowsic</creator></identification><part-list>' in p.read_text()


def test_credit_never_meowsic_as_composer():
    x = '<score-partwise><identification><creator type="composer">Meowsic</creator></identification><part-list/></score-partwise>'
    assert '<creator type="composer">' not in credit_xml(x)  # keeps the composer it has, but Meowsic is not one
    y = credit_xml('<score-partwise><identification><creator type="composer">Tom &amp; Jerry</creator></identification><part-list/></score-partwise>', None, 'Arranged by Meowsic')
    assert '<creator type="composer">Tom &amp; Jerry</creator><creator type="arranger">Arranged by Meowsic</creator>' in y
    assert credit_xml(x, 'Meowsic', '') == x.replace('<creator type="composer">Meowsic</creator>', '')


def test_byline():
    assert score_byline('From the score “X”', 1) == 'Arranged by Meowsic'
    assert score_byline('From the sheet “X” (photo → score, beta)') == 'Read by Meowsic'
    assert score_byline('Meowsic', 1) == 'Made by Meowsic'
    assert score_byline('YouTube') == 'Transcribed by Meowsic' and score_byline('Audio file') == 'Transcribed by Meowsic'
