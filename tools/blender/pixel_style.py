import os
# Pixel-art treatment: pixel textures (UV cube-projected at fixed texel density),
# stepped toon lighting with warm shadows, inverted-hull dark outlines, chunky-pixel viewport.
import bpy, bmesh, random, math
from mathutils import Vector

SC = bpy.data.scenes['LowRange_lc70']
TEXEL = 20.0            # texture pixels per metre (chunky, like the reference)
TILE = 16               # texture tile size in pixels
OUTLINE = (0.16, 0.10, 0.07)

def lin(c): return c ** 2.2

def srgb_hex(h):
    h = h.lstrip('#'); return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]

def pixel_image(name, rgb_lin, seed, contrast=0.035, speck=0.05):
    """16x16 tile: base colour + dithered lighter/darker pixels, like hand-placed pixel shading."""
    img = bpy.data.images.get(name)
    if img: bpy.data.images.remove(img)
    img = bpy.data.images.new(name, TILE, TILE, alpha=False)
    rnd = random.Random(seed)
    base = [c ** (1 / 2.2) for c in rgb_lin]  # work in sRGB-ish
    px = []
    for y in range(TILE):
        for x in range(TILE):
            v = 0.0
            r = rnd.random()
            if r < speck: v = contrast * 1.6          # highlight speck
            elif r < speck * 2.2: v = -contrast * 1.3  # dark speck
            elif (x + y) % 2 == 0 and rnd.random() < 0.25: v = contrast * 0.5  # soft dither
            c = [min(1, max(0, b + v)) for b in base]
            px += [lin(c[0]), lin(c[1]), lin(c[2]), 1.0]
    img.pixels = px
    img.update()

    return img

def toon_material(m, seed):
    """Rebuild a material as: pixel texture * stepped diffuse light (warm shadows) [+ emission for lamps]."""
    nt = m.node_tree
    old = nt.nodes.get('Principled BSDF')
    base = list(m.get('base_rgb', [0.5, 0.5, 0.5]))
    emis = list(m.get('emit_rgb', [0, 0, 0]))
    estr = m.get('emit_str', 0)
    rough = m.get('rough', 0.6)
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); out.location = (900, 0)
    uv = nt.nodes.new('ShaderNodeTexCoord'); uv.location = (-900, 0)
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.location = (-650, 0)
    tex.image = pixel_image('px_' + m.name, base, seed, contrast=0.025 if rough < 0.3 else (0.06 if 'Dirt' in m.name else 0.035), speck=0.09 if 'Dirt' in m.name else 0.05)
    tex.interpolation = 'Closest'
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    if estr > 0.5:   # lamps: flat bright
        em = nt.nodes.new('ShaderNodeEmission'); em.location = (500, 0)
        em.inputs['Color'].default_value = (*emis, 1); em.inputs['Strength'].default_value = 1.0
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        return
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse'); diff.location = (-400, -200)
    s2r = nt.nodes.new('ShaderNodeShaderToRGB'); s2r.location = (-200, -200)
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.location = (0, -200)
    cr = ramp.color_ramp; cr.interpolation = 'CONSTANT'
    # warm, three-band lighting: shadow (brown-purple), mid, lit
    cr.elements[0].position = 0.0; cr.elements[0].color = (0.33, 0.24, 0.24, 1)
    cr.elements[1].position = 0.62; cr.elements[1].color = (1.04, 1.0, 0.93, 1)
    e = cr.elements.new(0.22); e.color = (0.68, 0.58, 0.52, 1)
    nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix'); mix.location = (300, 0)
    mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 1.0
    nt.links.new(tex.outputs['Color'], mix.inputs[6])
    nt.links.new(ramp.outputs['Color'], mix.inputs[7])
    col = mix.outputs[2]
    if rough < 0.3:  # glass / chrome: add a flat sky-reflection highlight band
        lw = nt.nodes.new('ShaderNodeLayerWeight'); lw.location = (0, 200)
        lw.inputs['Blend'].default_value = 0.35
        add = nt.nodes.new('ShaderNodeMix'); add.location = (520, 120)
        add.data_type = 'RGBA'; add.blend_type = 'SCREEN'
        st = nt.nodes.new('ShaderNodeMath'); st.operation = 'GREATER_THAN'; st.location = (250, 220)
        st.inputs[1].default_value = 0.55
        nt.links.new(lw.outputs['Facing'], st.inputs[0])
        nt.links.new(st.outputs[0], add.inputs['Factor'])
        nt.links.new(col, add.inputs[6]); add.inputs[7].default_value = (0.55, 0.68, 0.78, 1)
        col = add.outputs[2]
    em = nt.nodes.new('ShaderNodeEmission'); em.location = (650, 0)
    nt.links.new(col, em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])

def cube_uvs(o):
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    s = o.matrix_world.to_scale()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            co = l.vert.co
            p = (co.x * s.x, co.y * s.y, co.z * s.z)
            u, v = [(p[1], p[2]), (p[0], p[2]), (p[0], p[1])][ax]
            l[uvl].uv = (u * TEXEL / TILE, v * TEXEL / TILE)
    bm.to_mesh(me); bm.free()

outline = bpy.data.materials.get('Outline') or bpy.data.materials.new('Outline')
outline.use_nodes = True
nt = outline.node_tree; nt.nodes.clear()
o_out = nt.nodes.new('ShaderNodeOutputMaterial'); o_em = nt.nodes.new('ShaderNodeEmission')
o_em.inputs['Color'].default_value = (*[c ** 2.2 for c in OUTLINE], 1); o_em.inputs['Strength'].default_value = 1
nt.links.new(o_em.outputs[0], o_out.inputs['Surface'])
outline.use_backface_culling = True
try: outline.use_backface_culling_shadow = True
except Exception: pass

done = set()
for i, o in enumerate(SC.objects):
    if o.type != 'MESH' or o.get('cutter'): continue
    cube_uvs(o)
    for m in o.data.materials:
        if m and m.name not in done and m.name != 'Outline':
            toon_material(m, seed=len(done) * 7 + 3); done.add(m.name)
    # inverted-hull outline (works in the viewport, renders and in the game after export)
    if o.get('preview_only') and o.name == 'PrevGround': continue
    if 'Outline' not in [m.name for m in o.data.materials if m]:
        o.data.materials.append(outline)
    if not any(md.type == 'SOLIDIFY' for md in o.modifiers):
        md = o.modifiers.new('outline', 'SOLIDIFY')
        md.thickness = 0.025 if max(o.dimensions) > 0.3 else 0.012
        md.offset = 1.0; md.use_flip_normals = True; md.use_rim = False
        md.material_offset = len(o.data.materials) - 1

# ground: pixel dirt with pebbles, like the reference
g = SC.objects.get('PrevGround')
if g:
    gm = g.data.materials[0]
    toon_material(gm, 99)
    img = bpy.data.images['px_' + gm.name]
    # sprinkle pebbles / darker clumps
    rnd = random.Random(5); px = list(img.pixels)
    for _ in range(18):
        x, y = rnd.randrange(TILE), rnd.randrange(TILE); k = (y * TILE + x) * 4
        f = rnd.choice((0.75, 1.18))
        for c in range(3): px[k + c] = min(1, px[k + c] * f)
    img.pixels = px; img.update()

# Eevee look: soft warm sun, no specular sheen; chunky pixels in the rendered viewport
SC.render.preview_pixel_size = '4'
try: SC.eevee.use_shadows = True
except Exception: pass
win = bpy.context.window_manager.windows[0]
win.scene = SC
for area in win.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.shading.type = 'RENDERED'
        area.tag_redraw()
# low-res render (pixel art), upscaled with nearest-neighbour afterwards
SC.render.resolution_x, SC.render.resolution_y = 400, 250
SC.render.filter_size = 0.0
SC.render.filepath = os.path.join(os.environ.get('TEMP', '.'), 'lowrange_preview_small.png')
bpy.ops.render.render(write_still=True, scene=SC.name)
print('materials toon-ified:', len(done))
