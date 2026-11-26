# Hand-placed pixel textures for the lc70 wagon (numpy only, no bpy).
# All arrays are H x W x 3 uint8 sRGB, row 0 = BOTTOM of the image (Blender's pixel order).
# Painting is done in metres through "regions": a region maps a planar projection of the truck
# (side / top / front / rear) onto a rectangle of the atlas at 32 px per metre, so the build script
# can give every face the matching UV and texels stay square.
import numpy as np

PX = 32  # texture pixels per metre (docs/ART_STYLE.md)


def hx(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.uint8)


def ramp(*hs):
    return [hx(h) for h in hs]


# palette ramps: highlight, base, shade, deep shade (docs/ART_STYLE.md)
CREAM = ramp('#f6eed8', '#e6dcc0', '#c9bd9c', '#a2977a')
BLACK = ramp('#4a4640', '#33302c', '#24211e', '#161412')
GLASS = ramp('#7fa6c4', '#3f5f7a', '#2a4258', '#1c2d3e')
ROCK = ramp('#b7aa98', '#948775', '#73685c', '#544b45')
LAMP = ramp('#fff6cf', '#ffe08a', '#e8b860', '#b98a3e')
AMBER = ramp('#ffd08a', '#ffb347', '#d9832e', '#a85f22')
TAIL = ramp('#ff8a70', '#e0453a', '#a8302a', '#6e1f1e')
DIRT = ramp('#f2c25a', '#e0a440', '#c4832e', '#9a5f24')

RAMPS = {'cream': CREAM, 'black': BLACK, 'glass': GLASS, 'rock': ROCK, 'lamp': LAMP, 'amber': AMBER, 'tail': TAIL}


class Region:
    """Planar projection (a, b) in metres -> pixel rectangle of an atlas."""

    def __init__(self, x0, y0, w, h, a0, b0):
        self.x0, self.y0, self.w, self.h, self.a0, self.b0 = x0, y0, w, h, a0, b0

    def px(self, a, b):  # float pixel coords
        return self.x0 + (a - self.a0) * PX, self.y0 + (b - self.b0) * PX

    def uv(self, a, b, W, H):
        u, v = self.px(a, b)
        return u / W, v / H


class Canvas:
    def __init__(self, W, H, fill):
        self.W, self.H = W, H
        self.a = np.zeros((H, W, 3), dtype=np.uint8)
        self.a[:] = fill

    def _clip(self, r, x0, y0, x1, y1):
        X0 = max(r.x0, int(x0)); Y0 = max(r.y0, int(y0))
        X1 = min(r.x0 + r.w, int(x1)); Y1 = min(r.y0 + r.h, int(y1))
        return X0, Y0, X1, Y1

    def fill_region(self, r, c):
        self.a[r.y0:r.y0 + r.h, r.x0:r.x0 + r.w] = c

    def rect(self, r, a0, b0, a1, b1, c):
        """fill pixels whose centres fall inside the metric rectangle"""
        x0, y0 = r.px(min(a0, a1), min(b0, b1)); x1, y1 = r.px(max(a0, a1), max(b0, b1))
        X0, Y0, X1, Y1 = self._clip(r, round(x0), round(y0), round(x1), round(y1))
        if X1 > X0 and Y1 > Y0:
            self.a[Y0:Y1, X0:X1] = c

    def mask(self, r, fn, c):
        """paint every pixel of region r whose centre (in metres) satisfies fn(a, b)"""
        ys, xs = np.mgrid[r.y0:r.y0 + r.h, r.x0:r.x0 + r.w]
        A = r.a0 + (xs + 0.5 - r.x0) / PX
        B = r.b0 + (ys + 0.5 - r.y0) / PX
        m = fn(A, B)
        sub = self.a[r.y0:r.y0 + r.h, r.x0:r.x0 + r.w]
        sub[m] = c

    def hline(self, r, a0, a1, b, c):
        x0, y = r.px(min(a0, a1), b); x1, _ = r.px(max(a0, a1), b)
        Y = int(np.floor(y))
        X0, Y0, X1, Y1 = self._clip(r, round(x0), Y, round(x1), Y + 1)
        if X1 > X0 and Y1 > Y0:
            self.a[Y0:Y1, X0:X1] = c

    def vline(self, r, a, b0, b1, c):
        x, y0 = r.px(a, min(b0, b1)); _, y1 = r.px(a, max(b0, b1))
        X = int(np.floor(x))
        X0, Y0, X1, Y1 = self._clip(r, X, round(y0), X + 1, round(y1))
        if X1 > X0 and Y1 > Y0:
            self.a[Y0:Y1, X0:X1] = c

    def dot(self, r, a, b, c, w=1, h=1):
        x, y = r.px(a, b)
        X, Y = int(np.floor(x)), int(np.floor(y))
        X0, Y0, X1, Y1 = self._clip(r, X, Y, X + w, Y + h)
        if X1 > X0 and Y1 > Y0:
            self.a[Y0:Y1, X0:X1] = c

    def dither_band(self, r, a0, a1, b0, b1, c, phase=0):
        """checkerboard dither of colour c over a metric band (soft tone transition)"""
        def fn(A, B):
            inside = (A >= a0) & (A < a1) & (B >= b0) & (B < b1)
            xs = np.floor((A - r.a0) * PX).astype(int); ys = np.floor((B - r.b0) * PX).astype(int)
            return inside & (((xs + ys + phase) % 2) == 0)
        self.mask(r, fn, c)


def ring(A, B, cy, cz, r0, r1):
    d2 = (A - cy) ** 2 + (B - cz) ** 2
    return (d2 >= r0 * r0) & (d2 < r1 * r1)


# ---------------------------------------------------------------- paint atlas (body)
W_PAINT, H_PAINT = 256, 256
SIDE = Region(0, 0, 160, 64, -2.5, 0.5)      # (y, z)
TOP = Region(0, 64, 160, 64, -2.5, -1.0)     # (y, x)
FRONT = Region(160, 0, 64, 64, -1.0, 0.5)    # (x, z)
REAR = Region(160, 64, 64, 64, -1.0, 0.5)    # (x, z)
SW_X0, SW_Y0, SW_CELL = 0, 128, 8            # swatch cells (8x8 each), one ramp per row
SW_ROWS = ['cream', 'black', 'rock', 'glass', 'amber', 'tail', 'lamp']


def swatch_uv(name, tone, W=W_PAINT, H=H_PAINT, x0=SW_X0, y0=SW_Y0):
    row = SW_ROWS.index(name)
    return ((x0 + tone * SW_CELL + SW_CELL / 2) / W, (y0 + row * SW_CELL + SW_CELL / 2) / H)


def paint_swatches(cv, x0=SW_X0, y0=SW_Y0):
    for row, name in enumerate(SW_ROWS):
        for t in range(4):
            X, Y = x0 + t * SW_CELL, y0 + row * SW_CELL
            cv.a[Y:Y + SW_CELL, X:X + SW_CELL] = RAMPS[name][t]


def paint_body(D):
    cv = Canvas(W_PAINT, H_PAINT, CREAM[1])
    C0, C1, C2, C3 = CREAM
    K0, K1, K2, K3 = BLACK
    S0, S1, S2, S3 = ROCK
    paint_swatches(cv)

    AY, ACZ, AR = D['AY'], D['ARCH_CZ'], D['ARCH_R']
    SILL, BELT = D['SILL'], D['BELT']
    WZ0, WZ1 = D['WIN_Z0'], D['WIN_Z1']
    ROOF = D['ROOF_Z']
    bz0, bz1 = D['BUMP_Z0'], D['BUMP_Z1']

    # ================= SIDE (y, z) =================
    r = SIDE
    cv.fill_region(r, C1)
    # vertical tone placement: highlight under the belt shoulder, shade toward the sills
    cv.rect(r, -2.5, BELT - 0.09, 2.5, BELT + 0.02, C0)
    cv.dither_band(r, -2.5, 2.5, BELT - 0.15, BELT - 0.09, C0)
    cv.rect(r, -2.5, 0.5, 2.5, SILL + 0.14, C2)
    cv.dither_band(r, -2.5, 2.5, SILL + 0.14, SILL + 0.20, C2, phase=1)
    cv.rect(r, -2.5, 0.5, 2.5, SILL + 0.045, C3)
    cv.hline(r, -2.3, D['COWL_Y'], BELT + 0.005, C2)               # belt crease under the ledge
    # greenhouse: black window surround and pillars, cream roof edge above
    cv.rect(r, -2.5, WZ0 - 0.035, 2.5, WZ1 + 0.035, K2)
    cv.hline(r, -2.5, 2.5, WZ1 + 0.02, K1)
    cv.rect(r, -2.5, WZ1 + 0.035, 2.5, 2.5, C1)
    cv.rect(r, -2.5, ROOF - 0.05, 2.5, 2.5, C0)
    cv.hline(r, -2.4, 0.6, WZ1 + 0.07, C2)                          # rain gutter
    # A pillar is body colour (in front of the front door glass)
    a_front = D['A_PILLAR_Y']
    cv.mask(r, lambda A, B: (B > WZ0 - 0.04) & (B < WZ1 + 0.04) & (A > a_front(B) - 0.02), C1)
    cv.mask(r, lambda A, B: (B > WZ0 - 0.04) & (B < WZ1 + 0.04) & (A > a_front(B) + 0.07), C0)
    # door shut lines (deep shade) with a shade pixel behind them
    for y in D['DOOR_SEAMS']:
        cv.vline(r, y, SILL + 0.03, BELT - 0.005, C3)
        cv.vline(r, y - 1 / PX, SILL + 0.03, BELT - 0.005, C2)
    cv.hline(r, D['DOOR_SEAMS'][-1], D['DOOR_SEAMS'][0], SILL + 0.04, C3)
    # door handles: dark slot with a lit lip above
    for y in D['HANDLES']:
        cv.rect(r, y - 0.11, BELT - 0.19, y + 0.07, BELT - 0.12, K2)
        cv.hline(r, y - 0.11, y + 0.07, BELT - 0.13, K0)
        cv.hline(r, y - 0.11, y + 0.07, BELT - 0.10, C0)
    # fuel flap on the rear quarter
    fy, fz = -1.86, 1.30
    cv.rect(r, fy - 0.10, fz - 0.09, fy + 0.10, fz + 0.09, C3)
    cv.rect(r, fy - 0.07, fz - 0.06, fy + 0.10, fz + 0.09, C1)
    cv.hline(r, fy - 0.07, fy + 0.10, fz + 0.06, C0)
    # amber side marker on the front fender
    cv.rect(r, 1.93, 1.17, 2.06, 1.23, AMBER[1])
    cv.hline(r, 1.93, 2.06, 1.22, AMBER[0])
    # wheel arches: dark well, black rubber lip, lit flare crown, shade ring where the flare meets the body
    for ay in (AY, -AY):
        cv.mask(r, lambda A, B, ay=ay: ring(A, B, ay, ACZ, 0, AR), K3)
        cv.mask(r, lambda A, B, ay=ay: ring(A, B, ay, ACZ, AR, AR + 0.045), K1)
        cv.mask(r, lambda A, B, ay=ay: ring(A, B, ay, ACZ, AR + 0.045, AR + 0.075) & (B > ACZ + 0.25), K0)
        cv.mask(r, lambda A, B, ay=ay: ring(A, B, ay, ACZ, AR + 0.075, AR + 0.11) & (B > ACZ + 0.30), C0)
        cv.mask(r, lambda A, B, ay=ay: ring(A, B, ay, ACZ, AR + 0.15, AR + 0.18) & (B > SILL + 0.06), C2)
    # side steps (black) between the arches, below the sill
    cv.rect(r, -D['STEP_Y'], 0.5, D['STEP_Y'], SILL - 0.005, K1)
    cv.hline(r, -D['STEP_Y'], D['STEP_Y'], SILL - 0.035, K0)
    # bumper ends (grey steel)
    for y0_, y1_, zt in ((D['LB_F'] - 0.05, 2.5, bz1), (-2.5, D['LB_R'] + 0.05, D['RBUMP_Z1'])):
        cv.rect(r, y0_, 0.5, y1_, zt, S1)
        cv.rect(r, y0_, zt - 0.05, y1_, zt, S0)
        cv.rect(r, y0_, 0.5, y1_, bz0 + 0.05, S2)

    # ================= TOP (y, x) =================
    r = TOP
    cv.fill_region(r, C0)
    by0, by1 = D['COWL_Y'], D['LB_F']
    bx = D['BONNET_X']
    cv.rect(r, by0, -bx, by1, bx, C1)                              # bonnet panel a touch darker than fenders
    cv.rect(r, by0 + 0.25, -0.22, by1 - 0.12, 0.22, C0)            # crown highlight
    cv.dither_band(r, by0 + 0.25, by1 - 0.12, -0.32, -0.22, C0)
    cv.dither_band(r, by0 + 0.25, by1 - 0.12, 0.22, 0.32, C0)
    for s in (-1, 1):
        cv.mask(r, lambda A, B, s=s: (A > by0) & (A < by1 - 0.02) & (np.abs(B - s * bx) < 0.5 / PX), C3)
    cv.rect(r, by0 - 0.07, -0.86, by0 + 0.02, 0.86, K2)            # cowl / wiper strip
    for s in (-0.42, 0.08):                                        # wiper arms
        cv.rect(r, by0 + 0.02, s, by0 + 0.06, s + 0.34, K1)
    cv.rect(r, by1 - 0.04, -1.0, by1 + 0.01, 1.0, C2)              # bonnet front lip
    # roof: base tone, stamped ribs, gutters
    ry0, ry1 = D['CAB_R'], D['SCREEN_TOP_Y']
    cv.rect(r, ry0, -0.82, ry1, 0.82, C1)
    for i in range(1, 10):
        y = ry0 + (ry1 - ry0) * i / 10
        cv.vline(r, y, -0.6, 0.6, C0)
    for s in (-1, 1):
        cv.mask(r, lambda A, B, s=s: (A < ry1) & (A > ry0) & (np.abs(B - s * 0.78) < 0.5 / PX), C2)
    cv.rect(r, ry1 - 0.05, -0.82, ry1 + 0.05, 0.82, C0)             # screen header
    # bumper tops
    for y0_, y1_ in ((D['FBUMP_Y0'], 2.5), (-2.5, D['RBUMP_Y0'])):
        cv.rect(r, y0_, -1.0, y1_, 1.0, S0)
        cv.rect(r, y0_, -1.0, y1_, -0.92, S1)
        cv.rect(r, y0_, 0.92, y1_, 1.0, S1)

    # ================= FRONT (x, z) =================
    r = FRONT
    cv.fill_region(r, C1)
    cv.rect(r, -1.0, D['BON_F'] - 0.06, 1.0, 2.5, C0)              # bonnet nose highlight
    cv.rect(r, -1.0, 0.5, 1.0, 0.88, C2)
    # grille: dark frame, slats with lit tops, NO lettering
    gx, gz0, gz1 = D['GRILLE_X'], D['GRILLE_Z0'], D['GRILLE_Z1']
    cv.rect(r, -gx, gz0, gx, gz1, K2)
    cv.rect(r, -gx + 0.035, gz0 + 0.035, gx - 0.035, gz1 - 0.035, K3)
    n = 5
    for i in range(n):
        z = gz0 + 0.035 + (gz1 - gz0 - 0.07) * (i + 0.5) / n
        cv.rect(r, -gx + 0.05, z - 0.02, gx - 0.05, z + 0.02, K1)
        cv.hline(r, -gx + 0.05, gx - 0.05, z + 0.01, K0)
    cv.hline(r, -gx, gx, gz1 - 0.01, K0)
    # headlight housings (lamps are separate meshes)
    for s in (-1, 1):
        hx_ = s * D['HEAD_X']
        cv.rect(r, hx_ - 0.15, D['HEAD_Z'] - 0.13, hx_ + 0.15, D['HEAD_Z'] + 0.13, K2)
    # bumper: grey steel, lit top, bolts, small amber lamps
    cv.rect(r, -1.0, bz0, 1.0, bz1, S1)
    cv.rect(r, -1.0, bz1 - 0.05, 1.0, bz1, S0)
    cv.rect(r, -1.0, bz0, 1.0, bz0 + 0.05, S2)
    cv.hline(r, -1.0, 1.0, bz0 + 0.005, S3)
    for s in (-1, 1):
        cv.rect(r, s * 0.74 - 0.07, bz0 + 0.08, s * 0.74 + 0.07, bz0 + 0.14, AMBER[1])
        cv.hline(r, s * 0.74 - 0.07, s * 0.74 + 0.07, bz0 + 0.13, AMBER[0])
        cv.rect(r, s * 0.40 - 0.05, bz0 + 0.06, s * 0.40 + 0.05, bz0 + 0.13, S3)
        for bx_ in (0.14, 0.56, 0.90):
            cv.dot(r, s * bx_, bz1 - 0.10, S3)
    cv.rect(r, -0.17, bz0 + 0.06, 0.17, bz0 + 0.16, S2)            # blank plate (no text)
    cv.rect(r, -0.15, bz0 + 0.07, 0.15, bz0 + 0.15, C1)
    cv.rect(r, -1.0, BELT - 0.03, 1.0, BELT + 0.03, K2)            # cowl
    cv.rect(r, -1.0, ROOF - 0.05, 1.0, 2.5, C0)

    # ================= REAR (x, z) =================
    r = REAR
    cv.fill_region(r, C1)
    cv.rect(r, -1.0, 0.5, 1.0, SILL + 0.16, C2)
    cv.dither_band(r, -1.0, 1.0, SILL + 0.16, SILL + 0.22, C2, phase=1)
    cv.rect(r, -1.0, BELT - 0.06, 1.0, BELT + 0.03, C0)
    dx = D['RDOOR_X']
    for s in (-1, 1):
        cv.vline(r, s * dx, SILL + 0.06, ROOF - 0.07, C3)
    cv.hline(r, -dx, dx, ROOF - 0.07, C3)
    cv.hline(r, -dx, dx, SILL + 0.06, C3)
    cv.rect(r, -0.64, 1.30, -0.46, 1.35, K1)                       # handle
    cv.hline(r, -0.64, -0.46, 1.35, C0)
    cv.rect(r, -0.20, 0.92, 0.20, 1.10, C3)                        # blank plate recess (no text)
    cv.rect(r, -0.18, 0.94, 0.18, 1.08, C0)
    cv.rect(r, -1.0, BELT + 0.03, 1.0, BELT + 0.07, K2)
    cv.rect(r, -1.0, ROOF - 0.05, 1.0, 2.5, C0)
    rz1 = D['RBUMP_Z1']
    cv.rect(r, -1.0, bz0, 1.0, rz1, S1)
    cv.rect(r, -1.0, rz1 - 0.05, 1.0, rz1, S0)
    cv.rect(r, -1.0, bz0, 1.0, bz0 + 0.05, S2)
    for s in (-1, 1):
        cv.rect(r, s * 0.80 - 0.07, bz0 + 0.08, s * 0.80 + 0.07, bz0 + 0.13, TAIL[2])
        cv.hline(r, s * 0.80 - 0.07, s * 0.80 + 0.07, bz0 + 0.12, TAIL[1])
        cv.rect(r, s * 0.30 - 0.05, bz0 + 0.06, s * 0.30 + 0.05, bz0 + 0.12, S3)
    return cv


# ---------------------------------------------------------------- glass (64 x 64, repeats every 2 m)
def paint_glass():
    # dark glass like the reference, a lighter sky band near the top, chunky diagonal glints
    cv = Canvas(64, 64, GLASS[2])
    a = cv.a
    for y in range(64):
        for x in range(64):
            # rows = (z - 1.5 m) * 32: window glass lives in rows ~2..18
            if 12 <= y <= 15:
                a[y, x] = GLASS[1]
            d = (x - y) % 64
            if 2 <= y <= 16:
                if 4 <= d < 7:
                    a[y, x] = GLASS[0]
                elif d in (7, 10, 11):
                    a[y, x] = GLASS[1]
            if y in (16, 17) or y < 3:
                a[y, x] = GLASS[3]
    return cv


# ---------------------------------------------------------------- lamps (16 x 8): headlight tile + amber tile
def paint_lamp():
    cv = Canvas(16, 8, LAMP[1])
    a = cv.a
    white = np.array([255, 255, 246], np.uint8)
    a[0:8, 0:8] = ROCK[1]
    a[0, 0:8] = ROCK[3]
    a[7, 0:8] = ROCK[0]
    a[1:7, 1:7] = LAMP[1]
    a[2:6, 2:6] = LAMP[0]
    a[3:5, 3:5] = white
    a[5, 2] = white
    a[1, 1:7] = LAMP[2]
    # amber tile x 8..15
    a[0:8, 8:16] = AMBER[2]
    a[1:7, 9:15] = AMBER[1]
    a[4:6, 9:15] = AMBER[0]
    a[1, 9:15] = AMBER[3]
    return cv


def paint_tail():
    cv = Canvas(8, 16, TAIL[1])
    a = cv.a
    a[:, :] = TAIL[2]
    a[1:15, 1:7] = TAIL[1]
    a[10:14, 2:6] = TAIL[0]
    for y in (3, 6):
        a[y, 1:7] = TAIL[2]
    a[1, 1:7] = TAIL[3]
    return cv


# ---------------------------------------------------------------- wheel (64 x 32): sidewall disc + swatches
W_WHEEL, H_WHEEL = 64, 32
WHEEL_SIDE = Region(0, 0, 32, 32, -0.5, -0.5)      # (y, z) relative to the hub
WHEEL_SW_X0, WHEEL_SW_Y0, WHEEL_SW_ROWS = 32, 0, ['black', 'rock', 'cream', 'glass']


def wheel_swatch_uv(name, tone):
    row = WHEEL_SW_ROWS.index(name)
    return ((WHEEL_SW_X0 + tone * 8 + 4) / W_WHEEL, (WHEEL_SW_Y0 + row * 8 + 4) / H_WHEEL)


def paint_wheel(D):
    cv = Canvas(W_WHEEL, H_WHEEL, BLACK[1])
    K0, K1, K2, K3 = BLACK
    S0, S1, S2, S3 = ROCK
    for row, name in enumerate(WHEEL_SW_ROWS):
        for t in range(4):
            X, Y = WHEEL_SW_X0 + t * 8, WHEEL_SW_Y0 + row * 8
            cv.a[Y:Y + 8, X:X + 8] = RAMPS[name][t]
    r = WHEEL_SIDE
    rim = D['RIM_R']
    rr = lambda A, B: np.sqrt(A * A + B * B)
    cv.mask(r, lambda A, B: rr(A, B) < 0.5, K1)
    cv.mask(r, lambda A, B: (rr(A, B) > 0.33) & (rr(A, B) < 0.355), K0)  # moulded sidewall ring
    cv.mask(r, lambda A, B: (rr(A, B) > 0.33) & (rr(A, B) < 0.355) & (B < -0.1), K2)
    cv.mask(r, lambda A, B: (rr(A, B) > rim) & (rr(A, B) < rim + 0.035), K2)
    # steel rim: lit lip, dish, 6 holes, hub and nuts
    cv.mask(r, lambda A, B: rr(A, B) <= rim, S1)
    cv.mask(r, lambda A, B: (rr(A, B) <= rim) & (rr(A, B) > rim - 0.04), S0)
    cv.mask(r, lambda A, B: (rr(A, B) <= rim) & (rr(A, B) > rim - 0.04) & (B < -0.06), S2)
    cv.mask(r, lambda A, B: (rr(A, B) < rim - 0.04) & (rr(A, B) > rim - 0.07), S2)
    for i in range(6):
        ang = i / 6 * 2 * np.pi + np.pi / 6
        cy, cz = np.cos(ang) * 0.165, np.sin(ang) * 0.165
        cv.mask(r, lambda A, B, cy=cy, cz=cz: (A - cy) ** 2 + (B - cz) ** 2 < 0.036 ** 2, S3)
    cv.mask(r, lambda A, B: rr(A, B) < 0.095, S2)
    cv.mask(r, lambda A, B: rr(A, B) < 0.065, S0)
    cv.mask(r, lambda A, B: rr(A, B) < 0.03, S1)
    return cv


# ---------------------------------------------------------------- preview ground (64 x 64 dirt, repeats)
def paint_dirt():
    cv = Canvas(64, 64, DIRT[1])
    a = cv.a
    rng = np.random.default_rng(7)
    for _ in range(26):                     # pebble: lit pixel over a shade pixel
        x, y = rng.integers(0, 63), rng.integers(1, 63)
        a[y, x] = DIRT[0]
        a[y - 1, x] = DIRT[2]
    for _ in range(14):                     # shade dashes
        x, y = rng.integers(0, 61), rng.integers(0, 64)
        a[y, x:x + 3] = DIRT[2]
    for _ in range(5):                      # grey stones
        x, y = rng.integers(1, 62), rng.integers(1, 62)
        a[y, x] = DIRT[3]
        a[y + 1, x] = np.array([0xb7, 0xaa, 0x98], np.uint8)
    return cv
