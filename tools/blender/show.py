import os
import bpy
sc = bpy.data.scenes['LowRange_lc70']
win = bpy.context.window_manager.windows[0]
win.scene = sc
# frame the truck in every 3D viewport, solid shading with material colours
for area in win.screen.areas:
    if area.type == 'VIEW_3D':
        sp = area.spaces.active
        sp.shading.type = 'MATERIAL'
        r3d = sp.region_3d
        r3d.view_perspective = 'PERSP'
        from mathutils import Vector, Euler
        r3d.view_location = Vector((0, 0, 1.0))
        r3d.view_rotation = Euler((1.25, 0, 2.55)).to_quaternion()
        r3d.view_distance = 10.5
        area.tag_redraw()
sc.render.resolution_x, sc.render.resolution_y = 1120, 700
sc.render.filepath = os.path.join(os.environ.get('TEMP', '.'), 'lowrange_preview.png')
bpy.ops.render.render(write_still=True, scene=sc.name)
print('engine', sc.render.engine)
