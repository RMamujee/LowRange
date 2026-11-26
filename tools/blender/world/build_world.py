# Build art/blender/world_<map>.blend from a world export (tools/export/export_world.mjs).
#
#   node tools/export/export_world.mjs park
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/world/build_world.py -- park
#
# Options after `--`: the map id (park | race, default park) and `--no-render` to skip the preview
# stills (docs/previews/world_<map>_*.png).
#
# What gets built (collections):
#   Terrain            the 400 m heightfield at 1 m (the game's visual heights and softened shading
#                      normals) with a material that rebuilds the game's ground: per-surface pixel
#                      tiles at 32 px/m picked by the baked material grid, pixel-stepped ragged borders,
#                      darker trail tread, side projection on steep faces
#   Paths              roads / trails / race track centrelines as curves (viewport only)
#   Rocks              every gameplay rock: the game's exact convex hull and lit-top tone, rock tile
#   Trees, Props       glTF props from public/models as collection instances (grass tufts and flowering
#                      tufts as geometry-node instances); the race venue's procedural dressing
#   Markers            signposts, gates, trail / road posts, checkpoints, start line, spawn, trailhead
#   Vehicles           the three vehicle glTFs, wheels placed at their markers, parked at the spawn
#   Lights & Cameras   sun + named cameras (Trailhead / Race grid, each trail start, Overview, Top)
#   Library            hidden instance sources: one collection per prop model (edit one, all update)
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
MAP = next((a for a in ARGS if not a.startswith('-')), 'park')
RENDER = '--no-render' not in ARGS
EXP = os.path.join(HERE, 'export', MAP)
OUT = os.path.join(ROOT, 'art', 'blender', f'world_{MAP}.blend')
PREV = os.path.join(ROOT, 'docs', 'previews')
MODELS = os.path.join(ROOT, 'public', 'models')
if not os.path.exists(os.path.join(EXP, 'world.json')):
    sys.exit(f'[world] no export at {EXP}: run `node tools/export/export_world.mjs {MAP}` first')
W = json.load(open(os.path.join(EXP, 'world.json'), encoding='utf-8'))
SIZE, RES = W['map']['size'], W['map']['res']
N1 = RES + 1


def log(*a):
    print(f'[world {MAP} {time.time() - T0:6.1f}s]', *a, flush=True)


# ---------- coordinates: three.js (y up, -z forward) -> Blender (z up) ----------
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
CI = C.inverted()


def P(x, y, z):
    return Vector((x, -z, y))


def M(e):  # three.js Matrix4.elements (column-major) -> Blender world matrix
    return C @ Matrix((e[0:4], e[4:8], e[8:12], e[12:16])).transposed() @ CI


def verts3(flat):
    a = np.asarray(flat, dtype=np.float64).reshape(-1, 3)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], 1)


def srgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def lin(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def lhex(h, a=1.0):
    return (*lin(srgb(h)), a)


# ---------- grid ----------
VIS = np.fromfile(os.path.join(EXP, 'grid_vis.f32'), dtype=np.float32).reshape(N1, N1)  # [ix, iz]
MAT = np.fromfile(os.path.join(EXP, 'grid_mat.u8'), dtype=np.uint8).reshape(N1, N1)
PATH = np.fromfile(os.path.join(EXP, 'grid_path.i16'), dtype=np.int16).reshape(N1, N1)


def height(x, z):  # visualHeightAt, bilinear like the game
    cell = SIZE / RES
    fx = min(max((x + SIZE / 2) / cell, 0), RES - 1e-6)
    fz = min(max((z + SIZE / 2) / cell, 0), RES - 1e-6)
    ix, iz = int(fx), int(fz)
    tx, tz = fx - ix, fz - iz
    a, b, c, d = VIS[ix, iz], VIS[ix + 1, iz], VIS[ix, iz + 1], VIS[ix + 1, iz + 1]
    return float(a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz)


# ---------- scene + collections ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
SC = bpy.context.scene
SC.name = f'LowRange {W["map"]["name"]}'
SC.unit_settings.system = 'METRIC'


def coll(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or SC.collection).children.link(c)
    return c


COL = {n: coll(n) for n in ('Terrain', 'Paths', 'Rocks', 'Trees', 'Props', 'Markers', 'Vehicles', 'Lights & Cameras')}
LIB = coll('Library (instance sources)')
_sub = {}


def sub(top, name):
    k = (top, name)
    if k not in _sub:
        _sub[k] = coll(name, COL[top])
    return _sub[k]


def link(obj, c):
    c.objects.link(obj)
    return obj


def find_layer(lc, c):
    if lc.collection == c:
        return lc
    for ch in lc.children:
        r = find_layer(ch, c)
        if r:
            return r
    return None


# ---------- materials: the game's toon look ----------
# One shared node group: stepped 3-band light from the sun (warm mauve shade, lit, highlight; deeper
# shade on undersides), flat emission so nothing else lights it, linear distance fog to the haze.
# Matches src/gfx/toon.js (TOON uniforms) and main.js (Fog 90..330 m). Edit it once, all update.
SUN_ENERGY = 1.0
LIT_NORM = 0.2546 * SUN_ENERGY   # Shader-to-RGB of a white diffuse facing a sun of this energy (Eevee)
FOG = '#eac47c'
SKY = '#f3d58e'


def toon_group():
    ng = bpy.data.node_groups.get('LowRange Toon')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('LowRange Toon', 'ShaderNodeTree')
    it = ng.interface
    it.new_socket('Albedo', in_out='INPUT', socket_type='NodeSocketColor').default_value = (0.8, 0.8, 0.8, 1)
    it.new_socket('Emission', in_out='INPUT', socket_type='NodeSocketColor').default_value = (0, 0, 0, 1)
    s = it.new_socket('Alpha', in_out='INPUT', socket_type='NodeSocketFloat')
    s.default_value, s.min_value, s.max_value = 1.0, 0.0, 1.0
    s = it.new_socket('Fog', in_out='INPUT', socket_type='NodeSocketFloat')
    s.default_value, s.min_value, s.max_value = 1.0, 0.0, 1.0
    it.new_socket('Shader', in_out='OUTPUT', socket_type='NodeSocketShader')
    N, L = ng.nodes, ng.links
    gi, go = N.new('NodeGroupInput'), N.new('NodeGroupOutput')
    gi.location, go.location = (-1100, 0), (900, 0)
    diff = N.new('ShaderNodeBsdfDiffuse'); diff.location = (-1100, -300)
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = N.new('ShaderNodeShaderToRGB'); s2r.location = (-900, -300)
    L.new(diff.outputs[0], s2r.inputs[0])
    bw = N.new('ShaderNodeRGBToBW'); bw.location = (-720, -300)
    L.new(s2r.outputs['Color'], bw.inputs[0])
    norm = N.new('ShaderNodeMath'); norm.operation = 'DIVIDE'; norm.location = (-560, -300)
    norm.label = 'lit (0 = shadow, 1 = facing the sun)'
    L.new(bw.outputs[0], norm.inputs[0]); norm.inputs[1].default_value = LIT_NORM
    ramp = N.new('ShaderNodeValToRGB'); ramp.location = (-380, -300); ramp.label = 'toon bands (toon.js)'
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position, cr.elements[0].color = 0.0, lhex('#c4a6aa')
    cr.elements[1].position, cr.elements[1].color = 0.86, lhex('#fffbe8')
    e = cr.elements.new(0.22); e.color = lhex('#fff8ec')
    L.new(norm.outputs[0], ramp.inputs['Fac'])
    # undersides one notch deeper in the shade band
    geo = N.new('ShaderNodeNewGeometry'); geo.location = (-900, -600)
    sep = N.new('ShaderNodeSeparateXYZ'); sep.location = (-720, -600)
    L.new(geo.outputs['Normal'], sep.inputs[0])
    under = N.new('ShaderNodeMapRange'); under.interpolation_type = 'SMOOTHSTEP'; under.location = (-560, -600)
    L.new(sep.outputs['Z'], under.inputs['Value'])
    under.inputs['From Min'].default_value, under.inputs['From Max'].default_value = -0.6, 0.2
    under.inputs['To Min'].default_value, under.inputs['To Max'].default_value = 0.82, 1.0
    inshade = N.new('ShaderNodeMath'); inshade.operation = 'LESS_THAN'; inshade.location = (-380, -520)
    L.new(norm.outputs[0], inshade.inputs[0]); inshade.inputs[1].default_value = 0.22
    uf = N.new('ShaderNodeMix'); uf.data_type = 'FLOAT'; uf.location = (-200, -560)
    L.new(inshade.outputs[0], uf.inputs['Factor']); uf.inputs['A'].default_value = 1.0
    L.new(under.outputs['Result'], uf.inputs['B'])
    k = N.new('ShaderNodeVectorMath'); k.operation = 'SCALE'; k.location = (-20, -360)
    L.new(ramp.outputs['Color'], k.inputs[0]); L.new(uf.outputs['Result'], k.inputs['Scale'])
    lit = N.new('ShaderNodeMix'); lit.data_type = 'RGBA'; lit.blend_type = 'MULTIPLY'; lit.location = (150, -100)
    lit.inputs['Factor'].default_value = 1.0
    L.new(gi.outputs['Albedo'], lit.inputs['A']); L.new(k.outputs[0], lit.inputs['B'])
    add = N.new('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'; add.location = (320, -100)
    add.inputs['Factor'].default_value = 1.0
    L.new(lit.outputs['Result'], add.inputs['A']); L.new(gi.outputs['Emission'], add.inputs['B'])
    # linear fog to the golden haze, 90..330 m like the game
    cam = N.new('ShaderNodeCameraData'); cam.location = (150, -420)
    fog = N.new('ShaderNodeMapRange'); fog.location = (320, -420); fog.label = 'fog 90..330 m'
    L.new(cam.outputs['View Distance'], fog.inputs['Value'])
    fog.inputs['From Min'].default_value, fog.inputs['From Max'].default_value = 90.0, 330.0
    fogk = N.new('ShaderNodeMath'); fogk.operation = 'MULTIPLY'; fogk.location = (480, -420)
    L.new(fog.outputs['Result'], fogk.inputs[0]); L.new(gi.outputs['Fog'], fogk.inputs[1])
    famt = N.new('ShaderNodeValue'); famt.name = famt.label = 'Fog amount (scene)'; famt.location = (320, -600)
    famt.outputs[0].default_value = 1.0
    fogk2 = N.new('ShaderNodeMath'); fogk2.operation = 'MULTIPLY'; fogk2.location = (480, -560)
    L.new(fogk.outputs[0], fogk2.inputs[0]); L.new(famt.outputs[0], fogk2.inputs[1])
    fogk = fogk2
    fmix = N.new('ShaderNodeMix'); fmix.data_type = 'RGBA'; fmix.location = (500, -100)
    L.new(fogk.outputs[0], fmix.inputs['Factor']); L.new(add.outputs['Result'], fmix.inputs['A'])
    fmix.inputs['B'].default_value = lhex(FOG)
    em = N.new('ShaderNodeEmission'); em.location = (680, -100)
    L.new(fmix.outputs['Result'], em.inputs['Color'])
    tr = N.new('ShaderNodeBsdfTransparent'); tr.location = (680, 60)
    ms = N.new('ShaderNodeMixShader'); ms.location = (760, 0)
    L.new(gi.outputs['Alpha'], ms.inputs['Fac']); L.new(tr.outputs[0], ms.inputs[1]); L.new(em.outputs[0], ms.inputs[2])
    L.new(ms.outputs[0], go.inputs['Shader'])
    return ng


def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); out.location = (400, 0)
    g = nt.nodes.new('ShaderNodeGroup'); g.node_tree = toon_group(); g.location = (150, 0)
    nt.links.new(g.outputs[0], out.inputs['Surface'])
    return m, nt, g


def set_transparent(m):
    try:
        m.surface_render_method = 'DITHERED'
    except Exception:
        pass


def toonify(m):
    """Turn an imported glTF Principled material into the toon group, keeping its texture inputs."""
    if m.get('lr_toon'):
        return
    nt = m.node_tree
    pr = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not pr:
        return
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    g = nt.nodes.new('ShaderNodeGroup'); g.node_tree = toon_group(); g.location = pr.location

    def move(src, dst):
        if src.is_linked:
            nt.links.new(src.links[0].from_socket, dst)
            return True
        if hasattr(src, 'default_value') and hasattr(dst, 'default_value'):
            try:
                dst.default_value = src.default_value
            except (TypeError, ValueError):
                dst.default_value = (*src.default_value[:3], 1) if hasattr(src.default_value, '__len__') else src.default_value
        return False
    move(pr.inputs['Base Color'], g.inputs['Albedo'])
    if pr.inputs['Emission Strength'].default_value > 0 and (pr.inputs['Emission Color'].is_linked or any(pr.inputs['Emission Color'].default_value[:3])):
        if pr.inputs['Emission Color'].is_linked:
            nt.links.new(pr.inputs['Emission Color'].links[0].from_socket, g.inputs['Emission'])
        else:
            g.inputs['Emission'].default_value = pr.inputs['Emission Color'].default_value
    if pr.inputs['Alpha'].is_linked:
        nt.links.new(pr.inputs['Alpha'].links[0].from_socket, g.inputs['Alpha'])
        set_transparent(m)
    nt.nodes.remove(pr)
    nt.links.new(g.outputs[0], out.inputs['Surface'])
    for n in nt.nodes:
        if n.type == 'TEX_IMAGE':
            n.interpolation = 'Closest'
    m['lr_toon'] = True


OUTLINE = None


def outline_mat():
    global OUTLINE
    if OUTLINE:
        return OUTLINE
    m = bpy.data.materials.new('Outline (#2a1a14)')
    nt = m.node_tree
    nt.nodes.clear()
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = lhex('#2a1a14')
    nt.links.new(e.outputs[0], o.inputs['Surface'])
    m.use_backface_culling = True
    try:
        m.use_backface_culling_shadow = True
    except Exception:
        pass
    OUTLINE = m
    return m


def add_outline(obj, th=0.03):
    """Inverted-hull outline (viewport); renders also get 1-pixel Freestyle lines."""
    me = obj.data
    if me.users > 1 and me.get('lr_outlined'):
        pass
    if outline_mat().name not in [m.name for m in me.materials if m]:
        me.materials.append(outline_mat())
    md = obj.modifiers.new('Outline', 'SOLIDIFY')
    md.thickness = th
    md.offset = 1.0
    md.use_flip_normals = True
    md.use_rim = False
    md.material_offset = len(me.materials) - 1
    me['lr_outlined'] = True


# ---------- images ----------
def load_png(path, name):
    img = bpy.data.images.load(path)
    img.name = name
    img.colorspace_settings.name = 'sRGB'
    img.pack()
    return img


TILES = [load_png(os.path.join(EXP, m['tile']), f'tile_{m["layer"]}') for m in W['materials']]


def tex_node(nt, img, vec, loc, ext='REPEAT'):
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img; t.interpolation = 'Closest'; t.extension = ext; t.location = loc
    nt.links.new(vec, t.inputs['Vector'])
    return t


def mathn(nt, op, a, b=None, loc=(0, 0)):
    n = nt.nodes.new('ShaderNodeMath'); n.operation = op; n.location = loc
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def vmath(nt, op, a, b=None, loc=(0, 0)):
    n = nt.nodes.new('ShaderNodeVectorMath'); n.operation = op; n.location = loc
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (tuple, list)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def tile_projection(nt, loc=(-1400, 0)):
    """World-space tile coordinates like terrain_look.js: top-down, or from the side on steep faces
    (dominant axis, no blend). 4 m per tile; v flipped so PNG rows match the game's texture rows."""
    x0, y0 = loc
    geo = nt.nodes.new('ShaderNodeNewGeometry'); geo.location = (x0, y0)
    pos = nt.nodes.new('ShaderNodeSeparateXYZ'); pos.location = (x0 + 180, y0)
    nt.links.new(geo.outputs['Position'], pos.inputs[0])
    nrm = nt.nodes.new('ShaderNodeSeparateXYZ'); nrm.location = (x0 + 180, y0 - 200)
    absn = vmath(nt, 'ABSOLUTE', geo.outputs['Normal'], loc=(x0 + 60, y0 - 200))
    nt.links.new(absn, nrm.inputs[0])

    def comb(a, b, l):
        c = nt.nodes.new('ShaderNodeCombineXYZ'); c.location = l
        nt.links.new(a, c.inputs[0]); nt.links.new(b, c.inputs[1])
        return c.outputs[0]
    negy = mathn(nt, 'MULTIPLY', pos.outputs['Y'], -1.0, (x0 + 360, y0 - 60))
    negz = mathn(nt, 'MULTIPLY', pos.outputs['Z'], -1.0, (x0 + 360, y0 - 120))
    top = comb(pos.outputs['X'], pos.outputs['Y'], (x0 + 540, y0 + 60))
    side_x = comb(negy, negz, (x0 + 540, y0 - 40))      # three.js wp.zy
    side_z = comb(pos.outputs['X'], negz, (x0 + 540, y0 - 140))  # three.js wp.xy
    mxy = mathn(nt, 'MAXIMUM', nrm.outputs['X'], nrm.outputs['Y'], (x0 + 360, y0 - 220))
    thr = mathn(nt, 'MULTIPLY', mxy, 0.9, (x0 + 540, y0 - 220))
    is_top = mathn(nt, 'GREATER_THAN', nrm.outputs['Z'], thr, (x0 + 720, y0 - 220))
    is_x = mathn(nt, 'GREATER_THAN', nrm.outputs['X'], nrm.outputs['Y'], (x0 + 720, y0 - 300))
    m1 = nt.nodes.new('ShaderNodeMix'); m1.data_type = 'VECTOR'; m1.location = (x0 + 720, y0 - 80)
    nt.links.new(is_x, m1.inputs['Factor']); nt.links.new(side_z, m1.inputs[4]); nt.links.new(side_x, m1.inputs[5])
    m2 = nt.nodes.new('ShaderNodeMix'); m2.data_type = 'VECTOR'; m2.location = (x0 + 900, y0)
    nt.links.new(is_top, m2.inputs['Factor']); nt.links.new(m1.outputs[1], m2.inputs[4]); nt.links.new(top, m2.inputs[5])
    return vmath(nt, 'SCALE', m2.outputs[1], loc=(x0 + 1080, y0)), geo, pos


def scale_in(nt, sock, k):
    sock.node.inputs['Scale'].default_value = k


def terrain_material():
    # per grid vertex: R = material id / 255, G = trail tread, B = slow tone drift (terrain_look.js)
    img = bpy.data.images.new('terrain_grid (material id, tread, tone)', N1, N1, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    ix, iz = np.meshgrid(np.arange(N1), np.arange(N1), indexing='ij')
    n = np.sin(ix * 0.071 + np.sin(iz * 0.05) * 2.1) * np.sin(iz * 0.063 + np.sin(ix * 0.045) * 1.7)
    tread = (PATH >= W['map']['nRoads']) & (MAT != 3)
    px = np.zeros((N1, N1, 4), np.float32)   # [row = iz, col = ix]
    px[..., 0] = MAT.T / 255.0
    px[..., 1] = tread.T.astype(np.float32)
    px[..., 2] = np.round((n.T * 0.5 + 0.5) * 255) / 255
    px[..., 3] = 1
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()
    m, nt, g = new_mat('Terrain (pixel ground)')
    tp, geo, pos = tile_projection(nt)
    scale_in(nt, tp, 0.25)  # 4 m per tile
    # pixel-stepped, ragged material borders: snap to a 1/16 m lattice, jitter by noise, nearest vertex
    xy = nt.nodes.new('ShaderNodeCombineXYZ'); xy.location = (-1200, 500)
    nt.links.new(pos.outputs['X'], xy.inputs[0]); nt.links.new(pos.outputs['Y'], xy.inputs[1])
    s16 = vmath(nt, 'SCALE', xy.outputs[0], loc=(-1050, 500))
    s16.node.inputs['Scale'].default_value = 16.0
    lat = vmath(nt, 'DIVIDE', vmath(nt, 'FLOOR', s16, loc=(-900, 500)), (16, 16, 16), (-750, 500))
    noise = nt.nodes.new('ShaderNodeTexNoise'); noise.location = (-600, 650)
    noise.inputs['Scale'].default_value = 0.9; noise.inputs['Detail'].default_value = 0.0
    nt.links.new(lat, noise.inputs['Vector'])
    jit = vmath(nt, 'SCALE', vmath(nt, 'SUBTRACT', noise.outputs['Color'], (0.5, 0.5, 0.5), (-420, 650)), loc=(-260, 650))
    jit.node.inputs['Scale'].default_value = 2.6   # Blender noise has less contrast than the game's pxNoise
    grain = nt.nodes.new('ShaderNodeTexWhiteNoise'); grain.noise_dimensions = '3D'; grain.location = (-600, 420)
    gs = vmath(nt, 'SCALE', lat, loc=(-750, 380))
    gs.node.inputs['Scale'].default_value = 16.0
    nt.links.new(gs, grain.inputs['Vector'])
    gr = vmath(nt, 'SCALE', vmath(nt, 'SUBTRACT', grain.outputs['Color'], (0.5, 0.5, 0.5), (-420, 420)), loc=(-260, 420))
    gr.node.inputs['Scale'].default_value = 0.35
    # grid coords: gx = x + 200, gz = -y + 200 (three.js z = -Blender y)
    gxy = nt.nodes.new('ShaderNodeCombineXYZ'); gxy.location = (-420, 260)
    nt.links.new(mathn(nt, 'ADD', pos.outputs['X'], SIZE / 2, (-600, 280)), gxy.inputs[0])
    nt.links.new(mathn(nt, 'SUBTRACT', SIZE / 2, pos.outputs['Y'], (-600, 220)), gxy.inputs[1])
    g1 = vmath(nt, 'ADD', vmath(nt, 'ADD', gxy.outputs[0], jit, (-100, 500)), gr, (40, 500))
    gi = vmath(nt, 'FLOOR', vmath(nt, 'ADD', g1, (0.5, 0.5, 0), (180, 500)), loc=(320, 500))
    gi = vmath(nt, 'MINIMUM', vmath(nt, 'MAXIMUM', gi, (0, 0, 0), (460, 500)), (RES, RES, 0), (600, 500))
    uv = vmath(nt, 'DIVIDE', vmath(nt, 'ADD', gi, (0.5, 0.5, 0), (740, 500)), (N1, N1, 1), (880, 500))
    cell = tex_node(nt, img, uv, (1020, 500), 'EXTEND')
    cs = nt.nodes.new('ShaderNodeSeparateColor'); cs.location = (1200, 500)
    nt.links.new(cell.outputs['Color'], cs.inputs[0])
    mid = mathn(nt, 'ROUND', mathn(nt, 'MULTIPLY', cs.outputs[0], 255.0, (1350, 560)), None, (1500, 560))
    col = None
    for i, t in enumerate(TILES):
        tn = tex_node(nt, t, tp, (1200, -200 - i * 260))
        if col is None:
            col = tn.outputs['Color']
            continue
        eq = mathn(nt, 'COMPARE', mid, float(i), (1500, -200 - i * 260))
        eq.node.inputs[2].default_value = 0.25
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.location = (1700, -200 - i * 260)
        nt.links.new(eq, mx.inputs['Factor']); nt.links.new(col, mx.inputs['A']); nt.links.new(tn.outputs['Color'], mx.inputs['B'])
        col = mx.outputs['Result']
    # worn trail tread one step darker; stepped slow tone drift
    tread_k = mathn(nt, 'SUBTRACT', 1.0, mathn(nt, 'MULTIPLY', mathn(nt, 'GREATER_THAN', cs.outputs[1], 0.5, (1500, 380)), 0.16, (1650, 380)), (1800, 380))
    tone_k = mathn(nt, 'ADD', 0.94, mathn(nt, 'MULTIPLY', mathn(nt, 'FLOOR', mathn(nt, 'MULTIPLY', cs.outputs[2], 3.0, (1500, 300)), None, (1650, 300)), 0.04, (1800, 300)), (1950, 300))
    k = mathn(nt, 'MULTIPLY', tread_k, tone_k, (2100, 340))
    sc = vmath(nt, 'SCALE', col, loc=(2250, 0))
    nt.links.new(k, sc.node.inputs['Scale'])
    nt.links.new(sc, g.inputs['Albedo'])
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    g.location, out.location = (2450, 0), (2650, 0)
    return m


def rock_material():
    m, nt, g = new_mat('Gameplay rock (pixel rock tile x tone)')
    tp, geo, pos = tile_projection(nt)
    scale_in(nt, tp, 0.25)
    t = tex_node(nt, TILES[2], tp, (-200, 0))
    ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'tone'; ca.location = (-200, -250)
    mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.location = (0, 0)
    mx.inputs['Factor'].default_value = 1.0
    nt.links.new(t.outputs['Color'], mx.inputs['A']); nt.links.new(ca.outputs['Color'], mx.inputs['B'])
    nt.links.new(mx.outputs['Result'], g.inputs['Albedo'])
    return m


_flat = {}


def flat_mat(rec, inst_color=False, obj_color=False):
    """Material for the game's procedural parts (MeshStandardMaterial colour / emissive / opacity /
    vertex colours); per-instance colours via the instancer attribute or the object colour."""
    key = (json.dumps(rec, sort_keys=True), inst_color, obj_color)
    if key in _flat:
        return _flat[key]
    nm = rec.get('name') or ''
    label = nm if nm and not nm.startswith('dressing') else f'Paint {rec["color"]}'
    if rec.get('texts'):
        label = 'Sign board ' + rec.get('bg', '')
    if rec.get('check'):
        label = 'Chequered'
    m, nt, g = new_mat(label)
    base = lhex(rec['bg'] if rec.get('bg') else rec['color'])
    src = None
    if rec.get('check'):
        ck = nt.nodes.new('ShaderNodeTexChecker'); ck.location = (-300, 0)
        tc = nt.nodes.new('ShaderNodeTexCoord'); tc.location = (-500, 0)
        nt.links.new(tc.outputs['Generated'], ck.inputs['Vector'])
        ck.inputs['Color1'].default_value = lhex('#111111'); ck.inputs['Color2'].default_value = lhex('#f2efe6')
        ck.inputs['Scale'].default_value = 24.0
        src = ck.outputs['Color']
    elif rec.get('vertexColors'):
        vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'; vc.location = (-300, 0)
        src = vc.outputs['Color']
    tint = None
    if inst_color:
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_type = 'INSTANCER'; at.attribute_name = 'inst_color'; at.location = (-300, -200)
        tint = at.outputs['Color']
    elif obj_color:
        oi = nt.nodes.new('ShaderNodeObjectInfo'); oi.location = (-300, -200)
        tint = oi.outputs['Color']
    col = src
    if col is None:
        rgb = nt.nodes.new('ShaderNodeRGB'); rgb.outputs[0].default_value = base; rgb.location = (-300, 150)
        col = rgb.outputs[0]
    elif not rec.get('check') and rec['color'].lower() != '#ffffff':
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1
        nt.links.new(col, mx.inputs['A']); mx.inputs['B'].default_value = base
        col = mx.outputs['Result']
    if tint is not None:
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1; mx.location = (-80, 0)
        nt.links.new(col, mx.inputs['A']); nt.links.new(tint, mx.inputs['B'])
        col = mx.outputs['Result']
    nt.links.new(col, g.inputs['Albedo'])
    if rec.get('emissive', '#000000') != '#000000':
        g.inputs['Emission'].default_value = lhex(rec['emissive'])
    if rec.get('transparent') and rec.get('opacity', 1) < 1:
        g.inputs['Alpha'].default_value = rec['opacity']
        set_transparent(m)
    m.use_backface_culling = not rec.get('doubleSided')
    _flat[key] = m
    return m


# ---------- mesh helpers ----------
def mesh_from(name, v, tris, mat_idx=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in v], [], [tuple(t) for t in tris])
    if mat_idx is not None:
        me.polygons.foreach_set('material_index', np.asarray(mat_idx, dtype=np.int32))
    me.update()
    return me


def geom_mesh(gi, name, nmats=1):
    gr = W['geoms'][gi]
    if gr.get('_mesh'):
        return bpy.data.meshes[gr['_mesh']]
    v = verts3(gr['v'])
    n = len(v)
    idx = np.asarray(gr['i'] if gr['i'] is not None else range(n), dtype=np.int64).reshape(-1, 3)
    mi = np.zeros(len(idx), np.int32)
    for start, count, m in gr['groups']:
        mi[start // 3:(start + count) // 3] = m if m < nmats else 0   # a box with one material still has 6 groups
    me = mesh_from(name, v, idx, mi)
    if gr.get('color'):
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        c = np.asarray(gr['color'], np.float32).reshape(-1, 3)
        ca.data.foreach_set('color', np.concatenate([c, np.ones((len(c), 1), np.float32)], 1).ravel())
    if gr['type'] not in ('BoxGeometry', 'PlaneGeometry'):
        me.shade_smooth() if gr['type'] in ('CylinderGeometry',) else None
    gr['_mesh'] = me.name
    return me


# ---------- scatter: geometry-node instancing of one source object ----------
def scatter_group():
    ng = bpy.data.node_groups.get('LowRange Scatter')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('LowRange Scatter', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N, L = ng.nodes, ng.links
    gi, go = N.new('NodeGroupInput'), N.new('NodeGroupOutput')
    gi.location, go.location = (-600, 0), (400, 0)
    oi = N.new('GeometryNodeObjectInfo'); oi.location = (-350, -150)
    oi.inputs['As Instance'].default_value = True
    rot = N.new('GeometryNodeInputNamedAttribute'); rot.data_type = 'FLOAT_VECTOR'; rot.inputs['Name'].default_value = 'rot'; rot.location = (-350, -350)
    scl = N.new('GeometryNodeInputNamedAttribute'); scl.data_type = 'FLOAT_VECTOR'; scl.inputs['Name'].default_value = 'scl'; scl.location = (-350, -500)
    iop = N.new('GeometryNodeInstanceOnPoints'); iop.location = (100, 0)
    L.new(gi.outputs['Geometry'], iop.inputs['Points'])
    L.new(oi.outputs['Geometry'], iop.inputs['Instance'])
    L.new(rot.outputs['Attribute'], iop.inputs['Rotation'])
    L.new(scl.outputs['Attribute'], iop.inputs['Scale'])
    L.new(iop.outputs['Instances'], go.inputs['Geometry'])
    return ng


def scatter(name, src_obj, mats, colors, collection):
    pts, rot, scl = [], [], []
    for mw in mats:
        loc, q, s = mw.decompose()
        pts.append(tuple(loc)); rot.extend(q.to_euler('XYZ')); scl.extend(s)
    me = bpy.data.meshes.new(name + ' (points)')
    me.from_pydata(pts, [], [])
    me.attributes.new('rot', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', rot)
    me.attributes.new('scl', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', scl)
    if colors:
        c = np.asarray([lhex(h) for h in colors], np.float32)
        me.attributes.new('inst_color', 'FLOAT_COLOR', 'POINT').data.foreach_set('color', c.ravel())
    ob = link(bpy.data.objects.new(name, me), collection)
    md = ob.modifiers.new('Scatter', 'NODES')
    ng = scatter_group().copy()   # one small tree per source: Object Info points at it directly
    ng.name = 'Scatter ' + src_obj.name
    next(n for n in ng.nodes if n.type == 'OBJECT_INFO').inputs['Object'].default_value = src_obj
    md.node_group = ng
    ob['instances'] = len(pts)
    return ob


# ======================================================================================
# Terrain
log('terrain')
cell = SIZE / RES
xs = -SIZE / 2 + np.arange(N1) * cell
gx, gz = np.meshgrid(xs, xs, indexing='ij')                          # [ix, iz]
V = np.stack([gx, -gz, VIS], -1).reshape(-1, 3)                      # vertex id = ix * N1 + iz
ix, iz = np.meshgrid(np.arange(RES), np.arange(RES), indexing='ij')
a = (ix * N1 + iz).ravel(); b = (ix * N1 + iz + 1).ravel(); c_ = ((ix + 1) * N1 + iz + 1).ravel(); d = ((ix + 1) * N1 + iz).ravel()
# same diagonal as three.js PlaneGeometry: (ix, iz+1)-(ix+1, iz); winding facing +Z in Blender
TRI = np.concatenate([np.stack([a, b, d], 1), np.stack([b, c_, d], 1)])
me = bpy.data.meshes.new('Terrain')
me.vertices.add(len(V)); me.vertices.foreach_set('co', V.astype(np.float32).ravel())
me.loops.add(TRI.size); me.loops.foreach_set('vertex_index', TRI.astype(np.int32).ravel())
me.polygons.add(len(TRI)); me.polygons.foreach_set('loop_start', np.arange(0, TRI.size, 3, dtype=np.int32))
me.update(calc_edges=True)
me.validate()
me.shade_smooth()
# shading normals from a softened heightfield (terrain_look.softenTerrainNormals, 2 box-blur passes)
h = VIS.astype(np.float64)
for _ in range(2):
    p = np.pad(h, 1, mode='edge')
    h = sum(p[1 + dx:1 + dx + N1, 1 + dz:1 + dz + N1] for dx in (-1, 0, 1) for dz in (-1, 0, 1)) / 9
p = np.pad(h, 1, mode='edge')
nx = p[0:N1, 1:N1 + 1] - p[2:N1 + 2, 1:N1 + 1]     # h(ix-1) - h(ix+1)
nz = p[1:N1 + 1, 0:N1] - p[1:N1 + 1, 2:N1 + 2]     # h(iz-1) - h(iz+1)
nrm = np.stack([nx, np.full_like(nx, 2 * cell), nz], -1)
nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
nrm_b = np.stack([nrm[..., 0], -nrm[..., 2], nrm[..., 1]], -1).reshape(-1, 3)
me.normals_split_custom_set_from_vertices(nrm_b.astype(np.float32))
me.materials.append(terrain_material())
terrain = link(bpy.data.objects.new('Terrain', me), COL['Terrain'])
terrain['map'] = W['map']['name']
terrain['note'] = 'Regenerated from the game. Edits here do NOT flow back to the game (see art/blender/README.md).'
# surface material as a face attribute too, for selecting / inspecting in the viewport
fm = me.attributes.new('surface', 'INT', 'FACE')
fm.data.foreach_set('value', MAT.ravel()[TRI[:, 0]].astype(np.int32))
terrain['surface_names'] = ', '.join(f'{m["id"]} {m["name"]}' for m in W['materials'])

# ======================================================================================
# Paths
log('paths')
for pth in W['paths']:
    cu = bpy.data.curves.new(pth['name'], 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    pts = pth['pts']
    sp.points.add(len(pts) - 1)
    sp.points.foreach_set('co', np.array([(x, -z, y + 0.25, 1) for x, y, z in pts], np.float32).ravel())
    sp.use_cyclic_u = pth['closed']
    cu.bevel_depth = 0.12
    ob = link(bpy.data.objects.new(f'{pth["kind"].title()} {pth["name"]}', cu), COL['Paths'])
    colr = pth['diffColor'] or ('#f4ead2' if pth['kind'] == 'road' else '#d9c7a6')
    m, nt, g = new_mat(f'Path {pth["diffLabel"] or pth["kind"]}')
    g.inputs['Albedo'].default_value = lhex(colr if colr not in ('#000000', '#1a1a1a') else '#2b2b2b')
    cu.materials.append(m)
    ob.hide_render = True
    for k in ('kind', 'diff', 'diffLabel', 'width', 'length', 'shoulder'):
        if pth[k] is not None:
            ob[k] = pth[k]
    ob.color = (*lin(srgb(colr)), 1)

# ======================================================================================
# Rocks
log(f'rocks ({len(W["rocks"])})')
rmat = rock_material()
for i, r in enumerate(W['rocks']):
    v = verts3(r['v'])
    me = mesh_from(('Ledge' if r['ledge'] else 'Rock') + f' {i:03d}', v, np.asarray(r['i']).reshape(-1, 3))
    ca = me.color_attributes.new('tone', 'FLOAT_COLOR', 'POINT')
    t = np.asarray(r['tone'], np.float32)
    ca.data.foreach_set('color', np.stack([t, t, t * 0.98, np.ones_like(t)], 1).ravel())
    me.shade_smooth()
    me.materials.append(rmat)
    ob = link(bpy.data.objects.new(me.name, me), COL['Rocks'])
    ob.location = P(r['x'], r['y'], r['z'])
    ob.rotation_euler = (0, 0, r['rotY'])
    add_outline(ob, 0.04)

# ======================================================================================
# Prop library: one collection per glTF model, instanced everywhere
log('prop library')
lib_layer = None
PROPLIB = {}


def import_glb(path, target):
    lc = find_layer(bpy.context.view_layer.layer_collection, target)
    bpy.context.view_layer.active_layer_collection = lc
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


prop_keys = sorted({k for k in W['dressing']['assets']} | {f[:-4] for f in W['modelFiles'] if not f.startswith('vehicles/')})
for key in prop_keys:
    c = coll(f'PROP {key}', LIB)
    objs = import_glb(os.path.join(MODELS, key + '.glb'), c)
    for o in objs:
        if o.type == 'MESH':
            o['source'] = f'public/models/{key}.glb'
    PROPLIB[key] = (c, objs)
# the glTF importer makes a fresh copy of the shared prop material / atlas per file: merge them
for coll_ in (bpy.data.materials, bpy.data.images):
    for d in list(coll_):
        base = d.name.rsplit('.', 1)[0] if d.name[-4:-3] == '.' and d.name[-3:].isdigit() else None
        if base and base in coll_ and coll_[base] != d:
            d.user_remap(coll_[base])
            coll_.remove(d)
for key, (c, objs) in PROPLIB.items():
    for o in objs:
        if o.type != 'MESH':
            continue
        for m in o.data.materials:
            toonify(m)
        if not key.startswith('grass_tuft'):   # the game skips outlines on tufts
            add_outline(o, 0.025)

# ======================================================================================
# Dressing: trees + props (dressing.js placements)
log('dressing')
DRESS = {
    'trees_round': ('Trees', 'Round trees'), 'trees_pine': ('Trees', 'Pine trees'), 'bushes': ('Props', 'Bushes'),
    'tufts': ('Props', 'Grass tufts'), 'flowers': ('Props', 'Flowering tufts'), 'stones': ('Props', 'Stones'),
    'logs': ('Props', 'Logs & stumps'), 'stumps': ('Props', 'Logs & stumps'), 'fences': ('Props', 'Fences'),
    'misc': ('Markers', 'Signs & gates'),
}
NICE = {'signpost': 'Trailhead fingerpost'}
for key, rec in W['dressing']['assets'].items():
    top, name = DRESS.get(rec['category'], ('Props', rec['category']))
    target = sub(top, name)
    mats = [M(it['m']) for it in rec['items']]
    if key.startswith('grass_tuft'):
        src = next(o for o in PROPLIB[key][1] if o.type == 'MESH')
        scatter(f'Grass tufts {key[-1].upper()}', src, mats, None, target)
        continue
    lc = PROPLIB[key][0]
    for n, mw in enumerate(mats):
        e = bpy.data.objects.new(f'{NICE.get(key, key)} {n + 1:03d}', None)
        e.instance_type = 'COLLECTION'
        e.instance_collection = lc
        e.empty_display_size = 0.5
        e.matrix_world = mw
        link(e, target)
lib_proc = coll('PROC procedural parts', LIB)


def place_meshes(recs, top_default, name_map):
    """Procedural parts from the game's view code: single parts as objects (grouped under their
    sign / gate / stand), repeated parts as geometry-node instances of one source mesh."""
    groups = {}
    for r in recs:
        top, subname = name_map(r)
        target = sub(top, subname)
        mats_ = [W['mats'][k] for k in r['mats']]
        many = len(r['items']) >= 8
        cols = [it.get('c') for it in r['items']] if any('c' in it for it in r['items']) else None
        me = geom_mesh(r['geom'], r['name'], len(r['mats']))
        if not me.materials:
            for mm in mats_:
                me.materials.append(flat_mat(mm, inst_color=bool(cols) and many, obj_color=bool(cols) and not many))
        if many:
            src = link(bpy.data.objects.new(r['name'] + ' (source)', me), lib_proc)
            if r['category'] not in ('tufts', 'flowers'):
                add_outline(src, 0.02)
            scatter(r['name'], src, [M(it['m']) for it in r['items']], cols, target)
            continue
        parent = None
        if r.get('groupM'):
            gk = r['category']
            if gk not in groups:
                ge = link(bpy.data.objects.new(gk, None), target)
                ge.empty_display_size = 1.0
                ge.matrix_world = M(r['groupM'])
                groups[gk] = ge
            parent = groups[gk]
        for n, it in enumerate(r['items']):
            ob = link(bpy.data.objects.new(r['name'] + (f' {n + 1:03d}' if len(r['items']) > 1 else ''), me), target)
            ob.matrix_world = M(it['m'])
            if parent:
                mw = ob.matrix_world.copy()
                ob.parent = parent
                ob.matrix_world = mw
            if it.get('c'):
                ob.color = lhex(it['c'])
            if not any(mm.get('transparent') for mm in mats_) and W['geoms'][r['geom']]['type'] != 'PlaneGeometry':
                add_outline(ob, 0.02)
            add_texts(ob, r)


def add_texts(ob, r):
    """Sign boards and banners: the game draws their text on a canvas; here it is a text object on
    the part's +Z face (three.js), sized to the face."""
    for k in r['mats']:
        mr = W['mats'][k]
        if not mr.get('texts'):
            continue
        bb = W['geoms'][r['geom']]['bbox']
        w, hgt, zmax = bb[3] - bb[0], bb[4] - bb[1], bb[5]
        lines = [t['text'] for t in mr['texts']]
        cu = bpy.data.curves.new(ob.name + ' text', 'FONT')
        cu.body = '\n'.join(lines)
        cu.align_x, cu.align_y = 'CENTER', 'CENTER'
        longest = max(len(s) for s in lines)
        cu.size = min(hgt * 0.75 / max(1, len(lines)), w * 0.9 / max(1, longest * 0.55))
        cu.space_line = 1.1
        tm, nt, g = new_mat('Sign text ' + mr['texts'][0]['color'])
        g.inputs['Albedo'].default_value = lhex(mr['texts'][0]['color'])
        cu.materials.append(tm)
        t = link(bpy.data.objects.new(ob.name + ' text', cu), ob.users_collection[0])
        t.parent = ob
        t.location = (0, -(zmax + 0.012), 0)   # three.js +z face of the part, in Blender local space
        t.rotation_euler = (math.pi / 2, 0, 0)
        if mr.get('doubleSided'):   # race arches show their banner from behind too (readable here)
            t2 = link(bpy.data.objects.new(ob.name + ' text (back)', cu), ob.users_collection[0])
            t2.parent = ob
            t2.location = (0, -(bb[2] - 0.012), 0)
            t2.rotation_euler = (math.pi / 2, 0, math.pi)
        break


place_meshes(W['dressing']['meshes'], 'Props', lambda r: DRESS.get(r['category'], ('Props', r['category'])))

# ======================================================================================
# Markers / race venue
log('markers')
if W['map']['kind'] == 'race':
    MARK = ('Arch', 'Start-finish', 'Marker post', 'Apex cone', 'Start line', 'Grid line', 'Start light')

    def race_map(r):
        n, c = r['name'], r['category']
        if c.startswith('Arch') or c.startswith('Start-finish') or any(n.startswith(k) for k in MARK):
            return ('Markers', 'Checkpoints, posts & start' if not c.startswith('Arch') else 'Checkpoint arches')
        if c.startswith('Grandstand') or n.startswith('Spectator') or n in ('Catch fence', 'Pole', 'Spectator tape'):
            return ('Props', 'Race venue: stands & crowd')
        if n in ('Concrete barrier', 'Barrier stripe', 'Tyre wall', 'White tyre / paint'):
            return ('Props', 'Race venue: barriers & tyre walls')
        return ('Props', 'Race venue: paddock, flags & signs')
    place_meshes(W['markers']['meshes'], 'Props', race_map)
else:
    def park_map(r):
        c = r['category']
        if c.startswith('Sign') or c.startswith('Gate'):
            return ('Markers', 'Signs & gates')
        return ('Markers', 'Road & trail posts')
    place_meshes(W['markers']['meshes'], 'Markers', park_map)

mk = sub('Markers', 'Gameplay points')


def point(name, x, z, kind='PLAIN_AXES', size=1.0, yaw=None, y=None, **props):
    e = link(bpy.data.objects.new(name, None), mk)
    e.empty_display_type = kind
    e.empty_display_size = size
    e.location = P(x, height(x, z) if y is None else y, z)
    if yaw is not None:
        e.rotation_euler = (0, 0, yaw)
    for k, v in props.items():
        e[k] = v
    return e


sp = W['spawn']
point('Spawn', sp['x'], sp['z'], 'SINGLE_ARROW', 3, yaw=sp['yaw'] + math.pi)  # arrow (+Z) tipped to point forward below
mk.objects['Spawn'].rotation_euler = (-math.pi / 2, 0, sp['yaw'])
if W['trailhead']:
    th = W['trailhead']
    e = point('Trailhead lot', th['x'], th['z'], 'CIRCLE', th['r'])
    e.rotation_euler = (0, 0, 0)
for te in W['trailEnds']:
    for end in ('start', 'end'):
        q = te[end]
        point(f'{te["name"]} {end} point', q['x'], q['z'], 'CONE', 1.5, y=q['y'] + 4, diff=te['diff'])
for cp in W['checkpoints']:
    e = point(f'Checkpoint {cp["i"]} point' + (' (start-finish)' if cp['i'] == 0 else ''), cp['x'], cp['z'], 'ARROWS', 2, yaw=math.atan2(cp['tx'], cp['tz']), s=cp['s'])

# ======================================================================================
# Vehicles, parked at the spawn (wheels placed at Marker_Wheel*, left side mirrored like the game)
log('vehicles')
VEH = [f[:-4] for f in W['modelFiles'] if f.startswith('vehicles/')]
yaw = sp['yaw']
fwd = (-math.sin(yaw), -math.cos(yaw))            # three.js x, z
right = (math.cos(yaw), -math.sin(yaw))
for n, key in enumerate(VEH):
    vid = key.split('/')[1]
    c = sub('Vehicles', f'Vehicle {vid}')
    objs = import_glb(os.path.join(MODELS, key + '.glb'), c)
    by = {o.name.split('.')[0]: o for o in objs}
    wheel = by.get('Wheel')
    root = link(bpy.data.objects.new(f'{vid} (parked)', None), c)
    root.empty_display_type = 'CUBE'; root.empty_display_size = 0.3
    if wheel:
        wheel.name = f'{vid} Wheel FR'
        for tag in ('FL', 'RL', 'RR'):
            mkr = by.get(f'Marker_Wheel{tag}')
            if not mkr:
                continue
            w = link(bpy.data.objects.new(f'{vid} Wheel {tag}', wheel.data), c)
            w.location = mkr.location
            w.scale = (-1 if tag.endswith('L') else 1, 1, 1)
            objs.append(w)
    for o in objs:
        if o.type == 'MESH':
            for m in o.data.materials:
                toonify(m)
            add_outline(o, 0.02)
        if o.parent is None:
            o.parent = root
        if o.type == 'EMPTY' and o.name.startswith('Marker'):
            o.empty_display_size = 0.15
    lat = (n - (len(VEH) - 1) / 2) * 3.6
    x, z = sp['x'] + right[0] * lat, sp['z'] + right[1] * lat
    root.location = P(x, height(x, z), z)
    root.rotation_euler = (0, 0, yaw)
    root['source'] = f'public/models/{key}.glb'

# ======================================================================================
# Sun, world, cameras
log('lights & cameras')
lc = COL['Lights & Cameras']
sd = bpy.data.lights.new('Sun', 'SUN')
sd.energy = SUN_ENERGY
sd.color = lin(srgb('#fff0d4'))
sd.angle = math.radians(0.5)
sun = link(bpy.data.objects.new('Sun', sd), lc)
sdir = P(-0.45, 0.8, 0.35).normalized()            # main.js SUN_DIR (towards the sun)
sun.location = sdir * 150
sun.rotation_euler = (-sdir).to_track_quat('-Z', 'Y').to_euler()

world = bpy.data.worlds.new('Golden haze')
SC.world = world
wn = world.node_tree
wn.nodes.clear()
wo = wn.nodes.new('ShaderNodeOutputWorld')
bg = wn.nodes.new('ShaderNodeBackground'); bg.inputs['Color'].default_value = lhex(SKY)
lp = wn.nodes.new('ShaderNodeLightPath')
blk = wn.nodes.new('ShaderNodeBackground'); blk.inputs['Strength'].default_value = 0.0
mx = wn.nodes.new('ShaderNodeMixShader')
wn.links.new(lp.outputs['Is Camera Ray'], mx.inputs['Fac'])
wn.links.new(blk.outputs[0], mx.inputs[1]); wn.links.new(bg.outputs[0], mx.inputs[2])
wn.links.new(mx.outputs[0], wo.inputs['Surface'])
# distant ground beyond the map edge (main.js `outer` ring)
RS, R0, R1 = 48, SIZE * 0.68, 900.0     # THREE.RingGeometry(SIZE * 0.68, 900, 32)
rv = [(r * math.cos(2 * math.pi * k / RS), r * math.sin(2 * math.pi * k / RS), 0) for r in (R0, R1) for k in range(RS)]
rf = [(RS + k, RS + (k + 1) % RS, (k + 1) % RS, k) for k in range(RS)]   # facing up
ring = link(bpy.data.objects.new('Outer ground (beyond the map)', mesh_from('Outer ground', rv, rf)), COL['Terrain'])
ring.location = (0, 0, 18)
rm, rnt, rg = new_mat('Outer ground')
rg.inputs['Albedo'].default_value = lhex('#c89a48')
rm.use_backface_culling = True   # front side only, like the game (it sits above the camera at the edges)
ring.data.materials.append(rm)

CAMS = []


def camera(name, eye, target, lens_fov=62.0, ortho=None):
    cd = bpy.data.cameras.new(name)
    cd.sensor_fit = 'VERTICAL'
    if ortho:
        cd.type = 'ORTHO'; cd.ortho_scale = ortho
    else:
        cd.angle_y = math.radians(lens_fov)
    cd.clip_start, cd.clip_end = 0.1, 2000
    ob = link(bpy.data.objects.new(name, cd), lc)
    ob.location = eye
    ob.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()
    CAMS.append(ob)
    return ob


def chase(name, x, z, fx, fz, back=11.0, up=5.0, ahead=8.0):
    gy = height(x, z)
    eye = P(x - fx * back, max(gy, height(x - fx * back, z - fz * back)) + up, z - fz * back)
    tgt = P(x + fx * ahead, height(x + fx * ahead, z + fz * ahead) + 1.0, z + fz * ahead)
    return camera(name, eye, tgt)


if W['map']['kind'] == 'race':
    chase('Race grid', sp['x'], sp['z'], fwd[0], fwd[1], back=16, up=6, ahead=18)
    cp0 = W['checkpoints'][0]
    camera('Start-finish view', P(cp0['x'] - cp0['tz'] * 22 + cp0['tx'] * 18, cp0['y'] + 9, cp0['z'] + cp0['tx'] * 22 + cp0['tz'] * 18), P(cp0['x'], cp0['y'] + 3, cp0['z']))
    for cp in W['checkpoints'][1:]:
        chase(f'Checkpoint {cp["i"]}', cp['x'], cp['z'], cp['tx'], cp['tz'], back=20, up=7, ahead=4)
else:
    chase('Trailhead', sp['x'], sp['z'], fwd[0], fwd[1], back=13, up=6, ahead=12)
    for te in W['trailEnds']:
        q = te['start']
        chase(f'Trail start {te["name"]}', q['x'], q['z'], q['tx'], q['tz'], back=12, up=6, ahead=14)
camera('Overview', Vector((0, -300, 230)), Vector((0, 10, 0)), 50)
camera('Top (ortho)', Vector((0, 0, 400)), Vector((0, 0.001, 0)), ortho=420)
SC.camera = CAMS[0]

# ======================================================================================
# Render / viewport look
eng = 'BLENDER_EEVEE'
try:
    SC.render.engine = eng
except TypeError as e:
    log('engine:', e)
SC.render.resolution_x, SC.render.resolution_y, SC.render.resolution_percentage = 480, 270, 100
SC.render.filter_size = 0.0
SC.render.preview_pixel_size = '4'      # chunky pixels in the rendered viewport
try:
    SC.eevee.taa_render_samples = 1
    SC.eevee.taa_samples = 1
except Exception:
    pass
try:
    SC.view_settings.view_transform = 'Standard'
except TypeError as e:
    log('view transform:', e)
SC.view_settings.look = 'None'
# 1-pixel dark warm outlines at the low render resolution, like the game's outline pass. Set up but
# OFF by default: Freestyle over the full map (400k-tri terrain + ~10k instances) ran out of memory
# (15 GB+). Tick Render > Freestyle for close-up shots, or pass --freestyle.
SC.render.use_freestyle = '--freestyle' in ARGS
SC.render.line_thickness_mode = 'ABSOLUTE'
SC.render.line_thickness = 1.0
vl = bpy.context.view_layer
vl.use_freestyle = True
fs = vl.freestyle_settings
fs.crease_angle = math.radians(120)
ls = fs.linesets[0] if fs.linesets else fs.linesets.new('Outline')
ls.select_by_visibility = True
ls.select_by_edge_types = True
ls.select_by_collection = True
ls.collection = coll('Outlined (Freestyle)', None)
for k in ('Terrain', 'Rocks', 'Trees', 'Props', 'Markers', 'Vehicles'):
    ls.collection.children.link(COL[k])
SC.collection.children.unlink(ls.collection)
ls.select_silhouette = True
ls.select_border = True
ls.select_crease = False
ls.select_material_boundary = True
ls.select_external_contour = True
if ls.linestyle is None:
    ls.linestyle = bpy.data.linestyles.new('Outline')
ls.linestyle.color = lin(srgb('#2a1a14'))
ls.linestyle.thickness = 1.0
ls.linestyle.chaining = 'PLAIN'
# exclude the library sources from the view layer (they render through their instances)
find_layer(vl.layer_collection, LIB).exclude = True
# viewport: rendered shading with the scene world, looking through the first camera
for scr in bpy.data.screens:
    for area in scr.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.shading.type = 'MATERIAL'
            area.spaces.active.clip_end = 3000
SC['how_to'] = 'Regenerate: node tools/export/export_world.mjs <map>; blender --background --python tools/blender/world/build_world.py -- <map>'

# ======================================================================================
# Save (textures packed), then preview stills
os.makedirs(os.path.dirname(OUT), exist_ok=True)
log('packing + saving')
try:
    bpy.ops.file.pack_all()
except Exception as e:
    log('pack_all:', e)
bpy.context.preferences.filepaths.save_version = 0   # no .blend1 backups next to the output
bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True)
log(f'saved {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)')


def upscale(src, dst, k=4):
    im = bpy.data.images.load(src)
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    b = a.repeat(k, 0).repeat(k, 1)
    o = bpy.data.images.new('up', w * k, h * k, alpha=False)
    o.pixels.foreach_set(b.ravel())
    o.filepath_raw = dst
    o.file_format = 'PNG'
    o.save()
    bpy.data.images.remove(im)
    bpy.data.images.remove(o)


if RENDER:
    os.makedirs(PREV, exist_ok=True)
    want = os.environ.get('LR_CAMS')
    for cam in CAMS:
        if want and cam.name not in want.split(','):
            continue
        SC.camera = cam
        # far views would be all haze: the game never sees the map from 300 m away
        toon_group().nodes['Fog amount (scene)'].outputs[0].default_value = 0.0 if cam.name in ('Overview', 'Top (ortho)') else 1.0
        slug = cam.name.lower().replace(' (ortho)', '').replace('-', ' ').replace(' ', '_')
        small = os.path.join(bpy.app.tempdir, f'world_{MAP}_{slug}_small.png')
        SC.render.filepath = small
        t = time.time()
        bpy.ops.render.render(write_still=True)
        dst = os.path.join(PREV, f'world_{MAP}_{slug}.png')
        upscale(small, dst)
        log(f'render {cam.name} -> {os.path.relpath(dst, ROOT)} ({time.time() - t:.1f}s)')
log('done')
