# Hand-placed pixel textures for the olive pickup. Every atlas is painted in WORLD coordinates
# (32 px per metre) through axis projections (side / top / front / rear / inner / bottom), and the
# builder lays the UVs out with the same projections, so panel lines, handles, lamps and bolts land
# exactly where the geometry is. Palette ramps come from docs/ART_STYLE.md.
import math
import numpy as np
from taco_shape import *


def hx(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


OLV = [hx(c) for c in ('#a8a56a', '#8a8650', '#6b683c', '#4c4a2c')]     # highlight, base, shade, deep
BLK = [hx(c) for c in ('#4a4640', '#33302c', '#24211e', '#161412')]
GLS = [hx(c) for c in ('#7fa6c4', '#3f5f7a', '#2a4258', '#1c2d3e')]
RED = [hx(c) for c in ('#f27a5a', '#e0453a', '#b8322c', '#82221f')]     # jerry cans / tail lamps
WOOD = [hx(c) for c in ('#c98a4e', '#a5683a', '#7d4a2a', '#55301f')]
DIRT = [hx(c) for c in ('#f2c25a', '#e0a440', '#c4832e', '#9a5f24')]
LAMP_H, LAMP_B, AMBER = hx('#fff6cf'), hx('#ffe08a'), hx('#ffb347')
BAYER = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))


def bayer(i, j):
    return BAYER[j & 3][i & 3] / 16.0


def hsh(i, j):
    return (((i * 73856093) ^ (j * 19349663)) & 0xffff) / 65535.0


def P(v):
    """metres -> integer pixel index (same grid in every region)."""
    return int(math.floor(v * PX + 1e-6))


# ------------------------------------------------------------------ atlas
class Atlas:
    KIND_AXES = {'side': ('y', 'z'), 'top': ('y', 'x'), 'front': ('x', 'z'), 'rear': ('-x', 'z'),
                 'inx': ('y', 'z'), 'iny': ('x', 'z')}

    def __init__(self, name, xr, yr, zr, painter, rows, inner_z=None, fixed=None):
        self.name, self.painter = name, painter
        rng = {'x': xr, 'y': yr, 'z': zr, '-x': (-xr[1], -xr[0])}
        self.R = {}
        oy = 0
        W = 0
        for row in rows:
            ox, rh = 0, 0
            for k in row:
                if k == 'bottom':
                    w = h = 4
                    self.R[k] = dict(ox=ox, oy=oy, w=w, h=h)
                else:
                    a, b = self.KIND_AXES[k]
                    ar = rng[a]
                    br = inner_z if (k in ('inx', 'iny') and inner_z) else rng[b]
                    a0, b0 = math.floor(ar[0] * PX) / PX, math.floor(br[0] * PX) / PX
                    w, h = int(math.ceil((ar[1] - a0) * PX)), int(math.ceil((br[1] - b0) * PX))
                    self.R[k] = dict(ox=ox, oy=oy, w=w, h=h, a=a, b=b, a0=a0, b0=b0)
                ox += w + 2
                rh = max(rh, h)
            W = max(W, ox)
            oy += rh + 2
        p2 = lambda n: 1 << max(5, (n - 1).bit_length())
        self.W, self.H = (fixed or (p2(W), max(16, (oy + 15) // 16 * 16)))
        assert W <= self.W and oy <= self.H, (name, W, oy)
        self.img = np.zeros((self.H, self.W, 3), np.uint8)
        self.img[:, :] = (255, 0, 255)

    def paint(self):
        for k, r in self.R.items():
            for j in range(r['h']):
                for i in range(r['w']):
                    if k == 'bottom':
                        c = self.painter(k, None, None, None)
                    else:
                        c = {'x': None, 'y': None, 'z': None}
                        av = r['a0'] + (i + 0.5) / PX
                        bv = r['b0'] + (j + 0.5) / PX
                        if r['a'] == '-x':
                            c['x'] = -av
                        else:
                            c[r['a']] = av
                        c[r['b']] = bv
                        c = self.painter(k, c['x'], c['y'], c['z'])
                    self.img[r['oy'] + j, r['ox'] + i] = c
        # bleed region edges into the gutters so mipmaps never pick up the fill colour
        img = self.img.astype(np.int32)
        empty = np.all(img == (255, 0, 255), axis=2)
        for _ in range(3):
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                src = np.roll(img, (dy, dx), axis=(0, 1))
                se = np.roll(empty, (dy, dx), axis=(0, 1))
                take = empty & ~se
                img[take] = src[take]
                empty = empty & ~take
        img[empty] = self.painter('bottom', None, None, None)
        self.img = img.astype(np.uint8)
        return self

    def uv(self, kind, co):
        r = self.R[kind]
        if kind == 'bottom':
            return ((r['ox'] + 2) / self.W, (r['oy'] + 2) / self.H)
        g = {'x': co[0], 'y': co[1], 'z': co[2], '-x': -co[0]}
        a = min(max(g[r['a']], r['a0'] + 0.01 / PX), r['a0'] + (r['w'] - 0.01) / PX)
        b = min(max(g[r['b']], r['b0'] + 0.01 / PX), r['b0'] + (r['h'] - 0.01) / PX)
        return ((r['ox'] + (a - r['a0']) * PX) / self.W, (r['oy'] + (b - r['b0']) * PX) / self.H)


# ------------------------------------------------------------------ olive paint
def _band(iz):
    """Side ramp by pixel row: lit shoulder, base, the mid-body crease, darker lower body."""
    if iz >= P(Z_BELT - 0.05):
        return OLV[0]
    if iz == P(Z_CREASE):
        return OLV[0]
    if iz == P(Z_CREASE) - 1:
        return OLV[2]
    if iz >= P(0.90):
        return OLV[1]
    if iz >= P(0.84):
        return None   # dither row
    if iz >= P(0.76):
        return OLV[2]
    return OLV[3]


def _mud(iy, iz, z, c):
    """Dried mud splats on the lower panels: clumps that thin out upwards (no per-pixel noise)."""
    f = (0.97 - z) / 0.27
    if f <= 0:
        return c
    cy, cz = iy // 3, iz // 2
    if hsh(cy * 3 + 7, cz * 5 + 1) < 0.42 * f:
        if hsh(iy * 11 + 3, iz * 7 + 5) < 0.75:
            return WOOD[2] if hsh(cy, cz) < 0.5 or z < 0.79 else DIRT[3]
    return c


def paint_olive(kind, x, y, z):
    O = OLV
    if kind == 'bottom':
        return O[3]
    if kind in ('inx', 'iny'):
        iz = P(z)
        if iz >= P(Z_BED_TOP) - 1:
            return O[1]
        if iz <= P(Z_FLOOR) + 1:
            return O[3]
        a = P(y) if kind == 'inx' else P(x)
        return O[3] if a % 8 == 0 else O[2]
    if kind == 'side':
        return _olive_side(y, z)
    if kind == 'top':
        return _olive_top(x, y)
    if kind == 'front':
        return _olive_front(x, z)
    if kind == 'rear':
        return _olive_rear(x, z)
    return O[1]


def _olive_side(y, z):
    O = OLV
    iy, iz = P(y), P(z)
    cab = Y_CAB - 0.02 <= y <= Y_COWL + 0.06
    if cab and z >= Z_BELT - 0.004:
        for poly in SIDE_WINDOWS:
            d = poly_sd(poly, y, z)
            if d < 1.6 / PX:
                return O[3]                         # window trim (glass sits over the inside)
        if iz >= P(gh_side_top(y)) - 1:
            return O[0]                             # roof edge catches the light
        if iz == P(Z_BELT) and y < Y_COWL - 0.02:
            return O[2]                             # belt moulding shadow
        return O[1]
    c = _band(iz)
    if c is None:
        c = O[1] if (iy + iz) % 2 else O[2]
    if y > Y_COWL + 0.02 and iz > P(Z_CREASE):
        top = P(hood_z(y))                                  # front fender: bands follow the sloping hood line
        c = O[0] if iz >= top - 1 else (O[2] if iz == top - 3 else O[1])
    bed = y < Y_BED_F + 0.02
    # door shut lines + door bottoms
    if not bed and P(Z_DOOR_BOT) <= iz < P(Z_BELT):
        for yd in DOOR_Y:
            if iy == P(yd):
                return O[3]
        if iy == P(DOOR_Y[0]) + 1 and iz < P(Z_BELT - 0.06):
            return O[2]
    if not bed and iz == P(Z_DOOR_BOT) and DOOR_Y[2] <= y <= DOOR_Y[0]:
        return O[3]
    # door handles (dark pull + lit lip under it)
    for y0, y1 in ((0.115, 0.235), (-0.505, -0.385)):
        if y0 <= y <= y1:
            if iz == P(HANDLE_Z):
                return O[3]
            if iz == P(HANDLE_Z) - 1:
                return O[0]
    # front fender: amber side marker
    if 2.24 <= y <= 2.33 and iz in (P(1.07), P(1.07) + 1):
        return AMBER
    # bed: fuel door, rail highlight, tail end shadow
    if bed:
        if -1.12 <= y <= -0.98 and P(1.24) <= iz <= P(1.36):
            if iy in (P(-1.12), P(-0.98)) or iz in (P(1.24), P(1.36)):
                return O[3]
            return O[1]
        if iz >= P(Z_BED_TOP) - 2:
            return O[0]
        if iy <= P(Y_BED_R) + 1:
            return O[2]
    return _mud(iy, iz, z, c)


def _olive_top(x, y):
    O = OLV
    ix, iy = P(x), P(y)
    ax = abs(x)
    if y > Y_COWL + 0.035:
        if y > Y_NOSE - 0.05:
            return O[1]
        if ax < 0.245 and 1.42 <= y <= 1.89:               # hood scoop
            if ax > 0.215:
                return O[2]
            return O[0] if y > 1.83 else O[1]
        if ax > 0.70:
            return O[1]
        if ix in (P(0.36), P(-0.36) - 1) and y < Y_NOSE - 0.1:
            return O[1]                                     # hood creases
        if iy == P(Y_NOSE) - 3:
            return O[2]                                     # hood front shut line
        return O[0]
    if y > Y_COWL - 0.02:
        return O[3]                                         # cowl / wiper well
    if y >= Y_CAB - 0.01:
        if ax > gh_w(Z_BELT) - 0.01:
            return O[1]                                     # belt ledge
        if y > Y_ROOF_F + 0.08:
            return O[3] if ax < ws_half(y) + 0.04 else O[1]  # windscreen frame / A-pillars
        if ax > gh_flat_half(y) - 0.02:
            return O[1]
        if ix in (P(0.56), P(-0.56) - 1):
            return O[1]                                     # roof ribs
        return O[0]
    if y > Y_BED_F + 0.005:
        return O[3]                                         # cab / bed gap
    if ax >= BED_IN - 0.006:
        return O[0]                                         # bed rails
    if y < Y_BED_R + 0.05:
        return O[0]                                         # tailgate top
    m = ix % 6
    return O[1] if m == 0 else (O[3] if m == 1 else O[2])  # ribbed bed floor


def _olive_front(x, z):
    O = OLV
    iz = P(z)
    ax = abs(x)
    if z > Z_BELT + 0.005:
        return O[3] if ax < ws_half(windscreen_y(z)) + 0.04 else O[1]
    if iz >= P(Z_HOOD_NOSE - 0.12):
        return O[0]
    if z < 0.98:
        return O[2]
    return O[1]


def _olive_rear(x, z):
    O = OLV
    ix, iz = P(x), P(z)
    ax = abs(x)
    if z > Z_BELT + 0.01:                                   # cab back wall
        hw, z0, z1 = REAR_WINDOW
        if ax < hw + 1.6 / PX and z0 - 1.6 / PX < z < z1 + 1.6 / PX:
            return O[3]
        return O[0] if iz >= P(gh_top(Y_CAB)) - 3 else O[1]
    if ax >= TAILGATE_X:
        return O[1]
    if iz >= P(Z_BED_TOP) - 2:
        return O[0]
    if abs(ix + 0.5) == P(TAILGATE_X - 0.035) + 0.5 and P(0.79) <= iz <= P(Z_BED_TOP - 0.05):
        return O[3]
    if iz == P(0.79) and ax < TAILGATE_X - 0.035:
        return O[3]
    if ax < 0.10 and iz == P(HANDLE_Z + 0.02):
        return O[3]
    if ax < 0.10 and iz == P(HANDLE_Z + 0.02) - 1:
        return O[0]
    c = _band(iz)
    if c is None:
        c = O[1] if (ix + iz) % 2 else O[2]
    return _mud(ix, iz, z, c)


# ------------------------------------------------------------------ black trim (bumpers, flares, rack...)
def _hub_dist(y, z):
    return min(math.hypot(y - FY, z - R), math.hypot(y - RY, z - R))


def paint_trim(kind, x, y, z):
    K = BLK
    if kind == 'bottom':
        return K[3]
    if kind == 'top':
        ax = abs(x)
        if SHELF_X[0] < x < SHELF_X[1] and RACK_Y[1] < y < RACK_Y[0]:
            return K[3] if P(y) % 3 == 0 else K[1]           # rack shelf grate
        for (a0, a1, b0, b1) in ((CASE_A[0], CASE_A[1], CASE_A[2], CASE_A[3]), (CASE_B[0], CASE_B[1], CASE_B[2], CASE_B[3])):
            if a0 < x < a1 and b0 < y < b1:
                cx, cy = (a0 + a1) / 2, (b0 + b1) / 2
                if abs(x - cx) < 0.09 and P(y) == P(cy):
                    return K[3]                              # case handle
                return K[0]
        if y > 2.2 and P(y) % 5 == 0 and ax < 0.7:
            return K[1]                                      # bumper top plate seams
        return K[0]
    if kind == 'side':
        iy, iz = P(y), P(z)
        # rock sliders
        if 0.575 < z < 0.69 and -0.68 < y < 0.97:
            if iz >= P(0.665):
                return K[0]
            if iz <= P(0.595):
                return K[3]
            if iy % 13 == 0:
                return K[0]
            return K[1]
        d = _hub_dist(y, z)
        if AR - 0.03 < d < AR + 0.12 and z > 0.6:
            if d > AR + 0.085:
                return K[0]
            if d < AR + 0.005:
                return K[3]
            a = math.atan2(y - (FY if y > 0 else RY), z - R)
            if abs(d - (AR + 0.05)) < 0.6 / PX and (round(math.degrees(a)) % 24) in (0, 1):
                return K[0]                                  # flare bolts
            return K[1]
        if y > 2.2 or y < -2.55:
            if iz in (P(0.935), P(0.795)) and y > 2.2 or (y < -2.55 and iz == P(0.79)):
                return K[0]
            if iz <= P(0.64) or (y < -2.55 and iz <= P(0.60)):
                return K[3]
            return K[1]
        if z < 0.72 and -2.6 < y < 2.4:
            return K[2]                                      # frame rails
        for (a0, a1, b0, b1, c0, c1) in (CASE_A, CASE_B):
            if b0 < y < b1 and c0 < z < c1:
                if iz == P(c1) - 1:
                    return K[0]
                if iz == P((c0 + c1) / 2) and P(y) % 4 == 1:
                    return K[0]                              # latches
                return K[1]
        return K[1]
    if kind == 'front':
        ix, iz = P(x), P(z)
        ax = abs(x)
        gw, g0, g1 = GRILLE
        if ax < gw and g0 < z < g1:
            if iz >= P(g1) - 1 or ax > gw - 1.0 / PX:
                return K[0]
            if iz <= P(g0):
                return K[3]
            m = (iz - P(g0)) % 3
            return (K[3], K[1], K[0])[m]                     # slats with dark gaps
        if 0.60 < z < 0.95 and ax < 0.95:                     # front bumper face
            if iz >= P(0.935) - 1:
                return K[0]
            if iz <= P(0.64):
                return K[3]
            if 0.80 < ax < 0.885 and P(0.835) <= iz <= P(0.885):
                return AMBER
            if ax < 0.13 and P(0.70) <= iz <= P(0.78):
                return K[0] if iz == P(0.74) else K[3]       # winch fairlead
            if abs(ix + 0.5) == P(0.56) + 0.5:
                return K[3]                                  # plate seams
            if iz == P(0.70) and abs(ix + 0.5) in (P(0.68) + 0.5, P(0.42) + 0.5):
                return K[0]                                  # bolt heads
            return K[1]
        if hood_z(1.885) - 0.03 < z < hood_z(1.885) + 0.09 and ax < 0.25:
            return K[3] if iz < P(hood_z(1.885) + 0.04) else K[2]   # hood scoop mouth
        return K[1]
    if kind == 'rear':
        ix, iz = P(x), P(z)
        ax = abs(x)
        if 0.57 < z < 0.81 and ax < 0.9:
            if iz >= P(0.79):
                return K[0]
            if iz <= P(0.595):
                return K[3]
            if ax < 0.06 and P(0.62) <= iz <= P(0.68):
                return K[3]                                  # hitch receiver
            if ax < 0.17 and P(0.665) <= iz <= P(0.765):    # blank plate (no text)
                if ax > 0.17 - 1.0 / PX or iz in (P(0.665), P(0.765)):
                    return K[3]
                return hx('#b7aa98') if iz > P(0.735) else hx('#948775')
            if 0.80 < ax < 0.86 and iz == P(0.70):
                return (255, 179, 71)
            return K[1]
        return K[1]
    return K[1]


# ------------------------------------------------------------------ glass
def paint_glass(kind, x, y, z):
    G = GLS
    if kind == 'bottom':
        return G[3]
    if kind == 'side':
        a, b = P(y), P(z)
        lo = P(WIN_Z0)
    elif kind in ('front', 'rear'):
        a, b = P(x), P(z)
        lo = P(WS_Z0 + 0.04 if kind == 'front' else REAR_WINDOW[1])
        for xc in (0.33, -0.33):                             # headrests seen through the glass
            dx = (x - xc) / 0.09
            if abs(dx) < 1 and Z_BELT + 0.10 < z < Z_BELT + 0.28 + 0.05 * math.sqrt(max(0.0, 1 - dx * dx)):
                return G[3]
    else:
        return G[1]
    m = (a + b) % 26
    if m in (0, 1, 2) or m == 5:
        return G[0]                                          # two diagonal sky glints
    if b <= lo + 1:
        return G[3] if b <= lo else G[2]                     # darker lower edge
    if b <= lo + 4:
        return G[2]
    return G[1]


# ------------------------------------------------------------------ lamps (emissive)
def paint_lamp(kind, x, y, z):
    if kind != 'front':
        return LAMP_B
    ax = abs(x)
    for cx in (FOG_X, -FOG_X):
        d = math.hypot(x - cx, z - FOG_Z)
        if d < FOG_R + 0.01:
            if d > FOG_R - 0.022:
                return AMBER
            if (x - cx) * (1 if cx < 0 else -1) > -0.01 and z - FOG_Z > 0.005 and d < 0.05:
                return LAMP_H
            return LAMP_B
    x0, x1, z0, z1 = HEAD
    if x0 - 0.01 <= ax <= x1 + 0.01:
        if ax > x1 - 0.075:
            return AMBER
        d = math.hypot(ax - 0.60, z - (z0 + z1) / 2 - 0.005)
        if d < 0.055:
            return LAMP_H if d < 0.03 else LAMP_B
        if P(z) <= P(z0) + 1:
            return LAMP_B
        return LAMP_H
    return LAMP_B


# ------------------------------------------------------------------ tail lights (game makes them glow on braking)
def paint_tail(kind, x, y, z):
    T = RED
    if kind != 'rear':
        return T[2] if kind == 'side' else T[0]
    iz = P(z)
    z0, z1 = TAIL_Z
    if z > z1 + 0.2:                                         # cab-top third brake light
        return T[0] if iz >= P(gh_top(Y_CAB)) - 2 else T[1]
    if iz >= P(z1) - 2:
        return T[0]
    if iz >= P(z0 + 0.12):
        return T[1] if (P(x) + iz) % 4 else T[0]
    if iz == P(z0 + 0.12) - 1:
        return T[3]
    if iz >= P(z0) + 1:
        return LAMP_H                                        # reverse lamp
    return T[2]


# ------------------------------------------------------------------ cargo (red jerry cans, canvas bag)
def paint_cargo(kind, x, y, z):
    C, Wd = RED, WOOD
    bx0, bx1, by, br = BAG
    if kind == 'bottom':
        return C[3]
    ztop = Z_FLOOR + 2 * br + 0.03
    if kind == 'top':
        in_bag = abs(y - by) < br + 0.03
    elif kind == 'side':
        in_bag = abs(y - by) < br + 0.03 and z < ztop
    else:
        in_bag = bx0 - 0.01 < x < bx1 + 0.01 and z < ztop
    if in_bag:
        if kind == 'side':                                   # bag ends
            d = math.hypot(y - by, z - (Z_FLOOR + br))
            return Wd[3] if d > br - 1.2 / PX else Wd[2]
        if x is not None and any(abs(x - s) < 0.03 for s in (bx0 + 0.15, bx1 - 0.15)):
            return Wd[3]                                     # straps
        if kind == 'top':
            return Wd[0]
        return Wd[1] if P(z) > P(Z_FLOOR + br * 0.7) else Wd[2]
    if kind == 'top':
        return C[0]
    if kind == 'side':                                       # the can's big face, with the X emboss
        yc, hy = (CAN_Y[0] + CAN_Y[1]) / 2, (CAN_Y[1] - CAN_Y[0]) / 2
        zc, hz = (CAN_Z[0] + CAN_Z[1]) / 2, (CAN_Z[1] - CAN_Z[0]) / 2
        u, v = (y - yc) / hy, (z - zc) / hz
        if P(z) >= P(CAN_Z[1]) - 1:
            return C[0]
        if abs(u) > 0.80 or abs(v) > 0.86:
            return C[2] if P(z) > P(CAN_Z[0]) + 1 else C[3]
        e = abs(abs(u) * hy) - abs(abs(v) * hz) * (hy / hz)
        if abs(e) < 0.6 / PX:
            return C[0]
        if -1.6 / PX < e < -0.6 / PX:
            return C[2]
        return C[1]
    iz = P(z)
    if iz >= P(CAN_Z[1]) - 1:
        return C[0]
    if iz <= P(CAN_Z[0]) + 1:
        return C[3]
    return C[1] if P(x) % 5 else C[2]


# ------------------------------------------------------------------ wheel (tyre + rim), painted in UV space
WHEEL_W, WHEEL_H = 128, 64
TREAD_U = 120                     # pixels around the circumference (4 per angular segment, 30 segments)
REG_TREAD = (0, 0, 128, 11)       # ox, oy, w, h   v: x from -0.165
REG_SIDE = (0, 13, 128, 8)        # v: radius from 0.235
REG_LUGSIDE = (0, 23)
REG_GROOVE = (6, 23)
REG_RIMBACK = (12, 23)
REG_RIM = (20, 23, 20, 20)        # planar y,z from -0.3125


def paint_wheel():
    K = BLK
    img = np.zeros((WHEEL_H, WHEEL_W, 3), np.uint8)
    img[:, :] = K[2]
    ox, oy, w, h = REG_TREAD
    for j in range(h):
        x = -0.165 + (j + 0.5) / PX
        for i in range(w):
            c = (i % TREAD_U) % 4
            if abs(x) > 0.118:
                col = K[2] if c != 0 else K[1]               # shoulder block faces
            elif c in (0, 1) and j not in (2, 8):
                col = K[0]                                   # dusty block tops catch the light
            elif c == 3:
                col = K[2]
            elif j in (2, 8) and c == 1:
                col = K[2]                                   # sipes
            else:
                col = K[1]
            img[oy + j, ox + i] = col
    ox, oy, w, h = REG_SIDE
    for j in range(h):
        r = 0.235 + (j + 0.5) / PX
        for i in range(w):
            seg = (i % TREAD_U) // 4
            if r < 0.262:
                col = K[3]                                   # bead shadow against the rim
            elif r > 0.395:
                col = K[0] if seg % 2 == 0 else K[2]         # sidewall lugs
            elif abs(r - 0.335) < 0.5 / PX:
                col = K[1]                                   # moulded ring
            else:
                col = K[2]
            img[oy + j, ox + i] = col
    for (rx, ry), col in ((REG_LUGSIDE, K[2]), (REG_GROOVE, K[3]), (REG_RIMBACK, K[3])):
        img[ry:ry + 4, rx:rx + 4] = col
    ox, oy, w, h = REG_RIM
    for j in range(h):
        zz = -0.3125 + (j + 0.5) / PX
        for i in range(w):
            yy = -0.3125 + (i + 0.5) / PX
            r = math.hypot(yy, zz)
            a = math.atan2(zz, yy) % (2 * math.pi / 6)
            sp = min(a, 2 * math.pi / 6 - a)
            if r > 0.212:
                col = K[0] if r < 0.238 else K[1]            # lip
            elif r > 0.185:
                col = K[3] if sp > 0.16 else K[1]
            elif r > 0.090:
                col = K[3] if sp > 0.20 else (K[0] if sp < 0.06 else K[1])   # six spokes, dark windows
            elif r > 0.04:
                n = math.atan2(zz, yy) % (2 * math.pi / 5)
                col = K[0] if (abs(r - 0.068) < 0.018 and min(n, 2 * math.pi / 5 - n) < 0.25) else K[2]
            else:
                col = K[0] if r < 0.022 else K[1]
            img[oy + j, ox + i] = col
    return img


# ------------------------------------------------------------------ preview ground (dirt, tiled)
def paint_dirt(n=64):
    D = DIRT
    img = np.zeros((n, n, 3), np.uint8)
    for j in range(n):
        for i in range(n):
            c = D[1]
            h1 = hsh(i // 4 + 11, j // 3 + 5)
            if h1 < 0.07 and hsh(i, j) < 0.8:
                c = D[2]
            elif h1 > 0.95 and hsh(i, j) < 0.7:
                c = D[0]
            img[j, i] = c
    # a few pebbles: lit top-left pixel, dark bottom-right
    for (pi, pj) in ((9, 12), (40, 7), (25, 44), (52, 30), (13, 55), (47, 51)):
        img[pj, pi] = D[0]
        img[pj, (pi + 1) % n] = D[2]
        img[(pj - 1) % n, (pi + 1) % n] = D[3]
    return img
