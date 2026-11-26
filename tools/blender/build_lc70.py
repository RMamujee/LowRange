import os
exec(open(os.path.join(os.environ.get('LOWRANGE_TOOLS', os.path.join(os.path.expanduser('~'), 'RockCrawler', 'tools', 'blender')), 'lib.py')).read())

# ---- spec (docs/MODELING_SPEC.md, lc70) ----
R, W = 0.455, 0.30
TRACK, WB = 1.56, 2.73
CHASSIS_Z = 0.855
HW = 0.90                      # half body width
FY, RY = WB / 2, -WB / 2       # front / rear axle y

sc = new_scene('LowRange_lc70')
C = sc.collection

# palette (warm, cozy pixel-art inspired)
cream = mat('lc_cream', hexc('#ece3cc'), 0.55)
cream_dk = mat('lc_cream_shadow', hexc('#d8ccb0'), 0.6)
black = mat('lc_trim', hexc('#2c2a27'), 0.75)
steel = mat('lc_steel', hexc('#55585c'), 0.45, 0.6)
glass = mat('lc_glass', hexc('#334452'), 0.12)
chrome = mat('lc_chrome', hexc('#c9ccce'), 0.25, 0.85)
head = mat('lc_head', hexc('#fff3c8'), 0.2, emit=hexc('#fff0c0'), emit_strength=1.2)
amber = mat('lc_amber', hexc('#f2a23a'), 0.3, emit=hexc('#f2a23a'), emit_strength=0.6)
tail = mat('TailLight', hexc('#8e1d17'), 0.3, emit=hexc('#ff2a1a'), emit_strength=0.3)
tyre = mat('lc_tyre', hexc('#26231f'), 0.95)
rim = mat('lc_rim', hexc('#3f4245'), 0.5, 0.4)
rack = mat('lc_rack', hexc('#232220'), 0.7)

# ---- Body (origin at chassis centre) ----
body = box(C, 'Body', (HW * 2, 4.62, 0.74), (0, 0, 1.0), cream, bevel=0.07, segs=3)   # lower tub z 0.63..1.37
# put the Body origin at the chassis centre before anything is attached
body.data.transform(Matrix.Translation((0, 0, 1.0 - CHASSIS_Z)))
body.location = (0, 0, CHASSIS_Z)
for y in (FY, RY):  # wheel arch cut-outs (clear tyre + bump travel)
    boolean_cut(body, cutter(C, f'cut{y:+.0f}', R + 0.11, 2.4, (0, y, R + 0.05)))

parts = []
def P(o): parts.append(o); return o
# bonnet + front clip
P(box(C, 'hood', (HW * 1.86, 1.40, 0.10), (0, 1.62, 1.39), cream, bevel=0.04))
P(box(C, 'cowl', (HW * 1.92, 0.12, 0.06), (0, 0.90, 1.41), black, bevel=0.02))
# cabin / greenhouse (slight tumblehome)
P(box(C, 'cabin', (HW * 1.88, 3.10, 0.78), (0, -0.70, 1.76), cream, bevel=0.08, segs=3))
P(box(C, 'roof', (HW * 1.84, 3.06, 0.07), (0, -0.70, 2.18), cream_dk, bevel=0.035))
# glass: windscreen, side windows x3, rear
P(box(C, 'wscreen', (HW * 1.66, 0.05, 0.56), (0, 0.86, 1.80), glass, bevel=0.015, rot=(math.radians(-8), 0, 0)))
for sx in (-1, 1):
    for i, (yc, ln) in enumerate(((0.38, 0.78), (-0.55, 0.86), (-1.55, 0.96))):
        P(box(C, f'win{sx}{i}', (0.04, ln, 0.50), (sx * (HW * 0.95 - 0.005), yc, 1.80), glass, bevel=0.012))
        P(box(C, f'pillar{sx}{i}', (0.05, 0.07, 0.56), (sx * (HW * 0.95), yc + ln / 2 + 0.04, 1.80), black, bevel=0.01))
    P(box(C, f'rocker{sx}', (0.10, 2.2, 0.10), (sx * (HW + 0.02), -0.05, 0.62), black, bevel=0.03))         # side step
    P(box(C, f'belt{sx}', (0.02, 4.4, 0.03), (sx * (HW + 0.005), 0, 1.20), cream_dk, bevel=0))              # body crease
    P(box(C, f'mirror{sx}', (0.07, 0.16, 0.18), (sx * (HW + 0.16), 0.78, 1.70), black, bevel=0.02))
    P(box(C, f'mirarm{sx}', (0.16, 0.03, 0.03), (sx * (HW + 0.07), 0.78, 1.66), black, bevel=0))
    P(box(C, f'handle{sx}a', (0.03, 0.14, 0.03), (sx * (HW + 0.01), 0.15, 1.30), black, bevel=0))
    P(box(C, f'handle{sx}b', (0.03, 0.14, 0.03), (sx * (HW + 0.01), -0.85, 1.30), black, bevel=0))
    # wide black fender flares hugging each arch
    for y in (FY, RY):
        P(arch_flare(C, f'flare{sx}{y:+.0f}', sx * (HW - 0.02), y, R + 0.05, R + 0.11, R + 0.24, 0.12, black, side=sx))
P(box(C, 'rearwin', (HW * 1.6, 0.04, 0.46), (0, -2.27, 1.82), glass, bevel=0.012))
P(box(C, 'barnseam', (0.03, 0.03, 0.9), (0, -2.32, 1.30), black, bevel=0))
# front: generic slatted grille, round headlights in square bezels, indicators
P(box(C, 'grille', (HW * 1.10, 0.06, 0.40), (0, 2.33, 1.12), black, bevel=0.02))
for i in range(5):
    P(box(C, f'slat{i}', (HW * 1.02, 0.03, 0.035), (0, 2.37, 0.98 + i * 0.07), chrome, bevel=0))
for sx in (-1, 1):
    P(box(C, f'bezel{sx}', (0.30, 0.06, 0.30), (sx * 0.66, 2.33, 1.13), black, bevel=0.03))
    P(cyl(C, f'lamp{sx}', 0.115, 0.05, (sx * 0.66, 2.37, 1.13), head, axis='Y', segs=14))
    P(cyl(C, f'lampring{sx}', 0.13, 0.03, (sx * 0.66, 2.355, 1.13), chrome, axis='Y', segs=14))
    P(box(C, f'ind{sx}', (0.16, 0.04, 0.07), (sx * 0.66, 2.36, 0.93), amber, bevel=0.01))
    P(box(C, f'tail{sx}', (0.12, 0.05, 0.26), (sx * (HW - 0.1), -2.32, 1.18), tail, bevel=0.015))
# steel bumpers + tow points
P(box(C, 'bumperF', (HW * 2.06, 0.22, 0.24), (0, 2.42, 0.78), black, bevel=0.04))
P(box(C, 'bumperR', (HW * 2.02, 0.20, 0.20), (0, -2.40, 0.74), black, bevel=0.04))
for sx in (-1, 1):
    P(box(C, f'hook{sx}', (0.08, 0.10, 0.08), (sx * 0.5, 2.55, 0.74), mat('lc_red', hexc('#c0392b'), 0.5), bevel=0.01))
# rear spare on the barn door
sp = build_wheel(C, R * 0.92, W * 0.9, tyre, rim, steel, name='Spare')
sp.location = (0.32, -2.50, 1.28); sp.rotation_euler = (0, 0, math.pi / 2)
P(sp)
# roof rack basket
for sx in (-1, 1):
    P(box(C, f'rackrail{sx}', (0.05, 2.7, 0.05), (sx * (HW * 0.86), -0.70, 2.36), rack, bevel=0.01))
    for yy in (0.6, -0.7, -2.0):
        P(box(C, f'rackleg{sx}{yy}', (0.05, 0.05, 0.16), (sx * (HW * 0.86), yy, 2.26), rack, bevel=0))
for yy in (0.62, -0.05, -0.7, -1.35, -2.02):
    P(box(C, f'rackbar{yy}', (HW * 1.72, 0.04, 0.04), (0, yy, 2.31), rack, bevel=0))
P(box(C, 'cargo1', (0.55, 0.45, 0.28), (-0.30, -1.20, 2.47), mat('lc_canvas', hexc('#8a7350'), 0.9), bevel=0.05))
P(cyl(C, 'cargo2', 0.13, 0.85, (0.35, -0.40, 2.45), mat('lc_swag', hexc('#5f7d3e'), 0.9), axis='X', segs=12, bevel=0.03))
# frame rails + skid under the body
for sx in (-1, 1):
    P(box(C, f'rail{sx}', (0.12, 4.0, 0.16), (sx * 0.52, 0, 0.62), steel, bevel=0.01))

for o in parts:
    parent_keep(o, body)


# ---- Wheel (one), axles, markers ----
wheel = build_wheel(C, R, W, tyre, rim, steel, name='Wheel')
wheel.location = (-TRACK / 2, FY, R)   # parked at FL for the preview
for nm, y in (('AxleFront', FY), ('AxleRear', RY)):
    ax = cyl(C, nm, 0.065, TRACK * 0.88, (0, y, R), steel, axis='X', segs=12)
    pump = sphere(C, nm + '_diff', 0.15, (0.12, y, R), steel, scale=(1, 0.85, 1))
    parent_keep(pump, ax)
for nm, x, y in (('Marker_WheelFL', -1, FY), ('Marker_WheelFR', 1, FY), ('Marker_WheelRL', -1, RY), ('Marker_WheelRR', 1, RY)):
    empty(C, nm, (x * TRACK / 2, y, R))
empty(C, 'Marker_Ground', (0, 0, 0))
# preview copies of the other three wheels (not exported)
for i, (x, y) in enumerate(((1, FY), (-1, RY), (1, RY))):
    cp = wheel.copy(); cp.data = wheel.data; C.objects.link(cp)
    cp.location = (x * TRACK / 2, y, R); cp['preview_only'] = True
    for ch in wheel.children:
        c2 = ch.copy(); C.objects.link(c2); c2.parent = cp; c2['preview_only'] = True

setup_preview(sc, target=(0, 0, 1.0), dist=9.5, yaw_deg=35, pitch_deg=12)
print('built', len(sc.objects), 'objects')
