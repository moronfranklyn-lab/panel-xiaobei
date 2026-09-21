#!/usr/bin/env python3
"""Build a consistent eight-frame walk cycle from one approved Xiaobei master."""

from collections import deque
from pathlib import Path
import math
import sys

from PIL import Image, ImageDraw


FRAME_SIZE = 256


def looks_like_checker(pixel):
    red, green, blue = pixel[:3]
    spread = max(red, green, blue) - min(red, green, blue)
    brightness = (red + green + blue) / 3
    return spread <= 18 and 38 <= brightness <= 205


def clear_checker(frame):
    rgba = frame.convert("RGBA")
    pixels = rgba.load()
    queue = deque()
    visited = set()
    for value in range(FRAME_SIZE):
        queue.extend(((value, 0), (value, FRAME_SIZE - 1), (0, value), (FRAME_SIZE - 1, value)))
    while queue:
        x, y = queue.popleft()
        if (x, y) in visited:
            continue
        visited.add((x, y))
        if not looks_like_checker(pixels[x, y]):
            continue
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
        if x:
            queue.append((x - 1, y))
        if x + 1 < FRAME_SIZE:
            queue.append((x + 1, y))
        if y:
            queue.append((x, y - 1))
        if y + 1 < FRAME_SIZE:
            queue.append((x, y + 1))
    return rgba.transpose(Image.Transpose.FLIP_LEFT_RIGHT)


def leg_pose(frame_index, phase):
    local = (frame_index - phase) % 8
    if local == 0:
        return -8, 5
    if local == 1:
        return 11, 8
    # During support the planted paw drifts backward relative to the moving body.
    return round(11 - ((local - 1) / 6) * 19), 0


def draw_leg(layer, anchor, pose, color):
    foot_offset, lift = pose
    anchor_x, anchor_y = anchor
    ankle_x = anchor_x + round(foot_offset * 0.62)
    ankle_y = 205 - lift
    toe_x = anchor_x + foot_offset + 9
    points = [(anchor_x, anchor_y), (ankle_x, ankle_y), (toe_x, ankle_y)]
    draw = ImageDraw.Draw(layer)
    draw.line(points, fill=(255, 255, 255, 255), width=20, joint="curve")
    draw.line(points, fill=(42, 34, 29, 255), width=14, joint="curve")
    draw.line(points, fill=color, width=8, joint="curve")


def build_frame(master, frame_index):
    frame = Image.new("RGBA", master.size, (0, 0, 0, 0))

    # Far-side legs are darker and rendered first. Each limb uses a distinct phase,
    # so exactly one paw is in the fast swing portion at a time.
    draw_leg(frame, (79, 167), leg_pose(frame_index, 0), (111, 88, 74, 255))
    draw_leg(frame, (184, 166), leg_pose(frame_index, 4), (137, 112, 92, 255))
    draw_leg(frame, (96, 166), leg_pose(frame_index, 2), (150, 122, 101, 255))
    draw_leg(frame, (204, 165), leg_pose(frame_index, 6), (252, 235, 213, 255))

    # Keep the identity-bearing head, torso, markings, tail, palette and outline from
    # one master image. Only the original lower-leg strip is removed.
    torso = master.copy()
    torso_pixels = torso.load()
    for y in range(178, FRAME_SIZE):
        for x in range(34, 235):
            torso_pixels[x, y] = (0, 0, 0, 0)
    frame.alpha_composite(torso)

    # Rebuild one stable lower belly edge over the moving leg roots.
    draw = ImageDraw.Draw(frame)
    belly = [(59, 166), (201, 166), (211, 177), (203, 184), (67, 184), (54, 176)]
    draw.polygon(belly, fill=(255, 255, 255, 255))
    inner = [(61, 166), (199, 166), (205, 176), (199, 179), (69, 179), (59, 174)]
    draw.polygon(inner, fill=(43, 35, 29, 255))
    fur = [(65, 164), (196, 164), (200, 174), (196, 175), (71, 175), (63, 172)]
    draw.polygon(fur, fill=(248, 226, 203, 255))
    return frame


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: build-pet-walk-rig.py SOURCE_SHEET OUTPUT_DIR PREVIEW_GIF")
    sheet = Image.open(sys.argv[1]).convert("RGB")
    if sheet.size != (1024, 1024):
        raise SystemExit(f"expected a 1024x1024 source sheet, got {sheet.size}")
    master = clear_checker(sheet.crop((0, 0, FRAME_SIZE, FRAME_SIZE)))
    output_dir = Path(sys.argv[2])
    preview = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)
    frames = [build_frame(master, index) for index in range(8)]
    for index, frame in enumerate(frames, start=1):
        frame.save(output_dir / f"xiaobei-ragdoll-walk-{index:02d}.png")
    frames[0].save(preview, save_all=True, append_images=frames[1:], duration=125, loop=0, disposal=2, transparency=0)
    sheet_preview = Image.new("RGB", (FRAME_SIZE * 4, FRAME_SIZE * 2), "#303030")
    for index, frame in enumerate(frames):
        tile = Image.new("RGBA", frame.size, "#303030")
        tile.alpha_composite(frame)
        sheet_preview.paste(tile.convert("RGB"), ((index % 4) * FRAME_SIZE, (index // 4) * FRAME_SIZE))
    sheet_preview.save(preview.with_name(f"{preview.stem}-sheet.png"))


if __name__ == "__main__":
    main()
