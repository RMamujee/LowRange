# Shape constants and profile functions for the olive pickup (`taco`), shared by the geometry
# builder (build_taco.py) and the pixel painter (taco_paint.py) so panel lines land on the geometry.
# World space while building: metres, +X right, +Y forward, +Z up, ground at z = 0.
import math

# ---- physics targets (docs/MODELING_SPEC.md, row `taco`) ----
R, TW = 0.465, 0.32            # tyre radius / width
TRACK, WB = 1.62, 3.24
HX, FY, RY = TRACK / 2, WB / 2, -WB / 2
CHASSIS_Z, FRAME_Z = 0.83, 0.53
BUMP = 0.12
AR = R + BUMP + 0.06 + 0.005    # arch radius about the hub: arch top 1.115 clears full bump + 6 cm

PX = 32.0                       # texture pixels per metre

# ---- body layout ----
Z_SILL, Z_BED_BOT = 0.68, 0.70
Z_BELT, Z_HOOD_NOSE = 1.49, 1.405
Z_ROOF, ROOF_CROWN = 2.12, 0.02
Z_GB = 1.46                      # greenhouse base (sunk into the belt)
Y_NOSE, Y_COWL = 2.42, 1.10
Y_ROOF_F, Y_ROOF_R, Y_CAB = 0.52, -0.56, -0.70
Y_BED_F, Y_BED_R = -0.77, -2.60
Z_BED_TOP, Z_FLOOR, BED_IN = 1.52, 1.02, 0.79
NOSE_R = 0.05
DOOR_Y = (0.985, 0.02, -0.64)    # front door leading edge, B-pillar shut line, rear door trailing edge
Z_DOOR_BOT = 0.73
Z_CREASE = 1.15
TAILGATE_X = 0.735
HANDLE_Z = 1.355
FOG_X, FOG_Z, FOG_R = 0.27, 0.925, 0.09
HEAD = (0.49, 0.83, 1.12, 1.29)   # headlight |x| range and z range
GRILLE = (0.47, 0.99, 1.32)       # half width, z0, z1
TAIL_Z = (1.06, 1.45)             # tail lamp z range


def side_w(z):
    """Half width of the lower body / bed sides at height z (slight barrel bulge)."""
    return 0.862 - 0.022 * ((z - 1.10) / 0.36) ** 2


def arch_z(y, yc, r=AR):
    d = y - yc
    return R + math.sqrt(r * r - d * d) if abs(d) < r else None


def bottom_z(y, zs):
    z = zs
    for yc in (FY, RY):
        a = arch_z(y, yc)
        if a is not None and a > z:
            z = a
    return z


def arch_stations(yc, zs, n=17):
    t0 = math.acos((zs - R) / AR)
    return [yc + AR * math.sin(-t0 + 2 * t0 * i / (n - 1)) for i in range(n)]


def hood_z(y):
    if y <= Y_COWL:
        return Z_BELT
    z = Z_BELT - (y - Y_COWL) / (Y_NOSE - Y_COWL) * (Z_BELT - Z_HOOD_NOSE)
    d = y - (Y_NOSE - NOSE_R)
    if d > 0:
        z -= NOSE_R - math.sqrt(max(0.0, NOSE_R ** 2 - d * d))
    return z


def nose_scale(y, r=0.06, w=0.86):
    d = y - (Y_NOSE - r)
    if d <= 0:
        return 1.0
    return (w - r + math.sqrt(max(0.0, r * r - d * d))) / w


# ---- greenhouse (cab glass house) ----
def _chaikin(pts, it):
    for _ in range(it):
        out = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        out.append(pts[-1])
        pts = out
    return pts


def _resample(pts, step):
    out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(d / step)))
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    # drop near-duplicates
    clean = [out[0]]
    for p in out[1:]:
        if abs(p[0] - clean[-1][0]) > 0.012:
            clean.append(p)
    return clean


# side-view roof line, front (cowl) to back; y decreasing
GH_PROFILE = _resample(_chaikin([(Y_COWL + 0.02, Z_GB + 0.012), (Y_ROOF_F, Z_ROOF), (Y_ROOF_R, Z_ROOF),
                                 (Y_CAB, Z_ROOF - 0.06)], 3), 0.2)


def gh_top(y):
    p = GH_PROFILE
    if y >= p[0][0]:
        return p[0][1]
    for a, b in zip(p[:-1], p[1:]):
        if b[0] <= y <= a[0]:
            t = (a[0] - y) / (a[0] - b[0])
            return a[1] + (b[1] - a[1]) * t
    return p[-1][1]


def gh_w(z):
    return 0.80 - (z - Z_GB) * 0.17


def gh_rs(zt):
    return min(0.09, max(0.002, (zt - Z_GB) * 0.45))


def gh_side_top(y):
    zt = gh_top(y)
    return zt - gh_rs(zt)


def gh_flat_half(y):
    """Half width of the flat top (windscreen/roof) between the rounded shoulders."""
    zt = gh_top(y)
    rs = gh_rs(zt)
    return gh_w(zt - rs) - rs


def crown(x, y):
    zt = gh_top(y)
    cx = gh_flat_half(y)
    k = min(1.0, (zt - Z_GB) / 0.5)
    t = min(1.0, abs(x) / max(cx, 1e-3))
    return ROOF_CROWN * k * (1 - t * t)


def a_line_y(z):
    """y of the A-pillar (top of the greenhouse side face) at height z."""
    y = Y_COWL
    while y > Y_ROOF_F - 0.2:
        if gh_side_top(y) >= z:
            return y
        y -= 0.004
    return y


def windscreen_y(z):
    """y on the windscreen centreline at height z."""
    y = Y_COWL + 0.02
    while y > Y_ROOF_F - 0.2:
        if gh_top(y) >= z:
            return y
        y -= 0.003
    return y


WIN_Z0, WIN_Z1 = 1.54, 1.98
WS_Z0, WS_Z1 = 1.545, 2.03      # windscreen glass bottom / top heights


def _ccw(poly):
    a = 0.0
    for (y0, z0), (y1, z1) in zip(poly, poly[1:] + poly[:1]):
        a += y0 * z1 - y1 * z0
    return poly if a > 0 else poly[::-1]


SIDE_WINDOWS = [
    _ccw([(a_line_y(WIN_Z0) - 0.05, WIN_Z0), (0.075, WIN_Z0), (0.075, WIN_Z1), (a_line_y(WIN_Z1) - 0.05, WIN_Z1)]),
    _ccw([(-0.035, WIN_Z0), (-0.50, WIN_Z0), (-0.47, WIN_Z1), (-0.035, WIN_Z1)]),
]
REAR_WINDOW = (0.50, 1.63, 1.95)   # half width, z0, z1


def ws_half(y):
    return gh_flat_half(y) - 0.055


def poly_sd(poly, y, z):
    """Signed distance (negative inside) to a convex CCW polygon in (y, z)."""
    best = -1e9
    for (y0, z0), (y1, z1) in zip(poly, poly[1:] + poly[:1]):
        dy, dz = y1 - y0, z1 - z0
        L = math.hypot(dy, dz)
        ny, nz = dz / L, -dy / L
        best = max(best, (y - y0) * ny + (z - z0) * nz)
    return best


# ---- bed rack + cargo layout ----
RACK_X = 0.76
RACK_Y = (-0.87, -1.52)
RACK_TOP = 2.06
SHELF_Z = 1.62
CANS = [(0.30, 0.47), (0.51, 0.68)]   # x ranges
CAN_Y = (-1.26, -0.90)
CAN_Z = (SHELF_Z, 2.08)
CASE_A = (0.06, 0.70, -1.52, -1.30, SHELF_Z, 1.86)      # x0 x1 y0 y1 z0 z1 (on the shelf, front)
CASE_B = (0.06, 0.56, -2.36, -1.96, Z_FLOOR, 1.31)        # on the bed floor, rear right
BAG = (-0.66, -0.06, -2.17, 0.145)                         # x0 x1 y centre radius (z centre = floor + r)
SPARE = (-0.18, -1.32, Z_FLOOR + R)                         # upright, axis X, face to -X
SHELF_X = (0.0, RACK_X)
