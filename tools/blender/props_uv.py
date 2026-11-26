# Face -> atlas tile, and per-face planar UVs at 32 px/m (props_atlas.py).
# Tone choice is where the "light top, dark underside" painting happens: each face picks the
# highlight / base / shade / deep tile of its material from its normal and height, so the
# texture stays a few hand-pixelled tiles shared by the whole set.
import random
from mathutils import Vector
from props_atlas import REG, SIZE, PX_PER_M

LIGHT = Vector((-0.45, -0.35, 0.0))  # gentle painted bias: lit from the upper left like the reference


def _tone(score, cuts):
    for i, c in enumerate(cuts):
        if score > c:
            return i
    return len(cuts)


def classify(m, R):
    """-> list of (face, region name, mode, grain axis)."""
    bm, parts = m.bm, m.parts
    leafz = [f.calc_center_median().z for f in bm.faces if parts[f[m.part]]['kind'] in ('leaf', 'leafflower')]
    allz = [v.co.z for v in bm.verts]
    z0, z1 = (min(leafz), max(leafz)) if leafz else (min(allz), max(allz))
    gx = Vector((1, 0, 0)) if getattr(m, 'grain_x', False) else Vector((0, 0, 1))
    out = []
    for f in bm.faces:
        p = parts[f[m.part]]
        k = p['kind']
        n = f.normal
        c = f.calc_center_median()
        h = R.random()
        hn = (c.z - z0) / max(1e-6, z1 - z0) * 2 - 1  # -1 bottom .. 1 top
        if k in ('leaf', 'leafflower'):
            local = (c - p['centre']).z / p['radii'].z
            s = 0.4 * n.z + 0.35 * hn + 0.55 * local + 0.3 * n.dot(LIGHT) + 0.12 * (h - 0.5)
            t = _tone(s, (0.38, -0.18, -0.62))
            reg = f'leaf{t}'
            if k == 'leafflower':
                if t < 3 and h < 0.7:
                    reg = f'flower{t}'
                elif t == 3 and h < 0.3:
                    reg = 'leaf_flower3'
            out.append((f, reg, 'fit', Vector((0, 0, 1))))
        elif k == 'pine':
            span = p['zt'] - p['zb']
            local = (c.z - p['zb']) / span * 2 - 1
            if n.z < -0.15:
                t = 3
            else:
                s = 0.4 * n.z + 0.55 * local + 0.3 * hn + 0.25 * n.dot(LIGHT) + 0.1 * (h - 0.5)
                t = _tone(s, (0.3, -0.2, -0.6))
            out.append((f, f'pine{t}', 'fit', Vector((0, 0, 1))))
        elif k == 'bark':
            if c.z < 0.3 and n.z < 0.6:
                t = 2
            else:
                s = 0.5 * n.z + 0.6 * n.dot(LIGHT) + 0.2 * (h - 0.5)
                t = _tone(s, (0.15, -0.35))
            out.append((f, f'bark{t}', 'fit', gx))
        elif k in ('wood', 'rail'):
            if n.z > 0.5:
                t = 0
            elif n.z < -0.5:
                t = 2
            else:
                t = 1  # mid-brown sides, light tops, dark undersides (like the reference fence)
            out.append((f, f'wood{t}', 'fit', gx if abs(n.z) < 0.9 or k == 'rail' else Vector((0, 1, 0))))
        elif k == 'board':
            out.append((f, 'board', 'fit', Vector((1, 0, 0))))
        elif k == 'cut':
            out.append((f, 'ring', 'center', None))
        elif k == 'cut_s':
            out.append((f, 'ring_s', 'center', None))
        elif k == 'rock':
            H = p.get('height', 1.0)
            hr = c.z / H * 2 - 1
            s = 0.9 * n.z + 0.25 * hr + 0.25 * n.dot(LIGHT)
            t = _tone(s, (0.62, -0.02, -0.55))
            reg = f'rock{t}'
            if t >= 1 and abs(n.z) < 0.7 and h < 0.16:
                reg = f'rockc{t}'
            out.append((f, reg, 'fit', Vector((0, 0, 1))))
        elif k == 'grass':
            out.append((f, 'grass', 'ground', Vector((0, 0, 1))))
        else:
            raise ValueError(k)
    return out


def map_uvs(m, seed):
    R = random.Random(seed)
    m.bm.normal_update()
    uvl = m.bm.loops.layers.uv.verify()
    pad = 1.0
    used = {}
    for f, reg, mode, grain in classify(m, R):
        used[reg] = used.get(reg, 0) + 1
        rx, ry, rw, rh = REG[reg]
        n = f.normal
        if grain is None:
            grain = Vector((0, 0, 1)) if abs(n.z) < 0.7 else Vector((0, 1, 0))
        g = grain - n * grain.dot(n)
        if g.length < 0.3:
            alt = Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))
            g = alt - n * alt.dot(n)
        g.normalize()
        u = g.cross(n).normalized()
        P = [(l, l.vert.co.dot(u) * PX_PER_M, l.vert.co.dot(g) * PX_PER_M) for l in f.loops]
        us, vs = [q[1] for q in P], [q[2] for q in P]
        umin, vmin = min(us), min(vs)
        w, h = max(us) - umin, max(vs) - vmin
        if mode == 'center':
            cu, cv = sum(us) / len(us), sum(vs) / len(vs)
            rad = max(((a - cu) ** 2 + (b - cv) ** 2) ** 0.5 for a, b in zip(us, vs))
            s = (rw / 2 - 0.5) / max(rad, 1e-6)
            for l, a, b in P:
                l[uvl].uv = ((rx + rw / 2 + (a - cu) * s) / SIZE, (ry + rh / 2 + (b - cv) * s) / SIZE)
            continue
        s = min(1.0, (rw - 2 * pad) / max(w, 1e-6), (rh - 2 * pad) / max(h, 1e-6))
        ou = round(R.uniform(0, rw - 2 * pad - w * s))
        if mode == 'ground':  # v = height above ground, so the tile's vertical ramp follows height
            for l, a, b in P:
                l[uvl].uv = ((rx + pad + ou + (a - umin) * s) / SIZE, (ry + 0.5 + max(0.0, l.vert.co.z) * PX_PER_M) / SIZE)
            continue
        ov = round(R.uniform(0, rh - 2 * pad - h * s))
        for l, a, b in P:
            l[uvl].uv = ((rx + pad + ou + (a - umin) * s) / SIZE, (ry + pad + ov + (b - vmin) * s) / SIZE)
    return used
