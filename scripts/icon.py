#!/usr/bin/env python3
"""Render the Houyu shuttlecock for the desktop app and OS icon formats."""

import math
import struct
import sys
import zlib
from pathlib import Path


def rounded_distance(x, y, left, top, right, bottom, radius):
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return math.hypot(x - cx, y - cy) - radius


def png(size, paint):
    def chunk(name, content):
        return struct.pack('>I', len(content)) + name + content + struct.pack('>I', zlib.crc32(name + content))

    body = bytearray()
    for row in range(size):
        body.append(0)
        for column in range(size):
            x = (column + 0.5) * 512 / size
            y = (row + 0.5) * 512 / size
            body.extend(paint(x, y, 512 / size))
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(body, 9)) + chunk(b'IEND', b'')


def opacity(distance, px):
    return max(0, min(255, round(255 * (0.5 - distance / px))))


FEATHERS = (
    ((-130, -112), (-121, -134), (-98, -146), (-64, -127), (-23, 41), (-47, 42)),
    ((-47, -145), (-25, -167), (23, -167), (47, -145), (12, 41), (-12, 41)),
    ((130, -112), (121, -134), (98, -146), (64, -127), (23, 41), (47, 42)),
)
ANGLE = math.radians(36)
COS, SIN = math.cos(ANGLE), math.sin(ANGLE)


def polygon_distance(x, y, points):
    inside = False
    distance = math.inf
    a = points[-1]
    for b in points:
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        qx, qy = x - a[0], y - a[1]
        t = min(1, max(0, (qx * dx + qy * dy) / (dx * dx + dy * dy)))
        distance = min(distance, math.hypot(qx - t * dx, qy - t * dy))
        if (a[1] > y) != (b[1] > y) and x < a[0] + dx * (y - a[1]) / dy:
            inside = not inside
        a = b
    return -distance if inside else distance


def mark(x, y, px):
    x, y = x - 255, y - 271
    u, v = COS * x + SIN * y, -SIN * x + COS * y
    if abs(u) > 130 + px or v < -167 - px or v > 140 + px:
        return (0, 0, 0, 0)
    wings = tuple(opacity(polygon_distance(u, v, points), px) for points in FEATHERS)
    cork = opacity(rounded_distance(u, v, -44, 57, 44, 140, 33), px)
    return (*wings, cork)


def blend(a, b, amount):
    return tuple(round(left + (right - left) * amount) for left, right in zip(a, b))


def icon(x, y, px):
    alpha = opacity(rounded_distance(x, y, 12, 12, 500, 500, 116), px)
    color = blend((39, 125, 88), (16, 57, 46), (x + y) / 1024)
    for pigment, coverage in zip(((218, 250, 229), (255, 255, 243), (190, 240, 203), (216, 246, 138)), mark(x, y, px)):
        color = blend(color, pigment, coverage / 255)
    return (*color, alpha)


def tray(x, y, px):
    alpha = max(mark((x - 256) * 0.73 + 256, (y - 256) * 0.73 + 256, px * 0.73))
    return (0, 0, 0, alpha)


def windows_icon(file):
    sizes = (16, 24, 32, 48, 64, 128, 256)
    entry_offset = 6 + 16 * len(sizes)
    directory, pictures = [], []
    for size in sizes:
        picture = png(size, icon)
        directory.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(picture), entry_offset))
        pictures.append(picture)
        entry_offset += len(picture)
    file.write_bytes(struct.pack('<HHH', 0, 1, len(sizes)) + b''.join(directory) + b''.join(pictures))


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'icon.png').write_bytes(png(512, icon))
    (directory / 'trayTemplate.png').write_bytes(png(72, tray))
