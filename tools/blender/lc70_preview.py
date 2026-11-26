# Preview-only look for the lc70 build: stepped warm toon light, inverted-hull outlines, low-res render
# upscaled with nearest neighbour. Runs AFTER the glb export, so nothing here reaches the game file.
import os
import math
import bpy
import numpy as np
from mathutils import Vector

OUTLINE = (0x2a / 255, 0x1a / 255, 0x14 / 255)
SUN_POWER, SUN_YAW, SUN_ELEV = 2.6, 40, 52
BANDS = ((0.0, (0.76, 0.63, 0.64)), (0.30, (0.91, 0.86, 0.84)), (0.58, (1.0, 1.0, 0.98)))


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin3(rgb):
    return tuple(srgb_to_lin(c) for c in rgb)


def toonify(m, emissive=False, boost=1.0):
    nt = m.node_tree
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    keep = tex.name
    for n in list(nt.nodes):
        if n.name != keep:
            nt.nodes.remove(n)
    tex = nt.nodes[keep]
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    if emissive:
        nt.links.new(tex.outputs['Color'], em.inputs['Color'])
        em.inputs['Strength'].default_value = 1.0
        return
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    # three warm bands: hue-shifted shadow (purple-brown), mid, lit
    cr.elements[0].position = BANDS[0][0]
    cr.elements[0].color = (*lin3(BANDS[0][1]), 1)
    cr.elements[1].position = BANDS[2][0]
    cr.elements[1].color = (*lin3(BANDS[2][1]), 1)
    e = cr.elements.new(BANDS[1][0])
    e.color = (*lin3(BANDS[1][1]), 1)
    nt.links.new(s2r.outputs[0], ramp.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    nt.links.new(tex.outputs['Color'], mix.inputs[6])
    nt.links.new(ramp.outputs[0], mix.inputs[7])
    nt.links.new(mix.outputs[2], em.inputs['Color'])
    em.inputs['Strength'].default_value = boost


def outline_mat():
    m = bpy.data.materials.new('PrevOutline')
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*lin3(OUTLINE), 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = True
    return m


def add_outline(o, mat, thick=0.025):
    """inverted hull as its own object (casts no shadow, so it can't darken the body)"""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * thick
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.material_index = 0
        f.smooth = True
    me = bpy.data.meshes.new(o.name + '_outline')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    sh = bpy.data.objects.new(o.name + '_outline', me)
    sh.matrix_world = o.matrix_world.copy()
    sh.visible_shadow = False
    bpy.context.scene.collection.objects.link(sh)
    return sh


def ground(T):
    import lc70_tex
    cv = lc70_tex.paint_dirt()
    img = bpy.data.images.new('prev_dirt', cv.W, cv.H, alpha=False)
    rgba = np.ones((cv.H, cv.W, 4), dtype=np.float32)
    rgba[..., :3] = cv.a / 255.0
    img.pixels.foreach_set(rgba.ravel())
    m = bpy.data.materials.new('PrevDirt')
    nt = m.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    toonify(m)
    me = bpy.data.meshes.new('PrevGround')
    S = 30.0
    me.from_pydata([(-S, -S, 0), (S, -S, 0), (S, S, 0), (-S, S, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new()
    k = 2 * S * 32 / 64
    for li, (u, v) in zip(range(4), ((0, 0), (k, 0), (k, k), (0, k))):
        uv.data[li].uv = (u, v)
    me.materials.append(m)
    o = bpy.data.objects.new('PrevGround', me)
    bpy.context.scene.collection.objects.link(o)
    return o


def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def upscale(path, k=3):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4).repeat(k, 0).repeat(k, 1)
    big = bpy.data.images.new(os.path.basename(path) + '_x', w * k, h * k, alpha=False)
    big.pixels.foreach_set(a.ravel())
    big.filepath_raw = path
    big.file_format = 'PNG'
    big.save()
    bpy.data.images.remove(img)
    bpy.data.images.remove(big)


VIEWS = {
    #  name: (ortho?, yaw deg (0 = looking from the front, + = from the vehicle's left), pitch, dist/scale, target z, lens)
    'front34': (False, 38, 20, 13.0, 1.05, 60),
    'side': (True, 90, 6, 6.6, 1.15, None),
    'rear34': (False, 180 + 38, 20, 13.0, 1.05, 60),
    'front': (True, 0, 6, 5.6, 1.25, None),
    # debug views (not committed)
    'rear': (True, 180, 6, 5.6, 1.25, None),
    'top': (True, 90, 89, 6.6, 1.0, None),
}
DEFAULT_VIEWS = ['front34', 'side', 'rear34', 'front']


def render_previews(SC, body, wheel, axles, markers, MATS, prev_dir, out_dir, T, views=None):
    # wheels at the four markers (left side mirrored, as the game does)
    wheel.hide_render = True
    for mk in markers[:4]:
        w = bpy.data.objects.new('prev_' + mk.name, wheel.data)
        w.location = mk.location
        if mk.location.x < 0:
            w.scale.x = -1
        SC.collection.objects.link(w)
    for m in MATS:
        toonify(m, emissive=m.name in ('LC70_Lamp', 'TailLight'))
    ol = outline_mat()
    bpy.context.view_layer.update()
    for o in [body] + axles + [o for o in SC.objects if o.name.startswith('prev_Marker')]:
        add_outline(o, ol, 0.025 if o is body else 0.02)
    ground(T)
    # warm sun from the front-left, soft warm ambient
    sd = bpy.data.lights.new('PrevSun', 'SUN')
    sd.energy = SUN_POWER
    sd.angle = math.radians(1)
    sd.color = (1.0, 0.97, 0.9)
    sun = bpy.data.objects.new('PrevSun', sd)
    SC.collection.objects.link(sun)
    world = bpy.data.worlds.new('PrevWorld')
    SC.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*lin3((0xe0 / 255, 0xa4 / 255, 0x40 / 255)), 1)
    bg.inputs['Strength'].default_value = 0.55
    try:
        SC.render.engine = 'BLENDER_EEVEE'
    except TypeError as e:
        print('engine', e)
    SC.eevee.taa_render_samples = 16   # filter_size 0 keeps hard pixels; samples only settle the shadows
    try:
        SC.eevee.use_shadows = True
    except Exception:
        pass
    try:
        SC.view_settings.view_transform = 'Standard'
    except TypeError as e:
        print('view transform', e)
    print('LC70 view transform', SC.view_settings.view_transform, SC.display_settings.display_device)
    SC.view_settings.look = 'None'
    SC.render.filter_size = 0.0
    SC.render.resolution_x, SC.render.resolution_y = 480, 300
    SC.render.resolution_percentage = 100
    SC.render.film_transparent = False
    SC.render.image_settings.file_format = 'PNG'

    cd = bpy.data.cameras.new('PrevCam')
    cam = bpy.data.objects.new('PrevCam', cd)
    SC.collection.objects.link(cam)
    SC.camera = cam
    for name in (views or DEFAULT_VIEWS):
        ortho, yaw, pitch, dist, tz, lens = VIEWS[name]
        yr, pr = math.radians(yaw), math.radians(pitch)
        # yaw 0: camera on +Y (in front), yaw 90: camera on -X (vehicle's left side)
        dirv = Vector((-math.sin(yr) * math.cos(pr), math.cos(yr) * math.cos(pr), math.sin(pr)))
        # light like a sprite sheet: from above, over the viewer's left shoulder
        ly = yr + math.radians(SUN_YAW)
        le = math.radians(SUN_ELEV)
        lfrom = Vector((-math.sin(ly) * math.cos(le), math.cos(ly) * math.cos(le), math.sin(le)))
        sun.rotation_euler = (-lfrom).to_track_quat('-Z', 'Y').to_euler()
        target = Vector((0, 0, tz))
        if ortho:
            cd.type = 'ORTHO'
            cd.ortho_scale = dist
            cam.location = target + dirv * 20
        else:
            cd.type = 'PERSP'
            cd.lens = lens
            cam.location = target + dirv * dist
        cd.clip_end = 200
        look_at(cam, target)
        path = os.path.join(prev_dir, 'lc70_%s.png' % name)
        SC.render.filepath = path
        bpy.ops.render.render(write_still=True)
        upscale(path, 3)
        print('LC70 preview', path)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, 'lc70_preview.blend'), compress=True)
