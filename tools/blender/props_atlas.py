# Shared 256 px pixel-art atlas for the LowRange nature/prop set (docs/ART_STYLE.md).
# Every region is hand-pixelled in code from the 4-tone palette ramps: leaf clumps, pine
# needles, rock with cracks, bark grain, planks, cut-end rings, grass. A face of a prop picks
# a region (material + tone), so lighter tops / darker undersides come from which tile a face
# samples, and the pixel pattern inside the tile carries the hand-drawn detail.
# Array convention: A[y, x] with y = 0 at the BOTTOM (same as Blender UVs and image.pixels).
import random
import numpy as np

SIZE = 256
PX_PER_M = 32


def hx(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


LEAF = [hx(c) for c in ('#7cc843', '#4fa032', '#2f7d2c', '#1f5a27')]
LEAF_HI, LEAF_DEEP = hx('#a6dc5e'), hx('#174621')
PINE = [hx(c) for c in ('#4f9f4a', '#2f7f3f', '#1f6236', '#164a2e')]
PINE_HI, PINE_DEEP = hx('#6fb85a'), hx('#103a26')
GRASS = [hx(c) for c in ('#8fd14a', '#5fae36', '#3f8a2e', '#2a6628')]
BARK = [hx(c) for c in ('#c98a4e', '#a5683a', '#7d4a2a', '#55301f')]
BARK_DEEP = hx('#3e2318')
CUT = [hx(c) for c in ('#f0c88a', '#dcab6c', '#c98a4e')]   # pale cut-wood face for rings
ROCK = [hx(c) for c in ('#b7aa98', '#948775', '#73685c', '#544b45')]
ROCK_HI, ROCK_DEEP = hx('#cfc3b0'), hx('#3e3634')
PINK, WHITE, YELLOW = hx('#f7a8c4'), hx('#fff4e6'), hx('#ffd95a')
PINK_DK = hx('#d97a9e')

# name -> (x, y, w, h) in pixels, origin bottom-left
REG = {}
for i in range(4):
    REG[f'leaf{i}'] = (i * 32, 224, 32, 32)
for i in range(3):
    REG[f'flower{i}'] = (128 + i * 32, 224, 32, 32)
REG['grass'] = (224, 224, 32, 32)
for i in range(4):
    REG[f'pine{i}'] = (i * 32, 192, 32, 32)
    REG[f'rock{i}'] = (128 + i * 32, 192, 32, 32)
REG['ring'] = (0, 160, 32, 32)
REG['ring_s'] = (32, 160, 32, 32)
REG['endgrain'] = (64, 160, 32, 32)
REG['leaf_flower3'] = (96, 160, 32, 32)
REG['rockc1'] = (128, 160, 32, 32)
REG['rockc2'] = (160, 160, 32, 32)
REG['rockc3'] = (192, 160, 32, 32)
for i in range(3):
    REG[f'bark{i}'] = (i * 32, 0, 32, 160)
    REG[f'wood{i}'] = (96 + i * 32, 0, 32, 160)
REG['board'] = (192, 0, 32, 160)
REG['board_dk'] = (224, 0, 32, 160)


def _put(A, x, y, c, reg):
    rx, ry, rw, rh = reg
    if 0 <= x < rw and 0 <= y < rh:
        A[ry + y, rx + x] = c


def _fill(A, reg, c):
    rx, ry, rw, rh = reg
    A[ry:ry + rh, rx:rx + rw] = c


# a leaf: rows listed top to bottom (y decreasing)
LEAF_SHAPE = ['.####..', '######.', '#######', '#######', '.#####.', '..##...']


def paint_leaves(A, reg, ramp, t, hi, deep, seed, flowers=0):
    """Overlapping leaf puffs on a staggered grid, drawn top row first so lower puffs overlap
    the ones above (scaly clump look, like the reference canopies). Fill = tone t, top-left
    rim one tone lighter, bottom row one tone darker, gaps darker still."""
    R = random.Random(seed)
    lighter = hi if t == 0 else ramp[t - 1]
    darker = deep if t == 3 else ramp[t + 1]
    deeper = deep if t >= 2 else ramp[t + 2]
    _fill(A, reg, deeper)
    rw, rh = reg[2], reg[3]
    rows = list(range(rh + 3, -6, -5))  # top to bottom
    for ri, top in enumerate(rows):
        for cx in range(-4 + (ri % 2) * 4, rw + 4, 8):
            x0 = cx + R.randint(-1, 1)
            y0 = top + R.randint(-1, 0)
            for dy, row in enumerate(LEAF_SHAPE):
                first = row.index('#')
                for dx, ch in enumerate(row):
                    if ch != '#':
                        continue
                    x, y = (x0 + dx) % rw, y0 - dy
                    if dy == 0 or (dy <= 2 and dx == first):
                        c = lighter
                    elif dy >= 4 or dx == row.rindex('#'):
                        c = darker
                    else:
                        c = ramp[t]
                    _put(A, x, y, c, reg)
            if R.random() < 0.5:  # a sparkle of light inside the puff
                _put(A, (x0 + 2) % rw, y0 - 1, hi if t <= 1 else lighter, reg)
    spots = []
    while len(spots) < flowers:  # blossoms spread out, not clumped
        cx, cy = R.randrange(3, rw - 3), R.randrange(3, rh - 3)
        if all(abs(cx - a) + abs(cy - b) > 9 for a, b in spots):
            spots.append((cx, cy))
    for i, (cx, cy) in enumerate(spots):
        petal = PINK if i % 3 != 2 else WHITE
        shade = PINK_DK if petal is PINK else hx('#e6cfc0')
        for dx, dy in ((0, 1), (-1, 0), (1, 0), (0, -1), (-1, 1), (1, 1)):
            _put(A, cx + dx, cy + dy, petal, reg)
        for dx, dy in ((-1, -1), (1, -1), (0, -2)):
            _put(A, cx + dx, cy + dy, shade, reg)
        _put(A, cx, cy, YELLOW, reg)


def paint_pine(A, reg, t, seed):
    """Needle tufts: little downward chevrons, lit upper stroke, shade between rows."""
    R = random.Random(seed)
    lighter = PINE_HI if t == 0 else PINE[t - 1]
    darker = PINE_DEEP if t == 3 else PINE[t + 1]
    _fill(A, reg, darker)
    rw, rh = reg[2], reg[3]
    for ri, top in enumerate(range(rh + 2, -6, -5)):
        for cx in range(-3 + (ri % 2) * 3, rw + 4, 6):
            x0, y0 = cx + R.randint(0, 1), top - R.randint(0, 1)
            # needle tuft: a filled downward chevron, lit spine, arms drooping into shade
            for k in range(5):
                for j in range(-k, k + 1):
                    if abs(j) < k - 1:
                        continue  # hollow middle shows the shade beneath
                    c = lighter if (j == 0 or (k <= 1)) else (PINE[t] if abs(j) < 4 else darker)
                    _put(A, (x0 + j) % rw, y0 - k - (abs(j) // 2), c, reg)


def paint_rock(A, reg, t, seed, cracks=1):
    """Flat rock tone with a few lighter chip highlights, dark pits and 1-3 crack lines."""
    R = random.Random(seed)
    lighter = ROCK_HI if t == 0 else ROCK[t - 1]
    darker = ROCK_DEEP if t == 3 else ROCK[t + 1]
    _fill(A, reg, ROCK[t])
    rw, rh = reg[2], reg[3]
    for _ in range(6):  # lighter chips: short horizontal dashes with a dark underside
        x, y, L = R.randrange(rw), R.randrange(rh), R.randint(2, 4)
        for i in range(L):
            _put(A, (x + i) % rw, y, lighter, reg)
            if R.random() < 0.6:
                _put(A, (x + i) % rw, y - 1, darker, reg)
    for _ in range(5):  # pits
        _put(A, R.randrange(rw), R.randrange(rh), darker, reg)
    for _ in range(cracks):
        x, y = R.randrange(4, rw - 4), R.randrange(rh // 2, rh - 2)
        for _ in range(R.randint(6, 11)):
            _put(A, x, y, ROCK_DEEP, reg)
            _put(A, x + 1, y, lighter, reg)  # lit edge of the crack
            y -= 1
            x += R.choice((-1, 0, 0, 1))
            if R.random() < 0.15:  # small branch
                _put(A, x - 1, y, ROCK_DEEP, reg)


def paint_bark(A, reg, t, seed, fine=False):
    """Vertical grain: long dark furrows, lighter ridges beside them, the odd knot.
    fine=True is planed wood (fence, sign): sparser, shorter grain."""
    R = random.Random(seed)
    base = BARK[t]
    darker = BARK[t + 1] if t < 3 else BARK_DEEP
    lighter = BARK[t - 1] if t > 0 else hx('#ddA466')
    _fill(A, reg, base)
    rw, rh = reg[2], reg[3]
    step = 5 if fine else 3
    x = R.randint(0, 2)
    while x < rw:
        y = R.randrange(rh)
        total = 0
        while total < rh * (0.7 if fine else 1.2):
            L = R.randint(6, 18) if fine else R.randint(10, 30)
            for k in range(L):
                _put(A, x, (y + k) % rh, darker, reg)
                if not fine and R.random() < 0.5:
                    _put(A, (x + 1) % rw, (y + k) % rh, lighter, reg)
            y += L + R.randint(3, 9)
            total += L
            if R.random() < 0.3:  # furrows wander a pixel sideways
                x = max(0, min(rw - 1, x + R.choice((-1, 1))))
        x += step + R.randint(0, 2)
    for _ in range(2 if fine else 3):  # knots
        cx, cy = R.randrange(3, rw - 3), R.randrange(4, rh - 4)
        for dx, dy in ((-1, 0), (1, 0), (0, 1), (0, -1), (-1, 1), (1, -1)):
            _put(A, cx + dx, cy + dy, darker, reg)
        _put(A, cx, cy, BARK_DEEP, reg)
        _put(A, cx - 1, cy + 2, lighter, reg)


def paint_board(A, reg, base, seed):
    """Sign / plank face: almost plain, two long faint grain lines so names stay readable."""
    R = random.Random(seed)
    rw, rh = reg[2], reg[3]
    _fill(A, reg, base)
    darker = base * 0.86
    for x in (R.randrange(4, 12), R.randrange(18, 28)):
        y = R.randrange(rh)
        for k in range(R.randint(30, 70)):
            _put(A, x, (y + k) % rh, darker, reg)


def paint_rings(A, reg, seed, bark_rim=2):
    """Cut end of a log/stump: pale face, concentric rings, dark heart, bark rim."""
    R = random.Random(seed)
    rx, ry, rw, rh = reg
    c = (rw - 1) / 2
    for y in range(rh):
        for x in range(rw):
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            if d > c + 0.5 - bark_rim:
                col = BARK[3] if d < c + 0.5 else BARK_DEEP
            else:
                ring = int(d + 0.3 * R.random()) % 4
                col = CUT[0] if ring in (0, 1) else (CUT[1] if ring == 2 else CUT[2])
                if d < 1.6:
                    col = BARK[1]
            A[ry + y, rx + x] = col
    for _ in range(2):  # radial check cracks
        a = R.random() * 6.283
        for k in range(3, int(c) - 2):
            x = int(round(c + np.cos(a) * k)); y = int(round(c + np.sin(a) * k))
            A[ry + y, rx + x] = BARK[2]


def paint_grass(A, reg, seed):
    """Vertical ramp by height above the ground (faces are mapped with v = height):
    deep at the root, light at the tips, with a few blade stripes."""
    R = random.Random(seed)
    rx, ry, rw, rh = reg
    for y in range(rh):
        t = 3 if y < 2 else 2 if y < 5 else 1 if y < 8 else 0
        for x in range(rw):
            c = GRASS[t]
            if 2 <= y < 9 and (x * 7 + y // 3) % 5 == 0:
                c = GRASS[max(0, t - 1)]
            A[ry + y, rx + x] = c


def build_atlas():
    A = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    A[:] = hx('#ff00ff')  # unused space shows up loudly
    for i in range(4):
        paint_leaves(A, REG[f'leaf{i}'], LEAF, i, LEAF_HI, LEAF_DEEP, 10 + i)
        paint_pine(A, REG[f'pine{i}'], i, 20 + i)
        paint_rock(A, REG[f'rock{i}'], i, 30 + i, cracks=1 if i in (1, 2) else 0)
    for i in range(3):
        paint_leaves(A, REG[f'flower{i}'], LEAF, i, LEAF_HI, LEAF_DEEP, 40 + i, flowers=5 - i)
        paint_bark(A, REG[f'bark{i}'], i + 1, 50 + i)
        paint_bark(A, REG[f'wood{i}'], i, 60 + i, fine=True)
    paint_leaves(A, REG['leaf_flower3'], LEAF, 3, LEAF_HI, LEAF_DEEP, 44, flowers=1)
    for k, t in (('rockc1', 1), ('rockc2', 2), ('rockc3', 3)):
        paint_rock(A, REG[k], t, 70 + t, cracks=3)
    paint_rings(A, REG['ring'], 80)
    paint_rings(A, REG['ring_s'], 81, bark_rim=3)
    paint_bark(A, REG['endgrain'], 0, 82, fine=True)
    paint_board(A, REG['board'], BARK[0], 83)
    paint_board(A, REG['board_dk'], BARK[1], 84)
    paint_grass(A, REG['grass'], 85)
    A[160:192, 224:256] = ROCK[2]  # spare cell, neutral so mip levels don't bleed magenta
    return A


def ground_texture(w=256, h=256, seed=7):
    """Preview-only warm ochre dirt: base with sparse darker clods, lighter pebble pairs and
    a few grass specks, like the reference ground."""
    DIRT = [hx(c) for c in ('#f2c25a', '#e0a440', '#c4832e', '#9a5f24')]
    R = random.Random(seed)
    A = np.zeros((h, w, 3), dtype=np.float32)
    A[:] = DIRT[1]
    for _ in range(w * h // 40):
        x, y = R.randrange(w), R.randrange(h)
        A[y, x] = DIRT[0] if R.random() < 0.5 else DIRT[2]
    for _ in range(w * h // 700):  # pebbles: light pixel over a dark one
        x, y = R.randrange(w), R.randrange(1, h)
        A[y, x] = DIRT[0]; A[y - 1, x] = DIRT[3]
    return A
