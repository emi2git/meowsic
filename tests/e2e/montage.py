import sys, glob
from PIL import Image
files = sys.argv[3:]; out = sys.argv[1]; cols = int(sys.argv[2])
ims = [Image.open(f) for f in files]
w = 360; ims = [im.resize((w, int(im.height * w / im.width))) for im in ims]
h = max(im.height for im in ims)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (w + 10), rows * (h + 10)), 'white')
for i, im in enumerate(ims): sheet.paste(im, ((i % cols) * (w + 10), (i // cols) * (h + 10)))
sheet.save(out)
