# Builds art/blender/loading_screen.blend (one studio scene per vehicle, BeamNG-style "car on a cube")
# and renders the loading-screen art into public/loading/.
#
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_loading.py
#
# Rebuilding overwrites the .blend from the vehicle .glb files. To keep hand edits made in Blender, re-render
# from the .blend instead (tools/blender/render_loading.py, see art/blender/README.md).
#
# Layout of every scene (Loading_<id>):
#   Vehicle  : <id>_Rig (empty, places the vehicle; custom props settle_z / settle_roll bounce the body)
#              ├ <id>_Body            (location/rotation DRIVEN from the axles/hubs: heave, pitch, roll)
#              ├ <id>_AxleFront/Rear  (solid axles: move Z and rotate Y to articulate; wheels are children)
#              ├ <id>_HubFL..RR       (independent corners: move Z for bump/droop, rotate Z to steer)
#              └ springs/shocks       (Stretch To a mount empty on the body, so they follow any pose)
#   Terrain  : simple blocks (cube, wedge, half-cylinder) with the pixel stone texture
#   Backdrop : cyclorama (floor curving into a wall), faces the camera
#   Lights   : one warm sun (toon bands come from the materials)
#   Camera   : front three-quarter hero camera, shifted to leave room for the title and progress UI
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import render_loading  # noqa: E402

VEH_DIR = os.path.join(REPO, 'public', 'models', 'vehicles')
BLEND = os.path.join(REPO, 'art', 'blender', 'loading_screen.blend')

OUTLINE = '#2a1a14'
SHADOW = (0.50, 0.40, 0.50)     # toon band multipliers (linear), warm purple-brown shadow
MID = (0.80, 0.74, 0.76)
LIT = (1.0, 1.0, 1.0)
T_MID, T_LIT = 0.42, 0.90

# Per-vehicle composition. corners: what each tyre stands on.
#   ('cube', height)            block under the tyre, top at `height`
#   ('wedge', lift, angle_deg)  tyre resting on a ramp; hub raised by `lift`
#   ('kerb', radius)            tyre on the crest of a half-cylinder lying across the path
# ride: optional body lift (m) over the axles, so a tucked tyre clears its arch through the whole settle loop.
# props: extra set dressing, placed relative to the camera: (screen-right m, depth-behind-car m) from the target.
# az/el: camera azimuth (deg from +Y towards +X) and elevation; dist in m; shift: camera lens shift.
SHOTS = {
    'lc70': dict(
        front='solid', rear='solid', steer=0.32, ride=0.02,
        corners={'FL': ('cube', 0.56)},
        props=[('cube', (-4.3, 3.4), (0.9, 0.9, 0.9), 0.5), ('cube', (-3.3, 3.9), (0.55, 0.55, 0.55), 0.2)],
        az=-46, el=8, dist=11.5, focal=50, target=(0.0, 0.1, 0.95), shift=(-0.11, 0.06), sun=(-58, 50)),
    'taco': dict(
        front='ifs', rear='solid', steer=0.28,
        corners={'FL': ('wedge', 0.17, 20), 'RR': ('cube', 0.36)},
        props=[('cube', (-4.4, 3.4), (1.3, 0.8, 0.45), 0.3)],
        az=-50, el=9, dist=12.5, focal=50, target=(0.0, 0.0, 0.95), shift=(-0.11, 0.04), sun=(-60, 50)),
    'wrx': dict(
        front='ifs', rear='ifs', steer=0.30,
        corners={'FL': ('kerb', 0.19)},
        props=[('cube', (-3.7, 2.8), (0.7, 0.7, 0.7), 0.4)],
        az=-44, el=8, dist=9.5, focal=50, target=(0.0, 0.0, 0.70), shift=(-0.11, 0.04), sun=(-58, 50)),
}
CORNERS = ('FL', 'FR', 'RL', 'RR')


# ------------------------------------------------------------------ small helpers
def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin(c):
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def sock(node, ident, out=False):
    return next(s for s in (node.outputs if out else node.inputs) if s.identifier == ident)


def link_to(obj, coll, parent=None):
    coll.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name, coll, loc=(0, 0, 0), parent=None, size=0.25, kind='PLAIN_AXES'):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = kind
    e.empty_display_size = size
    e.location = loc
    return link_to(e, coll, parent)


# ------------------------------------------------------------------ materials
def toon_mat(name, img=None, kind='paint', color=None):
    """Pixel texture (or flat colour) x stepped diffuse light, as emission. kind: paint | lamp."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (700, 0)
    em = nt.nodes.new('ShaderNodeEmission')
    em.location = (500, 0)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    if img is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.location = (-300, 150)
        tex.image = img
        tex.interpolation = 'Closest'
        col = tex.outputs['Color']
    else:
        rgb = nt.nodes.new('ShaderNodeRGB')
        rgb.location = (-300, 150)
        rgb.outputs[0].default_value = (*lin(hexrgb(color)), 1)
        col = rgb.outputs[0]
    if kind == 'lamp':
        nt.links.new(col, em.inputs['Color'])
        return m
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    diff.location = (-500, -150)
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    s2r.location = (-300, -150)
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.name = ramp.label = 'ToonBands'
    ramp.location = (-100, -150)
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*SHADOW, 1)
    cr.elements[1].position = T_LIT
    cr.elements[1].color = (*LIT, 1)
    cr.elements.new(T_MID).color = (*MID, 1)
    nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.location = (250, 0)
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    sock(mix, 'Factor_Float').default_value = 1.0
    nt.links.new(col, sock(mix, 'A_Color'))
    nt.links.new(ramp.outputs['Color'], sock(mix, 'B_Color'))
    nt.links.new(sock(mix, 'Result_Color', out=True), em.inputs['Color'])
    return m


_outline = None


def outline_mat():
    global _outline
    if _outline is None:
        m = bpy.data.materials.new('Outline')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*lin(hexrgb(OUTLINE)), 1)
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        m.use_backface_culling = True
        try:
            m.use_backface_culling_shadow = True
        except AttributeError:
            pass
        _outline = m
    return _outline


def add_outline(o, th):
    """Inverted-hull outline: a flipped, back-face-culled solidify shell in the outline colour."""
    o.data.materials.append(outline_mat())
    md = o.modifiers.new('Outline', 'SOLIDIFY')
    md.thickness = th
    md.offset = 1.0
    md.use_flip_normals = True
    md.use_rim = False
    md.material_offset = len(o.data.materials) - 1


def image_from(name, a):
    """numpy HxWx3 sRGB (row 0 = top) -> packed Blender image."""
    H, W = a.shape[:2]
    img = bpy.data.images.new(name, W, H, alpha=False)
    rgba = np.ones((H, W, 4), np.float32)
    rgba[..., :3] = a[::-1]   # Blender rows are bottom-up
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def stone_image():
    """1 m tile at 32 px/m: calm neutral stone, faint 0.5 m panel seams, sparse hand-placed specks."""
    S = 32
    hi, base, sh, deep = (hexrgb(h) for h in ('#e2d8c2', '#cfc3aa', '#b7aa92', '#9d8f79'))
    a = np.zeros((S, S, 3))
    a[:] = base
    rnd = np.random.default_rng(7)
    for y in range(S):
        for x in range(S):
            if x % 16 == 0 or y % 16 == 0:
                a[y, x] = sh
            elif x % 16 == 1 or y % 16 == 1:
                a[y, x] = hi
    for _ in range(14):
        x, y = rnd.integers(2, S), rnd.integers(2, S)
        if x % 16 > 2 and y % 16 > 2:
            a[y, x] = deep if rnd.random() < 0.4 else sh
            if rnd.random() < 0.5 and (x + 1) % 16 > 1:
                a[y, (x + 1) % S] = hi
    return image_from('stone_px', a)


def floor_image():
    """Sand speckle for the cyclorama floor (tiles at 32 px/m), alpha-free; the wall fades it out."""
    S = 64
    D = [hexrgb(h) for h in ('#f2c25a', '#e0a440', '#c4832e', '#9a5f24')]
    a = np.zeros((S, S, 3))
    a[:] = D[1]
    rnd = np.random.default_rng(3)
    for _ in range(22):
        x, y = rnd.integers(0, S), rnd.integers(0, S)
        w = 1 + int(rnd.integers(0, 2))
        for dx in range(w):
            a[y % S, (x + dx) % S] = D[2]
            a[(y - 1) % S, (x + dx) % S] = D[0]
    for _ in range(6):
        x, y = rnd.integers(0, S), rnd.integers(0, S)
        a[y, x] = D[3]
        a[y, (x + 1) % S] = D[2]
    return image_from('floor_px', a)


def cyc_mat(floor_img):
    """Floor sand that softly bands up into a pale cream wall (by height), x toon light."""
    m = toon_mat('Backdrop', floor_img)
    nt = m.node_tree
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    mix = next(n for n in nt.nodes if n.type == 'MIX')
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    geo.location = (-900, 400)
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    sep.location = (-700, 400)
    nt.links.new(geo.outputs['Position'], sep.inputs[0])
    band = nt.nodes.new('ShaderNodeValToRGB')
    band.name = band.label = 'WallBands'
    band.location = (-500, 400)
    nt.links.new(sep.outputs['Z'], band.inputs['Fac'])
    cr = band.color_ramp
    cr.interpolation = 'CONSTANT'
    stops = [(0.0, '#e0a440'), (0.07, '#e9b75e'), (0.2, '#efc67c'), (0.36, '#f3d59a'), (0.55, '#f6e2b6')]
    cr.elements[0].position, cr.elements[0].color = stops[0][0], (*lin(hexrgb(stops[0][1])), 1)
    cr.elements[1].position, cr.elements[1].color = stops[-1][0], (*lin(hexrgb(stops[-1][1])), 1)
    for p, h in stops[1:-1]:
        cr.elements.new(p).color = (*lin(hexrgb(h)), 1)
    # height in metres -> 0..1 over ~7 m
    mapz = nt.nodes.new('ShaderNodeMath')
    mapz.operation = 'MULTIPLY'
    mapz.inputs[1].default_value = 1 / 7
    mapz.location = (-600, 300)
    nt.links.remove(next(lk for lk in nt.links if lk.to_node == band))
    nt.links.new(sep.outputs['Z'], mapz.inputs[0])
    nt.links.new(mapz.outputs[0], band.inputs['Fac'])
    # sand speckle only on the floor: mix(band, tex/base * band, floor)
    rel = nt.nodes.new('ShaderNodeMix')
    rel.data_type = 'RGBA'
    rel.blend_type = 'MULTIPLY'
    rel.location = (0, 300)
    norm = nt.nodes.new('ShaderNodeMix')     # tex / base colour ~ 1 except specks
    norm.data_type = 'RGBA'
    norm.blend_type = 'DIVIDE'
    norm.location = (-200, 300)
    sock(norm, 'Factor_Float').default_value = 1.0
    nt.links.new(tex.outputs['Color'], sock(norm, 'A_Color'))
    sock(norm, 'B_Color').default_value = (*lin(hexrgb('#e0a440')), 1)
    nt.links.new(band.outputs['Color'], sock(rel, 'A_Color'))
    nt.links.new(sock(norm, 'Result_Color', out=True), sock(rel, 'B_Color'))
    fl = nt.nodes.new('ShaderNodeMapRange')
    fl.location = (-200, 500)
    fl.inputs['From Min'].default_value = 0.6
    fl.inputs['From Max'].default_value = 0.0
    fl.inputs['To Min'].default_value = 0.0
    fl.inputs['To Max'].default_value = 1.0
    nt.links.new(sep.outputs['Z'], fl.inputs['Value'])
    nt.links.new(fl.outputs['Result'], sock(rel, 'Factor_Float'))
    nt.links.remove(next(lk for lk in nt.links if lk.to_node == mix and lk.to_socket.identifier == 'A_Color'))
    nt.links.new(sock(rel, 'Result_Color', out=True), sock(mix, 'A_Color'))
    return m


# ------------------------------------------------------------------ geometry
def mesh_obj(name, bm, coll, mat, uv_px=32, tex_px=32, parent=None):
    """bmesh -> object, with box-projected UVs at uv_px texels per metre."""
    uvl = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            c = lp.vert.co
            u, v = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][ax]
            lp[uvl].uv = (u * uv_px / tex_px, v * uv_px / tex_px)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return link_to(bpy.data.objects.new(name, me), coll, parent)


def block(name, coll, mat, size, center_xy, yaw=0.0):
    sx, sy, sz = size
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, (v.co.z + 0.5) * sz))
    o = mesh_obj(name, bm, coll, mat)
    o.location = (center_xy[0], center_xy[1], 0)
    o.rotation_euler.z = yaw
    return o


def wedge(name, coll, mat, w, length, h, foot_xy, yaw=0.0):
    """Ramp rising towards local +Y: low edge at y=0, high (vertical) end at y=length."""
    bm = bmesh.new()
    xs = (-w / 2, w / 2)
    v = [bm.verts.new((x, y, z)) for x in xs for (y, z) in ((0, 0), (length, 0), (length, h))]
    bm.faces.new((v[0], v[2], v[1]))
    bm.faces.new((v[3], v[4], v[5]))
    bm.faces.new((v[0], v[3], v[5], v[2]))   # slope
    bm.faces.new((v[1], v[2], v[5], v[4]))   # back
    bm.faces.new((v[0], v[1], v[4], v[3]))   # bottom
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, coll, mat)
    o.location = (foot_xy[0], foot_xy[1], 0)
    o.rotation_euler.z = yaw
    return o


def kerb(name, coll, mat, length, r, center_xy, yaw=0.0, segs=10):
    """Half-cylinder lying along local X, crest at z = r."""
    bm = bmesh.new()
    prof = [(r * math.cos(math.pi * i / segs), r * math.sin(math.pi * i / segs)) for i in range(segs + 1)]
    a = [bm.verts.new((-length / 2, y, z)) for (y, z) in prof]
    b = [bm.verts.new((length / 2, y, z)) for (y, z) in prof]
    for i in range(segs):
        bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
    bm.faces.new(a[::-1])
    bm.faces.new(b)
    bm.faces.new((a[0], b[0], b[-1], a[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, coll, mat)
    o.location = (center_xy[0], center_xy[1], 0)
    o.rotation_euler.z = yaw
    return o


def cyclorama(coll, mat, yaw, back=7.0, front=14.0, width=44.0, radius=3.5, height=14.0):
    """Floor that curves up into a back wall. Built facing +Y, then turned towards the camera."""
    prof = [(front, 0.0), (-back + radius, 0.0)]
    for i in range(1, 9):
        a = (math.pi / 2) * i / 8
        prof.append((-back + radius - radius * math.sin(a), radius - radius * math.cos(a)))
    prof.append((-back, height))
    bm = bmesh.new()
    L = [bm.verts.new((-width / 2, y, z)) for y, z in prof]
    R = [bm.verts.new((width / 2, y, z)) for y, z in prof]
    for i in range(len(prof) - 1):
        bm.faces.new((L[i], R[i], R[i + 1], L[i + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < -0.1 or f.normal.y < -0.5:
            f.normal_flip()
    for f in bm.faces:
        f.smooth = True
    o = mesh_obj('Cyclorama', bm, coll, mat, uv_px=32, tex_px=64)
    o.rotation_euler.z = yaw
    return o


def helix(name, coll, mat, r, length, turns, wire, parent):
    """Coil spring along +Y from 0 to length (Stretch To scales it along Y)."""
    bm = bmesh.new()
    n_seg = int(turns * 10)
    ring = 6
    rings = []
    for i in range(n_seg + 1):
        t = i / n_seg
        a = t * turns * 2 * math.pi
        c = Vector((r * math.cos(a), t * length, r * math.sin(a)))
        tang = Vector((-r * math.sin(a) * turns * 2 * math.pi, length, r * math.cos(a) * turns * 2 * math.pi)).normalized()
        nrm = Vector((math.cos(a), 0, math.sin(a)))
        bin_ = tang.cross(nrm)
        rings.append([bm.verts.new(c + wire * (math.cos(2 * math.pi * k / ring) * nrm + math.sin(2 * math.pi * k / ring) * bin_))
                      for k in range(ring)])
    for i in range(n_seg):
        for k in range(ring):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % ring], rings[i + 1][(k + 1) % ring], rings[i + 1][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, coll, mat, parent=parent)


def tube(name, coll, mat, r, length, parent, segs=8):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=length)
    for v in bm.verts:
        v.co = Vector((v.co.x, v.co.z + length / 2, v.co.y))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, coll, mat, parent=parent)


def stretch(obj, target, rest):
    c = obj.constraints.new('STRETCH_TO')
    c.target = target
    c.rest_length = rest
    c.volume = 'NO_VOLUME'
    c.keep_axis = 'PLANE_X'
    return c


# ------------------------------------------------------------------ drivers
def drive(obj, path, index, expr, vars_):
    fc = obj.driver_add(path, index)
    d = fc.driver
    d.type = 'SCRIPTED'
    for name, kind, target, extra in vars_:
        v = d.variables.new()
        v.name = name
        if kind == 'PROP':
            v.type = 'SINGLE_PROP'
            v.targets[0].id = target
            v.targets[0].data_path = extra
        else:
            v.type = 'TRANSFORMS'
            v.targets[0].id = target
            v.targets[0].transform_type = extra
            v.targets[0].transform_space = 'TRANSFORM_SPACE'
    d.expression = expr
    return fc


# ------------------------------------------------------------------ one scene
def import_vehicle(vid):
    before = set(bpy.data.objects)
    bmats = set(bpy.data.materials)
    bpy.ops.import_scene.gltf(filepath=os.path.join(VEH_DIR, vid + '.glb'))
    objs = {o.name.split('.')[0]: o for o in set(bpy.data.objects) - before}
    for m in set(bpy.data.materials) - bmats:
        m.name = f'{vid}_{m.name.split(".")[0]}'
    for o in objs.values():
        for c in list(o.users_collection):
            c.objects.unlink(o)
        # glTF imports in QUATERNION mode, which would silently ignore the axle tilt and the body's
        # pitch/roll drivers (all set on rotation_euler): the tyres then rose into the arches.
        o.rotation_mode = 'XYZ'
    return objs


def build_scene(vid, shot):
    sc = bpy.data.scenes.new(f'Loading_{vid}')
    colls = {}
    for n in ('Vehicle', 'Terrain', 'Backdrop', 'Lights', 'Camera'):
        c = bpy.data.collections.new(f'{n}_{vid}')
        sc.collection.children.link(c)
        colls[n] = c
    V = colls['Vehicle']
    parts = import_vehicle(vid)
    body, wheel = parts['Body'], parts['Wheel']
    R = float(wheel['tyre_radius'])
    TW = float(wheel['tyre_width'])
    mk = {c: Vector(parts['Marker_Wheel' + c].location) for c in CORNERS}
    T = mk['FR'].x - mk['FL'].x
    WB = mk['FL'].y - mk['RL'].y
    YF, YR = mk['FL'].y, mk['RL'].y
    BZ = body.location.z

    # toon materials from the glTF textures
    for m in [m for m in bpy.data.materials if m.name.startswith(vid + '_')]:
        tex = next((n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE'), None)
        kind = 'lamp' if ('Lamp' in m.name or 'TailLight' in m.name or 'lamp' in m.name) else 'paint'
        t = toon_mat('TOON_' + m.name, tex.image if tex else None, kind, color='#808080')
        for o in parts.values():
            if o.type == 'MESH':
                for i, s in enumerate(o.data.materials):
                    if s == m:
                        o.data.materials[i] = t
        bpy.data.materials.remove(m)

    rig = empty(f'{vid}_Rig', V, size=1.0, kind='ARROWS')
    rig['settle_z'] = 0.0
    rig['settle_roll'] = 0.0
    for n in ('Marker_Ground', 'Marker_WheelFL', 'Marker_WheelFR', 'Marker_WheelRL', 'Marker_WheelRR'):
        bpy.data.objects.remove(parts.pop(n))
    body.name = f'{vid}_Body'
    link_to(body, V, rig)
    add_outline(body, 0.03)

    terrain_mat = toon_mat('Stone', stone_image())
    TC = colls['Terrain']
    steel = toon_mat('Coil', None, color='#e6b23a')
    shock_m = toon_mat('Shock', None, color='#33302c')

    # surface height under each tyre + build that feature
    lift = {c: 0.0 for c in CORNERS}
    for c, spec in shot['corners'].items():
        x, y = mk[c].x, mk[c].y
        side = -1 if c[1] == 'L' else 1
        if spec[0] == 'cube':
            h = spec[1]
            block(f'Cube_{c}', TC, terrain_mat, (0.95, 0.95, h), (x + side * 0.08, y + 0.05), yaw=math.radians(4))
            lift[c] = h
        elif spec[0] == 'kerb':
            r = spec[1]
            kerb(f'Kerb_{c}', TC, terrain_mat, 1.5, r, (x + side * 0.25, y))
            lift[c] = r
        elif spec[0] == 'wedge':
            lf, ang = spec[1], math.radians(spec[2])
            zh = R + lf
            # ramp rises towards the rear, so its slope faces the front camera; foot ahead of the tyre
            y1 = y + (zh - R / math.cos(ang)) / math.tan(ang)
            htop = lf * 1.6 + 0.12
            wedge(f'Wedge_{c}', TC, terrain_mat, 0.9, htop / math.tan(ang), htop, (x + side * 0.05, y1), yaw=math.pi)
            lift[c] = ('hub', lf)
    az = math.radians(shot['az'])
    fwd = Vector((-math.sin(az), -math.cos(az)))           # camera look direction on the ground
    right = Vector((fwd.y, -fwd.x))
    tgt2 = Vector(shot['target'][:2])
    for i, (kind, (s, b), size, yaw) in enumerate(shot['props']):
        xy = tuple(tgt2 + right * s + fwd * b)
        if kind == 'cube':
            block(f'Prop_Cube{i}', TC, terrain_mat, size, xy, yaw)
        elif kind == 'wedge_prop':
            wedge(f'Prop_Wedge{i}', TC, terrain_mat, size[0], size[1], size[2], xy, yaw)
        elif kind == 'kerb_prop':
            kerb(f'Prop_Kerb{i}', TC, terrain_mat, size[0], size[1], xy, yaw)
    for o in TC.objects:
        add_outline(o, 0.025)

    # wheels + axles/hubs
    wheel_data = wheel.data
    bpy.data.objects.remove(wheel)
    wheels = {}

    def make_wheel(c, parent, loc):
        w = bpy.data.objects.new(f'{vid}_Wheel{c}', wheel_data)
        link_to(w, V, parent)
        w.location = loc
        if c[1] == 'L':
            w.scale = (-1, 1, 1)
        wheels[c] = w
        return w
    add_outline_done = False
    hubz = {}
    axle_info = {}
    for end, yA in (('front', YF), ('rear', YR)):
        cs = ('FL', 'FR') if end == 'front' else ('RL', 'RR')
        if shot[end] == 'solid':
            ax = parts.get('AxleFront' if end == 'front' else 'AxleRear')
            ax.name = f'{vid}_Axle{end.capitalize()}'
            link_to(ax, V, rig)
            add_outline(ax, 0.02)
            zl = lift[cs[0]] if not isinstance(lift[cs[0]], tuple) else lift[cs[0]][1]
            zr = lift[cs[1]] if not isinstance(lift[cs[1]], tuple) else lift[cs[1]][1]
            th = math.asin((zl - zr) / T)
            c0 = R * math.cos(th) + (TW / 2) * abs(math.sin(th))
            zc = (zl + zr) / 2 + c0
            ax.location = (0, yA, zc)
            ax.rotation_euler = (0, th, 0)
            for c in cs:
                make_wheel(c, ax, (mk[c].x, 0, 0))
            hubz[cs[0]] = zc + T / 2 * math.sin(th)
            hubz[cs[1]] = zc - T / 2 * math.sin(th)
            axle_info[end] = ax
            # coil springs + shocks between axle and frame
            for c in cs:
                sx = mk[c].x * 0.66
                mount = empty(f'{vid}_Mount{c}', V, (sx, yA - 0.05, 0.78 - BZ), parent=body, size=0.08)
                sp = helix(f'{vid}_Spring{c}', V, steel, 0.085, 0.3, 4.5, 0.018, ax)
                sp.location = (sx, -0.05, 0.12)
                stretch(sp, mount, 0.3)
                sm = empty(f'{vid}_ShockTop{c}', V, (mk[c].x * 0.78, yA + 0.22, 0.98 - BZ), parent=body, size=0.08)
                sh = tube(f'{vid}_Shock{c}', V, shock_m, 0.035, 0.4, ax)
                sh.location = (mk[c].x * 0.78, 0.12, 0.05)
                stretch(sh, sm, 0.4)
        else:
            for c in cs:
                hz = R + (lift[c][1] if isinstance(lift[c], tuple) else lift[c])
                hub = empty(f'{vid}_Hub{c}', V, (mk[c].x, mk[c].y, hz), parent=rig, size=0.3, kind='CIRCLE')
                make_wheel(c, hub, (0, 0, 0))
                hubz[c] = hz
                # strut: from the hub (inboard) up into the wheel arch
                sgn = -1 if c[1] == 'L' else 1
                mtop = Vector((mk[c].x - sgn * 0.32, mk[c].y, R + 0.62))
                mount = empty(f'{vid}_Mount{c}', V, (mtop.x, mtop.y, mtop.z - BZ), parent=body, size=0.08)
                st = helix(f'{vid}_Spring{c}', V, steel, 0.07, 0.3, 4, 0.015, hub)
                st.location = (-sgn * 0.2, 0, 0.1)
                stretch(st, mount, 0.3)
    # steering (front wheels / hubs about Z)
    for c in ('FL', 'FR'):
        tgt = wheels[c] if shot['front'] == 'solid' else wheels[c].parent
        tgt.rotation_euler.z = shot['steer']
    for w in wheels.values():
        if not add_outline_done:
            add_outline(w, 0.022)
            add_outline_done = True
    for o in list(V.objects):
        if o.type == 'MESH' and o.name.startswith((f'{vid}_Spring', f'{vid}_Shock')) and 'Outline' not in o.modifiers:
            add_outline(o, 0.01)

    # body follows the running gear: heave = mean hub lift, pitch from front/rear, roll from left/right
    def end_vars(end, cs):
        if shot[end] == 'solid':
            ax = axle_info[end]
            return ([(end[0] + 'z', 'T', ax, 'LOC_Z'), (end[0] + 'r', 'T', ax, 'ROT_Y')],
                    f'{end[0]}z', f'{end[0]}r')
        hl, hr = wheels[cs[0]].parent, wheels[cs[1]].parent
        a, b = end[0] + 'l', end[0] + 'r'
        return ([(a, 'T', hl, 'LOC_Z'), (b, 'T', hr, 'LOC_Z')], f'({a}+{b})/2', f'({a}-{b})/{T:.4f}')
    fv, fmean, froll = end_vars('front', ('FL', 'FR'))
    rv, rmean, rroll = end_vars('rear', ('RL', 'RR'))
    pv = [('sz', 'PROP', rig, '["settle_z"]'), ('sr', 'PROP', rig, '["settle_roll"]')]
    drive(body, 'location', 2, f'{BZ - R + shot.get("ride", 0.0):.4f}+({fmean}+{rmean})/2+sz', fv + rv + pv)
    drive(body, 'rotation_euler', 0, f'({fmean}-{rmean})/{WB:.4f}', fv + rv)
    drive(body, 'rotation_euler', 1, f'({froll}+{rroll})/2+sr', fv + rv + pv)

    # report suspension travel (rel. to the body plane) so poses stay believable
    dz = {c: hubz[c] - R for c in CORNERS}
    heave = sum(dz.values()) / 4
    roll = ((dz['FL'] - dz['FR']) + (dz['RL'] - dz['RR'])) / 2 / T
    pitch = ((dz['FL'] + dz['FR']) - (dz['RL'] + dz['RR'])) / 2 / WB
    for c in CORNERS:
        x, y = mk[c].x, mk[c].y
        plane = heave + pitch * y - roll * x
        print(f'[loading] {vid} {c}: lift {dz[c]:+.3f}  suspension {dz[c] - plane:+.3f} (+bump/-droop)')
    print(f'[loading] {vid}: heave {heave:.3f} m, roll {math.degrees(roll):.1f} deg, pitch {math.degrees(pitch):.1f} deg')

    # settle loop: gentle body bob over 8 frames (cyclic), rendered as an optional sprite strip
    sc.frame_start, sc.frame_end = 1, 8
    for f in range(1, 9):
        ph = 2 * math.pi * (f - 1) / 8
        rig['settle_z'] = -0.025 * math.sin(ph)
        rig['settle_roll'] = 0.006 * math.sin(ph + 0.8)
        rig.keyframe_insert('["settle_z"]', frame=f)
        rig.keyframe_insert('["settle_roll"]', frame=f)
    rig['settle_z'] = 0.0
    rig['settle_roll'] = 0.0
    sc.frame_set(1)

    # backdrop
    yaw = -math.radians(shot['az'])
    cyclorama(colls['Backdrop'], cyc_mat(floor_image()), yaw)

    # camera
    az, el = math.radians(shot['az']), math.radians(shot['el'])
    d = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
    tgt = Vector(shot['target'])
    cam_d = bpy.data.cameras.new(f'{vid}_Cam')
    cam_d.lens = shot['focal']
    cam_d.sensor_fit = 'HORIZONTAL'
    cam_d.sensor_width = 36
    cam_d.shift_x, cam_d.shift_y = shot['shift']
    cam_d.clip_end = 200
    cam = link_to(bpy.data.objects.new(f'{vid}_Camera', cam_d), colls['Camera'])
    cam.location = tgt + d * shot['dist']
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam

    # light
    sun_d = bpy.data.lights.new(f'{vid}_Sun', 'SUN')
    sun_d.energy = 1.7
    sun_d.color = (1.0, 0.95, 0.86)
    sun_d.angle = math.radians(1.0)
    sun = link_to(bpy.data.objects.new(f'{vid}_Sun', sun_d), colls['Lights'])
    laz, lel = math.radians(shot['sun'][0]), math.radians(shot['sun'][1])
    ld = Vector((math.cos(lel) * math.sin(laz), math.cos(lel) * math.cos(laz), math.sin(lel)))
    sun.location = tgt + ld * 8
    sun.rotation_euler = (-ld).to_track_quat('-Z', 'Y').to_euler()

    world = bpy.data.worlds.new(f'{vid}_World')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*lin(hexrgb('#e8b860')), 1)
    bg.inputs['Strength'].default_value = 0.38
    sc.world = world
    render_loading.setup_render(sc)
    return sc


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    only = [a for a in sys.argv[sys.argv.index('--') + 1:]] if '--' in sys.argv else []
    for vid, shot in SHOTS.items():
        build_scene(vid, shot)
    for s in list(bpy.data.scenes):
        if not s.name.startswith('Loading_'):
            bpy.data.scenes.remove(s)
    for img in bpy.data.images:
        if not img.packed_file and img.source in ('FILE', 'GENERATED'):
            try:
                img.pack()
            except RuntimeError as e:
                print('[loading] pack failed', img.name, e)
    os.makedirs(os.path.dirname(BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
    print('[loading] saved', BLEND, os.path.getsize(BLEND) // 1024, 'KB')
    render_loading.render_all(only or None)


if __name__ == '__main__':
    main()
