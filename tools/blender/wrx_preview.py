# Preview renders for build_wrx.py: toon (stepped, warm shadows) + dark outline shells + low-res frame
# upscaled with nearest neighbour, on warm ochre dirt (docs/ART_STYLE.md). Preview-only: runs after export.
import math
import os

import bpy
import numpy as np
from mathutils import Vector

from wrx_geo import hexrgb

RES = (480, 300)
UPSCALE = 3
OUTLINE = '#2a1a14'
# toon bands: multipliers on the texture colour (linear), warm purple-brown shadows
SHADOW = (0.50, 0.40, 0.50)
MID = (0.80, 0.74, 0.76)
LIT = (1.0, 1.0, 1.0)
T_MID, T_LIT = 0.42, 0.90


def lin(c):
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def sock(node, ident, out=False):
    return next(s for s in (node.outputs if out else node.inputs) if s.identifier == ident)


def toon_mat(name, img, kind):
    m = bpy.data.materials.new('TOON_' + name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    if kind == 'lamp':
        nt.links.new(tex.outputs['Color'], em.inputs['Color'])
        return m
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*SHADOW, 1)
    cr.elements[1].position = T_LIT
    cr.elements[1].color = (*LIT, 1)
    e = cr.elements.new(T_MID)
    e.color = (*MID, 1)
    nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    sock(mix, 'Factor_Float').default_value = 1.0
    nt.links.new(tex.outputs['Color'], sock(mix, 'A_Color'))
    nt.links.new(ramp.outputs['Color'], sock(mix, 'B_Color'))
    nt.links.new(sock(mix, 'Result_Color', out=True), em.inputs['Color'])
    return m


def outline_mat():
    m = bpy.data.materials.new('Outline')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*lin(hexrgb(OUTLINE)), 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = True
    m.use_backface_culling_shadow = True
    return m


def dirt_image():
    S = 64
    D = [hexrgb(h) for h in ('#f2c25a', '#e0a440', '#c4832e', '#9a5f24')]
    a = np.zeros((S, S, 4))
    a[..., :3] = D[1]
    a[..., 3] = 1
    seed = 12345

    def rnd():
        nonlocal seed
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    for _ in range(26):     # pebbles: dark body + lit top pixel
        x, y = int(rnd() * S), int(rnd() * S)
        w = 1 + int(rnd() * 2)
        for dx in range(w):
            a[y % S, (x + dx) % S, :3] = D[2]
            a[(y + 1) % S, (x + dx) % S, :3] = D[0]
    for _ in range(10):     # darker dirt clods
        x, y = int(rnd() * S), int(rnd() * S)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (-1, 0), (1, 1)):
            a[(y + dy) % S, (x + dx) % S, :3] = D[2]
        a[y % S, x % S, :3] = D[3]
    img = bpy.data.images.new('prev_dirt', S, S, alpha=False)
    img.pixels.foreach_set(a.astype(np.float32).ravel())
    return img


def ground(scene, mat):
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    me = bpy.data.meshes.new('PrevGround')
    bm.to_mesh(me)
    bm.free()
    uv = me.uv_layers.new(name='UVMap')
    co = [me.vertices[l.vertex_index].co for l in me.loops]
    uv.data.foreach_set('uv', np.array([(c.x * 32 / 64, c.y * 32 / 64) for c in co], dtype=np.float32).ravel())
    me.materials.append(mat)
    g = bpy.data.objects.new('PrevGround', me)
    g['preview_only'] = True
    scene.collection.objects.link(g)
    return g


def upscale(src, dst, k):
    im = bpy.data.images.load(src)
    W, H = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(H, W, 4)
    b = a.repeat(k, 0).repeat(k, 1)
    out = bpy.data.images.new('up_' + os.path.basename(dst), W * k, H * k, alpha=False)
    out.pixels.foreach_set(b.ravel())
    out.filepath_raw = dst
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(im)
    bpy.data.images.remove(out)


def run(scene, body, wheel, MATS, OUT, PREV, FA, RA, HX, R):
    # swap to toon materials (export already done)
    kinds = {'Lamp': 'lamp', 'Glass': 'glass'}
    toon = {n: toon_mat(n, next(nd for nd in m.node_tree.nodes if nd.type == 'TEX_IMAGE').image, kinds.get(n, 'paint'))
            for n, m in MATS.items()}
    for o in (body, wheel):
        for i, m in enumerate(o.data.materials):
            o.data.materials[i] = toon[m.name]
    ol = outline_mat()
    wheels = [wheel]
    for nm, loc, sx in (('FL', (-HX, FA, R), -1), ('RL', (-HX, RA, R), -1), ('RR', (HX, RA, R), 1)):
        w = bpy.data.objects.new('PrevWheel' + nm, wheel.data)
        w.location = loc
        w.scale = (sx, 1, 1)
        w['preview_only'] = True
        scene.collection.objects.link(w)
        wheels.append(w)
    for o in (body, wheel):
        o.data.materials.append(ol)
    for o, th in [(body, 0.022)] + [(w, 0.014) for w in wheels]:
        md = o.modifiers.new('outline', 'SOLIDIFY')
        md.thickness = th
        md.offset = 1.0
        md.use_flip_normals = True
        md.use_rim = False
        md.material_offset = len(o.data.materials) - 1
    ground(scene, toon_mat('Dirt', dirt_image(), 'paint'))

    # light, world, render settings
    sun_d = bpy.data.lights.new('PrevSun', 'SUN')
    sun_d.energy = 1.7
    sun_d.color = (1.0, 0.95, 0.86)
    sun_d.angle = math.radians(1.0)
    sun = bpy.data.objects.new('PrevSun', sun_d)
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('PrevWorld')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*lin(hexrgb('#e8b860')), 1)
    bg.inputs['Strength'].default_value = 0.38
    scene.world = world
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = 1
    try:
        scene.eevee.use_shadows = True
    except Exception:
        pass
    scene.render.filter_size = 0.0
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    try:
        scene.view_settings.view_transform = 'Standard'
    except TypeError as e:
        print('[preview] view transform:', e)
    scene.view_settings.look = 'None'
    cam_d = bpy.data.cameras.new('PrevCam')
    cam_d.type = 'ORTHO'
    cam = bpy.data.objects.new('PrevCam', cam_d)
    scene.collection.objects.link(cam)
    scene.camera = cam

    views = {   # name: (azimuth from +Y towards +X, elevation, ortho scale, target z)
        'front34': (-52, 20, 5.0, 0.72),
        'side': (-90, 6, 5.2, 0.76),
        'rear34': (140, 20, 5.0, 0.74),
        'front': (0, 12, 3.6, 0.72),
    }
    for name, (az, el, scale, tz) in views.items():
        az, el = math.radians(az), math.radians(el)
        d = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
        tgt = Vector((0, 0, tz))
        cam.location = tgt + d * 20
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        cam_d.ortho_scale = scale
        cam_d.clip_end = 100
        # sun from the camera's upper left
        laz = az - math.radians(40)
        lel = math.radians(52)
        ld = Vector((math.cos(lel) * math.sin(laz), math.cos(lel) * math.cos(laz), math.sin(lel)))
        sun.rotation_euler = (-ld).to_track_quat('-Z', 'Y').to_euler()
        small = os.path.join(OUT, f'wrx_{name}_small.png')
        scene.render.filepath = small
        bpy.ops.render.render(write_still=True)
        upscale(small, os.path.join(PREV, f'wrx_{name}.png'), UPSCALE)
        print('[preview]', name)
