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


SKIRT = (
    (-115, -108), (-106, -123), (-65, -136), (-44, -37), (-26, -37),
    (-42, -146), (-28, -156), (28, -156), (42, -146),
    (26, -37), (44, -37), (65, -136), (106, -123), (115, -108),
    (50, 48), (-50, 48),
)
COURT_LINES = (
    (82, 86, 162, 104), (82, 86, 100, 168),
    (350, 408, 430, 426), (412, 344, 430, 426),
)
ANGLE = math.radians(17)
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
    x, y = x - 256, y - 259
    u, v = COS * x + SIN * y, -SIN * x + COS * y
    if abs(u) > 115 + px or v < -156 - px or v > 133 + px:
        return (0, 0)
    feathers = min(polygon_distance(u, v, SKIRT), rounded_distance(u, v, -52, 33, 52, 59, 10))
    cork = rounded_distance(u, v, -43, 73, 43, 133, 29)
    return opacity(feathers, px), opacity(cork, px)


def blend(a, b, amount):
    return tuple(round(left + (right - left) * amount) for left, right in zip(a, b))


def icon(x, y, px):
    face_distance = rounded_distance(x, y, 41, 34, 471, 464, 96)
    face = opacity(face_distance, px) / 255
    # Two short, downward shadows have room to fade inside the transparent canvas.
    if face < 1:
        cast = rounded_distance(x, y - 9, 41, 34, 471, 464, 96)
        contact = rounded_distance(x, y - 4, 41, 34, 471, 464, 96)
        soft = .19 * math.erfc(cast / math.hypot(12, px / 2))
        tight = .12 * math.erfc(contact / math.hypot(4, px / 2))
        shadow = 1 - (1 - soft) * (1 - tight)
        alpha = face + shadow * (1 - face)
        if not round(alpha * 255):
            return (0, 0, 0, 0)
    else:
        alpha = 1

    light = max(0, min(1, (.35 * x + .65 * y - 37) / 430))
    color = blend((102, 132, 151), (55, 83, 106), light)
    if px < 16:
        court = min(rounded_distance(x, y, *bounds, 9) for bounds in COURT_LINES)
        color = blend(color, (179, 198, 199), .72 * opacity(court, px) / 255)
    # A small offset underneath the ivory feathers gives the mark a printed relief.
    under = max(mark(x, y - 4, max(px, 7))) / 255
    color = blend(color, (37, 59, 77), .36 * under)
    feathers, cork = mark(x, y, px)
    paper = blend((255, 253, 243), (234, 232, 217), light)
    color = blend(color, paper, feathers / 255)
    color = blend(color, (225, 201, 172), cork / 255)
    color = blend((27, 40, 52), color, face / alpha)
    return (*color, round(alpha * 255))


def tray(x, y, px):
    scale = 0.68
    alpha = max(mark((x - 256) * scale + 256, (y - 256) * scale + 256, px * scale))
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
