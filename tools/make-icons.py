#!/usr/bin/env python3
"""Genera los PNG de la PWA (monito con los ojos cerrados) sin dependencias.

Mismo diseño que icon.svg: fondo azul redondeado, cara de mono marrón, hocico
claro, ojos cerrados (dos arcos) y boquita. Se dibuja con campos de distancia
(SDF) para que los bordes salgan suaves sin antialias por muestreo.
"""
import math, os, struct, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

BROWN = (141, 85, 36)
BROWN_DARK = (59, 36, 22)
EAR_INNER = (176, 122, 74)
MUZZLE = (242, 207, 174)
NOSTRIL = (107, 63, 27)


def clamp(v, a=0.0, b=1.0):
    return a if v < a else (b if v > b else v)


def sdf_circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) - r


def sdf_ellipse(x, y, cx, cy, rx, ry):
    k = math.hypot((x - cx) / rx, (y - cy) / ry)
    return (k - 1.0) * min(rx, ry)


def sdf_rounded_rect(x, y, cx, cy, hw, hh, r):
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def sdf_arc(x, y, cx, cy, radius, half_width, a0, a1):
    """Arco circular: anillo recortado por ángulo (grados; 0 = +x, hacia abajo)."""
    d = abs(math.hypot(x - cx, y - cy) - radius) - half_width
    ang = math.degrees(math.atan2(y - cy, x - cx)) % 360
    soft = 3.0
    inside = clamp((ang - a0) / soft) * clamp((a1 - ang) / soft)
    return d + (1.0 - inside) * 1.0


def paint(dst, cov, color):
    a = clamp(cov)
    if a <= 0:
        return
    for i in range(3):
        dst[i] = dst[i] * (1 - a) + color[i] * a


def render(size, rounded=True, content_scale=1.0):
    px = 1.0 / size
    rows = []
    for j in range(size):
        row = bytearray()
        y = (j + 0.5) / size
        for i in range(size):
            x = (i + 0.5) / size
            t = y
            bg = (31 + (9 - 31) * t, 123 + (74 - 123) * t, 255 + (173 - 255) * t)
            col = [bg[0], bg[1], bg[2], 255.0]

            if rounded:
                d = sdf_rounded_rect(x, y, 0.5, 0.5, 0.5, 0.5, 0.215)
                col[3] = 255.0 * clamp(0.5 - d / px)

            if col[3] > 1:
                cx = (x - 0.5) / content_scale + 0.5
                cy = (y - 0.5) / content_scale + 0.5
                # Orejas
                paint(col, 0.5 - sdf_circle(cx, cy, 0.234, 0.488, 0.090) / px, BROWN)
                paint(col, 0.5 - sdf_circle(cx, cy, 0.766, 0.488, 0.090) / px, BROWN)
                paint(col, 0.5 - sdf_circle(cx, cy, 0.234, 0.488, 0.047) / px, EAR_INNER)
                paint(col, 0.5 - sdf_circle(cx, cy, 0.766, 0.488, 0.047) / px, EAR_INNER)
                # Cara
                paint(col, 0.5 - sdf_circle(cx, cy, 0.5, 0.469, 0.258) / px, BROWN)
                # Hocico
                paint(col, 0.5 - sdf_ellipse(cx, cy, 0.5, 0.629, 0.188, 0.141) / px, MUZZLE)
                # Ojos cerrados: dos arcos con forma de "u"
                paint(col, 0.5 - sdf_arc(cx, cy, 0.434, 0.426, 0.051, 0.0115, 20, 160) / px, BROWN_DARK)
                paint(col, 0.5 - sdf_arc(cx, cy, 0.566, 0.426, 0.051, 0.0115, 20, 160) / px, BROWN_DARK)
                # Nariz
                paint(col, 0.5 - sdf_ellipse(cx, cy, 0.469, 0.590, 0.012, 0.016) / px, NOSTRIL)
                paint(col, 0.5 - sdf_ellipse(cx, cy, 0.531, 0.590, 0.012, 0.016) / px, NOSTRIL)
                # Boquita
                paint(col, 0.5 - sdf_arc(cx, cy, 0.5, 0.639, 0.043, 0.0095, 35, 145) / px, BROWN_DARK)

            row += bytes(int(clamp(c, 0, 255)) for c in col)
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


jobs = [
    ("icon-192.png", 192, True, 1.0),
    ("icon-512.png", 512, True, 1.0),
    ("icon-maskable-512.png", 512, False, 0.80),
    ("apple-touch-icon.png", 180, False, 0.92),
]
for name, size, rounded, scale in jobs:
    write_png(os.path.join(OUT, name), size, render(size, rounded, scale))
    print(name, size, os.path.getsize(os.path.join(OUT, name)), "bytes")
