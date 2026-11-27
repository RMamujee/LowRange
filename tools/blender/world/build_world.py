# Build art/blender/world_<map>.blend from a world export (tools/export/export_world.mjs).
#
#   node tools/export/export_world.mjs <map>
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup --python tools/blender/world/build_world.py -- <map>
#
# map = park | race | crawl | jungle | desert. Options after the map id: `--no-render` (skip the preview
# stills, docs/previews/world_<map>_*.png), `--freestyle` (turn the 1-pixel Freestyle outline on).
# LR_CAMS=Overview,Trailhead renders only those cameras; LR_ALL_CAMS=1 renders every camera.
#
# What gets built (collections), the same for every map:
#   Terrain            the heightfield (the game's visual heights and shading normals; Coralume Island's
#                      1 m grid is decimated where the ground is plain) with a material that rebuilds the
#                      game's ground: per-surface pixel tiles at 32 px/m picked by the game's own ground
#                      lookup grid, pixel-stepped ragged borders, darker trail tread, ruts and churned mud,
#                      side projection on steep faces. The distant ranges round the map edge.
#   Water              the sea, creek, plunge pool and falls (Coralume Island), fords and splashes
#   Paths              roads / tracks / trails / courses / the race track / the creek as named curves
#   Rocks              every gameplay rock: the game's exact convex hull and lit-top tone, boulder tile
#   Trees, Props       glTF props from public/models as collection instances; the procedural plants and
#                      scatter (jungle trees, ferns, cacti, shrubs, tufts, stones) as geometry-node
#                      instances of one source each; the race venue's procedural dressing
#   Structures         bridges, the dock, guard rails, huts, the lookout, the lighthouse, road paint,
#                      the desert camp (Coralume Island, Sunfall Basin)
#   Markers            signposts, gates (their real pixel-font faces), posts, checkpoints, start line,
#                      and named empties: spawn, trailhead, trail ends, stage / course gates, places,
#                      landmarks, every spawn point of the game's spawn list
#   Vehicles           the three vehicle glTFs, wheels placed at their markers, parked at the spawn
#   Lights & Cameras   sun + named cameras
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
BLOB = open(os.path.join(EXP, 'blob.bin'), 'rb').read()
SIZE, RES = W['map']['size'], W['map']['res']
N1 = RES + 1
CELL = SIZE / RES
LOOK = W['look']
TERRAIN_MAX_VERTS = int(os.environ.get('LR_TERRAIN_MAX_VERTS', 300000))


def log(*a):
    print(f'[world {MAP} {time.time() - T0:6.1f}s]', *a, flush=True)


def arr(ref):
    off, n, dt = ref
    return np.frombuffer(BLOB, dtype=np.dtype(dt), count=n, offset=off)


# ---------- coordinates: three.js (y up, -z forward) -> Blender (z up) ----------
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
CI = C.inverted()


def P(x, y, z):
    return Vector((x, -z, y))


def M(e):  # three.js Matrix4.elements (column-major) -> Blender world matrix
    return C @ Matrix((e[0:4], e[4:8], e[8:12], e[12:16])).transposed() @ CI


def mats_of(items):
    a = arr(items['m']).reshape(-1, 16)
    return [M(list(map(float, e))) for e in a]


def colors_of(items):
    if 'c' not in items:
        return None
    return arr(items['c']).reshape(-1, 3)


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
VIS = np.fromfile(os.path.join(EXP, 'grid_vis.f32'), dtype=np.float32).reshape(N1, N1)        # [ix, iz]
LOOKG = np.fromfile(os.path.join(EXP, 'grid_look.u8'), dtype=np.uint8).reshape(N1, N1, 4)
NRM = np.fromfile(os.path.join(EXP, 'grid_nrm.i8'), dtype=np.int8).reshape(N1, N1, 3).astype(np.float32) / 127.0
TINT = np.fromfile(os.path.join(EXP, 'grid_tint.u8'), dtype=np.uint8).reshape(N1, N1, 3).astype(np.float32) / 128.0
HAS_TINT = bool(np.any(np.abs(TINT - 1.0) > 0.01))


def bilinear(grid, x, z):
    """grid[ix, iz, ...] sampled at three.js x, z (arrays)."""
    fx = np.clip((np.asarray(x, np.float64) + SIZE / 2) / CELL, 0, RES - 1e-6)
    fz = np.clip((np.asarray(z, np.float64) + SIZE / 2) / CELL, 0, RES - 1e-6)
    ix, iz = fx.astype(np.int64), fz.astype(np.int64)
    tx, tz = fx - ix, fz - iz
    if grid.ndim == 3:
        tx, tz = tx[..., None], tz[..., None]
    return (grid[ix, iz] * (1 - tx) * (1 - tz) + grid[ix + 1, iz] * tx * (1 - tz)
            + grid[ix, iz + 1] * (1 - tx) * tz + grid[ix + 1, iz + 1] * tx * tz)


def height(x, z):  # visualHeightAt, bilinear like the game
    return float(bilinear(VIS, x, z))


# ---------- scene + collections ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
SC = bpy.context.scene
SC.name = f'LowRange {W["map"]["name"]}'
SC.unit_settings.system = 'METRIC'


def coll(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or SC.collection).children.link(c)
    return c


TOP = ('Terrain', 'Water', 'Paths', 'Rocks', 'Trees', 'Props', 'Structures', 'Markers', 'Vehicles', 'Lights & Cameras')
COL = {n: coll(n) for n in TOP}
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
# One shared node group: stepped light from the sun (toon.js: warm mauve shade, lit, highlight; the
# ground's softer 3-step ramp when Soft = 1; deeper shade on undersides), flat emission so nothing else
# lights it, and the game's capped aerial perspective (smoothstep fog near..far, desaturate, lean
# towards the haze by at most FOG_MAX). Edit it once, every material follows.
SUN_ENERGY = 1.0
LIT_NORM = 0.2546 * SUN_ENERGY   # Shader-to-RGB of a white diffuse facing a sun of this energy (Eevee)


def toon_group():
    ng = bpy.data.node_groups.get('LowRange Toon')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('LowRange Toon', 'ShaderNodeTree')
    it = ng.interface
    it.new_socket('Albedo', in_out='INPUT', socket_type='NodeSocketColor').default_value = (0.8, 0.8, 0.8, 1)
    it.new_socket('Emission', in_out='INPUT', socket_type='NodeSocketColor').default_value = (0, 0, 0, 1)
    for nm, dv in (('Alpha', 1.0), ('Fog', 1.0), ('Soft', 0.0)):
        s = it.new_socket(nm, in_out='INPUT', socket_type='NodeSocketFloat')
        s.default_value, s.min_value, s.max_value = dv, 0.0, 1.0
    s = it.new_socket('Normal', in_out='INPUT', socket_type='NodeSocketVector')   # (0, 0, 0) = the surface's own
    s.default_value = (0, 0, 0)
    it.new_socket('Shader', in_out='OUTPUT', socket_type='NodeSocketShader')
    N, L = ng.nodes, ng.links
    gi, go = N.new('NodeGroupInput'), N.new('NodeGroupOutput')
    gi.location, go.location = (-1100, 0), (1100, 0)
    # shading normal: the Normal input when given (the terrain's game normals), else the geometry's
    gnorm = N.new('ShaderNodeNewGeometry'); gnorm.location = (-1500, -500)
    nlen = N.new('ShaderNodeVectorMath'); nlen.operation = 'LENGTH'; nlen.location = (-1500, -300)
    L.new(gi.outputs['Normal'], nlen.inputs[0])
    has_n = N.new('ShaderNodeMath'); has_n.operation = 'GREATER_THAN'; has_n.location = (-1350, -300)
    L.new(nlen.outputs['Value'], has_n.inputs[0]); has_n.inputs[1].default_value = 0.5
    nsel = N.new('ShaderNodeMix'); nsel.data_type = 'VECTOR'; nsel.location = (-1250, -450)
    L.new(has_n.outputs[0], nsel.inputs['Factor']); L.new(gnorm.outputs['Normal'], nsel.inputs[4]); L.new(gi.outputs['Normal'], nsel.inputs[5])
    shading_n = nsel.outputs[1]
    diff = N.new('ShaderNodeBsdfDiffuse'); diff.location = (-1100, -300)
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    L.new(shading_n, diff.inputs['Normal'])
    s2r = N.new('ShaderNodeShaderToRGB'); s2r.location = (-900, -300)
    L.new(diff.outputs[0], s2r.inputs[0])
    bw = N.new('ShaderNodeRGBToBW'); bw.location = (-720, -300)
    L.new(s2r.outputs['Color'], bw.inputs[0])
    norm = N.new('ShaderNodeMath'); norm.operation = 'DIVIDE'; norm.location = (-560, -300)
    norm.label = 'lit (0 = shadow, 1 = facing the sun)'
    L.new(bw.outputs[0], norm.inputs[0]); norm.inputs[1].default_value = LIT_NORM
    b0, b1 = LOOK['toonBands']
    ramp = N.new('ShaderNodeValToRGB'); ramp.location = (-380, -200); ramp.label = 'toon bands (toon.js)'
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position, cr.elements[0].color = 0.0, lhex(LOOK['toonShade'])
    cr.elements[1].position, cr.elements[1].color = b1, lhex(LOOK['toonHi'])
    e = cr.elements.new(b0); e.color = lhex(LOOK['toonLit'])
    L.new(norm.outputs[0], ramp.inputs['Fac'])
    # the ground's soft ramp (toon.js TOON_SOFT): shade, a half-step, lit
    ramp2 = N.new('ShaderNodeValToRGB'); ramp2.location = (-380, -420); ramp2.label = 'soft bands (terrain)'
    cr2 = ramp2.color_ramp
    cr2.interpolation = 'CONSTANT'
    sh, lt = lin(srgb(LOOK['toonShade'])), lin(srgb(LOOK['toonLit']))
    cr2.elements[0].position, cr2.elements[0].color = 0.0, (*sh, 1)
    cr2.elements[1].position, cr2.elements[1].color = 0.42, (*lt, 1)
    e = cr2.elements.new(0.16); e.color = (*[a + (b - a) * 0.55 for a, b in zip(sh, lt)], 1)
    L.new(norm.outputs[0], ramp2.inputs['Fac'])
    rsel = N.new('ShaderNodeMix'); rsel.data_type = 'RGBA'; rsel.location = (-180, -300)
    L.new(gi.outputs['Soft'], rsel.inputs['Factor']); L.new(ramp.outputs['Color'], rsel.inputs['A']); L.new(ramp2.outputs['Color'], rsel.inputs['B'])
    # undersides one notch deeper in the shade band
    sep = N.new('ShaderNodeSeparateXYZ'); sep.location = (-720, -700)
    L.new(shading_n, sep.inputs[0])
    under = N.new('ShaderNodeMapRange'); under.interpolation_type = 'SMOOTHSTEP'; under.location = (-560, -700)
    L.new(sep.outputs['Z'], under.inputs['Value'])
    under.inputs['From Min'].default_value, under.inputs['From Max'].default_value = -0.6, 0.2
    under.inputs['To Min'].default_value, under.inputs['To Max'].default_value = LOOK['toonUnder'], 1.0
    inshade = N.new('ShaderNodeMath'); inshade.operation = 'LESS_THAN'; inshade.location = (-380, -620)
    L.new(norm.outputs[0], inshade.inputs[0]); inshade.inputs[1].default_value = b0
    uf = N.new('ShaderNodeMix'); uf.data_type = 'FLOAT'; uf.location = (-200, -660)
    L.new(inshade.outputs[0], uf.inputs['Factor']); uf.inputs['A'].default_value = 1.0
    L.new(under.outputs['Result'], uf.inputs['B'])
    k = N.new('ShaderNodeVectorMath'); k.operation = 'SCALE'; k.location = (-20, -360)
    L.new(rsel.outputs['Result'], k.inputs[0]); L.new(uf.outputs['Result'], k.inputs['Scale'])
    lit = N.new('ShaderNodeMix'); lit.data_type = 'RGBA'; lit.blend_type = 'MULTIPLY'; lit.location = (150, -100)
    lit.inputs['Factor'].default_value = 1.0
    L.new(gi.outputs['Albedo'], lit.inputs['A']); L.new(k.outputs[0], lit.inputs['B'])
    add = N.new('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'; add.location = (320, -100)
    add.inputs['Factor'].default_value = 1.0
    L.new(lit.outputs['Result'], add.inputs['A']); L.new(gi.outputs['Emission'], add.inputs['B'])
    # aerial perspective: smoothstep(near, far) -> desaturate 35%, lean to the haze by at most FOG_MAX
    cam = N.new('ShaderNodeCameraData'); cam.location = (150, -420)
    fog = N.new('ShaderNodeMapRange'); fog.interpolation_type = 'SMOOTHSTEP'; fog.location = (320, -420)
    fog.label = f'fog {LOOK["fogNear"]:.0f}..{LOOK["fogFar"]:.0f} m'
    L.new(cam.outputs['View Distance'], fog.inputs['Value'])
    fog.inputs['From Min'].default_value, fog.inputs['From Max'].default_value = float(LOOK['fogNear']), float(LOOK['fogFar'])
    fogk = N.new('ShaderNodeMath'); fogk.operation = 'MULTIPLY'; fogk.location = (480, -420)
    L.new(fog.outputs['Result'], fogk.inputs[0]); L.new(gi.outputs['Fog'], fogk.inputs[1])
    famt = N.new('ShaderNodeValue'); famt.name = famt.label = 'Fog amount (scene)'; famt.location = (320, -600)
    famt.outputs[0].default_value = 1.0
    fogk2 = N.new('ShaderNodeMath'); fogk2.operation = 'MULTIPLY'; fogk2.location = (480, -560)
    L.new(fogk.outputs[0], fogk2.inputs[0]); L.new(famt.outputs[0], fogk2.inputs[1])
    desat = N.new('ShaderNodeMath'); desat.operation = 'MULTIPLY'; desat.location = (640, -560)
    L.new(fogk2.outputs[0], desat.inputs[0]); desat.inputs[1].default_value = 0.35
    gray = N.new('ShaderNodeRGBToBW'); gray.location = (500, -220)
    L.new(add.outputs['Result'], gray.inputs[0])
    dmix = N.new('ShaderNodeMix'); dmix.data_type = 'RGBA'; dmix.location = (660, -100)
    L.new(desat.outputs[0], dmix.inputs['Factor']); L.new(add.outputs['Result'], dmix.inputs['A']); L.new(gray.outputs[0], dmix.inputs['B'])
    cap = N.new('ShaderNodeMath'); cap.operation = 'MULTIPLY'; cap.location = (640, -420); cap.label = 'FOG_MAX'
    L.new(fogk2.outputs[0], cap.inputs[0]); cap.inputs[1].default_value = float(LOOK['fogMax'])
    fmix = N.new('ShaderNodeMix'); fmix.data_type = 'RGBA'; fmix.location = (820, -100)
    L.new(cap.outputs[0], fmix.inputs['Factor']); L.new(dmix.outputs['Result'], fmix.inputs['A'])
    fmix.inputs['B'].default_value = lhex(LOOK['fog'])
    em = N.new('ShaderNodeEmission'); em.location = (960, -100)
    L.new(fmix.outputs['Result'], em.inputs['Color'])
    tr = N.new('ShaderNodeBsdfTransparent'); tr.location = (960, 60)
    ms = N.new('ShaderNodeMixShader'); ms.location = (1040, 0)
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


def set_transparent(m, blended=False):
    try:
        m.surface_render_method = 'BLENDED' if blended else 'DITHERED'
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
    m = bpy.data.materials.new(f'Outline ({LOOK["outline"]})')
    nt = m.node_tree
    nt.nodes.clear()
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = lhex(LOOK['outline'])
    nt.links.new(e.outputs[0], o.inputs['Surface'])
    m.use_backface_culling = True
    try:
        m.use_backface_culling_shadow = True
    except Exception:
        pass
    OUTLINE = m
    return m


def add_outline(obj, th=0.03):
    """Inverted-hull outline (viewport and renders), sized like the game's 2 to 3 cm line."""
    me = obj.data
    if outline_mat().name not in [m.name for m in me.materials if m]:
        me.materials.append(outline_mat())
    md = obj.modifiers.new('Outline', 'SOLIDIFY')
    md.thickness = th
    md.offset = 1.0
    md.use_flip_normals = True
    md.use_rim = False
    md.material_offset = len(me.materials) - 1


# ---------- images ----------
_imgs = {}


def load_png(rel, name):
    if rel in _imgs:
        return _imgs[rel]
    img = bpy.data.images.load(os.path.join(EXP, rel))
    img.name = name
    img.colorspace_settings.name = 'sRGB'
    img.pack()
    _imgs[rel] = img
    return img


TILES = [load_png(l['tile'], f'tile_{l["name"]}') for l in W['layers']]
LAYER_BOULDER = next(i for i, l in enumerate(W['layers']) if l['name'] == 'boulder')


def tex_node(nt, img, vec, loc, ext='REPEAT'):
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img; t.interpolation = 'Closest'; t.extension = ext; t.location = loc
    if vec is not None:
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


def tile_projection(nt, loc=(-1400, 0), top_thr=0.55, normal=None):
    """World-space tile coordinates like terrain_look.js: top-down (|n.up| > top_thr), else from the side
    on the dominant axis, no blend. 4 m per tile; v flipped so PNG rows match the game's texture rows."""
    x0, y0 = loc
    geo = nt.nodes.new('ShaderNodeNewGeometry'); geo.location = (x0, y0)
    pos = nt.nodes.new('ShaderNodeSeparateXYZ'); pos.location = (x0 + 180, y0)
    nt.links.new(geo.outputs['Position'], pos.inputs[0])
    nrm = nt.nodes.new('ShaderNodeSeparateXYZ'); nrm.location = (x0 + 180, y0 - 200)
    absn = vmath(nt, 'ABSOLUTE', normal if normal is not None else geo.outputs['Normal'], loc=(x0 + 60, y0 - 200))
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
    if top_thr is None:   # rocks: top when up is the largest component
        mxy = mathn(nt, 'MAXIMUM', nrm.outputs['X'], nrm.outputs['Y'], (x0 + 360, y0 - 220))
        is_top = mathn(nt, 'GREATER_THAN', nrm.outputs['Z'], mxy, (x0 + 720, y0 - 220))
    else:
        is_top = mathn(nt, 'GREATER_THAN', nrm.outputs['Z'], top_thr, (x0 + 720, y0 - 220))
    is_x = mathn(nt, 'GREATER_THAN', nrm.outputs['X'], nrm.outputs['Y'], (x0 + 720, y0 - 300))
    m1 = nt.nodes.new('ShaderNodeMix'); m1.data_type = 'VECTOR'; m1.location = (x0 + 720, y0 - 80)
    nt.links.new(is_x, m1.inputs['Factor']); nt.links.new(side_z, m1.inputs[4]); nt.links.new(side_x, m1.inputs[5])
    m2 = nt.nodes.new('ShaderNodeMix'); m2.data_type = 'VECTOR'; m2.location = (x0 + 900, y0)
    nt.links.new(is_top, m2.inputs['Factor']); nt.links.new(m1.outputs[1], m2.inputs[4]); nt.links.new(top, m2.inputs[5])
    out = vmath(nt, 'SCALE', m2.outputs[1], loc=(x0 + 1080, y0))
    out.node.inputs['Scale'].default_value = 0.25   # 4 m per tile
    return out, geo, pos


def terrain_material():
    # the game's ground lookup grid, one pixel per grid vertex: R = shown surface id, G = trail tread,
    # B = slow tone drift, A = 255 - rut / churned-mud tone (gfx/terrain_look.js terrainMaterial)
    img = bpy.data.images.new('terrain_grid (surface, tread, tone, ruts)', N1, N1, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.alpha_mode = 'CHANNEL_PACKED'
    px = LOOKG.transpose(1, 0, 2).astype(np.float32) / 255.0   # [row = iz, col = ix]
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()
    m, nt, g = new_mat('Terrain (pixel ground)')
    g.inputs['Soft'].default_value = 1.0
    # the game's terrain shading normals (softened heightfield, sharper on the dunes) and the desert's
    # painted dune light, one texel per grid vertex, read bilinearly like the game's vertex attributes
    def grid_image(name, rgb):
        im = bpy.data.images.new(name, N1, N1, alpha=False, float_buffer=False)
        im.colorspace_settings.name = 'Non-Color'
        p4 = np.concatenate([rgb, np.ones(rgb.shape[:2] + (1,), np.float32)], 2).transpose(1, 0, 2)
        im.pixels.foreach_set(np.clip(p4, 0, 1).astype(np.float32).ravel())
        im.update()
        im.pack()
        return im
    nb = np.stack([NRM[..., 0], -NRM[..., 2], NRM[..., 1]], -1)
    nimg = grid_image('terrain_normals (game shading normals)', nb * 0.5 + 0.5)
    geo0 = nt.nodes.new('ShaderNodeNewGeometry'); geo0.location = (-2000, -900)
    p0 = nt.nodes.new('ShaderNodeSeparateXYZ'); p0.location = (-1850, -900)
    nt.links.new(geo0.outputs['Position'], p0.inputs[0])
    guv = nt.nodes.new('ShaderNodeCombineXYZ'); guv.location = (-1500, -900)
    nt.links.new(mathn(nt, 'DIVIDE', mathn(nt, 'ADD', mathn(nt, 'DIVIDE', mathn(nt, 'ADD', p0.outputs['X'], SIZE / 2, (-1750, -880)), CELL, (-1650, -880)), 0.5, (-1600, -880)), N1, (-1550, -880)), guv.inputs[0])
    nt.links.new(mathn(nt, 'DIVIDE', mathn(nt, 'ADD', mathn(nt, 'DIVIDE', mathn(nt, 'SUBTRACT', SIZE / 2, p0.outputs['Y'], (-1750, -960)), CELL, (-1650, -960)), 0.5, (-1600, -960)), N1, (-1550, -960)), guv.inputs[1])
    ntex = nt.nodes.new('ShaderNodeTexImage'); ntex.image = nimg; ntex.interpolation = 'Linear'; ntex.extension = 'EXTEND'; ntex.location = (-1350, -900)
    nt.links.new(guv.outputs[0], ntex.inputs['Vector'])
    n2 = vmath(nt, 'SCALE', ntex.outputs['Color'], loc=(-1150, -900))
    n2.node.inputs['Scale'].default_value = 2.0
    ndec = vmath(nt, 'NORMALIZE', vmath(nt, 'SUBTRACT', n2, (1, 1, 1), (-1050, -900)), loc=(-950, -900))
    nt.links.new(ndec, g.inputs['Normal'])
    tint_out = None
    if HAS_TINT:
        timg = grid_image('terrain_tint (painted dune light, x2)', TINT * 0.5)
        ttex = nt.nodes.new('ShaderNodeTexImage'); ttex.image = timg; ttex.interpolation = 'Linear'; ttex.extension = 'EXTEND'; ttex.location = (-1350, -1200)
        nt.links.new(guv.outputs[0], ttex.inputs['Vector'])
        tint_out = vmath(nt, 'SCALE', ttex.outputs['Color'], loc=(-1150, -1200))
        tint_out.node.inputs['Scale'].default_value = 2.0
    tp, geo, pos = tile_projection(nt, normal=ndec)
    # pixel-stepped, ragged surface borders: snap to the game's 1/8 m world lattice, wobble by two
    # noise scales, then the nearest grid vertex
    xy = nt.nodes.new('ShaderNodeCombineXYZ'); xy.location = (-1200, 500)
    nt.links.new(pos.outputs['X'], xy.inputs[0]); nt.links.new(pos.outputs['Y'], xy.inputs[1])
    s8 = vmath(nt, 'SCALE', xy.outputs[0], loc=(-1050, 500))
    s8.node.inputs['Scale'].default_value = 8.0
    lat = vmath(nt, 'DIVIDE', vmath(nt, 'ADD', vmath(nt, 'FLOOR', s8, loc=(-900, 500)), (0.5, 0.5, 0), (-820, 500)), (8, 8, 8), (-750, 500))
    jit = None
    for sc_, amp, off, y in ((0.32, 1.2, 0.0, 650), (1.1, 0.45, 5.0, 420)):
        nz = nt.nodes.new('ShaderNodeTexNoise'); nz.location = (-600, y)
        nz.inputs['Scale'].default_value = sc_; nz.inputs['Detail'].default_value = 0.0
        nt.links.new(vmath(nt, 'ADD', lat, (off, off * 7, 0), (-700, y)), nz.inputs['Vector'])
        j = vmath(nt, 'SCALE', vmath(nt, 'SUBTRACT', nz.outputs['Color'], (0.5, 0.5, 0.5), (-420, y)), loc=(-260, y))
        j.node.inputs['Scale'].default_value = amp * 2.2 / CELL   # Blender noise has less contrast than pxNoise
        jit = j if jit is None else vmath(nt, 'ADD', jit, j, (-120, y))
    # grid coords: gx = (x + size/2) / cell, gz = (-y + size/2) / cell (three.js z = -Blender y)
    gxy = nt.nodes.new('ShaderNodeCombineXYZ'); gxy.location = (-420, 260)
    nt.links.new(mathn(nt, 'DIVIDE', mathn(nt, 'ADD', pos.outputs['X'], SIZE / 2, (-700, 280)), CELL, (-560, 280)), gxy.inputs[0])
    nt.links.new(mathn(nt, 'DIVIDE', mathn(nt, 'SUBTRACT', SIZE / 2, pos.outputs['Y'], (-700, 220)), CELL, (-560, 220)), gxy.inputs[1])
    g1 = vmath(nt, 'ADD', gxy.outputs[0], jit, (40, 500))
    gi = vmath(nt, 'FLOOR', vmath(nt, 'ADD', g1, (0.5, 0.5, 0), (180, 500)), loc=(320, 500))
    gi = vmath(nt, 'MINIMUM', vmath(nt, 'MAXIMUM', gi, (0, 0, 0), (460, 500)), (RES, RES, 0), (600, 500))
    uv = vmath(nt, 'DIVIDE', vmath(nt, 'ADD', gi, (0.5, 0.5, 0), (740, 500)), (N1, N1, 1), (880, 500))
    cell = tex_node(nt, img, uv, (1020, 500), 'EXTEND')
    cs = nt.nodes.new('ShaderNodeSeparateColor'); cs.location = (1200, 500)
    nt.links.new(cell.outputs['Color'], cs.inputs[0])
    mid = mathn(nt, 'ROUND', mathn(nt, 'MULTIPLY', cs.outputs[0], 255.0, (1350, 560)), None, (1500, 560))
    col = None
    used = sorted(set(np.unique(LOOKG[..., 0]).tolist()))
    for i in used:
        tn = tex_node(nt, TILES[i], tp, (1200, -200 - i * 260))
        if col is None:
            col = tn.outputs['Color']
            continue
        eq = mathn(nt, 'COMPARE', mid, float(i), (1500, -200 - i * 260))
        eq.node.inputs[2].default_value = 0.25
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.location = (1700, -200 - i * 260)
        nt.links.new(eq, mx.inputs['Factor']); nt.links.new(col, mx.inputs['A']); nt.links.new(tn.outputs['Color'], mx.inputs['B'])
        col = mx.outputs['Result']
    # worn trail tread one step darker (0.86); slow stepped tone drift (0.95 + 0.035 * floor(b * 3));
    # ruts and churned mud two calm steps (tone > 0.45: 0.88, > 0.2: 0.94)
    tread_k = mathn(nt, 'SUBTRACT', 1.0, mathn(nt, 'MULTIPLY', mathn(nt, 'GREATER_THAN', cs.outputs[1], 0.5, (1500, 380)), 0.14, (1650, 380)), (1800, 380))
    tone_k = mathn(nt, 'ADD', 0.95, mathn(nt, 'MULTIPLY', mathn(nt, 'FLOOR', mathn(nt, 'MULTIPLY', cs.outputs[2], 3.0, (1500, 300)), None, (1650, 300)), 0.035, (1800, 300)), (1950, 300))
    alpha = tex_node(nt, img, uv, (1020, 760), 'EXTEND')
    tn_ = mathn(nt, 'SUBTRACT', 1.0, alpha.outputs['Alpha'], (1200, 760))
    rut = mathn(nt, 'SUBTRACT', 1.0, mathn(nt, 'ADD', mathn(nt, 'MULTIPLY', mathn(nt, 'GREATER_THAN', tn_, 0.45, (1350, 800)), 0.06, (1500, 800)),
                                           mathn(nt, 'MULTIPLY', mathn(nt, 'GREATER_THAN', tn_, 0.2, (1350, 720)), 0.06, (1500, 720)), (1650, 760)), (1800, 760))
    k = mathn(nt, 'MULTIPLY', mathn(nt, 'MULTIPLY', tread_k, tone_k, (2100, 340)), rut, (2200, 400))
    sc = vmath(nt, 'SCALE', col, loc=(2250, 0))
    nt.links.new(k, sc.node.inputs['Scale'])
    res = sc
    if tint_out is not None:   # the desert's painted dune light
        res = vmath(nt, 'MULTIPLY', sc, tint_out, (2400, -100))
    nt.links.new(res, g.inputs['Albedo'])
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    g.location, out.location = (2600, 0), (2800, 0)
    return m


def rock_material():
    m, nt, g = new_mat('Gameplay rock (pixel boulder tile x tone)')
    tp, geo, pos = tile_projection(nt, top_thr=None)
    t = tex_node(nt, TILES[LAYER_BOULDER], tp, (-200, 0))
    ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'tone'; ca.location = (-200, -250)
    mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.location = (0, 0)
    mx.inputs['Factor'].default_value = 1.0
    nt.links.new(t.outputs['Color'], mx.inputs['A']); nt.links.new(ca.outputs['Color'], mx.inputs['B'])
    nt.links.new(mx.outputs['Result'], g.inputs['Albedo'])
    return m


_flat = {}
SIGN_GLOW = '#8c8c8c'   # src/art/signs.js: emissive = the face itself x this


def flat_mat(rec, inst_color=False, obj_color=False, water=False):
    """Material for the game's procedural parts (MeshStandardMaterial colour / emissive / opacity /
    vertex colours / canvas maps); per-instance colours via the instancer attribute or the object colour."""
    key = (json.dumps(rec, sort_keys=True), inst_color, obj_color, water)
    if key in _flat:
        return _flat[key]
    nm = rec.get('name') or ''
    label = nm if nm and not nm.startswith('dressing') and not nm.startswith('gate-') else f'Paint {rec["color"]}'
    if rec.get('sign'):
        label = 'Sign face ' + rec['sign']['title'] + (f' {rec["sign"]["sub"]}' if rec['sign'].get('sub') else '')
    elif rec.get('map'):
        label = 'Texture ' + os.path.basename(rec['map'])
    if water:
        label = 'Water ' + label
    m, nt, g = new_mat(label)
    base = lhex(rec['color'])
    col = None
    if rec.get('map'):
        tn = tex_node(nt, load_png(rec['map'], 'canvas_' + os.path.basename(rec['map'])), None, (-500, 0))
        uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.location = (-700, 0)
        nt.links.new(uvn.outputs[0], tn.inputs['Vector'])
        col = tn.outputs['Color']
        if rec.get('emissiveMap') and rec.get('emissive', '#000000') != '#000000':
            em = nt.nodes.new('ShaderNodeMix'); em.data_type = 'RGBA'; em.blend_type = 'MULTIPLY'; em.inputs['Factor'].default_value = 1; em.location = (-200, -250)
            nt.links.new(col, em.inputs['A']); em.inputs['B'].default_value = lhex(rec['emissive'])
            nt.links.new(em.outputs['Result'], g.inputs['Emission'])
        if rec['color'].lower() != '#ffffff':
            mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1
            nt.links.new(col, mx.inputs['A']); mx.inputs['B'].default_value = base
            col = mx.outputs['Result']
    elif rec.get('vertexColors'):
        vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'; vc.location = (-300, 0)
        col = vc.outputs['Color']
        if rec['color'].lower() != '#ffffff':
            mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1
            nt.links.new(col, mx.inputs['A']); mx.inputs['B'].default_value = base
            col = mx.outputs['Result']
        if water:   # depth-stepped water: alpha in the vertex colour
            am = mathn(nt, 'MULTIPLY', vc.outputs['Alpha'], float(rec.get('opacity', 1)), (-100, -300))
            nt.links.new(am, g.inputs['Alpha'])
    if col is None:
        rgb = nt.nodes.new('ShaderNodeRGB'); rgb.outputs[0].default_value = base; rgb.location = (-300, 150)
        col = rgb.outputs[0]
    tint = None
    if inst_color:
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_type = 'INSTANCER'; at.attribute_name = 'inst_color'; at.location = (-300, -200)
        tint = at.outputs['Color']
    elif obj_color:
        oi = nt.nodes.new('ShaderNodeObjectInfo'); oi.location = (-300, -200)
        tint = oi.outputs['Color']
    if tint is not None:
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1; mx.location = (-80, 0)
        nt.links.new(col, mx.inputs['A']); nt.links.new(tint, mx.inputs['B'])
        col = mx.outputs['Result']
    if rec.get('basic'):   # unlit (MeshBasicMaterial): the colour as it is, no fog unless it asks for it
        em = nt.nodes.new('ShaderNodeEmission'); em.location = (150, -200)
        nt.links.new(col, em.inputs['Color'])
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        nt.nodes.remove(g)
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(col, g.inputs['Albedo'])
        if rec.get('emissive', '#000000') != '#000000' and not rec.get('emissiveMap'):
            g.inputs['Emission'].default_value = lhex(rec['emissive'])
        if rec.get('transparent') and rec.get('opacity', 1) < 1 and not (water and rec.get('vertexColors')):
            g.inputs['Alpha'].default_value = rec['opacity']
    if rec.get('transparent') and (rec.get('opacity', 1) < 1 or water):
        set_transparent(m, blended=water)
    m.use_backface_culling = not rec.get('doubleSided')
    _flat[key] = m
    return m


# ---------- mesh helpers ----------
def mesh_from(name, v, tris, mat_idx=None):
    me = bpy.data.meshes.new(name)
    v = np.asarray(v, np.float32).reshape(-1, 3)
    tris = np.asarray(tris, np.int32).reshape(-1, 3)
    me.vertices.add(len(v)); me.vertices.foreach_set('co', v.ravel())
    me.loops.add(tris.size); me.loops.foreach_set('vertex_index', tris.ravel())
    me.polygons.add(len(tris)); me.polygons.foreach_set('loop_start', np.arange(0, tris.size, 3, dtype=np.int32))
    if mat_idx is not None:
        me.polygons.foreach_set('material_index', np.asarray(mat_idx, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    return me


SMOOTH_TYPES = ('CylinderGeometry', 'SphereGeometry', 'ConeGeometry', 'CapsuleGeometry', 'TorusGeometry', 'LatheGeometry')


def geom_mesh(gi, name, mats_):
    gr = W['geoms'][gi]
    if gr.get('_mesh'):
        return bpy.data.meshes[gr['_mesh']]
    v = verts3(arr(gr['v']))
    n = len(v)
    idx = (arr(gr['i']).astype(np.int64) if gr['i'] is not None else np.arange(n)).reshape(-1, 3)
    col_ = arr(gr['color']).reshape(n, -1) if gr.get('color') else None
    uv_ = arr(gr['uv']).reshape(n, 2) if gr.get('uv') else None
    if gr['i'] is None and n > 3000:
        # big triangle soups (the sea grid, road paint): weld vertices that share position and colour
        key = np.concatenate([np.round(v, 4)] + ([np.round(col_, 3)] if col_ is not None else []) + ([np.round(uv_, 4)] if uv_ is not None else []), 1)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        v = v[first]
        col_ = col_[first] if col_ is not None else None
        uv_ = uv_[first] if uv_ is not None else None
        idx = inv.reshape(-1)[idx]
        n = len(v)
    mi = np.zeros(len(idx), np.int32)
    for start, count, m in gr['groups']:
        mi[start // 3:(start + count) // 3] = m if m < len(mats_) else 0   # a box with one material still has 6 groups
    me = mesh_from(name, v, idx, mi)
    loops = idx.ravel()
    if col_ is not None:
        c = col_.astype(np.float32)
        if c.shape[1] == 3:
            c = np.concatenate([c, np.ones((len(c), 1), np.float32)], 1)
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        ca.data.foreach_set('color', c.ravel())
    if uv_ is not None:
        lay = me.uv_layers.new(name='UVMap')
        lay.data.foreach_set('uv', uv_[loops].astype(np.float32).ravel())
    if gr['type'] in SMOOTH_TYPES and not all(m.get('flat') for m in mats_):
        me.shade_smooth()
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
    if colors is not None:
        c = np.asarray([(*lin(list(cc / 255.0)), 1.0) for cc in colors], np.float32)
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
log(f'terrain ({N1}^2 at {CELL:g} m)')
xs = -SIZE / 2 + np.arange(N1) * CELL
gx, gz = np.meshgrid(xs, xs, indexing='ij')                          # [ix, iz]
V = np.stack([gx, -gz, VIS], -1).reshape(-1, 3)                      # vertex id = ix * N1 + iz
ix, iz = np.meshgrid(np.arange(RES), np.arange(RES), indexing='ij')
a = (ix * N1 + iz).ravel(); b = (ix * N1 + iz + 1).ravel(); c_ = ((ix + 1) * N1 + iz + 1).ravel(); d = ((ix + 1) * N1 + iz).ravel()
# same diagonal as three.js PlaneGeometry: (ix, iz+1)-(ix+1, iz); winding facing +Z in Blender
TRI = np.concatenate([np.stack([a, b, d], 1), np.stack([b, c_, d], 1)])
me = mesh_from('Terrain', V, TRI)
del TRI, a, b, c_, d
terrain = link(bpy.data.objects.new('Terrain', me), COL['Terrain'])
decimated = False
if len(V) > TERRAIN_MAX_VERTS:
    # Coralume Island: 1 M vertices at 1 m. Collapse the plain ground (sea floor, flat jungle) and keep
    # the detail where the ground changes; the material still reads the full 1 m surface grid
    ratio = TERRAIN_MAX_VERTS / len(V)
    log(f'decimating terrain to {ratio:.2f} ({len(V)} -> ~{TERRAIN_MAX_VERTS} vertices)')
    bpy.context.view_layer.objects.active = terrain
    md = terrain.modifiers.new('Decimate', 'DECIMATE')
    md.decimate_type = 'COLLAPSE'
    md.ratio = ratio
    md.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=md.name)
    me = terrain.data
    decimated = True
del V
for nm in ('.select_vert', '.select_edge', '.select_poly', 'sharp_face'):
    if nm in me.attributes:
        me.attributes.remove(me.attributes[nm])
me.shade_smooth()   # (the shading normals and the desert's dune tint come from the game's grids, in the material)
me.materials.append(terrain_material())
terrain['map'] = W['map']['name']
terrain['note'] = 'Regenerated from the game. Edits here do NOT flow back to the game (see art/blender/README.md).'
if decimated:
    terrain['decimated'] = f'collapse to {len(me.vertices)} vertices from {N1 * N1} (1 m grid); the material reads the full grid'
# shown surface per face (the game's ground lookup grid at the face centre), for selecting / inspecting
fc = np.empty(len(me.polygons) * 3, np.float32); me.polygons.foreach_get('center', fc); fc = fc.reshape(-1, 3)
fix = np.clip(np.round((fc[:, 0] + SIZE / 2) / CELL), 0, RES).astype(np.int64)
fiz = np.clip(np.round((-fc[:, 1] + SIZE / 2) / CELL), 0, RES).astype(np.int64)
fm = me.attributes.new('surface', 'INT8', 'FACE')
fm.data.foreach_set('value', LOOKG[fix, fiz, 0].astype(np.int8))
terrain['surface_names'] = ', '.join(f'{i} {l["name"]}' for i, l in enumerate(W['layers']))
del fc
log(f'terrain: {len(me.vertices)} vertices, {len(me.polygons)} faces')

# ======================================================================================
# Paths
log('paths')
PATH_COLORS = {'road': '#f4ead2', 'access': '#f4ead2', 'track': '#d9c7a6', 'creek': '#5bb0cc', 'course': '#d9c7a6'}
for pth in W['paths']:
    cu = bpy.data.curves.new(pth['name'], 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    pts = pth['pts']
    sp.points.add(len(pts) - 1)
    sp.points.foreach_set('co', np.array([(x, -z, y + 0.25, 1) for x, y, z in pts], np.float32).ravel())
    sp.use_cyclic_u = pth['closed']
    cu.bevel_depth = 0.12 if SIZE <= 400 else 0.25
    kind = pth['kind']
    title = {'access': 'Access track', 'creek': 'Creek'}.get(kind, kind.title())
    ob = link(bpy.data.objects.new(f'{title} {pth["name"]}', cu), COL['Paths'])
    colr = pth['diffColor'] or PATH_COLORS.get(kind, '#d9c7a6')
    m, nt, g = new_mat(f'Path {pth["diffLabel"] or kind}')
    g.inputs['Albedo'].default_value = lhex(colr if colr not in ('#000000', '#1a1a1a') else '#2b2b2b')
    g.inputs['Fog'].default_value = 0.0
    cu.materials.append(m)
    ob.hide_render = True
    for k in ('kind', 'surface', 'diff', 'diffLabel', 'width', 'length', 'shoulder'):
        if pth.get(k) is not None:
            ob[k] = pth[k]
    ob.color = (*lin(srgb(colr)), 1)

# ======================================================================================
# Rocks
log(f'rocks ({len(W["rocks"])})')
rmat = rock_material()
for i, r in enumerate(W['rocks']):
    v = verts3(arr(r['v']))
    kind = 'Ledge' if r['ledge'] else 'Embedded rock' if r.get('embedded') else 'Rock'
    me = mesh_from(f'{kind} {i:04d}', v, arr(r['i']).reshape(-1, 3))
    ca = me.color_attributes.new('tone', 'FLOAT_COLOR', 'POINT')
    t = arr(r['tone']).astype(np.float32)
    ca.data.foreach_set('color', np.stack([t, t, t * 0.98, np.ones_like(t)], 1).ravel())
    me.shade_smooth()
    me.materials.append(rmat)
    ob = link(bpy.data.objects.new(me.name, me), COL['Rocks'])
    ob.location = P(r['x'], r['y'], r['z'])
    ob.rotation_euler = (0, 0, r['rotY'])
    if not r.get('embedded'):
        add_outline(ob, 0.04)

# ======================================================================================
# Prop library: one collection per glTF model, instanced everywhere
log('prop library')
PROPLIB = {}


def import_glb(path, target):
    lc = find_layer(bpy.context.view_layer.layer_collection, target)
    bpy.context.view_layer.active_layer_collection = lc
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


used_assets = {a['asset'] for s in (W['dressing'], W['markers'], W['structures']) for a in s['assets'].values()}
prop_keys = sorted(used_assets | ({f[:-4] for f in W['modelFiles'] if not f.startswith('vehicles/')} if used_assets else set()))
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
# Dressing, markers, structures, water
DRESS = {
    'trees_round': ('Trees', 'Round trees'), 'trees_pine': ('Trees', 'Pine trees'), 'trees_palm': ('Trees', 'Palms'),
    'trees_broad': ('Trees', 'Broadleaf trees'), 'trees_giant': ('Trees', 'Emergent trees'), 'plants': ('Trees', 'Cacti, yuccas & snags'),
    'bushes': ('Props', 'Bushes'), 'tufts': ('Props', 'Grass tufts'), 'flowers': ('Props', 'Flowering tufts'), 'stones': ('Props', 'Stones'),
    'logs': ('Props', 'Logs & stumps'), 'stumps': ('Props', 'Logs & stumps'), 'fences': ('Props', 'Fences'),
    'ferns': ('Props', 'Ferns'), 'bananas': ('Props', 'Banana plants'), 'hibiscus': ('Props', 'Hibiscus'),
    'misc': ('Markers', 'Signs & gates'), 'road-signs': ('Markers', 'Signs & gates'), 'place-signs': ('Markers', 'Signs & gates'),
    'crawl-loose': ('Props', 'Stones'),
}
NICE = {'signpost': 'Trailhead fingerpost'}
NICE_PART = {'trees_palm': 'Palm', 'trees_broad': 'Broadleaf tree', 'trees_giant': 'Emergent tree', 'plants': 'Desert plant', 'ferns': 'Fern',
             'bushes': 'Bush', 'bananas': 'Banana plant', 'hibiscus': 'Hibiscus', 'tufts': 'Tuft', 'stones': 'Stone'}


def place_assets(assets, mapper):
    for rec in assets.values():
        key = rec['asset']
        top, name = mapper(rec)
        target = sub(top, name)
        mats = mats_of(rec['items'])
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
_srcs = {}


def place_meshes(sec, mapper, outline=True):
    """Procedural parts from the game's view code: single parts as objects (parented to their sign /
    gate / hut group), repeated parts as geometry-node instances of one source mesh."""
    groups = {}
    count = {}
    for r in sec['meshes']:
        top, subname = mapper(r)
        target = sub(top, subname)
        mats_ = [W['mats'][k] for k in r['mats']]
        items = r['items']
        many = items['n'] >= 8
        cols = colors_of(items)
        water = r.get('water') or top == 'Water'
        nice = NICE_PART.get(r['name'], r['name'])
        k = (nice, r['category'])
        count[k] = count.get(k, 0) + 1
        label = nice if count[k] == 1 else f'{nice} part {count[k]}'
        me = geom_mesh(r['geom'], label, mats_)
        if not me.materials:
            for mm in mats_:
                me.materials.append(flat_mat(mm, inst_color=cols is not None and many, obj_color=cols is not None and not many, water=water))
        mws = mats_of(items)
        if many:
            sk = (r['geom'], tuple(r['mats']))
            src = _srcs.get(sk)
            if not src:
                src = link(bpy.data.objects.new(label + ' (source)', me), lib_proc)
                if outline and r['category'] not in ('tufts', 'flowers', 'ferns') and not water:
                    add_outline(src, 0.02)
                _srcs[sk] = src
            scatter(label, src, mws, cols, target)
            continue
        parent = None
        gid = r.get('group')
        if gid:
            if gid not in groups:
                gr = sec['groups'][gid]
                ge = link(bpy.data.objects.new(gr['name'], None), target)
                ge.empty_display_size = 1.0
                ge.matrix_world = M(gr['m'])
                if gr.get('sign'):
                    ge['sign_title'] = gr['sign']['title']
                    if gr['sign'].get('sub'):
                        ge['sign_sub'] = gr['sign']['sub']
                groups[gid] = ge
            parent = groups[gid]
        for n, mw in enumerate(mws):
            ob = link(bpy.data.objects.new(label + (f' {n + 1:03d}' if len(mws) > 1 else ''), me), parent.users_collection[0] if parent else target)
            ob.matrix_world = mw
            if parent:
                ob.parent = parent
                ob.matrix_parent_inverse = parent.matrix_world.inverted()
            if cols is not None:
                ob.color = (*lin(list(cols[n] / 255.0)), 1)
            gt = W['geoms'][r['geom']]
            if outline and not water and not any(mm.get('transparent') for mm in mats_) and gt['type'] != 'PlaneGeometry' and not top == 'Terrain' and 'paint' not in r['category']:
                add_outline(ob, 0.02)


log('dressing')
place_assets(W['dressing']['assets'], lambda rec: DRESS.get(rec['category'], ('Props', rec['category'].replace('-', ' ').capitalize())))
place_meshes(W['dressing'], lambda r: ('Markers', 'Signs & gates') if r.get('group') and r['category'] in ('road-signs', 'place-signs') else DRESS.get(r['category'], ('Props', r['category'].replace('-', ' ').capitalize())))

log('markers')
if W['map']['kind'] == 'race':
    MARK = ('Marker post', 'Apex cone', 'Start line', 'Grid line', 'Start light', 'Edge post', 'Trail marker')

    def race_map(r):
        n = r['name']
        g = W['markers']['groups'].get(r.get('group')) if r.get('group') else None
        gname = g['name'] if g else ''
        if r.get('water'):
            return ('Water', 'Water splash')
        if gname.startswith('Arch'):
            return ('Markers', 'Checkpoint arches')
        if gname.startswith('Start-finish') or any(n.startswith(k) for k in MARK):
            return ('Markers', 'Checkpoints, posts & start')
        if gname.startswith('Grandstand') or n.startswith('Spectator') or n in ('Catch fence', 'Pole', 'Spectator tape'):
            return ('Props', 'Race venue: stands & crowd')
        if n in ('Concrete barrier', 'Barrier stripe', 'Tyre wall', 'White tyre / paint'):
            return ('Props', 'Race venue: barriers & tyre walls')
        return ('Props', 'Race venue: paddock, flags & signs')
    place_meshes(W['markers'], race_map)
else:
    def marker_map(r):
        if r.get('water'):
            return ('Water', 'Ford')
        if r.get('group'):
            return ('Markers', 'Signs & gates')
        if r['name'] in ('Flag pole', 'Cairn stone') or r['name'].startswith('Gate lamp'):
            return ('Markers', 'Summit flag & cairn')
        return ('Markers', 'Road & trail posts')
    place_meshes(W['markers'], marker_map)
place_assets(W['markers']['assets'], lambda rec: DRESS.get(rec['category'], ('Props', 'Loose stones & logs')))

if W['structures']['meshes']:
    log('structures')

    def struct_map(r):
        g = W['structures']['groups'].get(r.get('group')) if r.get('group') else None
        if g:
            n = g['name'].rstrip('0123456789 ')
            return ('Structures', {'Stilt hut': 'Huts', 'Canopy post': 'Camp', 'Fuel pump': 'Camp', 'Water tank': 'Camp', 'Old trailer': 'Camp', 'Camp shack': 'Camp'}.get(n, n))
        if 'paint' in r['category']:
            return ('Structures', 'Road paint')
        if r['name'].startswith('Deck') or r['name'] == 'Trail marker post':
            return ('Structures', 'Bridges & dock')
        if r['name'] == 'Guard rail':
            return ('Structures', 'Guard rails')
        if r['category'] == 'camp':
            return ('Structures', 'Camp')
        return ('Structures', r['category'].capitalize())
    place_meshes(W['structures'], struct_map)
    # the post mesh under the bridges / dock is the shared post colour: name it for what it is
    for o in COL['Structures'].all_objects:
        if o.name.startswith('Trail marker post'):
            o.name = 'Pilings'

if W['water']['meshes']:
    log('water')
    place_meshes(W['water'], lambda r: ('Water', {'sea': 'Sea', 'creek': 'Creek, pool & falls'}.get(r['category'], r['category'].capitalize())), outline=False)

if W.get('backdrop') and W['backdrop']['meshes']:
    place_meshes(W['backdrop'], lambda r: ('Terrain', 'Distant ranges'), outline=False)
    # a flat ground ring between the map edge and the distant ranges (Blender only: the game's camera
    # never looks past the edge; without it the overview shows sky under the map's corners)
    # inner loop: the terrain's own edge (a hair lower), outer loop: a circle well past it, flat
    step = max(1, RES // 64)
    ring_pts = ([(0, k) for k in range(0, RES, step)] + [(k, RES) for k in range(0, RES, step)]
                + [(RES, k) for k in range(RES, 0, -step)] + [(k, 0) for k in range(RES, 0, -step)])
    h0 = float(np.percentile(np.concatenate([VIS[0], VIS[-1], VIS[:, 0], VIS[:, -1]]), 10)) - 0.5
    R1 = SIZE * 1.6
    rv = []
    for i_, k_ in ring_pts:
        x_, z_ = -SIZE / 2 + i_ * CELL, -SIZE / 2 + k_ * CELL
        rv.append((x_, -z_, float(VIS[i_, k_]) - 0.05))
    for i_, k_ in ring_pts:
        x_, z_ = -SIZE / 2 + i_ * CELL, -SIZE / 2 + k_ * CELL
        L_ = math.hypot(x_, z_) or 1
        rv.append((x_ / L_ * R1, -z_ / L_ * R1, h0))
    RS = len(ring_pts)
    rf = [(k, (k + 1) % RS, RS + (k + 1) % RS, RS + k) for k in range(RS)]
    rme = bpy.data.meshes.new('Outer ground')
    rme.from_pydata(rv, [], rf)
    ring = link(bpy.data.objects.new('Outer ground (beyond the map, Blender only)', rme), sub('Terrain', 'Distant ranges'))
    rm = flat_mat({'color': LOOK['backdrop'][0], 'basic': True, 'name': 'Outer ground', 'doubleSided': True})
    rme.materials.append(rm)

# ======================================================================================
# Gameplay points
mk = sub('Markers', 'Gameplay points')
spk = sub('Markers', 'Spawn points')
POINT_LOOK = {'spawn': ('SINGLE_ARROW', 3), 'lot': ('CIRCLE', 1), 'trail-end': ('CONE', 1.5), 'stage-gate': ('CONE', 1.5), 'course-gate': ('CONE', 1.5),
              'checkpoint': ('ARROWS', 2), 'place': ('SPHERE', 2), 'landmark': ('SPHERE', 4), 'spawn-point': ('SINGLE_ARROW', 2.5)}
for p in W['points']:
    kind = p['kind']
    disp, size = POINT_LOOK.get(kind, ('PLAIN_AXES', 1))
    e = link(bpy.data.objects.new(p['name'], None), spk if kind == 'spawn-point' else mk)
    e.empty_display_type = disp
    e.empty_display_size = p.get('r') or size
    lift = 4 if kind in ('trail-end', 'stage-gate', 'course-gate') else 0
    e.location = P(p['x'], p['y'] + lift, p['z'])
    if disp == 'SINGLE_ARROW' and p.get('yaw') is not None:
        # the arrow (+Z) tipped forward along the truck's heading (three.js forward = -z rotated by yaw)
        e.rotation_euler = (-math.pi / 2, 0, p['yaw'])
    elif p.get('yaw') is not None:
        e.rotation_euler = (0, 0, p['yaw'])
    for k_ in ('diff', 'group', 'note', 'trail', 'course', 'stage', 's'):
        if p.get(k_) is not None:
            e[k_] = p[k_]
    e['kind'] = kind

# ======================================================================================
# Vehicles, parked at the spawn (wheels placed at Marker_Wheel*, left side mirrored like the game)
log('vehicles')
sp = W['spawn']
VEH = [f[:-4] for f in W['modelFiles'] if f.startswith('vehicles/')]
yaw = sp['yaw']
right = (math.cos(yaw), -math.sin(yaw))
spawn_y = next((p['y'] for p in W['points'] if p['kind'] == 'spawn'), None)
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
# Sun, sky, cameras
log('lights & cameras')
lc = COL['Lights & Cameras']
sd = bpy.data.lights.new('Sun', 'SUN')
sd.energy = SUN_ENERGY
sd.color = lin(srgb(LOOK['sun']))
sd.angle = math.radians(0.5)
sun = link(bpy.data.objects.new('Sun', sd), lc)
sdir = P(*LOOK['sunDir']).normalized()            # main.js SUN_DIR (towards the sun)
sun.location = sdir * 150
sun.rotation_euler = (-sdir).to_track_quat('-Z', 'Y').to_euler()

# sky: the pipeline's stepped bands, horizon (= the haze) up to the zenith, seen by the camera only
world = bpy.data.worlds.new('Sky (stepped bands)')
SC.world = world
wn = world.node_tree
wn.nodes.clear()
wo = wn.nodes.new('ShaderNodeOutputWorld'); wo.location = (600, 0)
tc = wn.nodes.new('ShaderNodeTexCoord'); tc.location = (-600, 0)
sxyz = wn.nodes.new('ShaderNodeSeparateXYZ'); sxyz.location = (-400, 0)
wn.links.new(tc.outputs['Generated'], sxyz.inputs[0])
band = wn.nodes.new('ShaderNodeValToRGB'); band.location = (-200, 0); band.label = 'sky bands (palette.js SKY_BANDS)'
br = band.color_ramp
br.interpolation = 'CONSTANT'
bands = LOOK['skyBands']
br.elements[0].position, br.elements[0].color = 0.0, lhex(bands[0])
br.elements[1].position, br.elements[1].color = 0.62, lhex(bands[-1])
for i, h in enumerate(bands[1:-1]):
    e = br.elements.new(0.07 + i * 0.16); e.color = lhex(h)
wn.links.new(sxyz.outputs['Z'], band.inputs['Fac'])
bg = wn.nodes.new('ShaderNodeBackground'); bg.location = (100, 100)
wn.links.new(band.outputs['Color'], bg.inputs['Color'])
lp = wn.nodes.new('ShaderNodeLightPath'); lp.location = (100, 300)
blk = wn.nodes.new('ShaderNodeBackground'); blk.inputs['Strength'].default_value = 0.0; blk.location = (100, -100)
mx = wn.nodes.new('ShaderNodeMixShader'); mx.location = (400, 0)
wn.links.new(lp.outputs['Is Camera Ray'], mx.inputs['Fac'])
wn.links.new(blk.outputs[0], mx.inputs[1]); wn.links.new(bg.outputs[0], mx.inputs[2])
wn.links.new(mx.outputs[0], wo.inputs['Surface'])

CAMS = []
CLIP = max(2000.0, SIZE * 3.5)
for cd_ in W['cameras']:
    cd = bpy.data.cameras.new(cd_['name'])
    cd.sensor_fit = 'VERTICAL'
    if cd_.get('ortho'):
        cd.type = 'ORTHO'; cd.ortho_scale = cd_['ortho']
    else:
        cd.angle_y = math.radians(cd_['fov'])
    cd.clip_start, cd.clip_end = 0.1, CLIP
    clash = bpy.data.objects.get(cd_['name'])   # a point or path of the same name keeps it with a suffix
    if clash:
        clash.name = cd_['name'] + (' (path)' if clash.type == 'CURVE' else ' (point)')
    ob = link(bpy.data.objects.new(cd_['name'], cd), lc)
    eye, tgt = P(*cd_['eye']), P(*cd_['target'])
    ob.location = eye
    ob.rotation_euler = (tgt - eye).to_track_quat('-Z', 'Y').to_euler()
    ob['fog'] = bool(cd_.get('fog', True))
    ob['preview'] = bool(cd_.get('render', True))
    CAMS.append(ob)
SC.camera = next(c for c in CAMS if c.name == 'Overview')

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
    SC.eevee.shadow_pool_size = '1024'   # thousands of instanced plants cast shadows
except Exception:
    pass
try:
    SC.view_settings.view_transform = 'Standard'
except TypeError as e:
    log('view transform:', e)
SC.view_settings.look = 'None'
# 1-pixel dark warm outlines, like the game's outline pass. Set up but OFF by default: Freestyle over
# a whole map runs out of memory. Tick Render > Freestyle for close-up shots, or pass --freestyle.
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
for k in ('Terrain', 'Rocks', 'Trees', 'Props', 'Structures', 'Markers', 'Vehicles'):
    ls.collection.children.link(COL[k])
SC.collection.children.unlink(ls.collection)
ls.select_silhouette = True
ls.select_border = True
ls.select_crease = False
ls.select_material_boundary = True
ls.select_external_contour = True
if ls.linestyle is None:
    ls.linestyle = bpy.data.linestyles.new('Outline')
ls.linestyle.color = lin(srgb(LOOK['outline']))
ls.linestyle.thickness = 1.0
ls.linestyle.chaining = 'PLAIN'
# exclude the library sources from the view layer (they render through their instances); drop empty tops
find_layer(vl.layer_collection, LIB).exclude = True
for n in TOP:
    c = COL[n]
    if not c.all_objects:
        bpy.data.collections.remove(c)
# viewport: opens looking through the Overview camera, material preview lit by the scene's sun and sky
for scr in bpy.data.screens:
    for area in scr.areas:
        if area.type == 'VIEW_3D':
            spc = area.spaces.active
            spc.shading.type = 'MATERIAL'
            spc.shading.use_scene_lights = True
            spc.shading.use_scene_world = True
            spc.clip_end = CLIP
            spc.clip_start = 0.1
            r3d = spc.region_3d
            r3d.view_perspective = 'CAMERA'
SC['how_to'] = f'Regenerate: node tools/export/export_world.mjs {MAP}; blender --background --factory-startup --python tools/blender/world/build_world.py -- {MAP}'

# ======================================================================================
# Save (textures packed), then preview stills
os.makedirs(os.path.dirname(OUT), exist_ok=True)
log('packing + saving')
try:
    bpy.ops.file.pack_all()
except Exception as e:
    log('pack_all:', e)
sys.path.insert(0, os.path.dirname(HERE))
import blend_save  # noqa: E402
blend_save.save(OUT, log=log)   # compressed, no .blend1, no local paths / file-browser state
log(f'saved {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)')
STATS = {'objects': len(bpy.data.objects), 'meshes': len(bpy.data.meshes), 'materials': len(bpy.data.materials), 'images': len(bpy.data.images),
         'instances': sum(o.get('instances', 0) for o in bpy.data.objects) + sum(1 for o in bpy.data.objects if o.instance_type == 'COLLECTION'),
         'collections': {c.name: len(c.all_objects) for c in SC.collection.children}}
log('stats', json.dumps(STATS))


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
        if not want and not cam['preview'] and not os.environ.get('LR_ALL_CAMS'):
            continue
        SC.camera = cam
        # far views would be all haze: the game never sees the map from that far away
        toon_group().nodes['Fog amount (scene)'].outputs[0].default_value = 1.0 if cam['fog'] else 0.0
        slug = cam.name.lower().replace(' (ortho)', '').replace('-', ' ').replace('&', 'and').replace(' ', '_')
        slug = ''.join(ch for ch in slug if ch.isalnum() or ch == '_').strip('_')
        small = os.path.join(bpy.app.tempdir, f'world_{MAP}_{slug}_small.png')
        SC.render.filepath = small
        t = time.time()
        bpy.ops.render.render(write_still=True)
        dst = os.path.join(PREV, f'world_{MAP}_{slug}.png')
        upscale(small, dst)
        log(f'render {cam.name} -> {os.path.relpath(dst, ROOT)} ({time.time() - t:.1f}s)')
log('done')
