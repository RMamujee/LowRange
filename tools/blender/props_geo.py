# Geometry for the LowRange nature/prop set: blob clusters (canopies, bushes), lofts (trunks,
# logs, posts), tiered pine skirts, faceted boulders, grass blades. Built with bmesh in Blender
# Z-up metres; origin at the base centre on the ground. Every face carries a "part" id whose
# entry in Mesh.parts says what it is (leaf / pine / bark / wood / board / cut / rock / grass);
# props_uv.py turns that into a tile of the shared atlas.
import math
import random
import bmesh
from mathutils import Vector, Matrix


class Mesh:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.part = self.bm.faces.layers.int.new('part')
        self.parts = []
        self.blobs = []  # (centre, radii, part id) for interior culling
        self.grain = Vector((0, 0, 1))

    def new_part(self, kind, **kw):
        self.parts.append(dict(kind=kind, **kw))
        return len(self.parts) - 1

    def face(self, verts, pid, inside=None):
        f = self.bm.faces.new(verts)
        f[self.part] = pid
        if inside is not None:
            f.normal_update()
            if f.normal.dot(f.calc_center_median() - inside) < 0:
                f.normal_flip()
        return f

    def tris(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)


# ---------------------------------------------------------------- blobs
def blob(m, centre, radii, kind, R, subdiv=2, jitter=0.1, floor=None, **kw):
    """Icosphere clump scaled to radii with a lumpy per-vertex radius. floor: clamp z."""
    pid = m.new_part(kind, centre=Vector(centre), radii=Vector(radii), **kw)
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=subdiv, radius=1.0)
    rot = Matrix.Rotation(R.random() * 6.283, 3, 'Z')
    vmap = {}
    for v in tmp.verts:
        d = rot @ v.co.normalized()
        k = 1 + jitter * (R.random() * 2 - 1)
        p = Vector(centre) + Vector((d.x * radii[0], d.y * radii[1], d.z * radii[2])) * k
        if floor is not None:
            p.z = max(p.z, floor)
        vmap[v] = m.bm.verts.new(p)
    for f in tmp.faces:
        m.face([vmap[v] for v in f.verts], pid, inside=Vector(centre))
    tmp.free()
    m.blobs.append((Vector(centre), Vector(radii), pid))
    return pid


def cull_hidden(m, margin=0.93, floor=None):
    """Delete faces buried inside another clump (or under the ground) to save triangles."""
    dead = []
    for f in m.bm.faces:
        pid = f[m.part]
        if floor is not None and all(v.co.z <= floor + 1e-4 for v in f.verts):
            dead.append(f)
            continue
        for c, r, q in m.blobs:
            if q == pid:
                continue
            if all(((v.co.x - c.x) / r.x) ** 2 + ((v.co.y - c.y) / r.y) ** 2 + ((v.co.z - c.z) / r.z) ** 2 < margin ** 2 for v in f.verts):
                dead.append(f)
                break
    bmesh.ops.delete(m.bm, geom=dead, context='FACES')
    loose = [v for v in m.bm.verts if not v.link_faces]
    bmesh.ops.delete(m.bm, geom=loose, context='VERTS')


# ---------------------------------------------------------------- lofts
def loft(m, rings, segs, kind, cap_start=None, cap_end=None, phase=0.0, axis='Z', **kw):
    """rings: [(centre Vector, radius or fn(angle)->radius)]. Circles are perpendicular to
    the given axis ('Z' upright trunks/posts, 'X' logs/rails). cap_*: part kind for caps."""
    pid = m.new_part(kind, **kw)
    loops = []
    for c, r in rings:
        ring = []
        for i in range(segs):
            a = phase + i / segs * 2 * math.pi
            rr = r(a) if callable(r) else r
            if axis == 'Z':
                off = Vector((math.cos(a) * rr, math.sin(a) * rr, 0))
            elif axis == 'X':
                off = Vector((0, math.cos(a) * rr, math.sin(a) * rr))
            else:  # direction vector
                d = Vector(axis).normalized()
                t1 = d.orthogonal().normalized()
                t2 = d.cross(t1)
                off = (t1 * math.cos(a) + t2 * math.sin(a)) * rr
            ring.append(m.bm.verts.new(Vector(c) + off))
        loops.append((Vector(c), ring))
    for (c0, a), (c1, b) in zip(loops, loops[1:]):
        mid = (c0 + c1) / 2
        for i in range(segs):
            j = (i + 1) % segs
            m.face([a[i], a[j], b[j], b[i]], pid, inside=mid)
    for cap, (c, ring), other in ((cap_start, loops[0], loops[-1][0]), (cap_end, loops[-1], loops[0][0])):
        if cap:
            cp = m.new_part(cap)
            f = m.face(ring, cp)
            f.normal_update()
            if f.normal.dot(c - other) < 0:
                f.normal_flip()
    return pid


def box(m, lo, hi, kind, **kw):
    pid = m.new_part(kind, **kw)
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    P = [m.bm.verts.new(Vector(p)) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                              (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    ctr = (Vector(lo) + Vector(hi)) / 2
    for q in ((0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        m.face([P[i] for i in q], pid, inside=ctr)
    return pid


def prism(m, outline_xz, y0, y1, kind, face_kind):
    """Extrude an XZ polygon between y0 and y1 (sign boards). Big faces -> face_kind."""
    pid, fid = m.new_part(kind), m.new_part(face_kind)
    a = [m.bm.verts.new(Vector((x, y0, z))) for x, z in outline_xz]
    b = [m.bm.verts.new(Vector((x, y1, z))) for x, z in outline_xz]
    ctr = sum((v.co for v in a + b), Vector()) / (2 * len(a))
    n = len(a)
    for i in range(n):
        j = (i + 1) % n
        m.face([a[i], a[j], b[j], b[i]], pid, inside=ctr)
    m.face(a, fid, inside=ctr)
    m.face(b, fid, inside=ctr)


# ---------------------------------------------------------------- assets
def tree_round(variant):
    R = random.Random(100 + variant)
    m = Mesh(f'tree_round_{"ab"[variant]}')
    tall = variant == 1
    top = 2.7 if tall else 2.45  # where the trunk forks into the canopy
    lobes = lambda base, amp, ph: (lambda a: base + amp * max(0.0, math.cos(4 * (a + ph))) ** 2)
    lean = Vector((0.1, -0.05, 0)) if variant == 0 else Vector((-0.08, 0.04, 0))
    loft(m, [(Vector((0, 0, -0.05)), lobes(0.5, 0.3, 0.3)),
             (Vector((0, 0, 0.25)), lobes(0.4, 0.1, 0.3)),
             (Vector((0, 0, 0.8)) + lean * 0.3, 0.33),
             (Vector((0, 0, 1.7)) + lean * 0.8, 0.3),
             (Vector((0, 0, top)) + lean, 0.33),
             (Vector((0, 0, top + 0.8)) + lean, 0.25)], 8, 'bark', phase=0.2)
    # limbs forking into the canopy, visible below it
    for k in range(3):
        a = k * 2.1 + variant * 0.7
        d = Vector((math.cos(a), math.sin(a), 0))
        base = Vector((0, 0, top - 0.2)) + lean
        loft(m, [(base, 0.17), (base + d * 0.55 + Vector((0, 0, 0.45)), 0.13), (base + d * 1.0 + Vector((0, 0, 1.1)), 0.09)],
             5, 'bark', axis=tuple(d * 0.7 + Vector((0, 0, 0.8))))
    # canopy: overlapping leaf clumps, a big core and rings of smaller puffs
    c0 = Vector((lean.x, lean.y, 0))
    ring = lambda n, d, z, r, ph=0.0, wob=0.0: [((d * math.cos(a), d * math.sin(a), z + wob * math.sin(3 * a)), (r, r, r * 0.85)) for a in [k * 6.283 / n + ph for k in range(n)]]
    if not tall:
        spec = [((0, 0, 3.95), (1.5, 1.5, 1.25))]
        spec += ring(7, 1.4, 3.05, 0.86, 0.3, 0.15)
        spec += ring(6, 1.15, 4.1, 0.84, 0.0)
        spec += ring(3, 0.55, 4.95, 0.76, 0.5)
        spec += [((0.1, -0.1, 5.45), (0.6, 0.6, 0.5))]
    else:
        spec = [((0, 0, 4.4), (1.3, 1.3, 1.5))]
        spec += ring(6, 1.2, 3.35, 0.82, 0.2, 0.12)
        spec += ring(6, 1.05, 4.5, 0.8, 0.7)
        spec += ring(4, 0.62, 5.5, 0.72, 0.1)
        spec += [((-0.05, 0.05, 6.2), (0.6, 0.6, 0.52))]
    for c, r in spec:
        s = 0.92 + 0.16 * R.random()
        blob(m, c0 + Vector(c) + Vector((R.uniform(-.1, .1), R.uniform(-.1, .1), R.uniform(-.08, .08))),
             Vector(r) * s, 'leaf', R, jitter=0.09)
    cull_hidden(m)
    m.smooth = True
    return m


def tree_pine(variant):
    R = random.Random(200 + variant)
    m = Mesh(f'tree_pine_{"ab"[variant]}')
    tiers = 5 if variant == 0 else 6
    H = 7.6 if variant == 0 else 8.6
    zb0 = 1.15 if variant == 0 else 1.25
    R0 = 2.0 if variant == 0 else 1.75
    lobes = lambda a: 0.3 + 0.12 * max(0.0, math.cos(3 * (a + 0.4))) ** 2
    loft(m, [(Vector((0, 0, -0.05)), lobes), (Vector((0, 0, 0.3)), 0.22), (Vector((0, 0, zb0 + 1.0)), 0.17)], 7, 'bark')
    N = 11
    span = (H - zb0) / (tiers - 0.1)
    for t in range(tiers):
        f = t / max(1, tiers - 1)
        zb = zb0 + t * span * 0.9
        zt = H if t == tiers - 1 else zb + span * 1.3
        rad = R0 * (1 - 0.7 * f) * (0.95 + 0.1 * R.random())
        h = zt - zb
        pid = m.new_part('pine', zb=zb, zt=zt, tier=t)
        ph = R.random() * 6.28
        apex = m.bm.verts.new(Vector((R.uniform(-.03, .03), R.uniform(-.03, .03), zt)))
        mid = [m.bm.verts.new(Vector((math.cos(ph + i / N * 6.283) * rad * 0.52, math.sin(ph + i / N * 6.283) * rad * 0.52, zb + 0.45 * h))) for i in range(N)]
        tips, notch = [], []
        for i in range(N):
            a = ph + i / N * 6.283
            rr = rad * (0.95 + 0.12 * R.random())
            tips.append(m.bm.verts.new(Vector((math.cos(a) * rr, math.sin(a) * rr, zb - 0.22 - 0.1 * R.random()))))
            a2 = a + 3.1416 / N
            notch.append(m.bm.verts.new(Vector((math.cos(a2) * rad * 0.74, math.sin(a2) * rad * 0.74, zb + 0.14))))
        under = m.bm.verts.new(Vector((0, 0, zb + 0.3 * h)))
        inside = Vector((0, 0, zb + 0.32 * h))
        for i in range(N):
            j = (i + 1) % N
            m.face([apex, mid[i], mid[j]], pid, inside)
            m.face([mid[i], tips[i], notch[i]], pid, inside)
            m.face([mid[i], notch[i], mid[j]], pid, inside)
            m.face([mid[j], notch[i], tips[j]], pid, inside)
            m.face([under, notch[i], tips[i]], pid, Vector((0, 0, zb + 2.0 * h)))
            m.face([under, tips[j], notch[i]], pid, Vector((0, 0, zb + 2.0 * h)))
    m.smooth = True
    m.sharp_angle = 55
    return m


def bush(variant, flowers):
    R = random.Random(300 + variant + (50 if flowers else 0))
    m = Mesh(f'bush_{"flower_" if flowers else ""}{"ab"[variant]}')
    kind = 'leafflower' if flowers else 'leaf'
    if variant == 0:  # round
        spec = [((0, 0, 0.5), (0.58, 0.55, 0.5))]
        spec += [((0.48 * math.cos(a), 0.44 * math.sin(a), 0.33), (0.4, 0.4, 0.36)) for a in [k * 1.257 + 0.3 for k in range(5)]]
        spec += [((0.22 * math.cos(a), 0.22 * math.sin(a), 0.82), (0.34, 0.34, 0.3)) for a in (0.4, 3.3)]
    else:  # wide and low
        spec = [((-0.25, 0, 0.42), (0.5, 0.46, 0.42)), ((0.35, 0.05, 0.4), (0.48, 0.45, 0.4))]
        spec += [((0.8 * math.cos(a), 0.45 * math.sin(a), 0.28), (0.36, 0.36, 0.3)) for a in [k * 1.257 for k in range(5)]]
        spec += [((0.05, -0.05, 0.72), (0.36, 0.34, 0.3))]
    for c, r in spec:
        s = 0.9 + 0.2 * R.random()
        blob(m, Vector(c) + Vector((R.uniform(-.04, .04), R.uniform(-.04, .04), 0)), Vector(r) * s, kind, R, jitter=0.1, floor=0.0)
    cull_hidden(m, floor=0.0)
    m.smooth = True
    return m


def grass_tuft(variant):
    R = random.Random(400 + variant)
    m = Mesh(f'grass_tuft_{"ab"[variant]}')
    pid = m.new_part('grass')
    n = 8 if variant == 0 else 11
    for i in range(n):
        a = i / n * 6.283 + R.uniform(-0.3, 0.3)
        d = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-d.y, d.x, 0))
        h = R.uniform(0.17, 0.3) if variant == 0 else R.uniform(0.14, 0.36)
        lean = R.uniform(0.05, 0.13)
        root = d * R.uniform(0.0, 0.06)
        w = 0.035
        b0 = m.bm.verts.new(root - side * w)
        b1 = m.bm.verts.new(root + side * w)
        m0 = m.bm.verts.new(root + d * lean * 0.4 - side * w * 0.6 + Vector((0, 0, h * 0.55)))
        m1 = m.bm.verts.new(root + d * lean * 0.4 + side * w * 0.6 + Vector((0, 0, h * 0.55)))
        tip = m.bm.verts.new(root + d * lean + Vector((0, 0, h)))
        for q in ((b0, b1, m1), (b0, m1, m0), (m0, m1, tip)):
            f = m.face(list(q), pid)
            f.normal_update()
            if f.normal.dot(d) < 0:
                f.normal_flip()
    m.smooth = False
    m.double_sided = True
    return m


def _rock_into(m, R, size, subdiv, centre=(0, 0), facets=9, sink=0.22):
    """Rounded lump: icosphere warped by a few low-frequency waves, flattened by a couple of
    facet planes, base cut flat and sunk into the ground."""
    pid = m.new_part('rock')
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=subdiv, radius=1.0)
    waves = [(Vector((R.uniform(-1, 1), R.uniform(-1, 1), R.uniform(-1, 1))).normalized(), R.uniform(1.5, 3.0), R.uniform(0, 6.28)) for _ in range(3)]
    # a slightly tilted flat crown (reads as the light top band) plus a few side facets
    planes = [(Vector((R.uniform(-0.3, 0.3), R.uniform(-0.3, 0.3), 1)).normalized(), R.uniform(0.74, 0.82))]
    for _ in range(facets):
        n = Vector((R.uniform(-1, 1), R.uniform(-1, 1), R.uniform(-0.1, 0.9))).normalized()
        planes.append((n, R.uniform(0.76, 0.86)))
    pts = {}
    for v in tmp.verts:
        d = v.co.normalized()
        k = 1 + sum(0.07 * math.cos(d.dot(w) * f + p) for w, f, p in waves)
        p = d * k
        for n, dist in planes:
            e = p.dot(n) - dist
            if e > 0:
                p = p - n * e
        pts[v] = p
    zs = [p.z for p in pts.values()]
    cut = min(zs) + sink * (max(zs) - min(zs))
    vmap = {}
    sx, sy, sz = size
    span = max(zs) - cut
    for v, p in pts.items():
        z = max(p.z, cut) - cut
        vmap[v] = m.bm.verts.new(Vector((centre[0] + p.x * sx / 2, centre[1] + p.y * sy / 2, z / span * sz - 0.03)))
    for f in tmp.faces:
        m.face([vmap[v] for v in f.verts], pid, inside=Vector((centre[0], centre[1], sz * 0.35)))
    tmp.free()
    m.parts[pid]['height'] = sz


def rock(name, seed, size, subdiv, cluster=None):
    R = random.Random(seed)
    m = Mesh(name)
    if cluster:
        for c, s in cluster:
            _rock_into(m, R, s, subdiv, centre=c)
    else:
        _rock_into(m, R, size, subdiv)
    # drop faces lying flat under the ground
    dead = [f for f in m.bm.faces if all(v.co.z < -0.02 for v in f.verts)]
    bmesh.ops.delete(m.bm, geom=dead, context='FACES')
    bmesh.ops.delete(m.bm, geom=[v for v in m.bm.verts if not v.link_faces], context='VERTS')
    m.smooth = True
    m.sharp_angle = 38
    return m


def fence_segment():
    m = Mesh('fence_segment')
    w = 0.11 * math.sqrt(2)
    for x in (0.0, 2.0):
        loft(m, [(Vector((x, 0, -0.05)), w), (Vector((x, 0, 1.0)), w), (Vector((x, 0, 1.12)), w * 0.6)], 4, 'wood', cap_end='wood', phase=math.pi / 4)
    for z in (0.4, 0.8):
        box(m, (0.0, -0.13, z - 0.1), (2.0, -0.03, z + 0.1), 'rail')
    m.grain_x = True
    m.smooth = False
    return m


def signpost():
    m = Mesh('signpost')
    w = 0.095 * math.sqrt(2)
    loft(m, [(Vector((0, 0, -0.05)), w), (Vector((0, 0, 2.1)), w), (Vector((0, 0, 2.22)), 0.02)], 4, 'wood', phase=math.pi / 4)
    for z, sgn, L in ((1.8, 1, 0.95), (1.42, -1, 0.82)):
        h = 0.13
        pts = [(-0.12, -h), (L - 0.2, -h), (L, 0), (L - 0.2, h), (-0.12, h)]
        if sgn < 0:
            pts = [(-x, zz) for x, zz in reversed(pts)]
        prism(m, [(x, z + zz) for x, zz in pts], -0.17, -0.1, 'rail', 'board')
    m.grain_x = True
    m.smooth = False
    return m


def log():
    R = random.Random(600)
    m = Mesh('log')
    r = 0.29
    xs = [-1.5, -0.75, 0.0, 0.75, 1.5]
    rings = []
    for i, x in enumerate(xs):
        rr = r * (1.0 + 0.06 * math.sin(i * 1.7)) * (1.08 if i in (0, 4) else 1)
        rings.append((Vector((x, 0.02 * math.sin(i * 2.1), r - 0.03)), (lambda q: (lambda a: q * (1 + 0.05 * math.cos(3 * a + q * 9))))(rr)))
    loft(m, rings, 9, 'bark', cap_start='cut', cap_end='cut', axis='X', phase=0.3)
    # broken-off branch stub
    b = Vector((0.45, 0.05, r * 1.75))
    loft(m, [(Vector((0.35, 0.02, r * 1.2)), 0.09), (b, 0.07)], 5, 'bark', cap_end='cut_s', axis=(0.25, 0.05, 1.0))
    m.grain_x = True
    m.smooth = True
    return m


def stump():
    m = Mesh('stump')
    roots = lambda a: 0.44 + 0.15 * abs(math.cos(2.5 * a))
    loft(m, [(Vector((0, 0, -0.05)), roots), (Vector((0, 0, 0.14)), lambda a: 0.35 + 0.04 * abs(math.cos(2.5 * a))),
             (Vector((0, 0, 0.42)), 0.31), (Vector((0, 0.02, 0.6)), 0.3)], 10, 'bark', cap_end='cut')
    m.smooth = True
    return m


def all_assets():
    return [tree_round(0), tree_round(1), tree_pine(0), tree_pine(1),
            bush(0, False), bush(1, False), bush(0, True), bush(1, True),
            grass_tuft(0), grass_tuft(1),
            rock('rock_small_a', 701, (0.55, 0.48, 0.36), 2),
            rock('rock_small_b', 702, None, 2, cluster=[((-0.12, 0.05), (0.42, 0.36, 0.3)), ((0.2, -0.06), (0.3, 0.28, 0.22)), ((0.05, 0.25), (0.22, 0.2, 0.15))]),
            rock('rock_medium_a', 703, (1.25, 1.05, 0.85), 3),
            rock('rock_medium_b', 704, (1.15, 0.95, 0.95), 3),
            rock('rock_large_a', 705, (2.6, 2.2, 1.65), 3),
            fence_segment(), signpost(), log(), stump()]
