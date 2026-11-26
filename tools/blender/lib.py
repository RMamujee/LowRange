# Shared helpers for building LowRange vehicles in Blender via the add-on socket.
# Blender axes: +X right, +Y forward, +Z up (exports as glTF -Z forward, +Y up).
import bpy, bmesh, math
from mathutils import Vector, Matrix

def new_scene(name):
    if name in bpy.data.scenes:
        old = bpy.data.scenes[name]
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.scenes.remove(old)
    sc = bpy.data.scenes.new(name)
    bpy.context.window.scene = sc
    return sc

def mat(name, rgb, rough=0.6, metal=0.0, emit=None, emit_strength=1.5):
    old = bpy.data.materials.get(name)
    if old: bpy.data.materials.remove(old)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m['base_rgb'] = list(rgb); m['emit_rgb'] = list(emit) if emit else [0, 0, 0]; m['emit_str'] = emit_strength if emit else 0; m['rough'] = rough
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = emit_strength
    return m

def hexc(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    # sRGB -> linear
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def _obj(name, bm, m, coll):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me)
    if m: me.materials.append(m)
    coll.objects.link(o)
    return o

def box(coll, name, size, loc, m, bevel=0.04, segs=2, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    o = _obj(name, bm, m, coll)
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        md = o.modifiers.new('bevel', 'BEVEL'); md.width = bevel; md.segments = segs; md.limit_method = 'ANGLE'
    return o

def cyl(coll, name, r, depth, loc, m, axis='X', segs=16, bevel=0.0, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=(r if r2 is None else r2), depth=depth)
    o = _obj(name, bm, m, coll)
    o.location = loc
    if axis == 'X': o.rotation_euler = (0, math.pi / 2, 0)
    elif axis == 'Y': o.rotation_euler = (math.pi / 2, 0, 0)
    if bevel > 0:
        md = o.modifiers.new('bevel', 'BEVEL'); md.width = bevel; md.segments = 2; md.limit_method = 'ANGLE'
    return o

def sphere(coll, name, r, loc, m, scale=(1, 1, 1), segs=12):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=max(6, segs // 2), radius=r)
    o = _obj(name, bm, m, coll)
    o.location = loc; o.scale = scale
    return o

def _world(o):
    # world matrix from transforms (doesn't need a depsgraph update)
    m = o.matrix_basis.copy()
    p = o.parent
    while p is not None:
        m = p.matrix_basis @ p.matrix_parent_inverse @ m if False else _world(p) @ o.matrix_parent_inverse @ o.matrix_basis
        break
    return m

def parent_keep(child, parent):
    cw = _world(child)
    pw = _world(parent)
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_basis = pw.inverted() @ cw

def empty(coll, name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'; e.empty_display_size = 0.2
    e.location = loc
    coll.objects.link(e)
    return e

def cutter(coll, name, r, depth, loc):
    c = cyl(coll, name, r, depth, loc, None, axis='X', segs=24)
    c.display_type = 'WIRE'; c.hide_render = True
    c['cutter'] = True
    return c

def boolean_cut(obj, cutter_obj):
    md = obj.modifiers.new('cut_' + cutter_obj.name, 'BOOLEAN')
    md.operation = 'DIFFERENCE'; md.object = cutter_obj; md.solver = 'EXACT'
    # booleans before bevels
    obj.modifiers.move(len(obj.modifiers) - 1, 0)

def build_wheel(coll, R, W, tyre_m, rim_m, cap_m, lug=1.0, name='Wheel'):
    """Chunky lugged off-road wheel, spin axis X, origin at hub."""
    core = cyl(coll, name, R * 0.9, W * 0.92, (0, 0, 0), tyre_m, axis='X', segs=20, bevel=W * 0.22)
    n = 14
    for i in range(n):
        a = i / n * math.pi * 2
        for side in (-1, 1):
            off = 0.02 if (i % 2) else -0.02
            b = box(coll, f'{name}_lug{i}{side}', (W * 0.44, R * 0.24 * lug, R * 0.13 * lug), (0, 0, 0), tyre_m, bevel=0.012, segs=1)
            b.location = (side * W * 0.23 + off * side, math.sin(a) * R * 0.92, math.cos(a) * R * 0.92)
            b.rotation_euler = (-a, 0, 0)
            parent_keep(b, core)
    rim = cyl(coll, f'{name}_rim', R * 0.56, W * 0.96, (0, 0, 0), rim_m, axis='X', segs=16, bevel=0.015)
    parent_keep(rim, core)
    hub = cyl(coll, f'{name}_cap', R * 0.16, W * 1.02, (0, 0, 0), cap_m, axis='X', segs=10)
    parent_keep(hub, core)
    for i in range(6):  # lug nut / spoke dimples
        a = i / 6 * math.pi * 2
        s = cyl(coll, f'{name}_nut{i}', R * 0.035, W * 1.0, (0, math.sin(a) * R * 0.3, math.cos(a) * R * 0.3), cap_m, axis='X', segs=6)
        parent_keep(s, core)
    core['tyre_radius'] = R
    core['tyre_width'] = W
    return core

def setup_preview(sc, target=(0, 0, 0.9), dist=8.0, yaw_deg=35, pitch_deg=14, res=(1280, 800)):
    cam_data = bpy.data.cameras.new('PrevCam'); cam_data.lens = 50
    cam = bpy.data.objects.new('PrevCam', cam_data)
    sc.collection.objects.link(cam)
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    pos = Vector(target) + Vector((math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch))) * dist
    cam.location = pos
    direction = Vector(target) - pos
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sun_d = bpy.data.lights.new('PrevSun', 'SUN'); sun_d.energy = 4.0; sun_d.color = (1.0, 0.92, 0.78)
    sun = bpy.data.objects.new('PrevSun', sun_d); sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(140))
    sc.collection.objects.link(sun)
    world = bpy.data.worlds.get('PrevWorld') or bpy.data.worlds.new('PrevWorld')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (*hexc('#e9c98a'), 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    sc.world = world
    # ground plane in warm ochre dirt
    g = box(sc.collection, 'PrevGround', (30, 30, 0.02), (0, 0, -0.01), mat('PrevDirt', hexc('#d9a441'), 1.0), bevel=0)
    g['preview_only'] = True
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            sc.render.engine = eng; break
        except Exception:
            continue
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.film_transparent = False
    return cam

def render_to(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)

def export_glb(sc, path):
    # hide preview helpers and boolean cutters from the export
    keep = []
    for o in sc.objects:
        skip = o.get('preview_only') or o.get('cutter') or o.type in ('CAMERA', 'LIGHT')
        o.select_set(not skip)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_extras=True, export_yup=True)

def arch_flare(coll, name, cx, cy, cz, r_in, r_out, depth, m, a0=-1.75, a1=1.75, segs=14, side=1):
    """Smooth wheel-arch flare: a thick curved band around (cy, cz) in the YZ plane, extruded along X."""
    bm = bmesh.new()
    rings = []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * i / segs
        sy, cz_ = math.sin(a), math.cos(a)
        ring = []
        for (r, x) in ((r_in, 0), (r_out, 0), (r_out, depth * side), (r_in * 1.02, depth * side * 0.6)):
            ring.append(bm.verts.new((cx + x, cy + sy * r, cz + cz_ * r)))
        rings.append(ring)
    for i in range(segs):
        a, b = rings[i], rings[i + 1]
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new((a[k], a[k2], b[k2], b[k]))
    bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = _obj(name, bm, m, coll)
    md = o.modifiers.new('bevel', 'BEVEL'); md.width = 0.015; md.segments = 1; md.limit_method = 'ANGLE'
    return o
