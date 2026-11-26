# LowRange lc70 (cream 70-series-style wagon), v2.
# Run headless:
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_lc70_v2.py
# Builds the model from lofted profiles, paints pixel textures in code (lc70_tex.py), exports
# public/models/vehicles/lc70.glb, saves tools/blender/out/lc70.blend and renders toon/pixel previews
# to docs/previews/lc70_*.png.  Optional: --no-preview after "--" to skip rendering.
# Blender axes: +X right, +Y forward, +Z up (exports as glTF -Z forward, +Y up).
import os
import sys
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import importlib
import lc70_tex as T
importlib.reload(T)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = os.path.join(HERE, 'out')
GLB = os.path.join(REPO, 'public', 'models', 'vehicles', 'lc70.glb')
BLEND = os.path.join(OUT_DIR, 'lc70.blend')
PREV_DIR = os.path.join(REPO, 'docs', 'previews')
for d in (OUT_DIR, os.path.dirname(GLB), PREV_DIR):
    os.makedirs(d, exist_ok=True)

# ------------------------------------------------------------------ dimensions (docs/MODELING_SPEC.md, lc70)
R, TW = 0.455, 0.30           # tyre radius / width
TRACK, WB = 1.56, 2.73
AY = WB / 2                   # axle y (front +, rear -)
CZ = 0.86                     # chassis centre height (Body origin)
FRAME_Z = 0.53                # frame bottom
SILL = 0.66
BELT = 1.52
ROOF_Z = 2.14
LB_F, LB_R = 2.22, -2.18      # lower body front / rear faces
COWL_Y = 0.80
BON_F = 1.40                  # bonnet height at the nose
HW_B, HW_T = 0.865, 0.895     # lower body half width at sill / shoulder
ARCH_CZ, ARCH_R = 0.50, 0.60  # arch opening: top = 1.10 = tyre top 0.91 + bump 0.13 + 0.06
WIN_Z0, WIN_Z1 = 1.60, 2.00
SCREEN_RAKE = 0.24            # windscreen top sits this far behind its base
CAB_Z0 = 1.36
CAB_R = -2.18
SCREEN_TOP_Y = COWL_Y - SCREEN_RAKE
BUMP_Z0, BUMP_Z1 = 0.60, 0.84
RBUMP_Z1 = 0.82
FBUMP_Y0, FBUMP_Y1 = 2.18, 2.42
RBUMP_Y0, RBUMP_Y1 = -2.14, -2.38
STEP_Y = 0.70
HEAD_X, HEAD_Z = 0.62, 1.12
RIM_R = 0.27


def y_front(z):
    """windscreen / A-pillar line: y of the cabin front at height z"""
    return COWL_Y - (z - BELT) * SCREEN_RAKE / (ROOF_Z - BELT)


A_PILLAR_W = 0.13
D = dict(AY=AY, ARCH_CZ=ARCH_CZ, ARCH_R=ARCH_R, SILL=SILL, BELT=BELT, WIN_Z0=WIN_Z0, WIN_Z1=WIN_Z1,
         ROOF_Z=ROOF_Z, BUMP_Z0=BUMP_Z0, BUMP_Z1=BUMP_Z1, RBUMP_Z1=RBUMP_Z1, LB_F=LB_F, LB_R=LB_R,
         COWL_Y=COWL_Y, BON_F=BON_F, BONNET_X=0.66, CAB_R=CAB_R, SCREEN_TOP_Y=SCREEN_TOP_Y,
         FBUMP_Y0=FBUMP_Y0, RBUMP_Y0=RBUMP_Y0, STEP_Y=STEP_Y, GRILLE_X=0.44, GRILLE_Z0=0.93, GRILLE_Z1=1.31,
         HEAD_X=HEAD_X, HEAD_Z=HEAD_Z, RDOOR_X=0.76, RIM_R=RIM_R,
         A_PILLAR_Y=lambda z: y_front(z) - A_PILLAR_W,
         DOOR_SEAMS=[0.74, -0.27, -1.30], HANDLES=[-0.12, -1.14])

# material slots, same order on every part so joins keep indices
M_PAINT, M_GLASS, M_LAMP, M_TAIL, M_WHEEL = range(5)

# ------------------------------------------------------------------ scene reset
bpy.ops.wm.read_factory_settings(use_empty=True)
SC = bpy.context.scene
SC.name = 'LowRange_lc70'
COLL = SC.collection


# ------------------------------------------------------------------ images + materials
def make_image(name, cv, repeat=False):
    img = bpy.data.images.new(name, cv.W, cv.H, alpha=False)
    rgba = np.ones((cv.H, cv.W, 4), dtype=np.float32)
    rgba[..., :3] = cv.a.astype(np.float32) / 255.0
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'PNG'
    path = os.path.join(OUT_DIR, name + '.png')
    img.filepath_raw = path
    img.save()
    img.pack()
    return img


def principled(m):
    return next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def make_mat(name, img, rough=1.0, emit=0.0, repeat=False):
    m = bpy.data.materials.new(name)   # Blender 5: materials always have a node tree
    nt = m.node_tree
    b = principled(m)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    tex.extension = 'REPEAT' if repeat else 'EXTEND'
    tex.location = (-400, 200)
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    if emit > 0:
        nt.links.new(tex.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emit
    m['tex'] = img.name
    return m


IMG = {
    'paint': make_image('lc70_paint', T.paint_body(D)),
    'glass': make_image('lc70_glass', T.paint_glass()),
    'lamp': make_image('lc70_lamp', T.paint_lamp()),
    'tail': make_image('lc70_tail', T.paint_tail()),
    'wheel': make_image('lc70_wheel', T.paint_wheel(D)),
}
MATS = [
    make_mat('LC70_Paint', IMG['paint']),
    make_mat('LC70_Glass', IMG['glass'], rough=0.2, repeat=True),
    make_mat('LC70_Lamp', IMG['lamp'], emit=1.0),
    make_mat('TailLight', IMG['tail'], emit=1.0),
    make_mat('LC70_Wheel', IMG['wheel']),
]


# ------------------------------------------------------------------ UV rules
def uv_paint_proj(n, co):
    """planar projection into the paint atlas by dominant normal axis"""
    ax = max(range(3), key=lambda i: abs(n[i]))
    if ax == 0:
        return T.SIDE.uv(co.y, co.z, T.W_PAINT, T.H_PAINT)
    if ax == 1:
        reg = T.FRONT if n.y > 0 else T.REAR
        return reg.uv(co.x, co.z, T.W_PAINT, T.H_PAINT)
    if n.z > 0:
        return T.TOP.uv(co.y, co.x, T.W_PAINT, T.H_PAINT)
    return T.swatch_uv('black', 3)


def tone_by_normal(n):
    if n.z > 0.6:
        return 0
    if n.z < -0.4:
        return 3
    return 1


def set_uvs(bm, rule):
    """rule(face) -> None (projection) | ('sw', ramp, tone) | callable(co)->uv"""
    uvl = bm.loops.layers.uv.verify()
    for f in bm.faces:
        res = rule(f)
        n = f.normal
        if f.material_index == M_GLASS:
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                c = l.vert.co
                a = c.y if ax == 0 else c.x
                l[uvl].uv = (a * T.PX / 64.0, (c.z - 1.5) * T.PX / 64.0)
            continue
        if res is None:
            for l in f.loops:
                l[uvl].uv = uv_paint_proj(n, l.vert.co)
        elif isinstance(res, tuple) and res[0] == 'sw':
            uv = T.swatch_uv(res[1], res[2] if res[2] is not None else tone_by_normal(n))
            for l in f.loops:
                l[uvl].uv = uv
        else:
            for l in f.loops:
                l[uvl].uv = res(l.vert.co)


def proj_rule(f):
    return None


def black_rule(f):
    return ('sw', 'black', None)


def obj_from_bm(name, bm, smooth_angle=40.0):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in MATS:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    COLL.objects.link(o)
    return o


# ------------------------------------------------------------------ geometry helpers
def half_profile(hw_b, hw_t, z0, z1, rb, rt, crown, side_z, nb=4, nt=4, ca=3, bulge=0.0):
    """right half of a rounded cross-section, bottom centre -> top centre, as (x, z)"""
    pts = []
    xb = hw_b - rb
    for i in range(nb):
        pts.append((xb * i / nb, z0))
    for k in range(ca + 1):
        a = -math.pi / 2 + math.pi / 2 * k / ca
        pts.append((hw_b - rb + rb * math.cos(a), z0 + rb + rb * math.sin(a)))
    za, zb = z0 + rb, z1 - rt
    for z in side_z:
        t = (z - za) / (zb - za)
        pts.append((hw_b + (hw_t - hw_b) * t + bulge * math.sin(math.pi * t), z))
    for k in range(ca + 1):
        a = math.pi / 2 * k / ca
        pts.append((hw_t - rt + rt * math.cos(a), z1 - rt + rt * math.sin(a)))
    xt = hw_t - rt
    for i in range(1, nt + 1):
        x = xt * (1 - i / nt)
        pts.append((x, z1 + crown * (1 - (x / xt) ** 2)))
    return pts


def full_loop(half):
    return half + [(-x, z) for (x, z) in reversed(half[1:-1])]


def inset_loop(loop, d):
    """offset a convex closed 2D loop inward by d (along vertex normals)"""
    n = len(loop)
    cx = sum(p[0] for p in loop) / n
    cz = sum(p[1] for p in loop) / n
    out = []
    for i in range(n):
        p0, p1, p2 = loop[i - 1], loop[i], loop[(i + 1) % n]
        tx, tz = p2[0] - p0[0], p2[1] - p0[1]
        L = math.hypot(tx, tz) or 1.0
        nx, nz = tz / L, -tx / L
        # make it point inward
        if (cx - p1[0]) * nx + (cz - p1[1]) * nz < 0:
            nx, nz = -nx, -nz
        out.append((p1[0] + nx * d, p1[1] + nz * d))
    return out


def loft(bm, rings, cap0=True, cap1=True):
    """rings: list of lists of Vector (same length, closed). Returns (grid faces[i][j], cap faces)"""
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    grid = []
    for i in range(len(vs) - 1):
        row = []
        for j in range(n):
            j2 = (j + 1) % n
            row.append(bm.faces.new((vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j])))
        grid.append(row)
    caps = []
    if cap0:
        caps.append(bm.faces.new(vs[0]))
    if cap1:
        caps.append(bm.faces.new(vs[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return grid, caps


def fill_cap(bm, f, step=0.25):
    """replace a convex planar n-gon with concentric rings + a centre fan (~step m apart),
    so big flat end panels get vertices for crash dents and no sliver triangles"""
    loop = list(f.verts)
    mi = f.material_index
    c = f.calc_center_median()
    reach = max((v.co - c).length for v in loop)
    steps = max(1, int(round(reach / step)))
    bmesh.ops.delete(bm, geom=[f], context='FACES_ONLY')
    outer = loop
    new = []
    for k in range(1, steps):
        t = k / steps
        inner = [bm.verts.new(v.co.lerp(c, t)) for v in loop]
        for j in range(len(loop)):
            j2 = (j + 1) % len(loop)
            new.append(bm.faces.new((outer[j], outer[j2], inner[j2], inner[j])))
        outer = inner
    cv = bm.verts.new(c)
    for j in range(len(loop)):
        new.append(bm.faces.new((outer[j], outer[(j + 1) % len(loop)], cv)))
    for nf in new:
        nf.material_index = mi
    return new


def end_rounding(loop2d, y_end, sign, r, K, place):
    """rounded end: K extra rings beyond y_end, each inset more (quarter circle of radius r)"""
    rings = []
    for k in range(1, K + 1):
        th = math.pi / 2 * k / K
        d = r * (1 - math.cos(th))
        dy = r * math.sin(th)
        rings.append(place(inset_loop(loop2d, d), y_end + sign * dy))
    return rings


def box_bm(bm, lo, hi, mat=M_PAINT):
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    v = [bm.verts.new(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                   (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    fs = [bm.faces.new(q) for q in ((v[0], v[3], v[2], v[1]), (v[4], v[5], v[6], v[7]), (v[0], v[1], v[5], v[4]),
                                     (v[1], v[2], v[6], v[5]), (v[2], v[3], v[7], v[6]), (v[3], v[0], v[4], v[7]))]
    for f in fs:
        f.material_index = mat
    return fs


def bar_bm(bm, p0, p1, s, mat=M_PAINT, up=Vector((0, 0, 1))):
    """square bar of side s from p0 to p1"""
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    a = d.cross(up)
    if a.length < 1e-4:
        a = d.cross(Vector((1, 0, 0)))
    a.normalize()
    b = a.cross(d).normalized()
    h = s / 2
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    ring0 = [bm.verts.new(p0 + a * cx * h + b * cy * h) for cx, cy in corners]
    ring1 = [bm.verts.new(p1 + a * cx * h + b * cy * h) for cx, cy in corners]
    fs = []
    for j in range(4):
        j2 = (j + 1) % 4
        fs.append(bm.faces.new((ring0[j], ring0[j2], ring1[j2], ring1[j])))
    fs.append(bm.faces.new(ring0[::-1]))
    fs.append(bm.faces.new(ring1))
    for f in fs:
        f.material_index = mat
    return fs


def finish(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()


def apply_boolean(obj, cutters):
    for c in cutters:
        md = obj.modifiers.new('cut', 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.object = c
        md.solver = 'EXACT'
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    bpy.data.meshes.remove(old)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)


def cylinder_obj(name, r, x0, x1, y, z, segs=32):
    bm = bmesh.new()
    rings = []
    for x in (x0, x1):
        rings.append([Vector((x, y + r * math.sin(2 * math.pi * k / segs), z + r * math.cos(2 * math.pi * k / segs))) for k in range(segs)])
    loft(bm, rings)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    COLL.objects.link(o)
    return o


# ================================================================== LOWER BODY (bonnet, fenders, doors, rear)
def lb_top(y):
    if y >= COWL_Y:
        t = (y - COWL_Y) / (LB_F - COWL_Y)
        return BELT - 0.02 - (BELT - 0.02 - BON_F) * t ** 1.4
    return BELT


LB_RB, LB_RT, END_R = 0.09, 0.10, 0.06


def lb_section(y):
    z1 = lb_top(y)
    crown = 0.03 if y > COWL_Y else 0.0
    # corner radii stay larger than the 0.06 end rounding, so the inset end rings remain clean arcs
    za, zb = SILL + LB_RB, z1 - LB_RT
    side = [za + (zb - za) * f for f in (0.2, 0.4, 0.6, 0.8)]
    return full_loop(half_profile(HW_B, HW_T, SILL, z1, LB_RB, LB_RT, crown, side, bulge=0.012))


def build_lower_body():
    bm = bmesh.new()
    ys = [LB_F - END_R, 1.98, 1.80, 1.62, 1.44, 1.29, 1.12, 0.96, COWL_Y, 0.60, 0.40, 0.20, 0.0, -0.20, -0.40, -0.60,
          -0.80, -1.00, -1.18, -1.36, -1.54, -1.72, -1.90, LB_R + END_R]
    place = lambda loop, y: [Vector((x, y, z)) for (x, z) in loop]
    rings = [place(lb_section(y), y) for y in ys]
    front = end_rounding(lb_section(ys[0]), ys[0], +1, LB_F - ys[0], 2, place)
    rear = end_rounding(lb_section(ys[-1]), ys[-1], -1, ys[-1] - LB_R, 2, place)
    rings = list(reversed(front)) + rings + rear
    _, caps = loft(bm, rings)
    for c in caps:                    # ring-filled caps: dentable grid, no sliver triangles
        fill_cap(bm, c)
    for f in bm.faces:
        f.material_index = M_PAINT
    finish(bm)
    o = obj_from_bm('lb', bm)
    # wheel arches: per-side cylinders (inner wall becomes the wheel-well liner; the front wells
    # reach further in so a tyre steered to full lock has room)
    cut = []
    for ay, xin in ((AY, 0.36), (-AY, 0.40)):
        for s in (-1, 1):
            cut.append(cylinder_obj('cut', ARCH_R, s * xin, s * 1.30, ay, ARCH_CZ))
    apply_boolean(o, cut)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.normal_update()

    def rule(f):
        c = f.calc_center_median()
        for ay in (AY, -AY):
            if (c.y - ay) ** 2 + (c.z - ARCH_CZ) ** 2 < (ARCH_R + 0.004) ** 2 and abs(c.x) < HW_T - 0.01:
                return ('sw', 'black', 3)
        return None
    set_uvs(bm, rule)
    bm.to_mesh(o.data)
    bm.free()
    return o


# ================================================================== CABIN / GREENHOUSE
# the cabin shell starts well inside the lower body (CAB_Z0) so the rounded rear edges of the two
# lofts never open a notch; half width 0.868 at the belt, tumbling in to 0.80 at the roof edge
CAB_SIDE_Z = [1.47, BELT, WIN_Z0, 1.70, 1.80, 1.90, WIN_Z1]


def cab_section():
    za, zb = CAB_Z0 + 0.08, ROOF_Z - 0.10
    slope = (0.80 - 0.868) / (zb - 1.48)
    hw_b = 0.868 - slope * (1.48 - za)
    return full_loop(half_profile(hw_b, 0.80, CAB_Z0, ROOF_Z, 0.08, 0.10, 0.02, CAB_SIDE_Z, nb=2, nt=4, ca=3))


def build_cabin():
    bm = bmesh.new()
    loop = cab_section()
    # stations: (y at the belt, sheared with the A pillar?)
    st = [(COWL_Y, True), (COWL_Y - A_PILLAR_W, True), (0.30, False), (0.06, False), (-0.22, False),
          (-0.32, False), (-0.55, False), (-0.78, False), (-1.01, False), (-1.24, False),
          (-1.36, False), (-1.58, False), (-1.81, False), (-2.04, False), (CAB_R + END_R, False)]
    windows = [(1, 4), (5, 9), (10, 13)]   # station index ranges (inclusive) spanned by glass

    def place(lp, y0, shear):
        out = []
        for (x, z) in lp:
            y = y0 + ((y_front(z) - y_front(BELT)) if shear else 0.0)
            out.append(Vector((x, y, z)))
        return out

    rings = [place(loop, y, s) for (y, s) in st]
    rf = 0.05
    front = [place(inset_loop(loop, rf * (1 - math.cos(th))), COWL_Y + rf * math.sin(th), True)
             for th in (math.pi / 4, math.pi / 2)]
    rr_ = CAB_R - st[-1][0]
    rear = [place(inset_loop(loop, -rr_ * (1 - math.cos(th))), st[-1][0] + rr_ * math.sin(th), False)
            for th in (math.pi / 4, math.pi / 2)]
    rings = list(reversed(front)) + rings + rear
    off = len(front)
    grid, caps = loft(bm, rings)
    for f in bm.faces:
        f.material_index = M_PAINT
    # side windows: faces between window stations and window heights
    glass_groups = []
    for (a, b) in windows:
        for side in (-1, 1):
            grp = []
            for i in range(a, b):
                for f in grid[off + i]:
                    c = f.calc_center_median()
                    if side * c.x > 0.5 and WIN_Z0 < c.z < WIN_Z1:
                        grp.append(f)
            glass_groups.append(grp)
    walls = []
    for grp in glass_groups:
        res = bmesh.ops.inset_region(bm, faces=grp, thickness=0.0, depth=-0.014, use_even_offset=True)
        walls += res['faces']
        for f in grp:
            f.material_index = M_GLASS
    # windscreen and rear glass: inset the end caps
    finish(bm)
    capf = [f for f in bm.faces if len(f.verts) > 8]
    fans = []
    for f in capf:
        is_front = f.calc_center_median().y > 0
        # split the cap at the glass sill: below stays body (cowl / rear door top), above becomes glass
        # cut on an existing vertex row, so no vertex sits closer to the sill than the inset width
        zcut = BELT if is_front else WIN_Z0
        res = bmesh.ops.bisect_plane(bm, geom=[f] + list(f.edges) + list(f.verts), dist=1e-4,
                                     plane_co=(0, 0, zcut), plane_no=(0, 0, 1))
        halves = [g for g in res['geom'] if isinstance(g, bmesh.types.BMFace)]
        upper = max(halves, key=lambda g: g.calc_center_median().z)
        fans += halves
        res = bmesh.ops.inset_region(bm, faces=[upper], thickness=0.045 if is_front else 0.035, depth=-0.018)
        upper.material_index = M_GLASS
        walls += [w for w in res['faces'] if abs(w.normal.y) < 0.5]
    for g in fans:
        fill_cap(bm, g)
    finish(bm)
    wall_set = set(walls)
    set_uvs(bm, lambda f: ('sw', 'black', 2) if f in wall_set else None)
    return obj_from_bm('cabin', bm)


# ================================================================== FLARES (body colour, black lip)
def build_flares():
    bm = bmesh.new()
    prof = [(ARCH_R + 0.002, 0.80), (ARCH_R + 0.002, 0.975), (ARCH_R + 0.03, 0.995),
            (ARCH_R + 0.09, 0.975), (ARCH_R + 0.15, 0.93), (ARCH_R + 0.18, 0.875)]
    segs = 16
    a0, a1 = math.radians(-86), math.radians(86)
    caps = []
    for ay in (AY, -AY):
        for s in (-1, 1):
            rings = []
            for k in range(segs + 1):
                a = a0 + (a1 - a0) * k / segs
                rings.append([Vector((s * x, ay + r * math.sin(a), ARCH_CZ + r * math.cos(a))) for (r, x) in prof])
            caps += loft(bm, rings)[1]
    bmesh.ops.poke(bm, faces=caps)
    for f in bm.faces:
        f.material_index = M_PAINT
    finish(bm)

    def rule(f):
        n = f.normal
        if abs(n.x) > 0.55:
            return None
        return ('sw', 'black', 0 if n.z > 0.5 else 2)
    set_uvs(bm, rule)
    return obj_from_bm('flares', bm)


# ================================================================== BUMPERS
def rrect2(cy, cz, hy, hz, r, ca=2):
    """rounded rectangle loop in (y, z) around (cy, cz)"""
    pts = []
    for (sy, sz, a0) in ((1, -1, -90), (1, 1, 0), (-1, 1, 90), (-1, -1, 180)):
        ccy, ccz = cy + sy * (hy - r), cz + sz * (hz - r)
        for k in range(ca + 1):
            a = math.radians(a0 + 90 * k / ca)
            pts.append((ccy + r * math.cos(a), ccz + r * math.sin(a)))
    return pts


def build_bumper(front=True):
    bm = bmesh.new()
    if front:
        y0, y1, z0, z1 = FBUMP_Y0, FBUMP_Y1, BUMP_Z0, BUMP_Z1
    else:
        y0, y1, z0, z1 = RBUMP_Y0, RBUMP_Y1, BUMP_Z0 + 0.02, RBUMP_Z1
    cy, cz, hy, hz = (y0 + y1) / 2, (z0 + z1) / 2, abs(y1 - y0) / 2, (z1 - z0) / 2
    loop = rrect2(cy, cz, hy, hz, 0.035)
    xs = [-0.97, -0.90, -0.80, -0.60, -0.40, -0.20, 0.0, 0.20, 0.40, 0.60, 0.80, 0.90, 0.97]
    sgn = 1 if front else -1
    rings = []
    for x in xs:
        t = max(0.0, (abs(x) - 0.78) / 0.19)
        back = -sgn * 0.16 * t * t
        rings.append([Vector((x, y + back, z)) for (y, z) in loop])
    bmesh.ops.poke(bm, faces=loft(bm, rings)[1])
    for f in bm.faces:
        f.material_index = M_PAINT
    # tow hooks / recovery points (front) or step pad (rear)
    if front:
        for s in (-1, 1):
            box_bm(bm, (s * 0.40 - 0.04, y1 - 0.04, 0.63), (s * 0.40 + 0.04, y1 + 0.02, 0.70))
    finish(bm)

    def rule(f):
        n = f.normal
        if n.z < -0.4:
            return ('sw', 'rock', 3)
        c = f.calc_center_median()
        if front and c.y > y1 - 0.01 and abs(abs(c.x) - 0.40) < 0.05 and c.z < 0.72:
            return ('sw', 'black', None)
        return None
    set_uvs(bm, rule)
    return obj_from_bm('bumperF' if front else 'bumperR', bm)


# ================================================================== FRONT DETAILS: grille, lamps
def build_front():
    bm = bmesh.new()
    gx, gz0, gz1 = D['GRILLE_X'], D['GRILLE_Z0'], D['GRILLE_Z1']
    box_bm(bm, (-gx, LB_F - 0.03, gz0), (gx, LB_F + 0.025, gz1))
    # chunky slat bars proud of the grille face
    n = 5
    for i in range(n):
        z = gz0 + 0.035 + (gz1 - gz0 - 0.07) * (i + 0.5) / n
        box_bm(bm, (-gx + 0.05, LB_F + 0.025, z - 0.02), (gx - 0.05, LB_F + 0.045, z + 0.02))
    # headlight bezels
    for s in (-1, 1):
        box_bm(bm, (s * HEAD_X - 0.15, LB_F - 0.03, HEAD_Z - 0.13), (s * HEAD_X + 0.15, LB_F + 0.03, HEAD_Z + 0.13))
    # bonnet front lip under the nose: valance between bumper and grille
    finish(bm)

    def rule(f):
        c = f.calc_center_median()
        if f.normal.y > 0.7 and c.y < LB_F + 0.03 and abs(c.x) < gx:
            return None          # grille face: painted slats in the FRONT region
        if f.normal.y > 0.7 and c.y > LB_F + 0.03 and abs(c.x) < gx:
            return ('sw', 'black', 0)
        return ('sw', 'black', None)
    set_uvs(bm, rule)
    o = obj_from_bm('front', bm)
    return o


def lamp_tile_uv(tile_x0, c0, c1, a0, b0, a1, b1):
    """map metric rect (a0..a1, b0..b1) onto an 8x8 lamp tile"""
    def f(co, ax):
        a = co.x if ax == 'x' else co.y
        u = (tile_x0 + 8 * (a - a0) / (a1 - a0)) / 16.0
        v = (co.z - b0) / (b1 - b0)
        return (min(max(u, tile_x0 / 16 + 0.01), (tile_x0 + 8) / 16 - 0.01), min(max(v, 0.01), 0.99))
    return f


def build_lamps():
    bm = bmesh.new()
    heads, ambers = [], []
    for s in (-1, 1):
        lo = (s * HEAD_X - 0.12, LB_F + 0.02, HEAD_Z - 0.10)
        hi = (s * HEAD_X + 0.12, LB_F + 0.045, HEAD_Z + 0.10)
        heads.append((box_bm(bm, lo, hi, M_LAMP), lo, hi))
        # amber corner lamps wrapping round the front corner, outboard of the headlights
        lo = (s * 0.845 - 0.065, LB_F - 0.14, HEAD_Z - 0.10) if s > 0 else (-0.91, LB_F - 0.14, HEAD_Z - 0.10)
        hi = (0.91, LB_F + 0.03, HEAD_Z + 0.10) if s > 0 else (-0.78, LB_F + 0.03, HEAD_Z + 0.10)
        ambers.append((box_bm(bm, lo, hi, M_LAMP), lo, hi))
    finish(bm)
    uvl = bm.loops.layers.uv.verify()
    for group, tx in ((heads, 0), (ambers, 8)):
        for fs, lo, hi in group:
            for f in fs:
                n = f.normal
                if abs(n.y) > 0.7:
                    fn = lamp_tile_uv(tx, None, None, min(lo[0], hi[0]), lo[2], max(lo[0], hi[0]), hi[2])
                    for l in f.loops:
                        l[uvl].uv = fn(l.vert.co, 'x')
                elif abs(n.x) > 0.7:
                    fn = lamp_tile_uv(tx, None, None, lo[1], lo[2], hi[1], hi[2])
                    for l in f.loops:
                        l[uvl].uv = fn(l.vert.co, 'y')
                else:
                    for l in f.loops:
                        l[uvl].uv = ((tx + 4) / 16, 0.5)
    return obj_from_bm('lamps', bm)


def build_rear():
    bm = bmesh.new()
    tails, ambers = [], []
    for s in (-1, 1):
        x0, x1 = (0.78, 0.905) if s > 0 else (-0.905, -0.78)
        tails.append((box_bm(bm, (x0, LB_R - 0.025, 1.10), (x1, LB_R + 0.10, 1.42), M_TAIL), (x0, 1.10), (x1, 1.42)))
        ambers.append((box_bm(bm, (x0, LB_R - 0.025, 0.95), (x1, LB_R + 0.10, 1.10), M_LAMP), (x0, 0.95), (x1, 1.10)))
    finish(bm)
    uvl = bm.loops.layers.uv.verify()
    for fs, lo, hi in tails:
        for f in fs:
            for l in f.loops:
                c = l.vert.co
                if abs(f.normal.y) > 0.7:
                    u = (c.x - lo[0]) / (hi[0] - lo[0])
                elif abs(f.normal.x) > 0.7:
                    u = (c.y - (LB_R - 0.025)) / 0.125
                else:
                    u = 0.5
                l[uvl].uv = (min(max(u, 0.02), 0.98), min(max((c.z - lo[1]) / (hi[1] - lo[1]), 0.02), 0.98))
    for fs, lo, hi in ambers:
        for f in fs:
            for l in f.loops:
                c = l.vert.co
                a = (c.x - lo[0]) / (hi[0] - lo[0]) if abs(f.normal.y) > 0.7 else ((c.y - (LB_R - 0.025)) / 0.125)
                u = (8 + 8 * min(max(a, 0.02), 0.98)) / 16
                l[uvl].uv = (u, min(max((c.z - lo[1]) / (hi[1] - lo[1]), 0.05), 0.95))
    return obj_from_bm('rearlamps', bm)


# ================================================================== SMALL TRIM: steps, mirrors, frame, rack
def build_trim():
    bm = bmesh.new()
    rules = {}
    for s in (-1, 1):
        # side steps + two brackets each
        box_bm(bm, (s * 0.80 if s > 0 else -0.975, -STEP_Y, 0.565), (0.975 if s > 0 else -0.80, STEP_Y, 0.625))
        for y in (-0.45, 0.45):
            box_bm(bm, (s * 0.62 if s > 0 else -0.82, y - 0.03, 0.57), (0.82 if s > 0 else -0.62, y + 0.03, 0.62))
        # mirrors: arm + squarish black head
        bar_bm(bm, (s * 0.84, 0.64, 1.62), (s * 1.00, 0.60, 1.66), 0.035)
        box_bm(bm, (s * 0.975 if s > 0 else -1.07, 0.55, 1.60), (1.07 if s > 0 else -0.975, 0.63, 1.81))
        # frame rails (frame bottom = 0.53)
        box_bm(bm, (s * 0.26 if s > 0 else -0.35, -2.05, FRAME_Z), (0.35 if s > 0 else -0.26, 2.12, 0.67))
    # crossmembers / skid under the nose
    box_bm(bm, (-0.35, 1.90, FRAME_Z + 0.01), (0.35, 2.18, 0.60))
    box_bm(bm, (-0.35, -2.05, FRAME_Z + 0.02), (0.35, -1.95, 0.66))
    # spare-wheel carrier bracket on the rear door
    box_bm(bm, (0.24, LB_R - 0.20, 1.26), (0.36, LB_R + 0.01, 1.38))
    finish(bm)
    set_uvs(bm, black_rule)
    return obj_from_bm('trim', bm)


def build_rack():
    bm = bmesh.new()
    s = 0.036
    x, yf, yr, rc = 0.76, 0.42, -2.02, 0.14

    def rrect_path(z):
        pts = []
        for (cx, cy, a0) in ((x - rc, yf - rc, 0), (-x + rc, yf - rc, 90), (-x + rc, yr + rc, 180), (x - rc, yr + rc, 270)):
            for k in range(3):
                a = math.radians(a0 + 45 * k)
                pts.append(Vector((cx + rc * math.cos(a), cy + rc * math.sin(a), z)))
        return pts
    for z in (2.29, 2.40):
        p = rrect_path(z)
        for i in range(len(p)):
            bar_bm(bm, p[i], p[(i + 1) % len(p)], s)
    # vertical posts between the rails
    for yy in (0.28, -0.20, -0.70, -1.20, -1.70):
        for sx in (-1, 1):
            bar_bm(bm, (sx * x, yy, 2.29), (sx * x, yy, 2.40), s * 0.9)
    for xx in (-0.45, 0.0, 0.45):
        for yy in (yf, yr):
            bar_bm(bm, (xx, yy, 2.29), (xx, yy, 2.40), s * 0.9)
    # floor: cross slats + two long bars
    for i in range(8):
        yy = yf - 0.20 - i * (yf - yr - 0.40) / 7
        bar_bm(bm, (-x + 0.01, yy, 2.275), (x - 0.01, yy, 2.275), s * 0.85)
    for xx in (-0.30, 0.30):
        bar_bm(bm, (xx, yf - 0.01, 2.26), (xx, yr + 0.01, 2.26), s * 0.85)
    # legs onto the gutters
    for yy in (0.30, -0.55, -1.35, -1.92):
        for sx in (-1, 1):
            bar_bm(bm, (sx * 0.74, yy, 2.29), (sx * 0.74, yy, ROOF_Z - 0.03), s)
            box_bm(bm, (sx * 0.74 - 0.04, yy - 0.05, ROOF_Z - 0.04), (sx * 0.74 + 0.04, yy + 0.05, ROOF_Z - 0.0))
    finish(bm)
    set_uvs(bm, black_rule)
    return obj_from_bm('rack', bm)


# ================================================================== WHEEL
def build_wheel_bm(width_scale=1.0):
    """one wheel, hub at the origin, spin axis X, outer face +X"""
    bm = bmesh.new()
    segs = 16
    w = width_scale
    prof = [(-0.07, 0.0), (-0.07, 0.11), (-0.11, 0.245), (-0.135, 0.27),
            (-0.15, 0.31), (-0.155, 0.355), (-0.145, 0.395), (-0.12, 0.414),
            (0.12, 0.414), (0.145, 0.395), (0.155, 0.355), (0.15, 0.31), (0.135, 0.27),
            (0.125, 0.262), (0.115, 0.245), (0.085, 0.228), (0.07, 0.20), (0.07, 0.10),
            (0.085, 0.092), (0.10, 0.06), (0.10, 0.0)]
    prof = [(x * w, r) for (x, r) in prof]
    rings = []
    for (x, r) in prof:
        if r == 0.0:
            rings.append([bm.verts.new((x, 0.0, 0.0))])
        else:
            rings.append([bm.verts.new((x, r * math.sin(2 * math.pi * k / segs), r * math.cos(2 * math.pi * k / segs))) for k in range(segs)])
    for i in range(len(rings) - 1):
        A, B = rings[i], rings[i + 1]
        for k in range(segs):
            k2 = (k + 1) % segs
            if len(A) == 1:
                bm.faces.new((A[0], B[k2], B[k]))
            elif len(B) == 1:
                bm.faces.new((A[k], A[k2], B[0]))
            else:
                bm.faces.new((A[k], A[k2], B[k2], B[k]))
    carcass = set(bm.faces)
    # staggered tread blocks wrapping over the shoulders
    blk = [(0.012, 0.413), (0.012, 0.455), (0.132, 0.455), (0.162, 0.428), (0.160, 0.37), (0.140, 0.372)]
    nb = 16
    half = math.radians(6.8)
    blocks = []
    for row in (1, -1):
        for k in range(nb):
            th = 2 * math.pi * k / nb + (math.pi / nb if row < 0 else 0.0)
            th += 0.03 * row
            rings2 = []
            for dth in (-half, half):
                rings2.append([Vector((row * x * w, r * math.sin(th + dth), r * math.cos(th + dth))) for (x, r) in blk])
            g, c = loft(bm, rings2)
            for rr in g:
                blocks += rr
            blocks += c
    finish(bm)
    block_set = set(blocks)
    for f in bm.faces:
        f.material_index = M_WHEEL
    uvl = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        c = f.calc_center_median()
        rc = math.hypot(c.y, c.z)
        if f in block_set:
            radial = (c.y * n.y + c.z * n.z) / max(rc, 1e-6)
            uv = T.wheel_swatch_uv('black', 0 if radial > 0.7 else 1)
            for l in f.loops:
                l[uvl].uv = uv
        elif abs(n.x) > 0.6:
            for l in f.loops:
                co = l.vert.co
                # inner face mirrored so its lit side matches
                l[uvl].uv = T.WHEEL_SIDE.uv(co.y if n.x > 0 else -co.y, co.z, T.W_WHEEL, T.H_WHEEL)
        else:
            if rc < RIM_R + 0.005:
                uv = T.wheel_swatch_uv('rock', 1 if rc > 0.2 else 2)
            else:
                uv = T.wheel_swatch_uv('black', 2)
            for l in f.loops:
                l[uvl].uv = uv
    return bm


def build_wheel():
    o = obj_from_bm('Wheel', build_wheel_bm())
    o.location = (TRACK / 2, AY, R)        # parked at the front-right hub (outer face +X)
    o['tyre_radius'] = R
    o['tyre_width'] = TW
    return o


def build_spare():
    bm = build_wheel_bm(width_scale=0.75)
    # outer face to -Y, centred on the rear door carrier
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, 'Z'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0.30, LB_R - 0.015 - 0.162 * 0.75, 1.32))
    return obj_from_bm('spare', bm)


# ================================================================== AXLES
def build_axle(name, y, front):
    bm = bmesh.new()
    segs = 8
    rings = []
    for x in (-0.60, 0.60):
        rings.append([Vector((x, 0.055 * math.sin(2 * math.pi * k / segs), 0.055 * math.cos(2 * math.pi * k / segs))) for k in range(segs)])
    loop = [list(r) for r in rings]
    loft(bm, loop)
    res = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=7, radius=0.16)
    bmesh.ops.scale(bm, verts=res['verts'], vec=(0.9, 0.95, 0.9))
    bmesh.ops.translate(bm, verts=res['verts'], vec=(0.14, 0.0, 0.0))
    for s in (-1, 1):
        r2 = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=5, radius=0.095 if front else 0.075)
        bmesh.ops.translate(bm, verts=r2['verts'], vec=(s * 0.56, 0.0, 0.0))
    for f in bm.faces:
        f.material_index = M_PAINT
    finish(bm)
    set_uvs(bm, lambda f: ('sw', 'black', 0 if f.normal.z > 0.5 else (1 if f.normal.z > -0.3 else 3)))
    o = obj_from_bm(name, bm)
    o.location = (0, y, R)
    return o


# ================================================================== assemble
parts = [build_lower_body(), build_cabin(), build_flares(), build_bumper(True), build_bumper(False), build_front(),
         build_lamps(), build_rear(), build_trim(), build_rack(), build_spare()]
with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts, object=parts[0]):
    bpy.ops.object.join()
body = parts[0]
body.name = 'Body'
body.data.name = 'Body'
# Body origin at the chassis centre
body.data.transform(Matrix.Translation((0, 0, -CZ)))
body.location = (0, 0, CZ)

wheel = build_wheel()
axf = build_axle('AxleFront', AY, True)
axr = build_axle('AxleRear', -AY, False)


def smooth_by_angle(o, deg):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    ngons = [f for f in bm.faces if len(f.verts) > 4]       # boolean leftovers: triangulate deterministically
    if ngons:
        bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='BEAUTY')
    lim = math.radians(deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        e.smooth = e.calc_face_angle(0.0) < lim
    bm.to_mesh(o.data)
    bm.free()


for o, deg in ((body, 38), (wheel, 50), (axf, 50), (axr, 50)):
    smooth_by_angle(o, deg)
    o.data.update()


def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.2
    e.location = loc
    COLL.objects.link(e)
    return e


markers = [empty('Marker_WheelFL', (-TRACK / 2, AY, R)), empty('Marker_WheelFR', (TRACK / 2, AY, R)),
           empty('Marker_WheelRL', (-TRACK / 2, -AY, R)), empty('Marker_WheelRR', (TRACK / 2, -AY, R)),
           empty('Marker_Ground', (0, 0, 0))]


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


bb = [body.matrix_world @ Vector(c) for c in body.bound_box]
print('LC70 body tris', tris(body), 'wheel tris', tris(wheel), 'axles', tris(axf), tris(axr))
print('LC70 body bounds x %.3f..%.3f y %.3f..%.3f z %.3f..%.3f' % (
    min(v.x for v in bb), max(v.x for v in bb), min(v.y for v in bb), max(v.y for v in bb), min(v.z for v in bb), max(v.z for v in bb)))

# ------------------------------------------------------------------ export (clean scene: no preview helpers yet)
EXPORT = [body, wheel, axf, axr] + markers
for o in SC.objects:
    o.select_set(o in EXPORT)
bpy.context.view_layer.objects.active = body
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_apply=True,
                          export_extras=True, export_yup=True, export_materials='EXPORT')
print('LC70 exported', GLB, os.path.getsize(GLB), 'bytes')
bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
print('LC70 saved', BLEND)

if '--no-preview' in ARGS:
    sys.exit(0)

# ================================================================== PREVIEW (toon + outline + low-res pixels)
import lc70_preview as P
importlib.reload(P)
P.render_previews(SC, body, wheel, [axf, axr], markers, MATS, PREV_DIR, OUT_DIR, T,
                  views=[v for v in ARGS if not v.startswith('--')] or None)
