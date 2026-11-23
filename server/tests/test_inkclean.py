"""Coloured lines / highlighter come off a sheet page; black music and coloured words stay."""
import io

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

from meowsic import inkclean

W, H = 1200, 900
STAVES = [200, 500]  # top line of each staff
GAP = 14             # staff space


def page(paper=(255, 255, 255), jpeg=False):
    im = Image.new('RGB', (W, H), paper)
    d = ImageDraw.Draw(im)
    for top in STAVES:
        for k in range(5):
            y = top + k * GAP
            d.line([(60, y), (W - 60, y)], fill=(0, 0, 0), width=2)
        for x in range(150, W - 100, 90):  # notes: head + stem
            y = top + 2 * GAP
            d.ellipse([x - 9, y - 7, x + 9, y + 7], fill=(10, 10, 10))
            d.line([(x + 8, y), (x + 8, y - 3.5 * GAP)], fill=(0, 0, 0), width=2)
    if jpeg:
        b = io.BytesIO(); im.save(b, 'JPEG', quality=70); im = Image.open(io.BytesIO(b.getvalue())).convert('RGB')
    return im


def black(a):
    return a.mean(2) < 100


def run(tmp_path, im):
    src, dst = tmp_path / 'in.png', tmp_path / 'out.png'
    im.save(src)
    r = inkclean.clean(src, dst, debug=tmp_path / 'ink.png')
    return r, np.asarray(Image.open(src).convert('RGB'), dtype=np.int16), np.asarray(Image.open(dst).convert('RGB'), dtype=np.int16)


def music_kept(before_clean, after):
    """Every black pixel of the clean page is still dark after cleaning."""
    ref = black(np.asarray(before_clean, dtype=np.int16))
    return float(black(after)[ref].mean())


def coloured(a):
    return (a.max(2) - a.min(2)) > 60


def test_red_blue_yellow_lines_go_black_music_stays(tmp_path):
    clean_page = page()
    ink = Image.new('RGB', (W, H), 'white')  # pen on paper: drawn over the print (multiplied), as on a real page
    d = ImageDraw.Draw(ink)
    d.line([(80, 120), (1100, 760)], fill=(220, 30, 30), width=4)    # red diagonal across both staves
    d.line([(300, 40), (300, 860)], fill=(30, 60, 210), width=3)     # blue vertical
    d.line([(60, 228), (W - 60, 232)], fill=(240, 200, 0), width=5)  # yellow along a staff line
    d.line([(100, 650), (700, 660), (1000, 620)], fill=(20, 150, 40), width=3, joint='curve')  # green wobbly pen
    r, _, out = run(tmp_path, ImageChops.multiply(clean_page, ink))
    assert r['lines'] >= 1  # crossing strokes are one piece
    assert coloured(out).sum() < 50          # all coloured strokes gone
    assert music_kept(clean_page, out) > 0.995  # staff lines, heads, stems intact (cut places joined up)


def test_line_crossing_staff_rejoins_staff_lines(tmp_path):
    clean_page = page()
    im = clean_page.copy()
    ImageDraw.Draw(im).line([(640, 150), (640, 300)], fill=(200, 0, 0), width=6)  # red line through a staff
    r, _, out = run(tmp_path, im)
    assert r['lines'] == 1
    for k in range(5):
        y = STAVES[0] + k * GAP
        assert black(out)[y, 630:651].all(), f'staff line {k} cut'


def test_coloured_words_and_chord_names_kept(tmp_path):
    im = page()
    d = ImageDraw.Draw(im)
    try: font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 28)
    except OSError: font = ImageFont.load_default()
    d.text((140, 290), 'Cung tre o len dinh nui cao voi', fill=(110, 40, 160), font=font)  # purple lyrics
    d.text((140, 150), 'Am      G7      (F#m)', fill=(220, 60, 120), font=font)           # pink chord names
    r, before, out = run(tmp_path, im)
    assert r['lines'] == 0 and r['patches'] == 0
    assert (out == before).all()


def test_highlighter_goes_notes_under_it_stay(tmp_path):
    clean_page = page()
    a = np.asarray(clean_page, dtype=np.float32)
    hl = np.ones_like(a)
    hl[480:580, 300:900] = np.array([255, 245, 90]) / 255.0  # yellow highlighter, multiplied like real ink
    im = Image.fromarray((a * hl).astype(np.uint8))
    r, _, out = run(tmp_path, im)
    assert r['patches'] >= 1
    assert coloured(out).sum() < 200
    assert music_kept(clean_page, out) > 0.995


def test_tinted_jpeg_page_without_marks_is_unchanged(tmp_path):
    im = page(paper=(238, 226, 196), jpeg=True)  # yellowed paper, JPEG fringes round the black ink
    r, before, out = run(tmp_path, im)
    assert r == {'lines': 0, 'patches': 0, 'pixels': 0.0}
    assert (out == before).all()


def test_red_line_on_tinted_jpeg_page(tmp_path):
    clean_page = page(paper=(235, 228, 205))
    im = clean_page.copy()
    ImageDraw.Draw(im).line([(80, 420), (1120, 440)], fill=(200, 40, 40), width=4)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=75); im = Image.open(io.BytesIO(b.getvalue())).convert('RGB')
    r, _, out = run(tmp_path, im)
    assert r['lines'] >= 1
    assert coloured(out)[400:460].sum() < 30
    assert music_kept(clean_page, out) > 0.99
