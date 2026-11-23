#!/usr/bin/env python3
"""A fake Apple Photos album for tests/e2e/photoimport.mjs: make_fake_album.py <folder>  → <folder>/SHEET/

Start the test server with MEOWSIC_FAKE_PHOTOS=<folder> (server/meowsic/photoimport.py reads <folder>/<album>/
instead of Photos). 7 photos, dates in dates.json:
  1 "Moon River" (title)  2 its page 2 (music from the top)  · 5 min later ·  3 "Yesterday"  4, 5 its pages
  · 20 min later ·  6 a page without a title  · 1 min ·  7 a holiday photo (not a sheet)
Each page has its number in a corner square of its own colour, so the test can tell pages apart."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
W, H = 1240, 1754
T0 = 1_700_000_000_000
COLS = [(220, 40, 40), (40, 160, 40), (40, 60, 220), (200, 160, 20), (150, 40, 170), (20, 150, 160), (90, 90, 90)]


def sheet(n, title=None, top=360, bar=False):
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    big, small = ImageFont.truetype(FONT, 72), ImageFont.truetype(FONT, 26)
    if bar:  # an app's top bar (screen junk the crop suggestion cuts off)
        d.rectangle((0, 0, W, 90), fill=(60, 60, 70)); d.text((30, 30), '✕   Sheet viewer', fill='white', font=small)
    if title:
        tw = d.textlength(title, font=big)
        d.text(((W - tw) / 2, 150), title, fill='black', font=big)
        d.text((W - 420, 260), 'Words and Music by Someone', fill='black', font=small)
    for s in range(6):
        y = top + s * 230
        if y + 70 > H - 60: break
        for k in range(5): d.line((90, y + k * 16, W - 90, y + k * 16), fill='black', width=2)
    d.rectangle((W - 120, H - 120, W - 40, H - 40), fill=COLS[n - 1])
    d.text((W - 100, H - 110), str(n), fill='white', font=big)
    return im


def main(root):
    d = Path(root) / 'SHEET'
    d.mkdir(parents=True, exist_ok=True)
    pages = [sheet(1, 'Moon River', bar=True), sheet(2, top=120), sheet(3, 'Yesterday'), sheet(4, top=110), sheet(5, top=110), sheet(6, top=330)]
    gaps = [0, 10_000, 300_000, 12_000, 9_000, 1_200_000, 60_000]
    t, dates = T0, {}
    for k, im in enumerate(pages, 1):
        t += gaps[k - 1]
        im.save(d / f'IMG_{100 + k}.png'); dates[f'IMG_{100 + k}.png'] = t
    photo = Image.new('RGB', (1600, 1200), (90, 160, 220))
    ImageDraw.Draw(photo).ellipse((500, 300, 1100, 900), fill=(250, 210, 60))
    t += gaps[6]
    photo.save(d / 'IMG_107.jpg', quality=90); dates['IMG_107.jpg'] = t
    (d / 'dates.json').write_text(json.dumps(dates, indent=1))
    print(d)


if __name__ == '__main__':
    main(sys.argv[1])
