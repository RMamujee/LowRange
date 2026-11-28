# How stale is a world .blend? Compare an open world_<map>.blend with a fresh export of the game.
#
#   node tools/export/export_world.mjs <map>
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup <world_map.blend> ^
#       --python tools/blender/world/compare_world.py -- <map>
#
# Read-only: opens nothing for writing and never saves. Prints, against the export: terrain heights at
# every vertex of the .blend's terrain, the gameplay surface under each face, paths (by name: points,
# length, how far the centreline moved), gameplay rocks (matched by position), prop placements per
# model and scatter counts, sign / gate groups, and the named gameplay points.
import json
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
MAP = next((a for a in ARGS if not a.startswith('-')), 'park')
EXP = os.path.join(HERE, 'export', MAP)
W = json.load(open(os.path.join(EXP, 'world.json'), encoding='utf-8'))
SIZE, RES = W['map']['size'], W['map']['res']
N1, CELL = RES + 1, W['map']['size'] / W['map']['res']
VIS = np.fromfile(os.path.join(EXP, 'grid_vis.f32'), dtype=np.float32).reshape(N1, N1)
MATG = np.fromfile(os.path.join(EXP, 'grid_mat.u8'), dtype=np.uint8).reshape(N1, N1) if os.path.exists(os.path.join(EXP, 'grid_mat.u8')) else None
OUT = []


def say(*a):
    s = ' '.join(str(x) for x in a)
    OUT.append(s)
    print(s, flush=True)


def bil(x, z):
    fx = np.clip((np.asarray(x, np.float64) + SIZE / 2) / CELL, 0, RES - 1e-6)
    fz = np.clip((np.asarray(z, np.float64) + SIZE / 2) / CELL, 0, RES - 1e-6)
    ix, iz = fx.astype(np.int64), fz.astype(np.int64)
    tx, tz = fx - ix, fz - iz
    return VIS[ix, iz] * (1 - tx) * (1 - tz) + VIS[ix + 1, iz] * tx * (1 - tz) + VIS[ix, iz + 1] * (1 - tx) * tz + VIS[ix + 1, iz + 1] * tx * tz


say(f'== {bpy.data.filepath and os.path.basename(bpy.data.filepath)} vs fresh export of {W["map"]["name"]} ({MAP})')

# ---- terrain ----
t = bpy.data.objects.get('Terrain')
if t:
    me = t.data
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    d = co[:, 2] - bil(co[:, 0], -co[:, 1])
    a = np.abs(d)
    say(f'terrain: {len(co)} vertices; height change max {a.max():.2f} m, mean {a.mean():.3f} m; '
        f'{(a > 0.02).mean() * 100:.1f}% moved > 2 cm, {(a > 0.1).mean() * 100:.1f}% > 10 cm, {(a > 0.5).mean() * 100:.1f}% > 0.5 m, {(a > 2).mean() * 100:.2f}% > 2 m')
    if (a > 0.5).any():
        k = np.argsort(-a)[:5]
        say('  biggest changes (x, z three.js; old -> new):', '; '.join(f'({co[i, 0]:.0f}, {-co[i, 1]:.0f}) {co[i, 2]:.2f} -> {co[i, 2] - d[i]:.2f}' for i in k))
    if MATG is not None and 'surface' in me.attributes:
        fs = np.empty(len(me.polygons), np.int32); me.attributes['surface'].data.foreach_get('value', fs)
        fc = np.empty(len(me.polygons) * 3, np.float32); me.polygons.foreach_get('center', fc); fc = fc.reshape(-1, 3)
        # the old builder stored the gameplay surface of the face's first vertex
        ix = np.clip(np.round((fc[:, 0] + SIZE / 2) / CELL - 0.25), 0, RES).astype(int)
        iz = np.clip(np.round((-fc[:, 1] + SIZE / 2) / CELL - 0.25), 0, RES).astype(int)
        new = MATG[ix, iz]
        ch = fs != new
        names = [m['name'] for m in W['materials']]
        pairs = {}
        for o_, n_ in zip(fs[ch], new[ch]):
            pairs[(o_, n_)] = pairs.get((o_, n_), 0) + 1
        top = sorted(pairs.items(), key=lambda kv: -kv[1])[:6]
        say(f'surface: {ch.mean() * 100:.1f}% of faces changed gameplay surface;', ', '.join(f'{names[o_]}->{names[n_]} {c}' for (o_, n_), c in top))
else:
    say('terrain: none in the file')

# ---- paths ----
curves = {o.name: o for o in bpy.data.objects if o.type == 'CURVE'}
by_name = {}
for o in curves.values():
    nm = o.name.split(' ', 1)[1] if ' ' in o.name else o.name
    by_name[nm] = o
seen = set()
for p in W['paths']:
    o = by_name.get(p['name'])
    if not o:
        say(f'path NEW: {p["kind"]} {p["name"]} ({p["length"]:.0f} m)')
        continue
    seen.add(p['name'])
    pts = np.array([tuple(q.co)[:3] for q in o.data.splines[0].points])
    oldL = float(np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1).sum())
    new = np.array([(x, -z, y + 0.25) for x, y, z in p['pts']])
    newL = float(np.linalg.norm(np.diff(new[:, :2], axis=0), axis=1).sum())
    # how far the old centreline is from the new one (plan view and height)
    step = max(1, len(pts) // 400)
    dd, dz = [], []
    for q in pts[::step]:
        k = np.argmin(((new[:, :2] - q[:2]) ** 2).sum(1))
        dd.append(math.hypot(*(new[k, :2] - q[:2]))); dz.append(abs(new[k, 2] - q[2]))
    say(f'path {p["name"]}: {len(pts)} -> {len(new)} points, length {oldL:.0f} -> {newL:.0f} m, centreline moved max {max(dd):.2f} m, height max {max(dz):.2f} m')
for nm in by_name:
    if nm not in seen and nm not in {p['name'] for p in W['paths']}:
        say(f'path GONE: {nm}')

# ---- rocks ----
rocks = [o for o in bpy.data.objects if o.type == 'MESH' and (o.name.startswith('Rock ') or o.name.startswith('Ledge ') or o.name.startswith('Embedded rock '))]
old = np.array([(o.location.x, o.location.y, o.location.z) for o in rocks]) if rocks else np.zeros((0, 3))
new = np.array([(r['x'], -r['z'], r['y']) for r in W['rocks']])
matched = moved = 0
if len(old) and len(new):
    used = np.zeros(len(new), bool)
    for q in old:
        dd = np.linalg.norm(new - q, axis=1)
        k = int(np.argmin(dd))
        if dd[k] < 0.05 and not used[k]:
            matched += 1; used[k] = True
        elif dd[k] < 1.0 and not used[k]:
            moved += 1; used[k] = True
    say(f'rocks: {len(old)} -> {len(new)}; {matched} unchanged in place, {moved} moved under 1 m, {len(old) - matched - moved} removed / moved further, {int((~used).sum())} new')
    led_o = sum(1 for o in rocks if o.name.startswith('Ledge')); led_n = sum(1 for r in W['rocks'] if r['ledge'])
    emb_n = sum(1 for r in W['rocks'] if r.get('embedded'))
    say(f'  ledges {led_o} -> {led_n}; embedded relief rocks (new kind) {emb_n}')

# ---- props: collection instances per model, scatter counts ----
inst = {}
for o in bpy.data.objects:
    if o.instance_type == 'COLLECTION' and o.instance_collection and o.instance_collection.name.startswith('PROP '):
        k = o.instance_collection.name[5:]
        inst[k] = inst.get(k, 0) + 1
    elif o.get('instances') is not None:
        k = 'scatter: ' + o.name
        inst[k] = inst.get(k, 0) + int(o['instances'])
newc = {}
for s in ('dressing', 'markers', 'structures'):
    for a in W[s]['assets'].values():
        k = a['asset'] if not a['asset'].startswith('grass_tuft') else f'scatter: Grass tufts {a["asset"][-1].upper()}'
        newc[k] = newc.get(k, 0) + a['items']['n']
diffs = []
for k in sorted(set(inst) | set(newc)):
    if k.startswith('scatter:') and k not in newc and not k.startswith('scatter: Grass'):
        continue   # procedural scatter: compared below by kind
    o_, n_ = inst.get(k, 0), newc.get(k, 0)
    if o_ != n_:
        diffs.append(f'{k} {o_}->{n_}')
say('prop placements per model:', ', '.join(diffs) if diffs else 'all unchanged in count')
proc_old = {k[9:]: v for k, v in inst.items() if k.startswith('scatter:') and not k.startswith('scatter: Grass')}
proc_new = {}
for s in ('dressing', 'markers'):
    for r in W[s]['meshes']:
        if r['items']['n'] >= 8:
            proc_new[r['name']] = proc_new.get(r['name'], 0) + r['items']['n']
say('procedural scatter (old object: instances):', ', '.join(f'{k} {v}' for k, v in sorted(proc_old.items())) or 'none')
say('procedural scatter (new, by part):', ', '.join(f'{k} {v}' for k, v in sorted(proc_new.items())) or 'none')

# ---- signs, gates, points ----
old_groups = sorted(o.name for o in bpy.data.objects if o.type == 'EMPTY' and (o.name.startswith('Sign') or o.name.startswith('Gate') or o.name.startswith('Arch') or o.name.startswith('Start-finish') or o.name.startswith('Grandstand')) and o.children)
new_groups = sorted(g['name'] for s in ('markers', 'dressing') for g in W[s]['groups'].values())
say(f'sign / gate / stand groups: {len(old_groups)} -> {len(new_groups)}')
txt = [o for o in bpy.data.objects if o.type == 'FONT']
say(f'  old sign text: {len(txt)} text objects (Blender font); new: the game\'s pixel-font faces as textures ({sum(1 for m in W["mats"] if m.get("sign"))} faces)')
gp = bpy.data.collections.get('Gameplay points')
old_pts = {o.name: o.location for o in gp.objects} if gp else {}
say(f'gameplay points: {len(old_pts)} -> {len([p for p in W["points"] if p["kind"] != "spawn-point"])} (+ {len([p for p in W["points"] if p["kind"] == "spawn-point"])} spawn points, new)')
for p in W['points']:
    nm = p['name']
    cand = old_pts.get(nm) or old_pts.get(nm.replace(' gate', ' point')) or old_pts.get(nm.replace('Checkpoint', 'Checkpoint').replace(' (start-finish)', ' point (start-finish)')) or old_pts.get(nm + ' point')
    if cand is not None:
        lift = 4 if p['kind'] in ('trail-end',) else 0
        dpl = math.hypot(cand.x - p['x'], cand.y + p['z'])
        dh = abs(cand.z - lift - p['y'])
        if dpl > 0.05 or dh > 0.05:
            say(f'  {nm}: moved {dpl:.2f} m in plan, {dh:.2f} m in height')
fog = bpy.data.node_groups.get('LowRange Toon')
say(f'look: old file sky/fog = golden haze; game now: sky {W["look"]["sky"]}, haze {W["look"]["fog"]} capped at {W["look"]["fogMax"]}, fog {W["look"]["fogNear"]:.0f}..{W["look"]["fogFar"]:.0f} m')
rep = os.environ.get('LR_REPORT')
if rep:
    with open(rep, 'w', encoding='utf-8') as f:
        f.write('\n'.join(OUT) + '\n')
