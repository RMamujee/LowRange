# Re-import check for public/models/vehicles/lc70.glb in a fresh headless Blender:
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup --python tools/blender/lc70_check.py
# Reads the raw glTF JSON (node names, translations in glTF axes, extras, materials, image sizes) and
# imports the file to count triangles and measure bounds. Exits non-zero if a contract item fails.
import os
import sys
import json
import struct
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'public', 'models', 'vehicles', 'lc70.glb')
fails = []


def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok:
        fails.append(msg)


# ---------------------------------------------------------------- raw glTF JSON
with open(GLB, 'rb') as fh:
    data = fh.read()
magic, ver, length = struct.unpack_from('<III', data, 0)
clen, ctype = struct.unpack_from('<II', data, 12)
gj = json.loads(data[20:20 + clen])
bin_off = 20 + clen + 8
nodes = {n.get('name'): n for n in gj['nodes']}
print('glTF nodes:', sorted(nodes))
for name in ('Body', 'Wheel', 'AxleFront', 'AxleRear', 'Marker_WheelFL', 'Marker_WheelFR', 'Marker_WheelRL',
             'Marker_WheelRR', 'Marker_Ground'):
    check(name in nodes, 'node %s present' % name)
T = {k: nodes[k].get('translation', [0, 0, 0]) for k in nodes}
for k in sorted(T):
    print('   %-16s translation (glTF, Y up, -Z fwd) = (%.3f, %.3f, %.3f)%s' % (
        k, *T[k], '  rot ' + str(nodes[k]['rotation']) if 'rotation' in nodes[k] else ''))
fl, fr, rl, rr, g = (T['Marker_WheelFL'], T['Marker_WheelFR'], T['Marker_WheelRL'], T['Marker_WheelRR'], T['Marker_Ground'])
check(fl[2] < rl[2], 'front wheels are toward -Z (forward)')
check(fl[0] < 0 < fr[0], 'left wheels at -X, right at +X')
track = fr[0] - fl[0]
wb = rl[2] - fl[2]
ride = fl[1] - g[1]
print('   track %.3f  wheelbase %.3f  hub height %.3f  chassis centre %.3f' % (track, wb, ride, T['Body'][1] - g[1]))
check(abs(track - 1.56) < 1e-3 and abs(wb - 2.73) < 1e-3, 'track 1.56 / wheelbase 2.73')
ex = gj['nodes'][[n.get('name') for n in gj['nodes']].index('Wheel')].get('extras', {})
print('   Wheel extras', ex)
check(abs(ex.get('tyre_radius', 0) - 0.455) < 1e-6 and abs(ex.get('tyre_width', 0) - 0.30) < 1e-6, 'tyre_radius / tyre_width extras')
check(abs(ride - ex.get('tyre_radius', 0)) < 1e-3, 'hub height == tyre radius (tyres touch Marker_Ground)')
for k in ('Body', 'Wheel', 'AxleFront', 'AxleRear'):
    check('rotation' not in nodes[k] and 'scale' not in nodes[k], '%s has identity rotation/scale' % k)
mats = [m['name'] for m in gj['materials']]
print('   materials', mats)
check('TailLight' in mats, 'TailLight material present')
for m in gj['materials']:
    pbr = m.get('pbrMetallicRoughness', {})
    print('   %-11s baseTex=%s metallic=%s rough=%s emissiveTex=%s' % (
        m['name'], 'baseColorTexture' in pbr, pbr.get('metallicFactor', 1), pbr.get('roughnessFactor', 1), 'emissiveTexture' in m))
    check('baseColorTexture' in pbr, '%s has a base-colour texture' % m['name'])
for s in gj.get('samplers', []):
    check(s.get('magFilter') == 9728, 'sampler magFilter NEAREST (%s)' % s)
for im in gj['images']:
    bv = gj['bufferViews'][im['bufferView']]
    png = data[bin_off + bv.get('byteOffset', 0): bin_off + bv.get('byteOffset', 0) + bv['byteLength']]
    w, h = struct.unpack('>II', png[16:24])
    print('   image %-11s %dx%d %s' % (im.get('name'), w, h, im['mimeType']))
check(not any('outline' in (n.get('name') or '').lower() for n in gj['nodes']), 'no outline shells exported')

# ---------------------------------------------------------------- import and measure
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
sc = bpy.context.scene
budget = {'Body': 15000, 'Wheel': 1500, 'AxleFront': 800, 'AxleRear': 800}
for o in sc.objects:
    if o.type != 'MESH':
        continue
    me = o.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    top = o.name
    while sc.objects[top].parent is not None:
        top = sc.objects[top].parent.name
    print('   mesh %-10s (node %-9s) tris %5d  bounds x %.3f..%.3f y %.3f..%.3f z %.3f..%.3f  mats %s' % (
        o.name, top, tris, lo.x, hi.x, lo.y, hi.y, lo.z, hi.z, [m.name for m in me.materials]))
    if top in budget:
        check(tris <= budget[top], '%s triangles %d <= %d' % (top, tris, budget[top]))
    if top == 'Body':
        print('   Body envelope L %.3f  W %.3f  roof/rack top %.3f  belly %.3f' % (hi.y - lo.y, hi.x - lo.x, hi.z, lo.z))
        check(lo.z >= 0.529, 'Body belly >= frame bottom 0.53')
        check(lo.y > -2.46 and hi.y < 2.46, 'Body length within ~4.90 m')
for e in [o for o in sc.objects if o.name.startswith('Marker')]:
    print('   %-16s blender loc (%.3f, %.3f, %.3f)' % (e.name, *e.matrix_world.translation))
print('LC70 CHECK', 'PASSED' if not fails else 'FAILED: %s' % fails)
sys.exit(1 if fails else 0)
