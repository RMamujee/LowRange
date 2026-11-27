# Save a .blend for the repo without local paths or machine-specific UI state.
#
#   import blend_save; blend_save.save(path)                        # from a build script, instead of save_as_mainfile
#   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup <file.blend> ^
#       --python tools/blender/blend_save.py                         # clean an existing file in place
#
# What it strips (check with `node test/blend_paths.mjs`):
#   - File Browser editors: every workspace screen that has one (Blender's stock Shading workspace does) stores
#     the browser's folder, i.e. the user's Documents path, in the .blend. Those workspaces are removed.
#   - absolute image / font / sound / clip / cache / volume / library paths: made relative to the .blend; a path
#     from another checkout of this repo (e.g. a packed tile from <other clone>/tools/blender/...) is re-based onto
#     this repo first. Packed data is untouched (only the stored source path changes).
#   - absolute render output paths (render settings, compositor File Output nodes): the render scripts set their
#     own paths at render time, so the stored one is reset to '//'.
#   - string custom properties / text datablocks holding an absolute path or the user name are reported.
import getpass
import os
import re
import sys
import warnings

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TOP = ('tools', 'public', 'art', 'src', 'docs', 'test')   # repo top-level dirs, to re-base paths from other clones
ABS = re.compile(r'^(?:[A-Za-z]:[\\/]|\\\\|/(?!/))')   # '//' is Blender's "relative to the .blend"


def _user():
    try:
        return getpass.getuser()
    except Exception:
        return os.environ.get('USERNAME') or os.environ.get('USER') or ''


def _rebase(p):
    """Absolute path -> the same file in this repo when it lies under a repo top-level dir of any clone."""
    parts = re.split(r'[\\/]+', p)
    for i in range(len(parts) - 1, 0, -1):
        if parts[i] in TOP:
            cand = os.path.join(REPO, *parts[i:])
            return cand
    return p


def _rel(p, start):
    if not p or p.startswith('//') or not ABS.match(p):
        return p
    q = _rebase(p)
    try:
        return '//' + os.path.relpath(q, start).replace('\\', '/')
    except ValueError:          # other drive: keep just the file name
        return '//' + os.path.basename(q)


def _drop_file_browsers(log):
    keep = bpy.context.window.workspace if bpy.context.window else None
    for ws in list(bpy.data.workspaces):
        if any(sp.type == 'FILE_BROWSER' for scr in ws.screens for a in scr.areas for sp in a.spaces):
            if ws == keep:
                for scr in ws.screens:
                    for a in scr.areas:
                        if a.type == 'FILE_BROWSER':
                            a.type = 'VIEW_3D'
                log(f'kept active workspace {ws.name} (file browser area switched off)')
                continue
            log(f'removed workspace {ws.name} (has a file browser)')
            bpy.data.batch_remove([ws])


def clean(target, log=print):
    start = os.path.dirname(os.path.abspath(target))
    _drop_file_browsers(log)
    colls = [bpy.data.images, bpy.data.fonts, bpy.data.sounds, bpy.data.movieclips, bpy.data.cache_files,
             bpy.data.volumes, bpy.data.libraries]
    for coll in colls:
        for d in coll:
            attr = 'filepath'
            p = getattr(d, attr, '')
            if p and ABS.match(p) and not p.startswith('//'):
                r = _rel(p, start)
                if hasattr(d, 'filepath_raw'):
                    d.filepath_raw = r
                else:
                    setattr(d, attr, r)
                log(f'{d.__class__.__name__} {d.name}: {p} -> {r}')
            # a packed image also stores the absolute path it was packed from (read-only): re-pack the same
            # bytes so it takes the (now relative) image path. Pixel data is unchanged.
            pf = getattr(d, 'packed_file', None)
            if pf and isinstance(d, bpy.types.Image) and len(d.packed_files) == 1:
                src = d.packed_files[0].filepath
                if src and ABS.match(src):
                    data = bytes(pf.data)
                    d.pack(data=data, data_len=len(data))
                    assert bytes(d.packed_file.data) == data
                    log(f'Image {d.name}: re-packed ({len(data)} bytes), source {src} -> {d.packed_files[0].filepath}')
    for sc in bpy.data.scenes:
        if ABS.match(sc.render.filepath) and sc.render.filepath not in ('/tmp/', '/tmp\\'):
            log(f'scene {sc.name}: render.filepath {sc.render.filepath} -> //')
            sc.render.filepath = '//'
        with warnings.catch_warnings():   # either attribute is deprecated, depending on the Blender version
            warnings.simplefilter('ignore', DeprecationWarning)
            trees = [t for t in (getattr(sc, 'node_tree', None), getattr(sc, 'compositing_node_group', None)) if t]
        for nt in trees:
            for n in nt.nodes:
                if n.type == 'OUTPUT_FILE':
                    for attr in ('base_path', 'directory'):
                        v = getattr(n, attr, None)
                        if isinstance(v, str) and ABS.match(v):
                            log(f'scene {sc.name}: File Output {n.name}.{attr} {v} -> //')
                            setattr(n, attr, '//')
    # report-only: strings that would leak a local path or the user name
    user = _user()
    bad = re.compile(r'[A-Za-z]:[\\/]|\\\\[A-Za-z]' + (r'|' + re.escape(user) if len(user) >= 3 else ''), re.I)
    for t in bpy.data.texts:
        if bad.search(t.as_string()):
            log(f'WARNING text {t.name} contains a local path / user name')
    for coll in (bpy.data.objects, bpy.data.scenes, bpy.data.materials, bpy.data.meshes, bpy.data.collections):
        for d in coll:
            for k in d.keys():
                v = d[k]
                if isinstance(v, str) and bad.search(v):
                    log(f'WARNING {d.name}["{k}"] = {v!r}')


def save(target, log=print):
    """clean() + compressed save, no .blend1 backup."""
    clean(target, log)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=target, compress=True, relative_remap=True)


if __name__ == '__main__':
    # run on an opened .blend: clean it and save it in place
    if not bpy.data.filepath:
        sys.exit('[blend_save] open a .blend first: blender --background --factory-startup <file> --python blend_save.py')
    save(bpy.data.filepath, log=lambda *a: print('[blend_save]', *a))
    print('[blend_save] saved', bpy.data.filepath)
