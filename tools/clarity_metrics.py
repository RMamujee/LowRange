"""Metrics for test/clarity.mjs output (and any reference images).

  py tools/clarity_metrics.py <outdir> [ref images...]

grid purity  - in each device-pixel screenshot (HUD-free central crop), the share of colour steps
               between neighbouring pixels that fall on the pipeline's pixel grid. Exact integer
               blocks give 1.000; any browser resampling or fractional stretch smears steps off
               the grid. Also: share of grid blocks that are one flat colour.
tone         - on the internal frames: mean HSV saturation, mean value, RMS luminance contrast,
               5-95 percentile luminance spread, share of dark pixels (L < 0.22).
flicker      - on the bursts of consecutive frames: share of pixels that change by more than a
               visible step and come back on the next frame (A-B-A), averaged over the burst.
               Real motion moves edges along; shimmer toggles in place.
It also writes 4x nearest-neighbour zoomed crops (zoom_*.png) of each screenshot centre.
"""
import json, sys, glob, os
import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.int16)


def lum(a):
    return (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]) / 255.0


def tone(a):
    f = a.astype(np.float32) / 255.0
    mx, mn = f.max(-1), f.min(-1)
    sat = np.where(mx > 1e-3, (mx - mn) / np.maximum(mx, 1e-3), 0)
    L = lum(a)
    return dict(sat=round(float(sat.mean()), 3), val=round(float(mx.mean()), 3), rms=round(float(L.std()), 3),
                spread=round(float(np.percentile(L, 95) - np.percentile(L, 5)), 3), dark=round(float((L < 0.22).mean()), 3))


def comfort(a, top_frac=0.22):
    """Eye-comfort numbers on one frame, resampled (box filter) to 480 x 270 so screenshots of any
    resolution, pixel size or source compare on equal terms.
      L5/L50/L95 - luminance percentiles (Rec.709, display-encoded 0..1); Lmean
      white/black - share of near-white (L > 0.9) and near-black (L < 0.08) pixels
      sat/sat95  - mean and 95th percentile HSV saturation
      loud       - share of pixels that are both bright and strongly saturated (V > 0.75, S > 0.55):
                   big areas of this are what reads as 'too bright / neon'
      rms        - global RMS luminance contrast; local - mean local contrast (std of L in 4x4
                   blocks of the 480 frame)
      edges      - edge density: share of pixels whose Sobel luminance gradient exceeds 0.25
      hues       - number of 15-degree hue bins holding at least 2% of the coloured (S > 0.2) pixels
      skygap     - mean L of the top band minus mean L of the bottom half (sky / far vs ground)
    """
    im = Image.fromarray(a.astype(np.uint8)).resize((480, 270), Image.BOX)
    f = np.asarray(im).astype(np.float32) / 255.0
    mx, mn = f.max(-1), f.min(-1)
    S = np.where(mx > 1e-3, (mx - mn) / np.maximum(mx, 1e-3), 0)
    L = 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]
    gx = np.zeros_like(L); gy = np.zeros_like(L)
    gx[1:-1, 1:-1] = (L[:-2, 2:] + 2 * L[1:-1, 2:] + L[2:, 2:] - L[:-2, :-2] - 2 * L[1:-1, :-2] - L[2:, :-2]) / 4
    gy[1:-1, 1:-1] = (L[2:, :-2] + 2 * L[2:, 1:-1] + L[2:, 2:] - L[:-2, :-2] - 2 * L[:-2, 1:-1] - L[:-2, 2:]) / 4
    G = np.hypot(gx, gy)
    blk = L[:268, :480].reshape(67, 4, 120, 4).std(axis=(1, 3))
    # hue
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    col = S > 0.2
    hist = np.histogram(h[col], bins=24, range=(0, 360))[0]
    hues = int((hist > 0.02 * max(col.sum(), 1)).sum())
    t = int(270 * top_frac)
    p = lambda q: round(float(np.percentile(L, q)), 3)
    return dict(L5=p(5), L50=p(50), L95=p(95), Lmean=round(float(L.mean()), 3),
                white=round(float((L > 0.9).mean()), 3), black=round(float((L < 0.08).mean()), 3),
                sat=round(float(S.mean()), 3), sat95=round(float(np.percentile(S, 95)), 3),
                loud=round(float(((mx > 0.75) & (S > 0.55)).mean()), 3),
                rms=round(float(L.std()), 3), local=round(float(blk.mean()), 4),
                edges=round(float((G > 0.25).mean()), 4), hues=hues,
                skygap=round(float(L[:t].mean() - L[135:].mean()), 3))


def comfort_table(paths, label_fn=os.path.basename):
    rows = []
    for p in paths:
        c = comfort(load(p)); rows.append(c)
        print(f'{label_fn(p):28s}', ' '.join(f'{k}={v}' for k, v in c.items()))
    if rows:
        m = {k: round(float(np.mean([r[k] for r in rows])), 4) for k in rows[0]}
        print(f'{"MEAN":28s}', ' '.join(f'{k}={v}' for k, v in m.items()))
        return m


def grid_purity(a, s):
    h, w, _ = a.shape
    a = a[int(h * 0.25):int(h * 0.72), int(w * 0.2):int(w * 0.8)]
    dx = np.abs(np.diff(a, axis=1)).sum(-1) > 6
    dy = np.abs(np.diff(a, axis=0)).sum(-1) > 6
    best = (0, 0, 0)
    for ox in range(s):
        for oy in range(s):
            cx = ((np.arange(dx.shape[1]) + 1 - ox) % s == 0)
            cy = ((np.arange(dy.shape[0]) + 1 - oy) % s == 0)
            on = dx[:, cx].sum() + dy[cy, :].sum()
            tot = dx.sum() + dy.sum()
            p = on / max(tot, 1)
            if p > best[0]:
                best = (p, ox, oy)
    p, ox, oy = best
    b = a[oy:, ox:]
    H, W = (b.shape[0] // s) * s, (b.shape[1] // s) * s
    blk = b[:H, :W].reshape(H // s, s, W // s, s, 3)
    flat = (np.abs(blk - blk[:, :1, :, :1]).max(axis=(1, 3, 4)) <= 2).mean()
    return round(float(p), 4), round(float(flat), 4)


def flicker(frames, map_out=None):
    f = [load(p) for p in frames]
    if len(f) < 3:
        return None
    rates, mad = [], []
    acc = np.zeros(f[0].shape[:2])
    for i in range(1, len(f) - 1):
        a, b, c = f[i - 1], f[i], f[i + 1]
        d1 = np.abs(b - a).sum(-1) > 24
        back = np.abs(c - a).sum(-1) <= 12
        rates.append((d1 & back).mean())
        acc += d1 & back
        mad.append(np.abs(b - a).mean())
    if map_out:  # where it flickers: red over a darkened frame
        base = f[len(f) // 2].mean(-1) * 0.35
        Image.fromarray(np.stack([np.clip(base + acc * 90, 0, 255), base, base], -1).astype(np.uint8)).save(map_out)
    return round(float(np.mean(rates)), 4), round(float(np.mean(mad)), 2)


def zoom(p, out, s=4, cw=240, ch=135):
    im = Image.open(p).convert('RGB')
    w, h = im.size
    cx, cy = w // 2, int(h * 0.48)
    im.crop((cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2)).resize((cw * s, ch * s), Image.NEAREST).save(out)


def main():
    if sys.argv[1] == 'comfort':  # py tools/clarity_metrics.py comfort <images...>
        comfort_table(sys.argv[2:])
        return
    d = sys.argv[1]
    rep = json.load(open(os.path.join(d, 'report.json'))) if os.path.exists(os.path.join(d, 'report.json')) else {}
    print('== grid purity (device-pixel screenshots, central crop) ==')
    for cfg, r in rep.items():
        for sc, diag in r['scenes'].items():
            p = os.path.join(d, f'{cfg}_{sc}.png')
            pur, flat = grid_purity(load(p), diag['scale'])
            print(f'{cfg:8s} {sc:10s} dpr={diag["dpr"]:.2f} buf={diag["buffer"]} css*dpr ratio={diag["bufferOverCssDpr"]} x{diag["scale"]} purity={pur} flatBlocks={flat}')
            zoom(p, os.path.join(d, f'zoom_{cfg}_{sc}.png'))
    print('== tone (internal frames) ==')
    allt = []
    for p in sorted(glob.glob(os.path.join(d, 'internal_*.png'))):
        t = tone(load(p)); allt.append(t)
        print(os.path.basename(p), t)
    if allt:
        print('mean', {k: round(float(np.mean([t[k] for t in allt])), 3) for k in allt[0]})
    print('== comfort (internal frames, 480x270) ==')
    comfort_table(sorted(glob.glob(os.path.join(d, 'internal_*.png'))))
    print('== flicker (A-B-A share, mean abs diff) ==')
    for bd in sorted(glob.glob(os.path.join(d, 'burst_*'))):
        for kind in ('orbit', 'drive'):
            fr = sorted(glob.glob(os.path.join(bd, f'{kind}_*.png')))
            if fr:
                print(os.path.basename(bd), kind, flicker(fr, os.path.join(d, f'flick_{os.path.basename(bd)[6:]}_{kind}.png')))
    for p in sys.argv[2:]:
        print('ref', os.path.basename(p), tone(load(p)))


main()
