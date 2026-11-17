"""Draws the Splat Garden icon: a little splat-scanned flower pot dripping on a saturated blue.

    python tools/make_icon.py   ->  icon.ico (app folder, used by the shortcut) and static/icon.png (window icon)
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
BLUE = (0, 53, 255)


def blob(layer, cx, cy, rx, ry, color, blur):
    # blur only the coverage, never the colour, so the soft edge has no dark fringe
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color[3] if len(color) > 3 else 255)
    d = Image.new("RGBA", (S, S), color[:3] + (0,))
    d.putalpha(m.filter(ImageFilter.GaussianBlur(blur)))
    layer.alpha_composite(d)


def main():
    rnd = random.Random(7)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([24, 24, S - 24, S - 24], radius=210, fill=255)
    bg = Image.new("RGBA", (S, S), BLUE + (255,))
    img.paste(bg, (0, 0), mask)

    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # drips first (behind): vertical streaks hanging from the pot and leaves
    dr = ImageDraw.Draw(art)
    for _ in range(30):
        x = rnd.randint(300, 724)
        top = rnd.randint(470, 690)
        ln = rnd.randint(60, 260)
        w = rnd.choice([16, 20, 24, 28])
        col = rnd.choice([(58, 120, 52), (90, 150, 70), (150, 140, 120), (120, 112, 96), (210, 40, 40)])
        dr.rectangle([x, top, x + w, top + ln], fill=col + (235,))
    # pot
    blob(art, 512, 640, 205, 150, (176, 166, 140, 255), 6)
    blob(art, 512, 560, 220, 52, (120, 112, 96, 255), 5)
    # leaves: soft splats
    for _ in range(26):
        a = rnd.uniform(0, 6.28)
        r = rnd.uniform(40, 200)
        cx, cy = 512 + r * 1.1 * math.cos(a), 430 + r * 0.6 * math.sin(a) - 30
        g = rnd.randint(110, 190)
        blob(art, cx, cy, rnd.randint(55, 95), rnd.randint(40, 70), (40, g, 60, 255), 7)
    # red geranium heads
    for cx, cy in ((400, 330), (610, 300), (520, 250)):
        for _ in range(9):
            blob(art, cx + rnd.randint(-38, 38), cy + rnd.randint(-30, 30), 34, 30, (235, rnd.randint(25, 60), 40, 255), 5)
    # a pale veil
    blob(art, 640, 170, 30, 120, (215, 235, 255, 110), 18)
    img.alpha_composite(Image.composite(art, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

    img.resize((512, 512), Image.LANCZOS).save(os.path.join(APP, "static", "icon.png"))
    img.save(os.path.join(APP, "icon.ico"), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(APP, "icon.png"))
    print("icon.ico, icon.png and static/icon.png written")


if __name__ == "__main__":
    main()
