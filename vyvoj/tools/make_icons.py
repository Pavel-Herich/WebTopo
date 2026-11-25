from PIL import Image, ImageDraw
import math, sys
out = sys.argv[1]
def icon(size, maskable=False):
    S = size * 4  # supersampling
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = (23, 33, 43, 255)
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
        sc = 0.62
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)
        sc = 0.78
    def P(x, y):  # x,y in 0..1 of content box
        m = (1 - sc) / 2
        return (S * (m + x * sc), S * (m + y * sc))
    # obrys chodby (náčrt)
    wall = [(0.05, 0.86), (0.22, 0.60), (0.40, 0.56), (0.55, 0.30), (0.80, 0.18), (0.97, 0.10)]
    up = [(x - 0.06, y - 0.10) for x, y in wall]
    dn = [(x + 0.07, y + 0.10) for x, y in wall]
    lw = int(S * 0.022)
    d.line([P(*p) for p in up], fill=(230, 224, 205, 255), width=lw, joint='curve')
    d.line([P(*p) for p in dn], fill=(230, 224, 205, 255), width=lw, joint='curve')
    st = [(0.08, 0.80), (0.30, 0.60), (0.50, 0.42), (0.68, 0.26), (0.90, 0.16)]
    for (x, y) in st[1:-1]:
        for ang in (40, 140, 220, 320):
            a = math.radians(ang)
            d.line([P(x, y), P(x + 0.09 * math.cos(a), y + 0.09 * math.sin(a))], fill=(120, 144, 156, 255), width=int(S * 0.008))
    d.line([P(*p) for p in st], fill=(79, 195, 247, 255), width=int(S * 0.045), joint='curve')
    r = S * 0.035
    for (x, y) in st:
        cx, cy = P(x, y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255), outline=(2, 136, 209, 255), width=int(S * 0.012))
    return im.resize((size, size), Image.LANCZOS)
icon(192).save(out + '/icon-192.png')
icon(512).save(out + '/icon-512.png')
icon(512, True).save(out + '/icon-maskable-512.png')
print('ok')
