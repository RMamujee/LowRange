# Build the olive lifted pickup (`taco`) for LowRange, headless:
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup --python tools/blender/build_taco.py
#   ... --python tools/blender/build_taco.py -- verify      (re-import the exported .glb and report)
#   ... --python tools/blender/build_taco.py -- nopreview   (build + export only)
# Outputs: public/models/vehicles/taco.glb, tools/blender/out/taco.blend, docs/previews/taco_*.png
# Contract: docs/MODELING_SPEC.md + docs/ART_STYLE.md. Blender: +Y forward, +X right, +Z up.
import bpy, bmesh, math, os, sys, json, struct
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib
import taco_shape, taco_paint
importlib.reload(taco_shape); importlib.reload(taco_paint)
from taco_shape import *
from taco_paint import (Atlas, paint_olive, paint_trim, paint_glass, paint_lamp, paint_tail, paint_cargo,
                        paint_wheel, paint_dirt, WHEEL_W, WHEEL_H, TREAD_U, REG_TREAD, REG_SIDE, REG_LUGSIDE,
                        REG_GROOVE, REG_RIMBACK, REG_RIM)

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, 'out')
GLB = os.path.join(ROOT, 'public', 'models', 'vehicles', 'taco.glb')
PREV = os.path.join(ROOT, 'docs', 'previews')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


# =============================================================== mesh builder
class MB:
    """One bmesh with a UV layer; parts are appended with a material name."""
    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.mats = []
        self.fixed_uv = set()     # faces whose UVs were laid out by hand (wheel parts)

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def append(self, t, mat):
        vm = {v: self.bm.verts.new(v.co) for v in t.verts}
        out = []
        for f in t.faces:
            nf = self.bm.faces.new([vm[v] for v in f.verts])
            nf.material_index = self.mi(mat)
            out.append(nf)
        t.free()
        return out


def orient_out(faces, centre):
    """Flip faces so they face away from `centre` (for open shells where recalc can't decide)."""
    for f in faces:
        f.normal_update()
        if f.normal.dot(f.calc_center_median() - Vector(centre)) < 0:
            f.normal_flip()


def loft(mb, rings, mat, closed=True, cap0=False, cap1=False, recalc=True, centre=None):
    bm = mb.bm
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    faces = []
    for a, b in zip(vr[:-1], vr[1:]):
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            faces.append(bm.faces.new((a[k], a[k2], b[k2], b[k])))
    if cap0:
        faces.append(bm.faces.new(vr[0][::-1]))
    if cap1:
        faces.append(bm.faces.new(vr[-1]))
    m = mb.mi(mat)
    for f in faces:
        f.material_index = m
    if centre is not None:
        orient_out(faces, centre)
    elif recalc:
        bmesh.ops.recalc_face_normals(bm, faces=faces)
    return faces


def rbox(mb, mat, x0, x1, y0, y1, z0, z1, r=0.02, grid=None, rot_z=0.0, seg=1):
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    sx, sy, sz = x1 - x0, y1 - y0, z1 - z0
    for v in t.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    if grid:
        for axis, size in ((0, sx), (1, sy), (2, sz)):
            n = int(round(size / grid))
            for k in range(1, n):
                co = Vector((0, 0, 0)); co[axis] = -size / 2 + size * k / n
                no = Vector((0, 0, 0)); no[axis] = 1
                bmesh.ops.bisect_plane(t, geom=t.verts[:] + t.edges[:] + t.faces[:], plane_co=co, plane_no=no)
    t.normal_update()
    if r > 0:
        edges = [e for e in t.edges if len(e.link_faces) == 2 and e.link_faces[0].normal.angle(e.link_faces[1].normal) > 1.0]
        r = min(r, sx * 0.45, sy * 0.45, sz * 0.45)
        bmesh.ops.bevel(t, geom=edges, offset=r, segments=seg, affect='EDGES', profile=0.5, clamp_overlap=True)
    M = Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)) @ Matrix.Rotation(rot_z, 4, 'Z')
    bmesh.ops.transform(t, matrix=M, verts=t.verts)
    bmesh.ops.recalc_face_normals(t, faces=t.faces)
    return mb.append(t, mat)


def cyl(mb, mat, p0, p1, r, segs=8, caps=True, r1=None):
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    u = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
    w = d.cross(u)
    rings = []
    for p, rr in ((p0, r), (p1, r if r1 is None else r1)):
        rings.append([p + (u * math.cos(2 * math.pi * k / segs) + w * math.sin(2 * math.pi * k / segs)) * rr for k in range(segs)])
    return loft(mb, rings, mat, closed=True, cap0=caps, cap1=caps)


def mirror_x(pts):
    return [(-x, z) for (x, z) in reversed(pts)]


# =============================================================== body parts
def lower_body(mb):
    ys = set(np.linspace(Y_CAB, Y_NOSE, 22).tolist())
    ys.update(arch_stations(FY, Z_SILL))
    ys.update(Y_NOSE - NOSE_R + NOSE_R * math.sin(math.radians(a)) for a in (0, 25, 50, 70, 85, 90))
    ys.add(Y_COWL)
    st = []
    for y in sorted(ys):
        if not st or y - st[-1] > 0.012:
            st.append(y)
    st[-1] = Y_NOSE
    rings = []
    for y in st:
        zb = bottom_z(y, Z_SILL)
        zt = hood_z(y)
        s = nose_scale(y)
        rs = 0.09
        zst = zt - rs
        right = [(0.0, zb), (0.28, zb), (0.56, zb)]
        wl = side_w(zb)
        right += [(wl - 0.045, zb), (wl - 0.010, zb + 0.012), (wl, zb + 0.045)]
        z0 = zb + 0.045
        for f in (0.25, 0.5, 0.75):
            z = z0 + f * (zst - z0)
            right.append((side_w(z), z))
        wt = side_w(zst)
        for k in range(4):
            a = k / 3 * math.pi / 2
            right.append((wt - rs + rs * math.cos(a), zst + rs * math.sin(a)))
        for x in (0.52, 0.34, 0.17, 0.0):
            right.append((x, zt + 0.012 * (1 - (x / 0.76) ** 2)))
        ring = right + [(-x, z) for (x, z) in reversed(right[1:-1])]
        rings.append([(x * s, y, z) for (x, z) in ring])
    return loft(mb, rings, 'taco_paint', closed=True, cap0=True, cap1=True)


def greenhouse(mb):
    rings = []
    for (y, zt) in GH_PROFILE:
        rs = gh_rs(zt)
        zs = zt - rs
        right = [(gh_w(Z_GB), Z_GB)]
        for f in (0.34, 0.67):
            z = Z_GB + f * (zs - Z_GB)
            right.append((gh_w(z), z))
        cx = gh_w(zs) - rs
        for k in range(4):
            a = k / 3 * math.pi / 2
            right.append((cx + rs * math.cos(a), zs + rs * math.sin(a)))
        for f in (0.66, 0.33, 0.0):
            x = cx * f
            right.append((x, zt + crown(x, y)))
        ring = right + [(-x, z) for (x, z) in reversed(right[:-1])]
        rings.append([(x, y, z) for (x, z) in ring])
    return loft(mb, rings, 'taco_paint', closed=False, cap1=True, centre=(0, -0.1, 1.55))


def glass(mb):
    bm = mb.bm
    m = mb.mi('taco_glass')
    out = []
    # windscreen: a curved grid following the roof crown
    levels = np.linspace(WS_Z0, WS_Z1, 5)
    rows = []
    for z in levels:
        y = windscreen_y(z)
        xh = ws_half(y)
        rows.append([bm.verts.new((x, y, gh_top(y) + crown(x, y) + 0.012)) for x in np.linspace(-xh, xh, 5)])
    for a, b in zip(rows[:-1], rows[1:]):
        for k in range(4):
            out.append(bm.faces.new((a[k], a[k + 1], b[k + 1], b[k])))
    orient_out(out, (0, -0.4, 1.3))
    # side windows (both sides), on the tumblehome plane
    for sx in (1, -1):
        for poly in SIDE_WINDOWS:
            f = bm.faces.new([bm.verts.new((sx * (gh_w(z) + 0.008), y, z)) for (y, z) in poly])
            orient_out([f], (0, 0.2, 1.7))
            out.append(f)
    # rear window on the cab back
    hw, z0, z1 = REAR_WINDOW
    yb = Y_CAB - 0.008
    f = bm.faces.new([bm.verts.new(p) for p in ((-hw, yb, z0), (hw, yb, z0), (hw, yb, z1), (-hw, yb, z1))])
    orient_out([f], (0, 0, 1.7))
    out.append(f)
    for f in out:
        f.material_index = m
    # mirror glass
    for sx in (1, -1):
        rbox(mb, 'taco_glass', *sorted((sx * 0.945, sx * 1.005)), 0.793, 0.80, 1.565, 1.745, r=0.0)


def hood_scoop(mb):
    rings = []
    ys = np.linspace(1.42, 1.885, 6)
    for y in ys:
        h = 0.066 * ((y - 1.42) / 0.465) ** 0.8 + 0.002
        zb = hood_z(y) - 0.012
        right = [(0.245, zb), (0.236, zb + 0.5 * h), (0.214, zb + h), (0.11, zb + h + 0.004), (0.0, zb + h + 0.005)]
        ring = right + [(-x, z) for (x, z) in reversed(right[:-1])]
        rings.append([(x, y, z) for (x, z) in ring])
    loft(mb, rings, 'taco_paint', closed=False, centre=(0, 1.6, 1.2))
    bm = mb.bm
    mouth = bm.faces.new([bm.verts.new(p) for p in rings[-1]])
    mouth.material_index = mb.mi('taco_trim')
    orient_out([mouth], (0, 1.6, 1.36))


def bed(mb):
    ys = set(np.linspace(Y_BED_R, Y_BED_F, 10).tolist())
    ys.update(arch_stations(RY, Z_BED_BOT))
    st = []
    for y in sorted(ys):
        if not st or y - st[-1] > 0.012:
            st.append(y)
    st[-1] = Y_BED_F
    for sx in (1, -1):
        rings = []
        for y in st:
            zb = bottom_z(y, Z_BED_BOT)
            pts = [(BED_IN, zb), (side_w(zb) - 0.012, zb), (side_w(zb + 0.03), zb + 0.03)]
            for f in (0.33, 0.66):
                z = zb + 0.03 + f * (1.40 - zb - 0.03)
                pts.append((side_w(z), z))
            pts += [(side_w(1.40), 1.40), (0.848, 1.437), (0.822, Z_BED_TOP), (BED_IN, Z_BED_TOP),
                    (BED_IN, zb + 0.5 * (Z_BED_TOP - zb))]
            rings.append([(sx * x, y, z) for (x, z) in pts])
        loft(mb, rings, 'taco_paint', closed=True, cap0=True, cap1=True)
    # front wall, floor (between the wheel tubs), floor strips, tubs, tailgate
    rbox(mb, 'taco_paint', -BED_IN, BED_IN, Y_BED_F - 0.06, Y_BED_F, 0.95, Z_BED_TOP, r=0.012, grid=0.25)
    rbox(mb, 'taco_paint', -0.595, 0.595, Y_BED_R + 0.045, Y_BED_F - 0.06, Z_FLOOR - 0.04, Z_FLOOR, r=0.0, grid=0.25)
    for sx in (1, -1):
        for (y0, y1) in ((-1.19, Y_BED_F - 0.06), (Y_BED_R + 0.045, -2.05)):
            rbox(mb, 'taco_paint', *sorted((sx * 0.595, sx * BED_IN)), y0, y1, Z_FLOOR - 0.04, Z_FLOOR, r=0.0)
        t1 = math.acos((Z_FLOOR - 0.045 - R) / AR)
        rings = []
        for i in range(11):
            t = -t1 + 2 * t1 * i / 10
            ring = []
            for (x, r) in ((0.595, AR), (0.785, AR), (0.785, AR + 0.03), (0.595, AR + 0.03)):
                ring.append((sx * x, RY + r * math.sin(t), R + r * math.cos(t)))
            rings.append(ring)
        loft(mb, rings, 'taco_paint', closed=True, cap0=True, cap1=True)
    for sx in (1, -1):   # black bed-rail caps
        rbox(mb, 'taco_trim', *sorted((sx * (BED_IN - 0.012), sx * (side_w(1.45) + 0.008))), Y_BED_R - 0.01, Y_BED_F + 0.005,
             Z_BED_TOP - 0.012, Z_BED_TOP + 0.018, r=0.008, grid=0.5)
    rbox(mb, 'taco_paint', -TAILGATE_X, TAILGATE_X, Y_BED_R - 0.015, Y_BED_R + 0.045, 0.74, Z_BED_TOP - 0.004, r=0.015, grid=0.25)


def flares(mb):
    sec = [(0.840, AR + 0.001), (0.900, AR + 0.004), (0.925, AR + 0.016), (0.925, AR + 0.105), (0.903, AR + 0.135),
           (0.832, AR + 0.135)]
    t1 = math.acos((Z_SILL - 0.03 - R) / (AR + 0.135))
    for yc in (FY, RY):
        for sx in (1, -1):
            rings = []
            for i in range(19):
                t = -t1 + 2 * t1 * i / 18
                rings.append([(sx * x, yc + r * math.sin(t), R + r * math.cos(t)) for (x, r) in sec])
            loft(mb, rings, 'taco_trim', closed=True, cap0=True, cap1=True)


def front_end(mb):
    gw, g0, g1 = GRILLE
    rbox(mb, 'taco_trim', -gw, gw, Y_NOSE - 0.035, Y_NOSE + 0.028, g0, g1, r=0.014)
    x0, x1, z0, z1 = HEAD
    for sx in (1, -1):
        rbox(mb, 'taco_lamp', *sorted((sx * x0, sx * x1)), Y_NOSE - 0.06, Y_NOSE + 0.014, z0, z1, r=0.014)
    # steel bumper: centre section + swept wings
    rbox(mb, 'taco_trim', -0.68, 0.68, 2.36, 2.575, 0.615, 0.94, r=0.03, grid=0.3)
    # bull-bar ends rising from the bumper corners
    for sx in (1, -1):
        rbox(mb, 'taco_trim', *sorted((sx * 0.60, sx * 0.68)), 2.47, 2.565, 0.92, 1.12, r=0.02)
        cyl(mb, 'taco_trim', (sx * 0.64, 2.53, 1.10), (sx * 0.86, 2.36, 1.02), 0.026)
    # fog lamp pods sitting in the bumper top
    for sx in (1, -1):
        cyl(mb, 'taco_trim', (sx * FOG_X, 2.545, FOG_Z), (sx * FOG_X, 2.615, FOG_Z), FOG_R + 0.014, segs=12)
        cyl(mb, 'taco_lamp', (sx * FOG_X, 2.612, FOG_Z), (sx * FOG_X, 2.626, FOG_Z), FOG_R, segs=12)
    rbox(mb, 'taco_trim', -0.40, 0.40, 1.90, 2.38, 0.555, 0.60, r=0.0)          # skid plate
    rbox(mb, 'taco_trim', -0.16, 0.14, 1.48, 1.76, 0.555, 0.70, r=0.02)          # IFS diff (frame mounted)


def bumper_wings(mb):
    for sx in (1, -1):
        t = bmesh.new()
        bmesh.ops.create_cube(t, size=1.0)
        for v in t.verts:
            v.co = Vector((v.co.x * 0.29, v.co.y * 0.15, v.co.z * 0.29))
        t.normal_update()
        edges = [e for e in t.edges if e.link_faces[0].normal.angle(e.link_faces[1].normal) > 1.0]
        bmesh.ops.bevel(t, geom=edges, offset=0.025, segments=1, affect='EDGES', profile=0.5, clamp_overlap=True)
        M = Matrix.Translation((sx * 0.71, 2.43, 0.7775)) @ Matrix.Rotation(sx * math.radians(-39), 4, 'Z')
        bmesh.ops.transform(t, matrix=M, verts=t.verts)
        bmesh.ops.recalc_face_normals(t, faces=t.faces)
        mb.append(t, 'taco_trim')


def rear_end(mb):
    for sx in (1, -1):
        rbox(mb, 'taco_tail', *sorted((sx * TAILGATE_X, sx * 0.875)), Y_BED_R - 0.035, Y_BED_R + 0.015, TAIL_Z[0], TAIL_Z[1], r=0.012)
    zt = gh_top(Y_CAB)
    rbox(mb, 'taco_tail', -0.14, 0.14, Y_CAB - 0.035, Y_CAB + 0.005, zt - 0.075, zt - 0.038, r=0.008)
    rbox(mb, 'taco_trim', -0.86, 0.86, -2.73, Y_BED_R + 0.015, 0.575, 0.80, r=0.025, grid=0.3)


def chassis(mb):
    for sx in (1, -1):
        rbox(mb, 'taco_trim', *sorted((sx * 0.34, sx * 0.43)), -2.58, 2.36, FRAME_Z, 0.70, r=0.01, grid=0.6)
        rbox(mb, 'taco_trim', *sorted((sx * 0.80, sx * 0.925)), -0.66, 0.95, 0.585, 0.68, r=0.022, grid=0.4)   # rock slider
        for yb in (-0.45, 0.15, 0.72):
            rbox(mb, 'taco_trim', *sorted((sx * 0.43, sx * 0.81)), yb - 0.03, yb + 0.03, 0.60, 0.655, r=0.0)
        # mirrors
        rbox(mb, 'taco_trim', *sorted((sx * 0.80, sx * 0.975)), 0.86, 0.90, 1.57, 1.605, r=0.008)
        rbox(mb, 'taco_paint', *sorted((sx * 0.935, sx * 1.015)), 0.80, 0.97, 1.55, 1.76, r=0.022)
    for yc in (2.0, 0.6, -0.6, -2.4):
        rbox(mb, 'taco_trim', -0.34, 0.34, yc - 0.04, yc + 0.04, 0.57, 0.66, r=0.0)


def rack_and_cargo(mb):
    tr = 0.022
    for sx in (1, -1):
        x = sx * RACK_X
        for y in RACK_Y:
            cyl(mb, 'taco_trim', (x, y, Z_BED_TOP - 0.02), (x, y, RACK_TOP + tr), tr)
        cyl(mb, 'taco_trim', (x, RACK_Y[0] + tr, RACK_TOP), (x, RACK_Y[1] - tr, RACK_TOP), tr)
        cyl(mb, 'taco_trim', (x, RACK_Y[1], RACK_TOP), (x, -2.05, Z_BED_TOP - 0.01), tr)   # rear brace
    for y in RACK_Y:
        cyl(mb, 'taco_trim', (-RACK_X - 0.05, y, RACK_TOP), (RACK_X + 0.05, y, RACK_TOP), tr)
        cyl(mb, 'taco_trim', (SHELF_X[0], y, SHELF_Z - 0.03), (SHELF_X[1], y, SHELF_Z - 0.03), tr * 0.9)
    rbox(mb, 'taco_trim', SHELF_X[0], SHELF_X[1], RACK_Y[1] - 0.02, RACK_Y[0] + 0.02, SHELF_Z - 0.02, SHELF_Z, r=0.0)
    # two red jerry cans with three-bar handles and a spout cap
    for (x0, x1) in CANS:
        rbox(mb, 'taco_cargo', x0, x1, CAN_Y[0], CAN_Y[1], CAN_Z[0], CAN_Z[1], r=0.02, seg=1)
        cx = (x0 + x1) / 2
        yc = (CAN_Y[0] + CAN_Y[1]) / 2 - 0.02
        for dy in (-0.10, 0.0, 0.10):
            rbox(mb, 'taco_cargo', cx - 0.014, cx + 0.014, yc + dy - 0.015, yc + dy + 0.015, CAN_Z[1] - 0.01, CAN_Z[1] + 0.028, r=0.0)
        rbox(mb, 'taco_cargo', cx - 0.016, cx + 0.016, yc - 0.12, yc + 0.12, CAN_Z[1] + 0.02, CAN_Z[1] + 0.036, r=0.0)
        cyl(mb, 'taco_trim', (cx, CAN_Y[1] - 0.04, CAN_Z[1] - 0.01), (cx, CAN_Y[1] - 0.04, CAN_Z[1] + 0.03), 0.024, segs=8)
    rbox(mb, 'taco_trim', *CASE_A, r=0.022)
    rbox(mb, 'taco_trim', *CASE_B, r=0.022)
    bx0, bx1, by, br = BAG
    cyl(mb, 'taco_cargo', (bx0, by, Z_FLOOR + br), (bx1, by, Z_FLOOR + br), br, segs=10)
    # upright spare, face towards -X
    M = Matrix.Translation(SPARE) @ Matrix.Rotation(math.pi, 4, 'Z')
    wheel_geo(mb, 'taco_wheel', M)


# =============================================================== wheel (tyre with staggered lugs + dark six-spoke rim)
TYRE_PROFILE = [(-0.118, 0.240), (-0.155, 0.320), (-0.160, 0.390), (-0.138, 0.418), (-0.110, 0.425), (-0.055, 0.425),
                (0.0, 0.425), (0.055, 0.425), (0.110, 0.425), (0.138, 0.418), (0.160, 0.390), (0.155, 0.320),
                (0.118, 0.240)]
RIM_PROFILE = [(-0.110, 0.240), (0.126, 0.246), (0.110, 0.222), (0.092, 0.186), (0.092, 0.085), (0.116, 0.056)]
NSEG = 30
LUG_H = R - 0.425


def wheel_geo(mb, mat, M=Matrix.Identity(4)):
    bm = mb.bm
    mi = mb.mi(mat)
    for f in bm.faces:
        f.tag = True          # everything untagged after this point belongs to this wheel

    def rev(profile, n):
        rings = [[bm.verts.new((x, r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n))) for (x, r) in profile]
                 for i in range(n)]
        grid = []
        for i in range(n):
            a, b = rings[i], rings[(i + 1) % n]
            row = []
            for k in range(len(profile) - 1):
                row.append(bm.faces.new((a[k], b[k], b[k + 1], a[k + 1])))
            grid.append(row)
        return rings, grid

    def face_out(faces, probe, want):
        probe.normal_update()
        if probe.normal.dot(want) < 0:
            for f in faces:
                f.normal_flip()

    _, tg = rev(TYRE_PROFILE, NSEG)
    tyre = [f for row in tg for f in row]
    face_out(tyre, tg[0][6], Vector((0, *tg[0][6].calc_center_median().yz)))
    # staggered lugs: left half on even segments, right half on odd ones, wrapping onto the shoulders
    for i in range(NSEG):
        region = [tg[i][k] for k in ((3, 4, 5) if i % 2 == 0 else (6, 7, 8))]
        ret = bmesh.ops.extrude_face_region(bm, geom=region)
        for v in (e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)):
            v.co += Vector((0, v.co.y, v.co.z)).normalized() * LUG_H
            if abs(v.co.x) > 0.12:
                v.co.x += math.copysign(0.018, v.co.x)
        left = [f for f in region if f.is_valid]
        if left:
            bmesh.ops.delete(bm, geom=left, context='FACES_ONLY')
    # rim: barrel + lip + dished face, closed with a centre fan
    rr, rg = rev(RIM_PROFILE, 20)
    rim = [f for row in rg for f in row]
    face_out(rim, rg[0][3], Vector((1, 0, 0)))
    ctr = bm.verts.new((0.128, 0, 0))
    fan = [bm.faces.new((rr[i][-1], rr[(i + 1) % 20][-1], ctr)) for i in range(20)]
    face_out(fan, fan[0], Vector((1, 0, 0)))
    rim += fan
    bm.normal_update()
    return _wheel_uv(mb, mi, rim, M)


def _wheel_uv(mb, mi, rim, M):
    bm, uv = mb.bm, mb.uv
    rim_set = set(rim)
    faces = [f for f in bm.faces if not f.tag]
    for f in faces:
        f.tag = True
        f.material_index = mi
        mb.fixed_uv.add(f)
        f.normal_update()
        c = f.calc_center_median()
        n = f.normal
        ca = math.atan2(c.z, c.y) % (2 * math.pi)
        radc = Vector((0, c.y, c.z))
        rlen = radc.length
        if f in rim_set:
            barrel = abs(n.x) < 0.5
            for l in f.loops:
                if barrel:
                    u, v = REG_RIMBACK[0] + 2, REG_RIMBACK[1] + 2
                else:
                    u = REG_RIM[0] + (l.vert.co.y + 0.3125) * PX
                    v = REG_RIM[1] + (l.vert.co.z + 0.3125) * PX
                l[uv].uv = (u / WHEEL_W, v / WHEEL_H)
            continue
        if abs(n.x) > 0.75:
            kind = 'side'
        elif rlen > 1e-6 and n.dot(radc / rlen) > 0.6:
            kind = 'top' if rlen > 0.445 else 'groove'
        else:
            kind = 'lugside'
        for l in f.loops:
            co = l.vert.co
            a = math.atan2(co.z, co.y) % (2 * math.pi)
            if a - ca > math.pi:
                a -= 2 * math.pi
            elif ca - a > math.pi:
                a += 2 * math.pi
            if a < 0:
                a += 2 * math.pi   # keep u positive; wrap columns repeat the start of the strip
            uu = a / (2 * math.pi) * TREAD_U
            if kind == 'top':
                u, v = REG_TREAD[0] + uu, REG_TREAD[1] + (co.x + 0.165) * PX
            elif kind == 'side':
                u, v = REG_SIDE[0] + uu, REG_SIDE[1] + (Vector((0, co.y, co.z)).length - 0.235) * PX
            elif kind == 'groove':
                u, v = REG_GROOVE[0] + 2, REG_GROOVE[1] + 2
            else:
                u, v = REG_LUGSIDE[0] + 2, REG_LUGSIDE[1] + 2
            l[uv].uv = (u / WHEEL_W, v / WHEEL_H)
    verts = {v for f in faces for v in f.verts}
    bmesh.ops.transform(bm, matrix=M, verts=list(verts))
    return faces


# =============================================================== rear axle (solid, with diff pumpkin)
def axle_geo(mb):
    y, z = RY, R
    cyl(mb, 'taco_trim', (-0.625, y, z), (0.625, y, z), 0.055, segs=10)
    for sx in (1, -1):
        cyl(mb, 'taco_trim', (sx * 0.595, y, z), (sx * 0.635, y, z), 0.09, segs=10)
        rbox(mb, 'taco_trim', *sorted((sx * 0.43, sx * 0.53)), y - 0.06, y + 0.06, z + 0.04, z + 0.085, r=0.0)   # spring perch
    t = bmesh.new()
    bmesh.ops.create_uvsphere(t, u_segments=12, v_segments=8, radius=0.15)
    bmesh.ops.transform(t, matrix=Matrix.Translation((0.08, y, z)) @ Matrix.Diagonal((1.0, 0.85, 1.0, 1.0)), verts=t.verts)
    mb.append(t, 'taco_trim')
    cyl(mb, 'taco_trim', (0.08, y - 0.10, z), (0.08, y - 0.145, z), 0.118, segs=12)   # diff cover
    cyl(mb, 'taco_trim', (0.08, y + 0.10, z), (0.08, y + 0.24, z), 0.055, segs=8, r1=0.045)   # pinion snout


# =============================================================== textures / materials / UVs
def np_to_image(name, arr):
    h, w, _ = arr.shape
    path = os.path.join(OUT, name + '.png')
    img = bpy.data.images.new(name + '_tmp', w, h, alpha=False)
    rgba = np.concatenate([arr.astype(np.float32) / 255.0, np.ones((h, w, 1), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    img = bpy.data.images.load(path)
    img.name = name
    img.pack()
    return img


def make_material(name, img, rough=1.0, emissive=False):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    tex.location = (-400, 200)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    if emissive:
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    return m


def build_atlases():
    A = {
        'taco_paint': Atlas('taco_paint', (-0.95, 0.95), (-2.80, 2.70), (0.50, 2.20), paint_olive,
                            [['side', 'front'], ['top', 'rear'], ['inx', 'iny', 'bottom']], inner_z=(0.92, 1.50)),
        'taco_trim': Atlas('taco_trim', (-1.05, 1.05), (-2.80, 2.70), (0.50, 2.20), paint_trim,
                           [['side', 'front'], ['top', 'rear', 'bottom']]),
        'taco_glass': Atlas('taco_glass', (-1.02, 1.02), (-0.75, 1.15), (1.48, 2.13), paint_glass,
                            [['side', 'front', 'rear'], ['top', 'bottom']]),
        'taco_lamp': Atlas('taco_lamp', (-0.9, 0.9), (2.30, 2.70), (0.80, 1.33), paint_lamp,
                           [['front', 'side'], ['top', 'bottom']]),
        'taco_tail': Atlas('taco_tail', (-0.9, 0.9), (-2.70, -0.65), (1.02, 2.10), paint_tail,
                           [['rear', 'side', 'top', 'bottom']]),
        'taco_cargo': Atlas('taco_cargo', (-0.70, 0.75), (-2.40, -1.05), (1.00, 2.15), paint_cargo,
                            [['side', 'front', 'rear', 'top', 'bottom']]),
    }
    for a in A.values():
        a.paint()
    return A


def choose_kind(mat, n, c):
    ax_, ay_, az_ = abs(n.x), abs(n.y), abs(n.z)
    if mat in ('taco_paint', 'taco_trim'):
        for yc in (FY, RY):
            d = Vector((0, yc - c.y, R - c.z))
            if abs(c.x) > 0.55 and d.length < AR + 0.06 and ax_ < 0.7 and n.dot(d.normalized()) > 0.35:
                return 'bottom'          # wheel-well undersides
    if mat == 'taco_glass':
        if n.y > 0.3:
            return 'front'
        if n.y < -0.3:
            return 'rear'
        return 'top' if az_ > ax_ else 'side'
    if mat == 'taco_paint':
        inbed = (Y_BED_R + 0.02 < c.y < Y_BED_F - 0.02) and abs(c.x) < BED_IN + 0.004 and c.z > 0.93
        if inbed and az_ < max(ax_, ay_):
            return 'inx' if ax_ >= ay_ else 'iny'
        if n.y < -0.5 and ay_ >= max(ax_, az_) and c.y > Y_BED_R + 0.1 and c.z < Z_BELT + 0.01:
            return 'iny'
    if az_ >= ax_ and az_ >= ay_:
        return 'top' if n.z > 0 else 'bottom'
    if ax_ >= ay_:
        return 'side'
    return 'front' if n.y > 0 else 'rear'


def project_uvs(mb, atlases):
    for f in mb.bm.faces:
        if f in mb.fixed_uv:
            continue
        mat = mb.mats[f.material_index]
        a = atlases[mat]
        f.normal_update()
        kind = choose_kind(mat, f.normal, f.calc_center_median())
        if kind not in a.R:
            kind = 'side' if 'side' in a.R else 'front'
        for l in f.loops:
            l[mb.uv].uv = a.uv(kind, l.vert.co)


def mb_to_object(mb, name, mats, origin):
    me = bpy.data.meshes.new(name)
    bmesh.ops.transform(mb.bm, matrix=Matrix.Translation(-Vector(origin)), verts=mb.bm.verts)
    mb.bm.to_mesh(me)
    mb.bm.free()
    for mname in mb.mats:
        me.materials.append(mats[mname])
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(38))
    o = bpy.data.objects.new(name, me)
    o.location = origin
    bpy.context.scene.collection.objects.link(o)
    return o


def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.25
    e.location = loc
    bpy.context.scene.collection.objects.link(e)
    return e


# =============================================================== build
def build():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    os.makedirs(OUT, exist_ok=True)
    atl = build_atlases()
    imgs = {k: np_to_image(k, a.img) for k, a in atl.items()}
    imgs['taco_wheel'] = np_to_image('taco_wheel', paint_wheel())
    mats = {
        'taco_paint': make_material('taco_paint', imgs['taco_paint']),
        'taco_trim': make_material('taco_trim', imgs['taco_trim']),
        'taco_glass': make_material('taco_glass', imgs['taco_glass'], rough=0.2),
        'taco_lamp': make_material('taco_lamp', imgs['taco_lamp'], emissive=True),
        'taco_tail': make_material('TailLight', imgs['taco_tail']),
        'taco_cargo': make_material('taco_cargo', imgs['taco_cargo']),
        'taco_wheel': make_material('taco_wheel', imgs['taco_wheel']),
    }
    # ---- Body
    mb = MB()
    lower_body(mb)
    greenhouse(mb)
    glass(mb)
    hood_scoop(mb)
    bed(mb)
    flares(mb)
    front_end(mb)
    bumper_wings(mb)
    rear_end(mb)
    chassis(mb)
    rack_and_cargo(mb)
    project_uvs(mb, atl)
    body = mb_to_object(mb, 'Body', mats, (0, 0, CHASSIS_Z))
    # ---- Wheel (one; the game mirrors it for the left side), parked at the front-right hub
    wb = MB()
    wheel_geo(wb, 'taco_wheel')
    wheel = mb_to_object(wb, 'Wheel', mats, (0, 0, 0))
    wheel.location = (HX, FY, R)
    wheel['tyre_radius'] = R
    wheel['tyre_width'] = TW
    # ---- AxleRear
    ab = MB()
    axle_geo(ab)
    project_uvs(ab, atl)
    axle = mb_to_object(ab, 'AxleRear', mats, (0, RY, R))
    # ---- markers
    for nm, sx, y in (('Marker_WheelFL', -1, FY), ('Marker_WheelFR', 1, FY), ('Marker_WheelRL', -1, RY), ('Marker_WheelRR', 1, RY)):
        empty(nm, (sx * HX, y, R))
    empty('Marker_Ground', (0, 0, 0))
    report_counts()
    export()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'taco.blend'), compress=True)
    print('[taco] saved', os.path.join(OUT, 'taco.blend'))


def tri_count(o):
    me = o.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def report_counts():
    for o in bpy.data.objects:
        if o.type == 'MESH':
            bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
            mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
            mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
            print(f'[taco] {o.name}: tris={tri_count(o)} min={tuple(round(v, 3) for v in mn)} max={tuple(round(v, 3) for v in mx)}')


def export():
    os.makedirs(os.path.dirname(GLB), exist_ok=True)
    for o in bpy.data.objects:
        o.select_set(o.name in ('Body', 'Wheel', 'AxleRear') or o.name.startswith('Marker_'))
    bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_apply=True,
                              export_extras=True, export_yup=True)
    print('[taco] exported', GLB, os.path.getsize(GLB), 'bytes')


# =============================================================== preview (toon + outline + low-res pixels)
SHADOW = (0.60, 0.47, 0.56)
MID = (0.84, 0.76, 0.76)
LIT = (1.04, 1.0, 0.95)


def toonify(m):
    nt = m.node_tree
    tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)
    emissive = m.name == 'taco_lamp'
    for n in list(nt.nodes):
        if n.name != tex.name:
            nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    if emissive:
        nt.links.new(tex.outputs[0], em.inputs[0])
        return
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*SHADOW, 1)
    cr.elements[1].position = 0.40
    cr.elements[1].color = (*LIT, 1)
    e = cr.elements.new(0.12)
    e.color = (*MID, 1)
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(s2r.outputs[0], bw.inputs[0])
    nt.links.new(bw.outputs[0], ramp.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 1.0
    nt.links.new(tex.outputs[0], mix.inputs[6])
    nt.links.new(ramp.outputs[0], mix.inputs[7])
    nt.links.new(mix.outputs[2], em.inputs[0])


def outline_material():
    m = bpy.data.materials.new('PrevOutline')
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    c = [int('2a1a14'[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    em.inputs['Color'].default_value = (*[((x + 0.055) / 1.055) ** 2.4 for x in c], 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = True
    return m


def add_outline(o, om, th=0.022):
    o.data.materials.append(om)
    md = o.modifiers.new('outline', 'SOLIDIFY')
    md.thickness = th
    md.offset = 1.0
    md.use_flip_normals = True
    md.use_rim = False
    md.material_offset = len(o.data.materials) - 1


def setup_preview():
    sc = bpy.context.scene
    for m in list(bpy.data.materials):
        if m.node_tree and any(n.type == 'TEX_IMAGE' for n in m.node_tree.nodes):
            toonify(m)
    om = outline_material()
    body, wheel, axle = bpy.data.objects['Body'], bpy.data.objects['Wheel'], bpy.data.objects['AxleRear']
    wheels = [wheel]
    for nm, sx, y in (('FL', -1, FY), ('RL', -1, RY), ('RR', 1, RY)):
        w = bpy.data.objects.new('PrevWheel' + nm, wheel.data)
        w.location = (sx * HX, y, R)
        w.rotation_euler = (0, 0, math.pi if sx < 0 else 0)
        sc.collection.objects.link(w)
        wheels.append(w)
    for o in [body, axle, wheel]:
        add_outline(o, om)
    for w in wheels[1:]:
        md = w.modifiers.new('outline', 'SOLIDIFY')
        md.thickness, md.offset, md.use_flip_normals, md.use_rim = 0.022, 1.0, True, False
        md.material_offset = len(w.data.materials) - 1
    # ground
    dirt = np_to_image('prev_dirt', paint_dirt())
    gm = make_material('PrevDirt', dirt)
    toonify(gm)
    gme = bpy.data.meshes.new('PrevGround')
    S = 40.0
    gme.from_pydata([(-S, -S, 0), (S, -S, 0), (S, S, 0), (-S, S, 0)], [], [(0, 1, 2, 3)])
    uvl = gme.uv_layers.new(name='UVMap')
    k = S * 2 * PX / 64
    for i, (u, v) in enumerate(((0, 0), (k, 0), (k, k), (0, k))):
        uvl.data[i].uv = (u, v)
    gme.materials.append(gm)
    g = bpy.data.objects.new('PrevGround', gme)
    sc.collection.objects.link(g)
    # light, world, camera
    sd = bpy.data.lights.new('PrevSun', 'SUN')
    sd.energy = 3.2
    sd.color = (1.0, 0.95, 0.86)
    sd.angle = 0.0
    for k, v in (('use_shadow_jitter', False), ('shadow_jitter_overblur', 0.0), ('shadow_filter_radius', 0.0),
                 ('shadow_resolution_limit', 0.002)):
        if hasattr(sd, k):
            setattr(sd, k, v)
    sun = bpy.data.objects.new('PrevSun', sd)
    sc.collection.objects.link(sun)
    w = bpy.data.worlds.new('PrevWorld')
    sc.world = w
    if w.node_tree is None:
        w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.9, 0.7, 0.45, 1)
    bg.inputs['Strength'].default_value = 0.35
    cd = bpy.data.cameras.new('PrevCam')
    cd.type = 'ORTHO'
    cam = bpy.data.objects.new('PrevCam', cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 1
    for k, v in (('use_shadows', True), ('shadow_ray_count', 1), ('shadow_step_count', 1), ('shadow_resolution_scale', 1.0)):
        if hasattr(sc.eevee, k):
            setattr(sc.eevee, k, v)
    sc.render.filter_size = 0.0
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 480, 300, 100
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    return cam, sun


VIEWS = {
    # name: (azimuth deg from +Y towards -X, elevation deg, ortho width, target)
    'front34': (40, 22, 6.3, (0, -0.1, 1.05)),
    'side': (90, 6, 6.4, (0, -0.06, 1.05)),
    'rear34': (-140, 22, 6.3, (0, -0.1, 1.05)),
    'front': (0, 14, 5.0, (0, 0, 0.98)),
    'rear': (180, 14, 5.0, (0, 0, 0.98)),
}


def render_views(cam, sun, names, tag=''):
    sc = bpy.context.scene
    os.makedirs(PREV, exist_ok=True)
    for name in names:
        az, el, ow, tgt = VIEWS[name]
        a, e = math.radians(az), math.radians(el)
        d = Vector((-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
        T = Vector(tgt)
        cam.location = T + d * 20
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        cam.data.ortho_scale = ow
        cam.data.clip_end = 100
        fwd = Vector((-d.x, -d.y, 0)).normalized()
        left = Vector((-fwd.y, fwd.x, 0))
        L = (-fwd * 1.0 + left * 0.65 + Vector((0, 0, 1.1))).normalized()
        sun.rotation_euler = (-L).to_track_quat('-Z', 'Y').to_euler()
        small = os.path.join(OUT, f'prev_{name}{tag}_small.png')
        sc.render.filepath = small
        bpy.ops.render.render(write_still=True)
        upscale(small, os.path.join(PREV, f'taco_{name}.png') if not tag else os.path.join(OUT, f'taco_{name}{tag}.png'), 3)
        print('[taco] rendered', name)


def upscale(src, dst, k):
    img = bpy.data.images.load(src)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    up = px.repeat(k, 0).repeat(k, 1)
    out = bpy.data.images.new('up_' + os.path.basename(dst), w * k, h * k, alpha=True)
    out.pixels.foreach_set(up.ravel())
    out.filepath_raw = dst
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    bpy.data.images.remove(img)


# =============================================================== verify (fresh import of the .glb)
def verify():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    print('[verify] objects after import:')
    for o in sorted(bpy.data.objects, key=lambda o: o.name):
        extra = {k: (round(o[k], 4) if isinstance(o[k], float) else o[k]) for k in o.keys() if not k.startswith('_')}
        line = f'  {o.name:16s} {o.type:6s} parent={o.parent.name if o.parent else None} loc={tuple(round(v, 3) for v in o.matrix_world.translation)}'
        if o.type == 'MESH':
            bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
            mn = tuple(round(min(v[i] for v in bb), 3) for i in range(3))
            mx = tuple(round(max(v[i] for v in bb), 3) for i in range(3))
            line += f' tris={tri_count(o)} min={mn} max={mx} mats={[m.name for m in o.data.materials]}'
        if extra:
            line += f' extras={extra}'
        print(line)
    for m in bpy.data.materials:
        if m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image:
                    print(f'  material {m.name}: image {n.image.size[0]}x{n.image.size[1]} interp={n.interpolation}')
    # raw glTF: node names/extras and the Body accessor bounds in glTF axes (front must be -Z)
    with open(GLB, 'rb') as fh:
        data = fh.read()
    ln = struct.unpack('<I', data[12:16])[0]
    gl = json.loads(data[20:20 + ln])
    for nd in gl['nodes']:
        print('  [gltf node]', nd.get('name'), 't=', [round(v, 3) for v in nd.get('translation', [0, 0, 0])], 'extras=', nd.get('extras'))
    for nd in gl['nodes']:
        if nd.get('name') == 'Body':
            mesh = gl['meshes'][nd['mesh']]
            mins = [min(gl['accessors'][p['attributes']['POSITION']]['min'][i] for p in mesh['primitives']) for i in range(3)]
            maxs = [max(gl['accessors'][p['attributes']['POSITION']]['max'][i] for p in mesh['primitives']) for i in range(3)]
            print('  [gltf] Body local bounds x/y/z min', [round(v, 3) for v in mins], 'max', [round(v, 3) for v in maxs])
            # front bumper/lamps must be at negative glTF z
            print('  [gltf] front (most negative z) =', round(mins[2], 3), ' rear =', round(maxs[2], 3))
    print('  [gltf] materials:', [m['name'] for m in gl['materials']])
    print('  [gltf] images:', [(im.get('name'), im.get('mimeType')) for im in gl.get('images', [])])
    print('  [gltf] samplers:', gl.get('samplers'))


def checks():
    """Spec checks on the built scene (world space, ground z = 0)."""
    body = bpy.data.objects['Body']
    me = body.data
    M = body.matrix_world
    zs = [(M @ v.co).z for v in me.vertices]
    print(f'[check] Body lowest point z = {min(zs):.3f} (frame bottom target {FRAME_Z})')
    worst, wp = 9, None
    for v in me.vertices:
        p = M @ v.co
        for yc in (FY, RY):
            if HX - TW / 2 - 0.05 <= abs(p.x) <= HX + TW / 2 + 0.05 and p.z > R - 0.1:
                d = math.hypot(p.y - yc, p.z - R)
                if d < worst:
                    worst, wp = d, p
    print(f'[check] closest Body vertex to a hub inside the tyre slot: {worst:.3f} m at {tuple(round(c, 3) for c in wp)} (need >= {R + BUMP + 0.06:.3f})')


if __name__ == '__main__':
    if 'verify' in ARGS:
        verify()
    else:
        build()
        checks()
        if 'nopreview' not in ARGS:
            cam, sun = setup_preview()
            render_views(cam, sun, ['front34', 'side', 'rear34', 'front', 'rear'])
