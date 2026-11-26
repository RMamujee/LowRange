# Re-imports every exported prop .glb in a fresh scene and reports origin, size, orientation,
# triangle count and material/texture setup.
#   blender --background --factory-startup --python tools/blender/check_props.py
import os
import glob
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
for path in sorted(glob.glob(os.path.join(ROOT, 'public', 'models', '*.glb'))):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    tris, lo, hi, mats = 0, Vector((1e9,) * 3), Vector((-1e9,) * 3), set()
    for o in meshes:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
        for m in o.data.materials:
            tex = next((n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE'), None)
            mats.add('%s[%s %dx%d %s, culled=%s]' % (m.name, tex.image.name if tex else '-', *(tex.image.size if tex else (0, 0)),
                                                     tex.interpolation if tex else '-', m.use_backface_culling))
    ctr = (lo + hi) / 2
    print('CHECK %-16s meshes=%d tris=%4d  size(x,y,z)=(%.2f, %.2f, %.2f)  base_z=%.2f  centre_xy=(%.2f, %.2f)  %s' % (
        os.path.basename(path)[:-4], len(meshes), tris, *(hi - lo), lo.z, ctr.x, ctr.y, ' '.join(sorted(mats))))
