# Geometry, UV and pixel-paint helpers for build_wrx.py (pure Python + numpy, plus a little bpy).
#
# Parts are accumulated in a Mesh (verts, faces, per-corner UVs in metres, a tag per face). Every face
# belongs to a UV island; an Atlas shelf-packs the islands at TEX px/m so texels stay square, and
# paint() rasterises each face into the atlas, calling a paint function with the 3D position and normal
# of every texel centre. Textures are therefore authored in 3D ("the door line is at y = -0.34"),
# whatever the UV layout, and mirrored / rotated copies can share an island.
import math
import numpy as np

TEX = 32.0  # texture pixels per metre (docs/ART_STYLE.md)


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def newell(pts):
    n = np.zeros(3)
    k = len(pts)
    for i in range(k):
        a, b = pts[i], pts[(i + 1) % k]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    ln = np.linalg.norm(n)
    return n / ln if ln > 1e-12 else n


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


class Curve:
    """Catmull-Rom through (x, y) knots sorted by x; evaluated by x (clamped at the ends)."""

    def __init__(self, knots):
        self.k = sorted(knots)

    def __call__(self, x):
        k = self.k
        if x <= k[0][0]:
            return k[0][1]
        if x >= k[-1][0]:
            return k[-1][1]
        i = max(j for j in range(len(k) - 1) if k[j][0] <= x)
        x0, y0 = k[i]
        x1, y1 = k[i + 1]
        t = (x - x0) / (x1 - x0)
        ym = k[i - 1][1] if i > 0 else y0 - (y1 - y0)
        yp = k[i + 2][1] if i + 2 < len(k) else y1 + (y1 - y0)
        # tangents scaled to the local interval (non-uniform knots)
        xm = k[i - 1][0] if i > 0 else x0 - (x1 - x0)
        xp = k[i + 2][0] if i + 2 < len(k) else x1 + (x1 - x0)
        m0 = (y1 - ym) / (x1 - xm) * (x1 - x0)
        m1 = (yp - y0) / (xp - x0) * (x1 - x0)
        t2, t3 = t * t, t * t * t
        return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1


class Island:
    def __init__(self, name, fixed=None):
        self.name = name
        self.fixed = fixed      # (w, h) in px for swatch islands without faces
        self.members = []       # (mesh, face index)
        self.ox = self.oy = 0
        self.minu = self.minv = 0.0
        self.w = self.h = 0


class Atlas:
    def __init__(self, size, pad=1):
        self.size, self.pad = size, pad
        self.islands = []

    def island(self, name, fixed=None):
        isl = Island(name, fixed)
        self.islands.append(isl)
        return isl

    def pack(self):
        for isl in self.islands:
            if isl.fixed:
                isl.w, isl.h = isl.fixed
                continue
            us = [uv[0] for (m, f) in isl.members for uv in m.fuv[f]]
            vs = [uv[1] for (m, f) in isl.members for uv in m.fuv[f]]
            if not us:
                isl.w = isl.h = 0
                continue
            isl.minu, isl.minv = min(us), min(vs)
            isl.w = int(math.ceil((max(us) - isl.minu) * TEX - 1e-6)) + 1
            isl.h = int(math.ceil((max(vs) - isl.minv) * TEX - 1e-6)) + 1
        S, p = self.size, self.pad
        x = y = shelf_h = 0
        for isl in sorted([i for i in self.islands if i.w], key=lambda i: (-i.h, -i.w)):
            w, h = isl.w + 2 * p, isl.h + 2 * p
            if x + w > S:
                x, y, shelf_h = 0, y + shelf_h, 0
            if y + h > S or w > S:
                raise RuntimeError(f'atlas {S}px overflow at island {isl.name} ({isl.w}x{isl.h})')
            isl.ox, isl.oy = x + p, y + p
            x += w
            shelf_h = max(shelf_h, h)
        self.used_h = y + shelf_h
        return self.used_h

    def px(self, isl, uv):
        return ((uv[0] - isl.minu) * TEX + isl.ox, (uv[1] - isl.minv) * TEX + isl.oy)


class Mesh:
    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.fuv = []
        self.ftag = []
        self.fmat = []
        self.fsmooth = []
        self.fisl = []
        self.fswatch = []   # swatch colour index, or None

    def add_verts(self, pts):
        b = len(self.verts)
        self.verts.extend(np.asarray(p, dtype=float) for p in pts)
        return b

    def add_face(self, vids, uvs, tag, mat, smooth, isl, swatch=None):
        self.faces.append(list(vids))
        self.fuv.append([tuple(u) for u in uvs])
        self.ftag.append(tag)
        self.fmat.append(mat)
        self.fsmooth.append(smooth)
        self.fisl.append(isl)
        self.fswatch.append(swatch)
        if isl is not None:
            isl.members.append((self, len(self.faces) - 1))
        return len(self.faces) - 1

    def flip(self, f):
        self.faces[f].reverse()
        self.fuv[f].reverse()

    def fnormal(self, f):
        return newell([self.verts[i] for i in self.faces[f]])

    def fcentre(self, f):
        return np.mean([self.verts[i] for i in self.faces[f]], axis=0)

    def copy_faces(self, faces, xform, mirror=False):
        """Duplicate faces with every vertex mapped through xform(p); shares UVs/islands."""
        remap = {}
        out = []
        for f in faces:
            vids = []
            for vi in self.faces[f]:
                if vi not in remap:
                    remap[vi] = len(self.verts)
                    self.verts.append(np.asarray(xform(self.verts[vi]), dtype=float))
                vids.append(remap[vi])
            nf = self.add_face(vids, self.fuv[f], self.ftag[f], self.fmat[f], self.fsmooth[f], self.fisl[f], self.fswatch[f])
            if mirror:
                self.flip(nf)
            out.append(nf)
        return out

    def mirror_x(self, faces):
        return self.copy_faces(faces, lambda p: (-p[0], p[1], p[2]), mirror=True)

    def tri_count(self):
        return sum(len(f) - 2 for f in self.faces)


def _arc(pts, closed):
    pts = np.asarray(pts)
    if closed:
        pts = np.vstack([pts, pts[:1]])
    d = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(d)])


def loft(m, rings, *, closed, isl, tag, mat='Paint', smooth=True, mirror=False, wrap=False,
         caps=(False, False), cap_isl=(None, None), cap_mirror=False, rowtag=None, cap_tag=None,
         orient=True, cap_levels=(0.64, 0.3), v_ring=None):
    """Skin a list of rings (each M points). UV: u = arc length round the ring (mirror: distance
    from the symmetry vertex), v = arc length along the stations for each ring index (or, with
    v_ring, the arc length of ring index v_ring for every index)."""
    rings = [np.asarray(r, dtype=float) for r in rings]
    S, M = len(rings), len(rings[0])
    base = m.add_verts([p for r in rings for p in r])
    vid = lambda i, j: base + (i % S) * M + (j % M)
    nseg = M if closed else M - 1
    U = np.array([_arc(r, closed) for r in rings])   # (S, M+1) closed / (S, M) open
    if mirror:
        if closed:
            h = M // 2
            L = U[:, M:M + 1]
            U = np.where(np.arange(M + 1)[None, :] <= h, U, L - U)
        else:
            mid = (M - 1) // 2
            U = np.abs(U - U[:, mid:mid + 1])
    Sx = S + 1 if wrap else S
    V = np.zeros((Sx, M))
    for j in range(M):
        V[:, j] = _arc([rings[i % S][j] for i in range(Sx)], False)
    if v_ring is not None:      # one v per station (rows of texels follow the stations: no shear)
        V[:] = V[:, v_ring:v_ring + 1]
    nst = S if wrap else S - 1
    faces = []
    for i in range(nst):
        i1 = i + 1
        for j in range(nseg):
            jn = j + 1
            vids = [vid(i, j), vid(i, jn), vid(i1, jn), vid(i1, j)]
            uvs = [(U[i % S, j], V[i, j % M]), (U[i % S, jn], V[i, jn % M]),
                   (U[i1 % S, jn], V[i1, jn % M]), (U[i1 % S, j], V[i1, j % M])]
            t = tag if rowtag is None else tag + ':' + rowtag(j)
            faces.append(m.add_face(vids, uvs, t, mat, smooth, isl))
    if orient:
        s = 0.0
        for k, f in enumerate(faces):
            i = k // nseg
            c = rings[i % S].mean(axis=0)
            s += np.dot(m.fnormal(f), m.fcentre(f) - c)
        if s < 0:
            for f in faces:
                m.flip(f)
    caps_out = []
    for end, want in ((0, caps[0]), (1, caps[1])):
        if not want:
            continue
        i = 0 if end == 0 else S - 1
        inner = 1 if end == 0 else S - 2
        caps_out += cap(m, base + i * M, rings[i], away=rings[i].mean(axis=0) - rings[inner].mean(axis=0),
                        isl=cap_isl[end], tag=cap_tag or tag, mat=mat, mirror=cap_mirror, levels=cap_levels)
    return faces, caps_out


def cap(m, first_vid, ring, away, isl, tag, mat, mirror=False, smooth=False, levels=(0.64, 0.3)):
    """Fill a ring with concentric rings + a centre fan (keeps a loose grid for dents)."""
    ring = np.asarray(ring)
    M = len(ring)
    c = ring.mean(axis=0)
    n = newell(ring)
    if np.dot(n, away) < 0:
        n = -n
    ref = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = ref - np.dot(ref, n) * n
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)

    def uv(p):
        d = p - c
        u = np.dot(d, e1)
        return (abs(u) if mirror else u, np.dot(d, e2))

    rows = [list(range(first_vid, first_vid + M))]
    pts = [list(ring)]
    for s in levels:
        r = [c + (p - c) * s for p in ring]
        b = m.add_verts(r)
        rows.append(list(range(b, b + M)))
        pts.append(r)
    cv = m.add_verts([c])
    out = []
    for k in range(len(rows) - 1):
        for j in range(M):
            jn = (j + 1) % M
            vids = [rows[k][j], rows[k][jn], rows[k + 1][jn], rows[k + 1][j]]
            ps = [pts[k][j], pts[k][jn], pts[k + 1][jn], pts[k + 1][j]]
            out.append(m.add_face(vids, [uv(p) for p in ps], tag, mat, smooth, isl))
    for j in range(M):
        jn = (j + 1) % M
        vids = [rows[-1][j], rows[-1][jn], cv]
        ps = [pts[-1][j], pts[-1][jn], c]
        out.append(m.add_face(vids, [uv(p) for p in ps], tag, mat, smooth, isl))
    for f in out:
        if np.dot(m.fnormal(f), n) < 0:
            m.flip(f)
    return out


def superring(hx, hz, n, M, n_bot=None):
    """Closed superellipse ring in (x, z): index 0 at the top, then towards +x, M/2 at the bottom."""
    out = []
    for j in range(M):
        th = math.pi / 2 - 2 * math.pi * j / M
        c, s = math.cos(th), math.sin(th)
        nn = n if (s >= 0 or n_bot is None) else n_bot
        x = hx * math.copysign(abs(c) ** (2 / nn), c)
        z = hz * math.copysign(abs(s) ** (2 / nn), s)
        out.append((x, z))
    return out


def rbox(m, atlas, name, *, centre, half, rot=None, n=4.0, M=16, er=None, tag, mat='Paint', smooth=True,
         mid_step=0.2, shape=None, caps=(True, True), end_steps=(0, 35, 65, 90), cap_levels=(0.45,)):
    """Rounded box / cylinder lofted along local +Y (from -hy to +hy), cross-section a superellipse in
    local (x, z). Ends are rounded with radius er and capped. shape(t) -> (sx, sz, dz) optionally
    scales the section along the length (t in 0..1). rot: 3x3 matrix local->world."""
    hx, hy, hz = half
    if er is None:
        er = 0.3 * min(hx, hz, hy)
    er = min(er, hy * 0.95, hx * 0.95, hz * 0.95)
    R = np.eye(3) if rot is None else np.asarray(rot, dtype=float)
    C = np.asarray(centre, dtype=float)
    stations = []   # (y, inset)
    for a in end_steps:
        a = math.radians(a)
        stations.append((-hy + er - er * math.cos(a), er - er * math.sin(a)))
    span = 2 * hy - 2 * er
    nmid = max(0, int(math.ceil(span / mid_step)) - 1)
    for k in range(1, nmid + 1):
        stations.append((-hy + er + span * k / (nmid + 1), 0.0))
    for a in reversed(end_steps):
        a = math.radians(a)
        stations.append((hy - er + er * math.cos(a), er - er * math.sin(a)))
    # drop duplicate stations (er == 0)
    st = []
    for s in stations:
        if not st or abs(s[0] - st[-1][0]) > 1e-5 or abs(s[1] - st[-1][1]) > 1e-5:
            st.append(s)
    rings = []
    for (y, ins) in st:
        t = (y + hy) / (2 * hy)
        sx, sz, dz = shape(t) if shape else (1.0, 1.0, 0.0)
        ring = superring(max(1e-4, hx * sx - ins), max(1e-4, hz * sz - ins), n, M)
        rings.append([C + R @ np.array([x, y, z + dz]) for (x, z) in ring])
    isl = atlas.island(name)
    cis = (atlas.island(name + '_c0'), atlas.island(name + '_c1'))
    side, cp = loft(m, rings, closed=True, isl=isl, tag=tag, mat=mat, smooth=smooth, caps=caps, cap_isl=cis,
                    cap_levels=cap_levels)
    return side + cp


def lathe(m, atlas, name, profile, segs, *, tag, mat, smooth=True, rowtag=None):
    """Revolve an open (x, r) profile about the X axis; angle 0 is +Z (up)."""
    rings = []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        rings.append([(x, r * math.sin(a), r * math.cos(a)) for (x, r) in profile])
    isl = atlas.island(name)
    f, _ = loft(m, rings, closed=False, wrap=True, isl=isl, tag=tag, mat=mat, smooth=smooth, rowtag=rowtag)
    return f


def vertex_normals(m):
    vn = np.zeros((len(m.verts), 3))
    fn = [m.fnormal(f) for f in range(len(m.faces))]
    for f, vids in enumerate(m.faces):
        if m.fsmooth[f]:
            for v in vids:
                vn[v] += fn[f]
    ln = np.linalg.norm(vn, axis=1)
    ln[ln < 1e-12] = 1
    return vn / ln[:, None], fn


def paint(atlas, meshes, fn, swatches=None, swatch_isl=None):
    """Rasterise every face into an RGBA float image (sRGB values, row 0 = bottom like bpy pixels).
    fn(tag, p, n, ix, iy) -> (rgb, hint). Returns image and {(mesh, face): hint majority}."""
    S = atlas.size
    img = np.zeros((S, S, 4))
    img[..., 3] = 1
    done = np.zeros((S, S), bool)
    hints = {}
    for m in meshes:
        vn, fns = vertex_normals(m)
        for f, vids in enumerate(m.faces):
            isl = m.fisl[f]
            if isl is None or m.fswatch[f] is not None:
                continue
            P = np.array([atlas.px(isl, uv) for uv in m.fuv[f]])
            V = np.array([m.verts[v] for v in vids])
            N = np.array([vn[v] if m.fsmooth[f] else fns[f] for v in vids])
            votes = {}
            for t in range(1, len(vids) - 1):
                ids = (0, t, t + 1)
                a, b, c = P[ids[0]], P[ids[1]], P[ids[2]]
                den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
                if abs(den) < 1e-9:
                    continue
                x0, x1 = int(math.floor(min(a[0], b[0], c[0]))), int(math.ceil(max(a[0], b[0], c[0])))
                y0, y1 = int(math.floor(min(a[1], b[1], c[1]))), int(math.ceil(max(a[1], b[1], c[1])))
                xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
                px, py = xs.ravel() + 0.5, ys.ravel() + 0.5
                l0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den
                l1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den
                l2 = 1 - l0 - l1
                ok = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
                for k in np.nonzero(ok)[0]:
                    ix, iy = int(xs.ravel()[k]), int(ys.ravel()[k])
                    if not (0 <= ix < S and 0 <= iy < S):
                        continue
                    w = np.array([l0[k], l1[k], l2[k]])
                    p = w @ V[list(ids)]
                    nn = w @ N[list(ids)]
                    nn /= (np.linalg.norm(nn) or 1)
                    rgb, hint = fn(m.ftag[f], p, nn, ix, iy)
                    img[iy, ix, :3] = rgb
                    done[iy, ix] = True
                    votes[hint] = votes.get(hint, 0) + 1
            if votes:
                hints[(m.name, f)] = max(votes, key=votes.get)
            else:   # tiny face: sample its centre
                p = V.mean(axis=0)
                rgb, hint = fn(m.ftag[f], p, fns[f], 0, 0)
                hints[(m.name, f)] = hint
    if swatches and swatch_isl is not None:
        for k, rgb in enumerate(swatches):
            x, y = swatch_isl.ox + (k % swatch_isl.w), swatch_isl.oy + (k // swatch_isl.w)
            img[y, x, :3] = rgb
            done[y, x] = True
    # dilate painted texels outwards so nearest sampling at island borders never hits black
    for _ in range(3):
        grow = np.zeros_like(done)
        acc = np.zeros_like(img)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sd = np.roll(np.roll(done, dy, 0), dx, 1)
            si = np.roll(np.roll(img, dy, 0), dx, 1)
            take = sd & ~done & ~grow
            acc[take] = si[take]
            grow |= take
        img[grow] = acc[grow]
        done |= grow
    return img, hints


def swatch_uv(atlas, isl, k):
    """Normalised UV at the centre of swatch texel k."""
    x, y = isl.ox + (k % isl.w) + 0.5, isl.oy + (k // isl.w) + 0.5
    return (x / atlas.size, y / atlas.size)
