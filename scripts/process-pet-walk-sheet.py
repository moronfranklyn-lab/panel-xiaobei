#!/usr/bin/env python3
"""Turn the approved 4x4 Xiaobei walk sheet into transparent runtime frames."""

from collections import deque
from pathlib import Path
import sys

from PIL import Image


GRID_SIZE = 4
FRAME_SIZE = 256


def looks_like_checker(pixel):
    red, green, blue = pixel[:3]
    spread = max(red, green, blue) - min(red, green, blue)
    brightness = (red + green + blue) / 3
    return spread <= 18 and 38 <= brightness <= 205


def clear_connected_checker(frame):
    rgba = frame.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    queue = deque()
    visited = set()

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if (x, y) in visited:
            continue
        visited.add((x, y))
        if not looks_like_checker(pixels[x, y]):
            continue
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    return rgba


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: process-pet-walk-sheet.py INPUT OUTPUT_DIR PREVIEW_GIF")

    source = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    preview = Path(sys.argv[3])
    sheet = Image.open(source).convert("RGB")
    if sheet.size != (GRID_SIZE * FRAME_SIZE, GRID_SIZE * FRAME_SIZE):
        raise SystemExit(f"expected 1024x1024 source sheet, got {sheet.size}")

    output_dir.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)
    frames = []
    for row in range(GRID_SIZE):
        for column in range(GRID_SIZE):
            left = column * FRAME_SIZE
            top = row * FRAME_SIZE
            frame = sheet.crop((left, top, left + FRAME_SIZE, top + FRAME_SIZE))
            frame = clear_connected_checker(frame)
            # Runtime convention: unmirrored walk art faces right.
            frame = frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            index = row * GRID_SIZE + column + 1
            frame.save(output_dir / f"xiaobei-ragdoll-walk-{index:02d}.png")
            frames.append(frame)

    frames[0].save(
        preview,
        save_all=True,
        append_images=frames[1:],
        duration=95,
        loop=0,
        disposal=2,
        transparency=0,
    )

    contact_sheet = Image.new("RGB", (GRID_SIZE * FRAME_SIZE, GRID_SIZE * FRAME_SIZE), "#303030")
    for index, frame in enumerate(frames):
        tile = Image.new("RGBA", frame.size, "#303030")
        tile.alpha_composite(frame)
        contact_sheet.paste(tile.convert("RGB"), ((index % GRID_SIZE) * FRAME_SIZE, (index // GRID_SIZE) * FRAME_SIZE))
    contact_sheet.save(preview.with_name(f"{preview.stem}-sheet.png"))


if __name__ == "__main__":
    main()
