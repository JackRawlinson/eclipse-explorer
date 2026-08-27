"""A share image per lunar eclipse: the Moon in the Earth's shadow.

No map -- a lunar eclipse has no path to draw. What identifies one at a
glance is the classic shadow diagram: the penumbra, the umbra, and the Moon
at greatest eclipse on its chord through them. Radii and the chord come from
the same magnitude arithmetic the site uses (see lunar.js), so the picture
cannot disagree with the page it decorates.
"""

from io import BytesIO

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 1200, 630
NIGHT = (11, 17, 32)
STAR = (226, 232, 240)
PEN = (30, 41, 59)
UMBRA = (15, 15, 24)
UMBRA_RIM = (127, 29, 29)
MOON = (222, 220, 210)
MOON_RED = (156, 44, 28)
CHORD = (71, 85, 105)

RM = 0.2725
STARS = [(0.06, 0.12), (0.13, 0.72), (0.2, 0.3), (0.31, 0.85), (0.38, 0.08),
         (0.52, 0.2), (0.6, 0.9), (0.68, 0.06), (0.79, 0.8), (0.87, 0.16),
         (0.94, 0.55), (0.45, 0.55), (0.08, 0.45), (0.92, 0.88)]


def _geometry(entry):
    m0 = abs(entry["gamma"])
    ru = 2 * RM * entry["umbralMag"] + m0 - RM
    rp = 2 * RM * entry["penMag"] + m0 - RM
    return m0, ru, rp


def _disc(draw, cx, cy, r, fill, outline=None, width=0):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill,
                 outline=outline, width=width)


def render(entry):
    """One PNG for one lunar eclipse, as bytes."""
    image = Image.new("RGB", (WIDTH, HEIGHT), NIGHT)
    draw = ImageDraw.Draw(image)
    for sx, sy in STARS:
        r = 2 if (sx * 7) % 1 > 0.5 else 1
        _disc(draw, sx * WIDTH, sy * HEIGHT, r, STAR)

    m0, ru, rp = _geometry(entry)
    cx, cy = WIDTH / 2, HEIGHT / 2
    unit = (HEIGHT * 0.44) / max(rp, 1e-6)   # penumbra nearly fills the height

    _disc(draw, cx, cy, rp * unit, PEN)
    _disc(draw, cx, cy, ru * unit, UMBRA, outline=UMBRA_RIM, width=3)

    # the chord, with the direction of travel: west to east, left to right in
    # this diagram's north-up convention
    ychord = cy - (m0 * unit if entry["gamma"] > 0 else -m0 * unit)
    draw.line([(cx - WIDTH * 0.42, ychord), (cx + WIDTH * 0.42, ychord)],
              fill=CHORD, width=2)

    # the Moon at greatest eclipse, red when it is fully inside the umbra
    total = entry["umbralMag"] >= 1
    moon_r = RM * unit
    _disc(draw, cx, ychord, moon_r, MOON_RED if total else MOON)
    if not total and entry["umbralMag"] > 0:
        # the bitten part: the overlap with the umbra, darkened
        mask = Image.new("L", (WIDTH, HEIGHT), 0)
        pen = ImageDraw.Draw(mask)
        pen.ellipse([cx - ru * unit, cy - ru * unit,
                     cx + ru * unit, cy + ru * unit], fill=255)
        moon_mask = Image.new("L", (WIDTH, HEIGHT), 0)
        pen2 = ImageDraw.Draw(moon_mask)
        pen2.ellipse([cx - moon_r, ychord - moon_r,
                      cx + moon_r, ychord + moon_r], fill=255)
        both = Image.composite(moon_mask, Image.new("L", (WIDTH, HEIGHT), 0), mask)
        image.paste(Image.new("RGB", (WIDTH, HEIGHT), (58, 24, 20)), (0, 0), both)
    # ghosts of the Moon entering and leaving, faint
    for dx in (-2.2, 2.2):
        _disc(draw, cx + dx * ru * unit, ychord, moon_r, None,
              outline=(93, 102, 121), width=2)

    out = BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
