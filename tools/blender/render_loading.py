# Renders the loading-screen art from art/blender/loading_screen.blend (keeps your hand edits):
#
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background art/blender/loading_screen.blend ^
#       --python tools/blender/render_loading.py [-- lc70 taco]
#
# For every scene named Loading_<id>:
#   public/loading/<id>.png         480x270 still (frame 1), hard pixels, used by src/ui/loading.js
#   public/loading/<id>_settle.png  8-frame sprite strip of the suspension settle loop (frames 1-8)
#   docs/previews/loading_<id>.png  the still blown up 3x with nearest neighbour, for review
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, 'public', 'loading')
PREV = os.path.join(REPO, 'docs', 'previews')
TMP = os.path.join(HERE, 'out', 'loading')
RES = (480, 270)
PREVIEW_SCALE = 3
STRIP = os.environ.get('LOADING_STRIP', '1') != '0'   # set LOADING_STRIP=0 for quick stills-only passes


def setup_render(sc):
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError as e:
        print('[render] engine:', e)
    sc.eevee.taa_render_samples = 1
    sc.render.filter_size = 0.0          # no pixel filter: hard, aliased pixels
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.film_transparent = False
    try:
        sc.view_settings.view_transform = 'Standard'
    except TypeError as e:
        print('[render] view transform:', e)
    sc.view_settings.look = 'None'
    sc.render.fps = 8


def read_png(path):
    im = bpy.data.images.load(path, check_existing=False)
    W, H = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(H, W, 4)
    bpy.data.images.remove(im)
    return a


def write_png(a, path):
    H, W = a.shape[:2]
    out = bpy.data.images.new('tmp_out', W, H, alpha=False)
    out.pixels.foreach_set(np.ascontiguousarray(a, dtype=np.float32).ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)


def render_frame(sc, frame, path):
    sc.frame_set(frame)
    sc.render.use_stamp = False  # no file paths or dates in PNG metadata
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)


def render_scene(sc):
    vid = sc.name.split('_', 1)[1]
    setup_render(sc)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    still = os.path.join(OUT, vid + '.png')
    render_frame(sc, sc.frame_start, still)
    a = read_png(still)
    write_png(a.repeat(PREVIEW_SCALE, 0).repeat(PREVIEW_SCALE, 1), os.path.join(PREV, f'loading_{vid}.png'))
    if STRIP and sc.frame_end > sc.frame_start:
        frames = []
        for f in range(sc.frame_start, sc.frame_end + 1):
            p = os.path.join(TMP, f'{vid}_{f:02d}.png')
            render_frame(sc, f, p)
            frames.append(read_png(p))
        write_png(np.concatenate(frames, axis=1), os.path.join(OUT, f'{vid}_settle.png'))
    sc.frame_set(sc.frame_start)
    print('[render]', vid, 'done')


def render_all(only=None):
    for sc in bpy.data.scenes:
        if sc.name.startswith('Loading_') and (not only or sc.name.split('_', 1)[1] in only):
            render_scene(sc)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if bpy.data.filepath and any(s.name.startswith('Loading_') for s in bpy.data.scenes):
        render_all(args or None)
