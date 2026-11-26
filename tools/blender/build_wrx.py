# LowRange: blue rally sedan ("wrx"). Run headless:
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_wrx.py
# Builds the model from lofted profiles, paints its pixel textures in code (32 px/m), exports
# public/models/vehicles/wrx.glb (docs/MODELING_SPEC.md), saves tools/blender/out/wrx.blend and renders
# toon + outline + low-res previews to docs/previews/wrx_*.png (docs/ART_STYLE.md).
# Blender axes: +X right, +Y forward, +Z up; ground at z = 0 while building.
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib  # noqa: E402
import wrx_geo  # noqa: E402
importlib.reload(wrx_geo)
from wrx_geo import (TEX, Atlas, Curve, Mesh, cap, hexrgb, lathe, loft, paint, rbox,  # noqa: E402
                     smoothstep, swatch_uv)

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, 'out')
GLB = os.path.join(ROOT, 'public', 'models', 'vehicles', 'wrx.glb')
PREV = os.path.join(ROOT, 'docs', 'previews')
for d in (OUT, os.path.dirname(GLB), PREV):
    os.makedirs(d, exist_ok=True)

# ---------------------------------------------------------------- spec (MODELING_SPEC 2d, wrx row)
R_TYRE, W_TYRE = 0.33, 0.21
TRACK, WB = 1.52, 2.62
CZ = 0.59                       # chassis centre above ground (Body origin)
FA, RA = WB / 2, -WB / 2        # front / rear axle y
HX = TRACK / 2

# ---------------------------------------------------------------- palette (ART_STYLE, sRGB)
BH, BB, BS, BD = map(hexrgb, ('#4f7fe8', '#2f58c8', '#2140a0', '#172d74'))   # rally blue
GH, GB, GS, GD = map(hexrgb, ('#ffd866', '#e6b23a', '#b9862a', '#86601f'))   # gold
KH, KB, KS, KD = map(hexrgb, ('#4a4640', '#33302c', '#24211e', '#161412'))   # black trim / tyre
LH, LB, LS, LD = map(hexrgb, ('#7fa6c4', '#3f5f7a', '#2a4258', '#1c2d3e'))   # glass
W1, W2, AMB = map(hexrgb, ('#fff6cf', '#ffe08a', '#ffb347'))                  # lamps
TRH, TR, TRS, TRD = map(hexrgb, ('#ff8a6a', '#e0453a', '#a82c2c', '#6e1c22'))  # tail red ramp
CR, CRS = hexrgb('#f6eed8'), hexrgb('#c9bd9c')                                  # blank plates
PX = 1.0 / TEX                  # one texel in metres

# ---------------------------------------------------------------- body proportions
Y_F, Y_R = 2.28, -2.12          # bumper tips (4.40 m)
R_END_F, R_END_R = 0.15, 0.13   # plan/side rounding at the nose and tail
Z_SILL = 0.25                   # body bottom (sills)
ARCH_Z, ARCH_R = 0.36, 0.47     # wheel-arch cut: top at 0.83 = tyre top + bump 0.11 + 0.06
N_TOP, N_BOT, SHOULDER = 4.6, 5.0, 0.66
M_LOW = 28

ztop = Curve([(-2.12, 1.0), (-1.95, 1.05), (-1.6, 1.075), (-1.2, 1.08), (0.0, 1.07), (0.99, 1.02),
              (1.4, 0.955), (1.8, 0.89), (2.1, 0.835), (2.28, 0.805)])


def half_w(y):
    a = 0.82
    if y > 1.70:
        a -= 0.055 * ((y - 1.70) / (Y_F - 1.70)) ** 2
    if y < -1.65:
        a -= 0.07 * ((-1.65 - y) / (-1.65 - Y_R)) ** 2
    return a


def bulge(y):   # blistered arches
    return 0.05 * (math.exp(-((y - FA) / 0.62) ** 4) + math.exp(-((y - RA) / 0.62) ** 4))


def zbot(y):
    return Z_SILL - 0.06 * smoothstep(1.75, 2.15, y)


def _theta_samples():
    """Right-half angles giving equal arc-length spacing on the mid-car section."""
    th = np.linspace(math.pi / 2, -math.pi / 2, 4001)
    pts = np.array([_low_pt(t, 0.82, 0.25 + SHOULDER * 0.82, 1.07, 0.25, 0.0) for t in th])
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    want = np.linspace(0, s[-1], M_LOW // 2 + 1)
    return np.interp(want, s, th)


def _low_pt(th, a, zc, zt, zb, bl):
    c, s = math.cos(th), math.sin(th)
    if s >= 0:
        x = a * abs(c) ** (2 / N_TOP)
        z = zc + (zt - zc) * abs(s) ** (2 / N_TOP)
    else:
        x = a * abs(c) ** (2 / N_BOT)
        z = zc - (zc - zb) * abs(s) ** (2 / N_BOT)
    w = 1 - smoothstep(zc, zc + 0.14, z)
    x += bl * w * (x / a if a > 0 else 0)
    return (x, z)


TH = _theta_samples()


def lower_ring(y, ins=0.0):
    a = half_w(y) - ins
    zt0, zb0 = ztop(y), zbot(y)
    zt, zb = zt0 - ins * 0.9, zb0 + ins * 0.2
    zc = min(max(zb0 + SHOULDER * (zt0 - zb0), zb + 0.02), zt - 0.02)
    bl = bulge(y)
    right = [_low_pt(t, a, zc, zt, zb, bl) for t in TH]          # top centre .. bottom centre
    ring = [(x, y, z) for (x, z) in right] + [(-x, y, z) for (x, z) in reversed(right[1:-1])]
    return ring


def lower_top_at(y, x):
    """z of the lower body's upper surface at lateral offset x."""
    right = [_low_pt(t, half_w(y), zbot(y) + SHOULDER * (ztop(y) - zbot(y)), ztop(y), zbot(y), bulge(y))
             for t in TH[:M_LOW // 4 + 1]]
    xs = [p[0] for p in right]
    zs = [p[1] for p in right]
    return float(np.interp(x, xs, zs))


# cabin / greenhouse
Y_WS, Y_RF, Y_RR, Y_RS = 1.00, 0.28, -0.94, -1.47
WB_C, WR_C = 0.75, 0.645
roof = Curve([(1.02, 1.02), (0.86, 1.16), (0.64, 1.35), (0.44, 1.48), (0.27, 1.545), (0.0, 1.57),
              (-0.6, 1.565), (-0.90, 1.535), (-1.06, 1.45), (-1.24, 1.28), (-1.49, 1.065)])
B_PILLAR = (-0.40, -0.30)


def cabin_dims(y):
    base = lower_top_at(y, WB_C) - 0.03
    top = max(roof(y), base + 0.025)
    H = top - base
    k = smoothstep(0.0, 0.42, H)
    wr = WB_C - (WB_C - WR_C) * k
    c = min(0.10, 0.32 * H)
    crown = 0.025 * k
    te = top - crown * ((wr - c) / wr) ** 2
    return base, top, wr, c, te, crown, k


def cabin_ring(y):
    base, top, wr, c, te, crown, k = cabin_dims(y)
    right = []
    for i in range(4):
        x = (wr - c) * i / 3
        right.append((x, top - crown * (x / wr) ** 2))
    for i in range(1, 4):
        a = math.pi / 2 * (1 - i / 3)
        right.append((wr - c + c * math.cos(a), te - c + c * math.sin(a)))
    for i in range(1, 5):
        t = i / 4
        right.append((wr + (WB_C - wr) * t + 0.012 * math.sin(math.pi * t) * k, (te - c) + (base - (te - c)) * t))
    return [(x, y, z) for (x, z) in reversed(right)] + [(-x, y, z) for (x, z) in right[1:]]


def cabin_row(j):           # 21-point ring, 20 segments; classify by distance from the belt
    sb = j if j < 10 else 19 - j
    return 'side' if sb < 4 else (f'corner{sb - 4}' if sb < 7 else 'roof')


# ================================================================= BUILD BODY
atlas = Atlas(256)
SW = atlas.island('swatch', fixed=(8, 1))
SWATCHES = [KD, KS, KB, BS]   # 0: wheel-well, 1..: spare
low = Mesh('lower')
rest = Mesh('rest')

# --- lower body: stations with rounded ends
ys = []
for a in (0, 25, 50, 72, 90):
    a = math.radians(a)
    ys.append((Y_R + R_END_R - R_END_R * math.cos(a), R_END_R - R_END_R * math.sin(a)))
span0, span1 = Y_R + R_END_R, Y_F - R_END_F
nmid = int(round((span1 - span0) / 0.105))
for k in range(1, nmid):
    ys.append((span0 + (span1 - span0) * k / nmid, 0.0))
for a in (90, 72, 50, 25, 0):
    a = math.radians(a)
    ys.append((Y_F - R_END_F + R_END_F * math.cos(a), R_END_F - R_END_F * math.sin(a)))
rings = [lower_ring(y, ins) for (y, ins) in ys]
loft(low, rings, closed=True, mirror=True, isl=atlas.island('lower'), tag='lower', caps=(True, True),
     cap_isl=(atlas.island('tail'), atlas.island('nose')), cap_mirror=True)

# --- cabin
prof = [(y, roof(y)) for y in np.linspace(Y_WS + 0.02, Y_RS - 0.02, 400)]
L = np.concatenate([[0], np.cumsum([math.dist(prof[i], prof[i + 1]) for i in range(len(prof) - 1)])])
n_st = int(L[-1] / 0.085)
cys = list(np.interp(np.linspace(0, L[-1], n_st + 1), L, [p[0] for p in prof]))
forced = [B_PILLAR[0], B_PILLAR[1], Y_RF, Y_RR]
cys = [y for y in cys if all(abs(y - f) > 0.03 for f in forced)] + forced
cys.sort(reverse=True)
loft(rest, [cabin_ring(y) for y in cys], closed=False, mirror=False, isl=atlas.island('cabin'), tag='cabin',
     rowtag=cabin_row, v_ring=10)

# --- ray casts onto the lower body to seat the add-on parts
bvh = BVHTree.FromPolygons([tuple(v) for v in low.verts], low.faces)


def hit(o, d):
    loc, nor, _, _ = bvh.ray_cast(Vector(o), Vector(d))
    if loc is None:
        raise RuntimeError(f'ray miss {o} {d}')
    if nor.dot(Vector(d)) > 0:
        nor = -nor
    return np.array(loc), np.array(nor)


def track(n, up=(0, 0, 1)):
    """3x3 rotation taking local +Y to n with local +Z as close to `up` as possible."""
    return np.array(Vector(n).to_track_quat('Y', 'Z').to_matrix())


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


FRAMES = {}   # tag -> (centre, rot) of the right-hand instance, for painting in local coordinates


def part(tag, mat='Paint', mirror=True, **kw):
    fs = rbox(rest, atlas, tag, tag=tag, mat=mat, **kw)
    FRAMES[tag] = (np.asarray(kw['centre'], float), np.eye(3) if kw.get('rot') is None else np.asarray(kw['rot']))
    if mirror:
        rest.mirror_x(fs)
    return fs


# bonnet scoop (front opening), following the bonnet slope
sy0, sy1 = 1.22, 1.78
slope = math.atan2(ztop(sy1) - ztop(sy0), sy1 - sy0)
part('scoop', mirror=False, centre=(0, (sy0 + sy1) / 2, ztop((sy0 + sy1) / 2) + 0.035), half=(0.27, 0.28, 0.07),
     rot=rot_x(slope), n=3.2, M=20, er=0.05,
     shape=lambda t: (0.92 + 0.08 * t, 0.35 + 0.65 * smoothstep(0.0, 0.75, t), -0.07 * (1 - (0.35 + 0.65 * smoothstep(0.0, 0.75, t)))))

# headlights: swept lamps seated on the front corners
p, nrm = hit((0.575, 3.0, 0.64), (0, -1, 0))
nrm = nrm * np.array([1, 1, 0.3])
nrm /= np.linalg.norm(nrm)
part('head', mat='Lamp', centre=p - nrm * 0.02, half=(0.23, 0.045, 0.072), rot=track(nrm), n=3.0, M=16, er=0.025)

# round driving lamps + blank front plate
p, _ = hit((0.40, 3.0, 0.40), (0, -1, 0))
DL = np.array([0.40, p[1] + 0.02, 0.40])
part('dlamp_h', centre=DL, half=(0.14, 0.04, 0.14), n=2, M=20, er=0.03)
part('dlamp', mat='Lamp', centre=DL + (0, 0.035, 0), half=(0.118, 0.014, 0.118), n=2, M=20, er=0.008)
p, _ = hit((0.0, 3.0, 0.36), (0, -1, 0))
part('plate', mirror=False, centre=(0, p[1] + 0.008, 0.36), half=(0.15, 0.012, 0.052), n=6, M=12, er=0.006)
part('splitter', mirror=False, centre=(0, Y_F - 0.10, 0.205), half=(0.70, 0.085, 0.016), n=6, M=12, er=0.012)

# tail lights, rear plate, exhausts, diffuser
p, nrm = hit((0.53, -3.0, 0.87), (0, 1, 0))
nrm = nrm * np.array([1, 1, 0.2])
nrm /= np.linalg.norm(nrm)
part('tail', mat='TailLight', centre=p - nrm * 0.02, half=(0.26, 0.035, 0.105), rot=track(nrm), n=6, M=16, er=0.012)
p, _ = hit((0.0, -3.0, 0.62), (0, 1, 0))
part('rplate', mirror=False, centre=(0, p[1] - 0.008, 0.62), half=(0.16, 0.012, 0.055), rot=track((0, -1, 0)), n=6, M=12, er=0.006)
p, _ = hit((0.52, -3.0, 0.31), (0, 1, 0))
part('exhaust', centre=(0.52, p[1] + 0.035, 0.31), half=(0.048, 0.07, 0.048), n=2, M=12, er=0.012)
part('diffuser', mirror=False, centre=(0, Y_R + 0.17, 0.29), half=(0.56, 0.08, 0.025), n=6, M=12, er=0.012)

# door mirrors on short stalks at the A-pillar base
part('mirror', centre=(0.86, 0.80, 1.065), half=(0.055, 0.09, 0.065), n=2.6, M=14, er=0.03)
part('mstalk', centre=(0.78, 0.80, 1.035), half=(0.07, 0.025, 0.018), rot=np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]]), n=4, M=8, er=0.008)

# rear wing: struts, aerofoil, end plates
WY, WZ = -1.92, 1.36
p, _ = hit((0.44, WY + 0.02, 3.0), (0, 0, -1))
strut_h = (WZ - p[2]) / 2 + 0.03
part('strut', centre=(0.44, WY + 0.02, p[2] + strut_h - 0.03), half=(0.016, strut_h, 0.075),
     rot=np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]]) @ rot_x(math.radians(-14)), n=4, M=10, er=0.012)
wing_rot = rot_x(math.radians(-9)) @ np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]])
part('wing', mirror=False, centre=(0, WY, WZ), half=(0.19, 0.71, 0.03), rot=wing_rot, n=2.3, M=14, er=0.02)
part('endplate', centre=(0.715, WY - 0.03, WZ + 0.01), half=(0.014, 0.20, 0.075), n=4, M=10, er=0.012,
     shape=lambda t: (1.0, 1.0, 0.09 * (0.5 - t)))

# ================================================================= BUILD WHEEL (right-hand wheel, rim faces +X)
watlas = Atlas(128)
whl = Mesh('Wheel')
TYRE_PROF = [(-0.088, 0.226), (-0.104, 0.255), (-0.105, 0.288), (-0.093, 0.307), (-0.047, 0.315), (0.0, 0.316),
             (0.047, 0.315), (0.093, 0.307), (0.105, 0.288), (0.104, 0.255), (0.088, 0.226)]
NSEG = 24
lathe(whl, watlas, 'tyre', TYRE_PROF, NSEG, tag='tyre', mat='Wheel')


def prism(m, isl, bot, top, tag, mat):
    """Top + 4 sides of a hexahedron from 4 bottom / 4 top corners (the bottom is buried, so it is
    left out); UV: top face with the sides unfolded round it."""
    b = m.add_verts(list(bot) + list(top))
    A = np.linalg.norm(np.asarray(top[1]) - np.asarray(top[0]))
    C = np.linalg.norm(np.asarray(top[3]) - np.asarray(top[0]))
    h = np.linalg.norm(np.asarray(top[0]) - np.asarray(bot[0]))
    out = [m.add_face([b + 4, b + 5, b + 6, b + 7], [(0, 0), (A, 0), (A, C), (0, C)], tag, mat, False, isl)]
    sides = [((0, 1), [(0, -h), (A, -h), (A, 0), (0, 0)]), ((1, 2), [(A + h, 0), (A + h, C), (A, C), (A, 0)]),
             ((2, 3), [(A, C + h), (0, C + h), (0, C), (A, C)]), ((3, 0), [(-h, C), (-h, 0), (0, 0), (0, C)])]
    for (i, j), uv in sides:
        out.append(m.add_face([b + i, b + j, b + 4 + j, b + 4 + i], uv, tag, mat, False, isl))
    c = np.mean([m.fcentre(f) for f in out], axis=0)
    for f in out:
        if np.dot(m.fnormal(f), m.fcentre(f) - c) < 0:
            m.flip(f)
    return out


def rotx_pt(a):
    R = rot_x(a)
    return lambda p: R @ np.asarray(p)


PITCH = 2 * math.pi / NSEG
TREAD_ROWS = {'A': (0.010, 0.099, 0.0), 'B': (-0.099, -0.010, PITCH / 2)}
for row, (x0, x1, a0) in TREAD_ROWS.items():
    isl = watlas.island('tread' + row)
    dt = 0.036 / 0.33

    def corner(x, r, a):
        return (x, r * math.sin(a), r * math.cos(a))
    rb, rt, ins = 0.309, R_TYRE, 0.006
    bot = [corner(x0, rb, a0 - dt), corner(x1, rb, a0 - dt), corner(x1, rb, a0 + dt), corner(x0, rb, a0 + dt)]
    dti = (0.036 - ins) / 0.33
    top = [corner(x0 + ins, rt, a0 - dti), corner(x1 - ins, rt, a0 - dti), corner(x1 - ins, rt, a0 + dti), corner(x0 + ins, rt, a0 + dti)]
    fs = prism(whl, isl, bot, top, 'tread', 'Wheel')
    for k in range(1, NSEG):
        whl.copy_faces(fs, rotx_pt(PITCH * k))

# rim: barrel (seen from inside), dark disc, spokes, centre cap
RIM_PROF = [(-0.088, 0.228), (-0.075, 0.213), (0.068, 0.213), (0.088, 0.221), (0.097, 0.236)]
rim_f = lathe(whl, watlas, 'rim', RIM_PROF, NSEG, tag='rim', mat='Wheel')
for f in rim_f:     # the barrel must face the axle (it is seen from the outside, through the spokes)
    c = whl.fcentre(f)
    if np.dot(whl.fnormal(f), np.array([0, c[1], c[2]])) > 0 and abs(whl.fnormal(f)[0]) < 0.9:
        whl.flip(f)
disc_ring = [(0.035, 0.214 * math.sin(2 * math.pi * k / NSEG), 0.214 * math.cos(2 * math.pi * k / NSEG)) for k in range(NSEG)]
db = whl.add_verts(disc_ring)
cap(whl, db, disc_ring, away=np.array([1.0, 0, 0]), isl=watlas.island('disc'), tag='disc', mat='Wheel', levels=(0.5,))
NSPOKE = 6
isl = watlas.island('spoke')
dx = 0.025
bot = [(0.040, -0.032, 0.045), (0.040, 0.032, 0.045), (0.058, 0.022, 0.214), (0.058, -0.022, 0.214)]
top = [(0.066, -0.032, 0.045), (0.066, 0.032, 0.045), (0.086, 0.022, 0.214), (0.086, -0.022, 0.214)]
fs = prism(whl, isl, bot, top, 'spoke', 'Wheel')
for k in range(1, NSPOKE):
    whl.copy_faces(fs, rotx_pt(2 * math.pi * k / NSPOKE))
rbox(whl, watlas, 'hubcap', centre=(0.066, 0, 0), half=(0.052, 0.016, 0.052), rot=np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]]) @ np.eye(3),
     n=2, M=10, er=0.008, tag='hubcap', mat='Wheel', end_steps=(0, 90))


# ================================================================= PAINT
def livery(y, z):
    """Original livery: three parallel gold speed stripes sweeping up from the front arch to the rear
    door, and a plain gold-ringed blank roundel on the front door."""
    RC, RZ, RR = 0.40, 0.765, 0.16                      # roundel
    r = math.hypot(y - RC, z - RZ)
    if r < RR:
        if r > RR - 1.6 * PX:
            return GH if z > RZ + 0.05 else GB
        return CRS if z < RZ - 0.10 else CR
    if r < RR + PX:
        return None                                     # 1 px paint gap round the roundel
    for dz, y_end in ((0.0, -1.12), (-0.105, -0.98), (-0.21, -0.84)):
        if not (y_end < y < 0.98):
            continue
        t = (0.98 - y) / 1.96
        zc = 0.525 + dz + 0.25 * t ** 1.15              # rising sweep
        th = 0.075 * min(1.0, (y - y_end) / 0.45) ** 0.7  # tapered tail
        if abs(z - zc) < th / 2:
            return GH if z > zc + th / 2 - PX else GB
    return None


def on_line(v, at):
    return abs(v - at) < 0.5 * PX


def door_lines(y, z, zbelt):
    in_arch = any(math.hypot(y - wy, z - ARCH_Z) < ARCH_R + 0.06 for wy in (FA, RA))
    if in_arch or z > zbelt - 0.01:
        return False
    if z > 0.39 and (on_line(y, 0.80) or on_line(y, -0.34) or on_line(y, -1.20)):
        return True
    return -1.20 < y < 0.80 and on_line(z, 0.39)


def p_lower(tag, x, y, z, nx, ny, nz, chk, ix, iy):
    if nz < -0.6:
        return KD, None
    for wy in (FA, RA):     # arch lips
        d = math.hypot(y - wy, z - ARCH_Z)
        if d < ARCH_R + 2.5 * PX and nz < 0.8 and x > 0.5:
            if d < ARCH_R + 1.0 * PX:
                return BD, None
            return (BH if z > ARCH_Z + 0.12 else BB), None
    if y > Y_F - 0.3 and ny > 0.55:
        return fascia_front(x, z, iy, ny), None
    if y < Y_R + 0.3 and ny < -0.55:
        return fascia_rear(x, z, iy), None
    if nz > 0.55:
        return top_lower(x, y, z, nz, chk), None
    # sides
    if z < zbot(y) + 0.075:
        return (KS if z < zbot(y) + 0.035 else KB), None
    zbelt = lower_top_at(y, WB_C) if Y_RS < y < Y_WS else ztop(y)
    if nx > 0.5 and door_lines(y, z, zbelt):
        return BD, None
    if nx > 0.5:
        for (h0, h1) in ((0.02, 0.15), (-0.97, -0.84)):     # door handles
            if h0 < y < h1 and 0.865 < z < 0.895:
                return KS, None
            if h0 < y < h1 and 0.895 <= z < 0.925:
                return BH, None
        if 1.70 < y < 1.78 and 0.64 < z < 0.67:              # side repeater
            return AMB, None
        if -1.63 < y < -1.50 and 0.80 < z < 0.90 and (on_line(y, -1.63 + 0.5 * PX) or on_line(y, -1.50 - 0.5 * PX) or on_line(z, 0.80 + 0.5 * PX) or on_line(z, 0.90 - 0.5 * PX)):
            return BD, None                                    # fuel flap
        g = livery(y, z)
        if g:
            return g, None
    if nz > 0.3:
        return BH, None
    if z < 0.40 or (z < 0.45 and chk):
        return BS, None
    return BB, None


def top_lower(x, y, z, nz, chk):
    if Y_WS - 0.075 < y < Y_WS + 0.02 and x < 0.70:
        return KS                                   # wiper cowl
    if Y_WS < y < Y_F - 0.13:                       # bonnet shut lines
        if (on_line(x, 0.69) or on_line(y, Y_F - 0.13 - 0.5 * PX)) and x <= 0.69 + PX:
            return BD
    if Y_R + 0.09 < y < Y_RS - 0.03:                # boot lid
        if (on_line(x, 0.66) or on_line(y, Y_RS - 0.03 - 0.5 * PX)) and x <= 0.66 + PX:
            return BD
    if nz > 0.9:
        return BH if not (chk and nz < 0.93) else BB
    return BB


def fascia_front(x, z, iy, ny):
    zb = zbot(Y_F)
    if z < zb + 0.05:
        return KB
    if x < 0.34 and 0.56 < z < 0.67:               # upper grille
        if x > 0.34 - PX or z < 0.56 + PX or z > 0.67 - PX:
            return KD
        return KS if iy % 2 else KB
    if x < 0.60 and 0.24 < z < 0.52:                # lower intake
        if x > 0.60 - PX or z < 0.24 + PX or z > 0.52 - PX:
            return KD
        return KD if iy % 2 else KS
    if 0.61 <= x < 0.70 and 0.33 < z < 0.385 and ny > 0.85:  # indicator
        return AMB
    return BB if z > 0.50 else BS


def fascia_rear(x, z, iy):
    zb = zbot(Y_R)
    if z < zb + 0.09:
        return KS if z < zb + 0.05 else KB
    if 0.50 < x < 0.66 and 0.40 < z < 0.43:
        return TRD
    if on_line(z, 0.78) and x < 0.62:
        return BD
    return BB if z > 0.5 else BS


def glass(x, y, z, z0, z1, kind, iy):
    t = (z - z0) / max(1e-6, z1 - z0)
    if kind == 'side':
        s = y + 0.8 * z
        if abs(s - 1.38) < 0.045 or abs(s - 1.25) < 0.018 or abs(s - 0.34) < 0.045 or abs(s - 0.22) < 0.016:
            return LH
        for sy in (-0.13, -1.0):                       # head-rests seen through the glass
            dz = z - (z1 - 0.13)
            if (y - sy) ** 2 / 0.075 ** 2 + dz ** 2 / 0.06 ** 2 < 1 or (abs(y - sy) < 0.075 and dz < 0):
                return LD
    elif kind == 'front':
        s = x + 1.3 * (z - z0)
        if abs(s - 0.05) < 0.05 or abs(s - 0.24) < 0.022:
            return LH
        x = abs(x)
        w = z0 + 0.035 + 0.22 * (0.62 - x)              # wiper blades
        if 0.08 < x < 0.62 and abs(z - w) < 0.5 * PX:
            return LD
    elif kind == 'rear':
        if (iy % 3 == 0) and 0.2 < t < 0.85 and abs(x) < 0.5:
            return LS                                   # demister lines
        s = x + 1.2 * (z - z0)
        if abs(s - 0.1) < 0.04:
            return LH
    if t > 0.82:
        return LD
    if t < 0.22:
        return LS
    return LB


def p_cabin(tag, x, y, z, nx, ny, nz, chk, ix, iy, sx=0.0):
    row = tag.split(':')[1]
    base, top, wr, c, te, crown, k = cabin_dims(y)
    zvis = base + 0.03
    if row == 'side':
        w0, w1 = zvis + 0.035, te - c - 0.012
        if y < Y_RS + 0.06 or w1 - w0 < 0.04:
            return (BB if z > zvis + PX else KB), None
        yrear = -1.17 + 0.22 * smoothstep(w0, w1, z)
        if B_PILLAR[0] - 0.005 < y < B_PILLAR[1] + 0.005:
            return KB, None
        if y < yrear:
            return (KB if z < w0 else BB), None
        if y > 0.72 and z < w0 + 0.10:
            return KB, None                             # mirror sail
        if z < w0 or z > w1:
            return (KB if z < w0 else BB), None
        if z < w0 + PX or z > w1 - PX or y < yrear + PX or abs(y - B_PILLAR[0]) < PX or abs(y - B_PILLAR[1]) < PX:
            return KB, 'glass'
        return glass(x, y, z, w0, w1, 'side', iy), 'glass'
    screen = y > Y_RF + 0.02 or y < Y_RR - 0.02
    if row.startswith('corner'):
        if screen and row == 'corner2':
            return KB, None                             # screen surround
        return (BH if nz > 0.75 else BB), None
    # roof rows: windscreen, roof, rear screen
    if screen:
        front = y > 0
        z0 = zvis + 0.02
        z1 = roof(Y_RF + 0.03) - 0.035 if front else roof(Y_RR - 0.03) - 0.035
        if z < z0 or z > z1:
            return (KS if z < z0 else BB), None
        if z > z1 - PX or x > wr - c - 1.6 * PX:
            return KB, 'glass'
        return glass(sx, y, z, z0, z1, 'front' if front else 'rear', iy), 'glass'
    if abs(y - Y_RF) < 0.03 or abs(y - Y_RR) < 0.03:
        return BB, None
    return (BH if x < wr - 0.12 else BB), None


def local(tag, x, y, z):
    C, R = FRAMES[tag]
    return R.T @ (np.array([x, y, z]) - C)


def p_part(tag, x, y, z, nx, ny, nz, chk, ix, iy):
    t = tag
    if t == 'scoop':
        q = local(t, x, y, z)
        if ny > 0.6 and q[1] > 0.2:
            return (KD if (abs(q[0]) < 0.21 and q[2] > -0.07) else BS), None
        return (BH if nz > 0.75 else BB), None
    if t == 'head':
        q = local(t, x, y, z)
        if q[1] < 0.025:
            return BS, None
        if abs(q[0]) > 0.215 - PX or abs(q[2]) > 0.066 - PX:
            return KB, None
        if q[0] > 0.145:
            return AMB, None
        for cx, rr in ((0.07, 0.042), (-0.07, 0.036)):
            r = math.hypot(q[0] - cx, q[2] + 0.004)
            if r < rr * 0.55:
                return W1, None
            if r < rr:
                return W2, None
        return (W1 if q[2] > 0.045 else LH), None
    if t == 'dlamp_h':
        q = local(t, x, y, z)
        return (KH if q[1] > 0.035 else KB), None
    if t == 'dlamp':
        q = local(t, x, y, z)
        r = math.hypot(q[0], q[2])
        if q[1] < 0.005:
            return KH, None
        if r > 0.10:
            return CRS, None
        if (q[0] + 0.035) ** 2 + (q[2] - 0.04) ** 2 < 0.022 ** 2:
            return (1, 1, 1), None
        return (W1 if r < 0.062 else W2), None
    if t == 'tail':
        q = local(t, x, y, z)
        if q[1] < 0.02:
            return TRS, None
        if abs(q[0]) > 0.245 - PX or abs(q[2]) > 0.09 - PX:
            return TRD, None
        if abs(q[0] + 0.02) < PX:
            return TRD, None                            # divider between the two lamp cells
        if q[2] > 0.09 - 2 * PX:
            return TRH, None                            # lit top edge
        return (TR if q[2] > -0.03 else TRS), None
    if t in ('plate', 'rplate'):
        q = local(t, x, y, z)
        if q[1] > 0.0 and abs(q[0]) < 0.15 - PX * 0.8 and abs(q[2]) < 0.05 - PX * 0.8:
            return (CR if abs(q[2]) < 0.03 else CRS), None
        return KB, None
    if t == 'exhaust':
        q = local(t, x, y, z)
        if q[1] < -0.05 and math.hypot(q[0], q[2]) < 0.032:
            return KD, None
        return (hexrgb('#948775') if q[1] < -0.035 else KH), None
    if t in ('splitter', 'diffuser', 'mstalk'):
        return (KH if nz > 0.7 else KB), None
    if t == 'mirror':
        if ny < -0.55:
            return (LH if z > 1.075 else LB), 'glass'
        return (BH if nz > 0.6 else BB), None
    if t in ('wing', 'endplate', 'strut'):
        if nz > 0.6:
            return BH, None
        if nz < -0.5:
            return BS, None
        if t == 'endplate' and nx > 0.7:
            q = local(t, x, y, z)
            if abs(q[1]) > 0.20 - 1.5 * PX or abs(q[2]) > 0.075 - 1.5 * PX:
                return BS, None
        return BB, None
    return (1, 0, 1), None


def body_paint(tag, p, n, ix, iy):
    x, y, z = abs(p[0]), p[1], p[2]
    nx, ny, nz = abs(n[0]), n[1], n[2]
    chk = (ix + iy) & 1
    base = tag.split(':')[0]
    if base == 'lower':
        return p_lower(tag, x, y, z, nx, ny, nz, chk, ix, iy)
    if base == 'cabin':
        return p_cabin(tag, x, y, z, nx, ny, nz, chk, ix, iy, sx=p[0])
    return p_part(base, x, y, z, nx, ny, nz, chk, ix, iy)


def wheel_paint(tag, p, n, ix, iy):
    x, y, z = p
    r = math.hypot(y, z) or 1e-9
    nr = (n[1] * y + n[2] * z) / r
    if tag.startswith('tyre'):
        if nr > 0.75:
            return (KS if abs(x) < 0.006 else KD), None       # tread base between the blocks
        if abs(n[0]) > 0.6:
            if 0.284 < r < 0.294:
                return KH, None                                 # raised sidewall ring
            if r < 0.240:
                return KS, None
            return KB, None
        return KS, None
    if tag == 'tread':
        if nr > 0.8:
            a = math.atan2(y, z)
            if x > 0:
                a0 = 0.0
            else:
                a0 = PITCH / 2
            da = ((a - a0 + PITCH / 2) % PITCH) - PITCH / 2
            tq = da * r
            if abs(tq) < 0.5 * PX:
                return KS, None                                 # sipe
            if tq > 0.024 or abs(x) > 0.088 or abs(x) < 0.02:
                return KH, None                                 # lit block edge
            return KB, None
        return (KS if r > 0.318 else KD), None
    if tag == 'rim':
        if x > 0.085:
            return (GH if nr > 0.3 or n[0] > 0.6 else GB), None
        if x > 0.06:
            return GB, None
        return (GS if x < 0.0 else GB), None
    if tag == 'disc':
        if r > 0.18:
            return KD, None
        if r > 0.12:
            return KH, None
        return KS, None
    if tag == 'spoke':
        if n[0] > 0.7:
            if r > 0.2:
                return GB, None
            return GH, None
        return GS, None
    if tag == 'hubcap':
        if n[0] > 0.7:
            a = math.atan2(y, z)
            for k in range(5):
                b = 2 * math.pi * k / 5
                if math.hypot(y - 0.03 * math.sin(b), z - 0.03 * math.cos(b)) < 0.009:
                    return GD, None
            return (GH if (z > 0.012 and y < 0.0) else GB), None
        return GS, None
    return (1, 0, 1), None


atlas.pack()
watlas.pack()
print('[wrx] body atlas used height', atlas.used_h, 'wheel atlas used', watlas.used_h)
body_img, body_hints = paint(atlas, [low, rest], body_paint, swatches=SWATCHES, swatch_isl=SW)
wheel_img, wheel_hints = paint(watlas, [whl], wheel_paint)


# ================================================================= BLENDER OBJECTS
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


reset()
scene = bpy.context.scene
scene.name = 'LowRange_wrx'


def make_image(name, arr, path):
    S = arr.shape[0]
    img = bpy.data.images.new(name, S, S, alpha=False)
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    return img


IMG_BODY = make_image('wrx_body', body_img, os.path.join(OUT, 'wrx_body.png'))
IMG_WHEEL = make_image('wrx_wheel', wheel_img, os.path.join(OUT, 'wrx_wheel.png'))


def inp(node, *names):
    for nm in names:
        if nm in node.inputs:
            return node.inputs[nm]
    raise KeyError(names)


def export_mat(name, img, rough=1.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    tex.location = (-400, 0)
    nt.links.new(tex.outputs['Color'], inp(bsdf, 'Base Color'))
    inp(bsdf, 'Roughness').default_value = rough
    inp(bsdf, 'Metallic').default_value = 0.0
    if emit == 'texture':
        nt.links.new(tex.outputs['Color'], inp(bsdf, 'Emission Color'))
        inp(bsdf, 'Emission Strength').default_value = emit_strength
    elif emit is not None:
        inp(bsdf, 'Emission Color').default_value = (*emit, 1)
        inp(bsdf, 'Emission Strength').default_value = emit_strength
    else:
        inp(bsdf, 'Emission Strength').default_value = 0.0
    return m


MATS = {
    'Paint': export_mat('Paint', IMG_BODY, 1.0),
    'Glass': export_mat('Glass', IMG_BODY, 0.2),
    'Lamp': export_mat('Lamp', IMG_BODY, 1.0, emit='texture', emit_strength=1.0),
    'TailLight': export_mat('TailLight', IMG_BODY, 1.0, emit=(0, 0, 0), emit_strength=1.0),
    'Wheel': export_mat('Wheel', IMG_WHEEL, 1.0),
}
BODY_SLOTS = ['Paint', 'Glass', 'Lamp', 'TailLight']


def to_object(m, at, hints, slots, swatch_isl=None):
    """Mesh -> object. Faces are emitted as the same fan triangles paint() rasterised, so the
    texture mapping matches exactly (a quad split on the other diagonal would shear the pixels)."""
    S = at.size
    tris, uvs, idx, smooth = [], [], [], []
    for f, vids in enumerate(m.faces):
        if m.fswatch[f] is not None:
            fuv = [swatch_uv(at, swatch_isl, m.fswatch[f])] * len(vids)
        else:
            fuv = [tuple(c / S for c in at.px(m.fisl[f], uv)) for uv in m.fuv[f]]
        mat = m.fmat[f]
        if hints.get((m.name, f)) == 'glass' and mat == 'Paint':
            mat = 'Glass'
        for t in range(1, len(vids) - 1):
            tris.append((vids[0], vids[t], vids[t + 1]))
            uvs += [fuv[0], fuv[t], fuv[t + 1]]
            idx.append(slots.index(mat))
            smooth.append(bool(m.fsmooth[f]))
    me = bpy.data.meshes.new(m.name)
    me.from_pydata([tuple(v) for v in m.verts], [], tris)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', np.array(uvs, dtype=np.float32).ravel())
    for s in slots:
        me.materials.append(MATS[s])
    me.polygons.foreach_set('material_index', idx)
    me.polygons.foreach_set('use_smooth', smooth)
    me.validate()
    me.update()
    o = bpy.data.objects.new(m.name, me)
    scene.collection.objects.link(o)
    return o


low_o = to_object(low, atlas, body_hints, BODY_SLOTS, SW)
rest_o = to_object(rest, atlas, body_hints, BODY_SLOTS, SW)

# wheel-arch cuts (exact boolean); the pocket walls take the dark wheel-well swatch
cutters = []
for wy, xin in ((FA, 0.44), (RA, 0.52)):
    for sx in (1, -1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=ARCH_R, radius2=ARCH_R, depth=1.0 - xin + 0.4)
        me = bpy.data.meshes.new('cut')
        bm.to_mesh(me)
        bm.free()
        uvl = me.uv_layers.new(name='UVMap')
        u = swatch_uv(atlas, SW, 0)
        uvl.data.foreach_set('uv', np.array([u] * len(me.loops), dtype=np.float32).ravel())
        me.materials.append(MATS['Paint'])
        c = bpy.data.objects.new('cut', me)
        c.rotation_euler = (0, math.pi / 2, 0)
        c.location = (sx * (xin + (1.0 - xin + 0.4) / 2), wy, ARCH_Z)
        scene.collection.objects.link(c)
        cutters.append(c)
        md = low_o.modifiers.new('arch', 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.solver = 'EXACT'
        md.material_mode = 'TRANSFER'
        md.object = c
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
cut_me = bpy.data.meshes.new_from_object(low_o.evaluated_get(dg))
low_o.modifiers.clear()
for c in cutters:
    bpy.data.objects.remove(c, do_unlink=True)

# merge lower + rest into Body (both meshes share the slot order)
bm = bmesh.new()
bm.from_mesh(cut_me)
bm.from_mesh(rest_o.data)
body_me = bpy.data.meshes.new('Body')
bm.to_mesh(body_me)
bm.free()
for s in BODY_SLOTS:
    body_me.materials.append(MATS[s])
for o in (low_o, rest_o):
    bpy.data.objects.remove(o, do_unlink=True)
body_me.transform(Matrix.Translation((0, 0, -CZ)))
body = bpy.data.objects.new('Body', body_me)
body.location = (0, 0, CZ)
scene.collection.objects.link(body)

wheel = to_object(whl, watlas, wheel_hints, ['Wheel'])
wheel.name = 'Wheel'
wheel.data.name = 'Wheel'
wheel.location = (HX, FA, R_TYRE)
wheel['tyre_radius'] = R_TYRE
wheel['tyre_width'] = W_TYRE

markers = {}
for nm, loc in (('Marker_WheelFL', (-HX, FA, R_TYRE)), ('Marker_WheelFR', (HX, FA, R_TYRE)),
                ('Marker_WheelRL', (-HX, RA, R_TYRE)), ('Marker_WheelRR', (HX, RA, R_TYRE)),
                ('Marker_Ground', (0, 0, 0))):
    e = bpy.data.objects.new(nm, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.2
    e.location = loc
    scene.collection.objects.link(e)
    markers[nm] = e


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def bounds(o):
    vs = np.array([o.matrix_world @ v.co for v in o.data.vertices])
    return vs.min(axis=0), vs.max(axis=0)


bpy.context.view_layer.update()
bmin, bmax = bounds(body)
print('[wrx] Body tris', tris(body), 'Wheel tris', tris(wheel))
print('[wrx] Body bounds min', np.round(bmin, 3), 'max', np.round(bmax, 3), 'size', np.round(bmax - bmin, 3))

# ================================================================= EXPORT
for o in scene.objects:
    o.select_set(o in (body, wheel) or o.name.startswith('Marker_'))
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_apply=True,
                          export_extras=True, export_yup=True)
print('[wrx] exported', GLB, os.path.getsize(GLB), 'bytes')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'wrx.blend'))

# ================================================================= PREVIEW (toon + outline + low-res)
import wrx_preview  # noqa: E402
importlib.reload(wrx_preview)
wrx_preview.run(scene, body, wheel, MATS, OUT, PREV, FA, RA, HX, R_TYRE)
