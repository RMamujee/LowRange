# Re-import check for public/models/vehicles/wrx.glb in a fresh headless Blender:
#   blender --background --factory-startup --python tools/blender/wrx_verify.py
# Checks names, markers, Wheel extras, orientation (front at glTF -Z), budgets, materials and textures
# against docs/MODELING_SPEC.md. Exits non-zero on any failure.
import json
import os
import struct
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(HERE, '..', '..', 'public', 'models', 'vehicles', 'wrx.glb')
fails = []


def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok:
        fails.append(msg)


# ---- raw glTF JSON (what three.js sees)
with open(GLB, 'rb') as f:
    data = f.read()
magic, ver, length = struct.unpack_from('<4sII', data, 0)
clen, ctype = struct.unpack_from('<I4s', data, 12)
gl = json.loads(data[20:20 + clen])
nodes = {n.get('name'): n for n in gl['nodes']}
print('[verify] glTF nodes:', sorted(nodes))
for nm in ('Body', 'Wheel', 'Marker_WheelFL', 'Marker_WheelFR', 'Marker_WheelRL', 'Marker_WheelRR', 'Marker_Ground'):
    check(nm in nodes, f'node {nm} present')
check(not any(n in nodes for n in ('AxleFront', 'AxleRear')), 'no axle nodes (independent suspension)')
ex = nodes['Wheel'].get('extras', {})
check(abs(ex.get('tyre_radius', 0) - 0.33) < 1e-6 and abs(ex.get('tyre_width', 0) - 0.21) < 1e-6,
      f'Wheel extras tyre_radius/tyre_width = {ex}')
T = {k: nodes[k].get('translation', [0, 0, 0]) for k in nodes}
print('[verify] translations (glTF, Y up):', {k: [round(c, 3) for c in v] for k, v in T.items()})
fl, fr, rl, rr, g = (T['Marker_WheelFL'], T['Marker_WheelFR'], T['Marker_WheelRL'], T['Marker_WheelRR'], T['Marker_Ground'])
check(fl[2] < rl[2], 'front wheels at -Z (vehicle faces -Z)')
check(fr[0] > 0 > fl[0], 'right side at +X')
print(f'[verify] track {fr[0] - fl[0]:.3f}  wheelbase {rl[2] - fl[2]:.3f}  hub height {fl[1] - g[1]:.3f}  '
      f'Body origin height {T["Body"][1] - g[1]:.3f}')
mats = [m['name'] for m in gl['materials']]
print('[verify] materials:', mats)
check('TailLight' in mats, 'TailLight material present')
samplers = gl.get('samplers', [])
check(samplers and all(s.get('magFilter') == 9728 for s in samplers), f'nearest-neighbour samplers {samplers}')
print('[verify] images:', [(i.get('name'), i.get('mimeType')) for i in gl.get('images', [])])

# ---- Blender import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
obs = {o.name: o for o in bpy.context.scene.objects}
body, wheel = obs['Body'], obs['Wheel']


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


check(tris(body) <= 15000, f'Body triangles {tris(body)} <= 15000')
check(tris(wheel) <= 1500, f'Wheel triangles {tris(wheel)} <= 1500')
check(abs(wheel.get('tyre_radius', 0) - 0.33) < 1e-6, f'Wheel custom prop tyre_radius after import = {wheel.get("tyre_radius")}')
bpy.context.view_layer.update()
vs = [body.matrix_world @ v.co for v in body.data.vertices]
mn = [min(v[i] for v in vs) for i in range(3)]
mx = [max(v[i] for v in vs) for i in range(3)]
print(f'[verify] Body bounds (Blender, Z up): x {mn[0]:.3f}..{mx[0]:.3f}  y {mn[1]:.3f}..{mx[1]:.3f}  z {mn[2]:.3f}..{mx[2]:.3f}')
check(mx[1] > -mn[1] - 0.3, 'Body front (bumper with lamps) is towards +Y in Blender / -Z in glTF')
print(f'[verify] Body origin {tuple(round(c, 3) for c in body.location)}  Wheel origin {tuple(round(c, 3) for c in wheel.location)}')
wv = [wheel.matrix_world @ v.co - wheel.location for v in wheel.data.vertices]
wr = max((v[1] ** 2 + v[2] ** 2) ** 0.5 for v in wv)
ww = max(v[0] for v in wv) - min(v[0] for v in wv)
check(abs(wr - 0.33) < 0.005 and abs(ww - 0.21) < 0.01, f'Wheel geometry radius {wr:.3f} width {ww:.3f} (spin axis X)')
for o in (body, wheel):
    for m in o.data.materials:
        tex = [n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']
        print(f'[verify] {o.name}/{m.name}: image {tex[0].image.size[:] if tex else None} interp {tex[0].interpolation if tex else None}')
print('[verify]', 'ALL OK' if not fails else f'{len(fails)} FAILURE(S)')
sys.exit(1 if fails else 0)
