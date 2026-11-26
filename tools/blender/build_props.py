# Builds the LowRange nature/prop set headless and exports public/models/*.glb, then renders
# toon + outline + low-res preview sheets to docs/previews/props_*.png.
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_props.py
# Optional: -- --no-preview   (export only)
import os
import sys
import math
import importlib
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, 'out')
MODELS = os.path.join(ROOT, 'public', 'models')
PREV = os.path.join(ROOT, 'docs', 'previews')
sys.path.insert(0, HERE)
import props_atlas, props_geo, props_uv  # noqa: E402
for mod in (props_atlas, props_geo, props_uv):
    importlib.reload(mod)
from props_atlas import build_atlas, ground_texture, hx, SIZE  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def lin(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def np_to_image(name, A, path):
    h, w = A.shape[:2]
    img = bpy.data.images.get(name) or bpy.data.images.new(name, w, h, alpha=False)
    if img.size[0] != w or img.size[1] != h:
        img.scale(w, h)
    rgba = np.concatenate([A, np.ones((h, w, 1), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    return img


# ------------------------------------------------------------------ materials
def export_material(name, img, double_sided):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = not double_sided
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    tex.location = (-400, 200)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return m


def toon_material(name, img, double_sided=False, uv_scale=None):
    """Preview only: texture x stepped diffuse (3 warm bands), as emission."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = not double_sided
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    if uv_scale:
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (uv_scale, uv_scale, 1)
        nt.links.new(tc.outputs['UV'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], tex.inputs['Vector'])
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(s2r.outputs['Color'], bw.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.56, 0.44, 0.56, 1)   # warm purple-brown shadow
    cr.elements[1].position = 0.42
    cr.elements[1].color = (1.06, 1.02, 0.95, 1)   # lit
    e = cr.elements.new(0.16)
    e.color = (0.82, 0.74, 0.76, 1)                # mid
    nt.links.new(bw.outputs[0], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    nt.links.new(tex.outputs['Color'], mix.inputs[6])
    nt.links.new(ramp.outputs['Color'], mix.inputs[7])
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(mix.outputs[2], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


def outline_material():
    m = bpy.data.materials.new('PV_Outline')
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*lin(hx('#2a1a14')), 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


# ------------------------------------------------------------------ assets
def make_object(m, mat, coll):
    me = bpy.data.meshes.new(m.name)
    m.bm.to_mesh(me)
    m.bm.free()
    me.materials.append(mat)
    if getattr(m, 'smooth', False):
        me.shade_smooth()
        if getattr(m, 'sharp_angle', None):
            me.set_sharp_from_angle(angle=math.radians(m.sharp_angle))
    else:
        me.shade_flat()
    o = bpy.data.objects.new(m.name, me)
    coll.objects.link(o)
    return o


def export_glb(o, path):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
              export_materials='EXPORT', export_image_format='AUTO', export_texcoords=True, export_normals=True,
              export_cameras=False, export_lights=False, export_animations=False, export_extras=False)
    try:
        bpy.ops.export_scene.gltf(export_vertex_color='NONE', **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


BUDGET = {'tree_round': 1500, 'tree_pine': 1200, 'bush': 600, 'grass_tuft': 80, 'rock': 400,
          'fence_segment': 300, 'signpost': 300, 'log': 300, 'stump': 200}


def budget(name):
    for k, v in BUDGET.items():
        if name.startswith(k):
            return v


# ------------------------------------------------------------------ preview
def preview_copy(src, coll, toon, outline, loc, rz=0.0, s=1.0, thick=0.035, shell=True):
    me = src.data.copy()
    me.materials.clear()
    me.materials.append(toon)
    o = bpy.data.objects.new(src.name + '_pv', me)
    o.location = loc
    o.rotation_euler = (0, 0, rz)
    o.scale = (s, s, s)
    coll.objects.link(o)
    if shell:
        me.materials.append(outline)
        md = o.modifiers.new('outline', 'SOLIDIFY')
        md.thickness = thick
        md.offset = 1.0
        md.use_flip_normals = True
        md.use_rim = False
        md.material_offset = 1
    return o


def setup_render(scene, w, h):
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.filter_size = 0.0
    scene.render.film_transparent = False
    try:
        scene.eevee.taa_render_samples = 1
    except AttributeError:
        pass
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    world = bpy.data.worlds.get('PV_World') or bpy.data.worlds.new('PV_World')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.9, 0.75, 0.62, 1)
    bg.inputs['Strength'].default_value = 0.12
    scene.world = world


def add_sun(coll):
    sd = bpy.data.lights.new('PV_Sun', 'SUN')
    sd.energy = 3.2
    sd.angle = math.radians(1.0)
    sun = bpy.data.objects.new('PV_Sun', sd)
    sun.rotation_euler = Vector((0.45, 0.6, -1.15)).to_track_quat('-Z', 'Y').to_euler()
    coll.objects.link(sun)


def add_camera(coll, target, scale, tilt_deg=32, yaw_deg=0.0):
    cd = bpy.data.cameras.new('PV_Cam')
    cd.type = 'ORTHO'
    cd.ortho_scale = scale
    cam = bpy.data.objects.new('PV_Cam', cd)
    t, y = math.radians(tilt_deg), math.radians(yaw_deg)
    d = Vector((math.sin(y) * math.cos(t), -math.cos(y) * math.cos(t), math.sin(t)))
    cam.location = Vector(target) + d * 60
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cd.clip_end = 200
    coll.objects.link(cam)
    return cam


def render_sheet(scene, path, upscale):
    small = os.path.join(OUT, 'render_small.png')
    scene.render.filepath = small
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(small, check_existing=False)
    w, h = img.size
    A = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(A)
    A = A.reshape(h, w, 4)[:, :, :3]
    big = np.repeat(np.repeat(A, upscale, axis=0), upscale, axis=1)
    np_to_image('PV_out_' + os.path.basename(path), big, path)
    bpy.data.images.remove(img)
    print('preview', path)


def ground(coll, size, ground_img, cx=0, cy=0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(cx, cy, 0))
    g = bpy.context.active_object
    g.name = 'PV_Ground'
    for c in g.users_collection:
        c.objects.unlink(g)
    coll.objects.link(g)
    gm = toon_material('PV_GroundMat', ground_img, uv_scale=size / 8.0)
    g.data.materials.append(gm)
    return g


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(MODELS, exist_ok=True)
    os.makedirs(PREV, exist_ok=True)
    scene = bpy.context.scene

    A = build_atlas()
    atlas = np_to_image('LR_props_atlas', A, os.path.join(OUT, 'props_atlas.png'))
    atlas.pack()
    np_to_image('PV_atlas_big', np.repeat(np.repeat(A, 3, 0), 3, 1), os.path.join(PREV, 'props_atlas.png'))
    mat = export_material('LR_Props', atlas, False)
    mat_grass = export_material('LR_PropsGrass', atlas, True)

    coll = bpy.data.collections.new('Assets')
    scene.collection.children.link(coll)
    objs = {}
    report = []
    for i, m in enumerate(props_geo.all_assets()):
        used = props_uv.map_uvs(m, 900 + i)
        o = make_object(m, mat_grass if getattr(m, 'double_sided', False) else mat, coll)
        objs[o.name] = o
        t = tri_count(o)
        dims = o.dimensions
        report.append((o.name, t, budget(o.name), tuple(round(x, 2) for x in dims)))
        export_glb(o, os.path.join(MODELS, o.name + '.glb'))
    print('\nASSET REPORT (name, tris, budget, dims xyz)')
    for r in report:
        print('  %-16s %5d / %-5d  %s%s' % (r[0], r[1], r[2], r[3], '  OVER BUDGET' if r[1] > r[2] else ''))

    if '--no-preview' not in ARGS:
        previews(scene, objs, atlas)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'props.blend'))


def previews(scene, objs, atlas):
    toon = toon_material('PV_Toon', atlas)
    toon2 = toon_material('PV_ToonGrass', atlas, double_sided=True)
    outl = outline_material()
    gimg = np_to_image('PV_ground', ground_texture(), os.path.join(OUT, 'ground.png'))
    # hide assets from the preview renders
    for o in objs.values():
        o.hide_render = True

    def place(coll, name, loc, rz=0.0, s=1.0):
        src = objs[name]
        grass = name.startswith('grass')
        return preview_copy(src, coll, toon2 if grass else toon, outl, loc, rz, s,
                            thick=0.03 if max(src.dimensions) < 3 else 0.045, shell=not grass)

    # ---------------- sheet 1: line-up on ochre ground, like the reference's bottom row
    pv = bpy.data.collections.new('PV_Lineup')
    scene.collection.children.link(pv)
    back = ['tree_round_a', 'tree_round_b', 'tree_pine_a', 'tree_pine_b', 'fence_segment', 'signpost']
    front = ['bush_a', 'bush_b', 'bush_flower_a', 'bush_flower_b', 'grass_tuft_a', 'grass_tuft_b',
             'rock_small_a', 'rock_small_b', 'rock_medium_a', 'rock_medium_b', 'rock_large_a', 'log', 'stump']
    rows = [(back, 5.0, 0.9), (front, 0.0, 0.55)]
    span = 0
    for names, y, gap in rows:
        x = 0
        xs = []
        for n in names:
            w = objs[n].dimensions.x
            xs.append(x + w / 2 - (0 if n not in ('fence_segment',) else w / 2))
            x += w + gap
        span = max(span, x)
        off = -x / 2
        for n, px in zip(names, xs):
            place(pv, n, (px + off, y, 0), rz=0.0 if n in ('fence_segment', 'signpost') else 0.4)
    ground(pv, 80, gimg)
    add_sun(pv)
    add_camera(pv, (0, 2.5, 3.3), span + 1.0, tilt_deg=30)
    scene.camera = bpy.data.objects['PV_Cam']
    setup_render(scene, 800, 400)
    render_sheet(scene, os.path.join(PREV, 'props_lineup.png'), 2)
    pv.hide_render = True

    # ---------------- sheet 2: a little scene like the reference's top background
    sc = bpy.data.collections.new('PV_Scene')
    scene.collection.children.link(sc)
    import random
    R = random.Random(3)
    for i in range(7):
        place(sc, 'fence_segment', (-7 + i * 2.0, 6.0, 0))
    place(sc, 'tree_round_a', (-6.5, 9.5, 0), 0.3)
    place(sc, 'tree_round_b', (3.5, 10.5, 0), 1.2)
    place(sc, 'tree_pine_a', (8.8, 11.5, 0), 0.5)
    place(sc, 'tree_pine_b', (-11.0, 12.5, 0), 2.0)
    place(sc, 'tree_round_a', (-1.0, 14.0, 0), 2.5, 1.1)
    place(sc, 'rock_large_a', (0.8, 8.0, 0), 0.6)
    place(sc, 'rock_medium_a', (6.8, 4.0, 0), 1.0)
    place(sc, 'rock_small_b', (-3.2, 3.4, 0), 0.2)
    place(sc, 'rock_small_a', (2.6, 2.0, 0), 1.4)
    place(sc, 'rock_medium_b', (-9.5, 4.8, 0), 0.4)
    place(sc, 'bush_a', (-4.2, 7.2, 0), 0.5)
    place(sc, 'bush_flower_a', (5.6, 7.0, 0), 1.0)
    place(sc, 'bush_b', (-9.0, 7.6, 0), 2.0)
    place(sc, 'bush_flower_b', (-1.6, 5.0, 0), 0.2)
    place(sc, 'bush_a', (9.5, 6.6, 0), 0.9, 0.9)
    place(sc, 'stump', (4.4, 3.0, 0), 0.4)
    place(sc, 'log', (-6.0, 2.4, 0), 0.25)
    place(sc, 'signpost', (8.6, 2.6, 0), -0.3)
    for i in range(45):
        x, y = R.uniform(-12, 12), R.uniform(-2, 9)
        place(sc, 'grass_tuft_a' if i % 2 else 'grass_tuft_b', (x, y, 0), R.uniform(0, 6.28), R.uniform(0.9, 1.6))
    ground(sc, 80, gimg, 0, 10)
    add_sun(sc)
    cam = add_camera(sc, (0, 6.5, 1.5), 22.0, tilt_deg=33)
    scene.camera = cam
    setup_render(scene, 480, 270)
    render_sheet(scene, os.path.join(PREV, 'props_scene.png'), 4)
    sc.hide_render = True

    # ---------------- sheet 3: close-up to judge the pixel textures
    cl = bpy.data.collections.new('PV_Close')
    scene.collection.children.link(cl)
    place(cl, 'tree_round_a', (-4.6, 2.0, 0), 0.4)
    place(cl, 'tree_pine_b', (4.4, 2.5, 0), 0.4)
    place(cl, 'rock_large_a', (0.6, 1.5, 0), 0.5)
    place(cl, 'bush_flower_a', (-1.6, -0.6, 0), 0.4)
    place(cl, 'stump', (1.8, -1.2, 0), 0.4)
    place(cl, 'log', (-1.0, -2.2, 0), 0.15)
    place(cl, 'fence_segment', (2.6, -2.2, 0), -0.1)
    place(cl, 'signpost', (-5.0, -1.8, 0), 0.2)
    place(cl, 'rock_small_b', (0.2, -1.4, 0), 0.4)
    ground(cl, 60, gimg)
    add_sun(cl)
    scene.camera = add_camera(cl, (0, 0.5, 2.6), 13.0, tilt_deg=30)
    setup_render(scene, 480, 300)
    render_sheet(scene, os.path.join(PREV, 'props_closeup.png'), 4)


main()
