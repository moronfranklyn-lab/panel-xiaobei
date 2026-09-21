#!/usr/bin/env python3
"""Create a gait by warping only the lower legs of one approved master sprite."""

from pathlib import Path
from collections import deque
import sys

from PIL import Image, ImageChops, ImageFilter


SIZE = 256
TARGET_EXTENT = 248
TARGET_BASELINE = 242
LIMBS = (
    # x0, x1, knee y, phase, rendering order
    # Keep the torso and belly fixed. Only the actual lower-leg columns move;
    # the previous broad regions started around y=182 and tore pieces out of
    # the body whenever a paw swung forward.
    (48, 90, 214, 0),
    (103, 149, 214, 4),
    (174, 207, 213, 2),
    (208, 236, 212, 6),
)


def gait_pose(frame, phase):
    local = (frame - phase) % 8
    if local == 0:
        return -4, 3
    if local == 1:
        return 7, 4
    # A planted paw moves backward relative to the travelling torso.
    return round(7 - ((local - 1) / 6) * 12), 0


def ease(value):
    return value * value * (3 - 2 * value)


def is_outline_white(pixel):
    red, green, blue, alpha = pixel
    return alpha > 0 and red >= 235 and green >= 235 and blue >= 215


def strip_outer_white(master):
    cleaned = master.copy()
    pixels = cleaned.load()

    def nearby(x, y, radius, predicate):
        for ny in range(max(0, y - radius), min(SIZE, y + radius + 1)):
            for nx in range(max(0, x - radius), min(SIZE, x + radius + 1)):
                if predicate(pixels[nx, ny]):
                    return True
        return False

    remove = []
    for y in range(SIZE):
        for x in range(SIZE):
            if not is_outline_white(pixels[x, y]):
                continue
            near_transparency = nearby(x, y, 5, lambda pixel: pixel[3] == 0)
            near_dark_outline = nearby(
                x,
                y,
                6,
                lambda pixel: pixel[3] > 0 and max(pixel[:3]) <= 90,
            )
            if near_transparency and near_dark_outline:
                remove.append((x, y))
    for x, y in remove:
        pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def normalize_extent(frame):
    bounds = frame.getchannel("A").getbbox()
    if not bounds:
        raise ValueError("walk frame contains no visible pixels")
    subject = frame.crop(bounds)
    extent = max(subject.size)
    scale = TARGET_EXTENT / extent
    if abs(scale - 1) > 0.001:
        subject = subject.resize(
            (max(1, round(subject.width * scale)), max(1, round(subject.height * scale))),
            Image.Resampling.NEAREST,
        )
    normalized = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    left = (SIZE - subject.width) // 2
    top = TARGET_BASELINE - subject.height
    normalized.alpha_composite(subject, (left, top))
    return normalized


def remove_small_exposed_white(frame):
    cleaned = frame.copy()
    pixels = cleaned.load()
    visited = set()
    for y in range(SIZE):
        for x in range(SIZE):
            if (x, y) in visited or not is_outline_white(pixels[x, y]):
                continue
            queue = deque([(x, y)])
            visited.add((x, y))
            component = []
            touches_transparency = False
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nx, ny = px + dx, py + dy
                    if nx < 0 or nx >= SIZE or ny < 0 or ny >= SIZE or pixels[nx, ny][3] == 0:
                        touches_transparency = True
                    elif (nx, ny) not in visited and is_outline_white(pixels[nx, ny]):
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            # Real white fur forms the large chest/face component. The exterior stroke
            # is fragmented into small islands after the dark-outline-aware first pass.
            if touches_transparency and len(component) < 100:
                for px, py in component:
                    pixels[px, py] = (0, 0, 0, 0)
    return cleaned


def remove_chroma_fringe(frame):
    cleaned = frame.copy()
    pixels = cleaned.load()
    remove = []
    for y in range(SIZE):
        for x in range(SIZE):
            red, green, blue, alpha = pixels[x, y]
            # The generated green-screen rim is very pale: some missed pixels only
            # have G 2-7 levels above R. Real cream fur trends warm (R >= G), so the
            # tighter threshold removes that rim without erasing the coat.
            if alpha == 0 or green < red + 2 or green < blue + 8:
                continue
            exposed = False
            for ny in range(max(0, y - 2), min(SIZE, y + 3)):
                for nx in range(max(0, x - 2), min(SIZE, x + 3)):
                    if pixels[nx, ny][3] == 0:
                        exposed = True
                        break
                if exposed:
                    break
            if exposed:
                remove.append((x, y))
    for x, y in remove:
        pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def remove_tiny_islands(frame, max_pixels=6):
    """Remove detached generator specks while preserving real facial details."""
    cleaned = frame.copy()
    alpha = cleaned.getchannel("A")
    visited = set()
    for y in range(SIZE):
        for x in range(SIZE):
            if (x, y) in visited or alpha.getpixel((x, y)) == 0:
                continue
            queue = deque([(x, y)])
            visited.add((x, y))
            component = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nx, ny = px + dx, py + dy
                    if (
                        0 <= nx < SIZE
                        and 0 <= ny < SIZE
                        and (nx, ny) not in visited
                        and alpha.getpixel((nx, ny)) > 0
                    ):
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            if len(component) <= max_pixels:
                pixels = cleaned.load()
                for px, py in component:
                    pixels[px, py] = (0, 0, 0, 0)
    return cleaned


def prune_outer_artifacts(frame):
    """Trim thin rectangular generator rails outside the character silhouette."""
    cleaned = frame.copy()
    original = cleaned.getchannel("A")
    # A 9px opening removes the 6-8px rails. Expanding its support by 3px and
    # intersecting it with the original mask restores normal pixel-art corners.
    opened = original.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
    support = opened.filter(ImageFilter.MaxFilter(7))
    cleaned.putalpha(ImageChops.multiply(original, support))
    return cleaned


def warp_limb(master, body, bounds, offset, lift):
    x0, x1, y0, _ = bounds
    layer = Image.new("RGBA", master.size, (0, 0, 0, 0))
    source = master.load()
    body_pixels = body.load()
    target = layer.load()
    span = max(1, SIZE - 1 - y0)

    for y in range(y0, SIZE):
        progress = ease((y - y0) / span)
        dx = round(offset * progress)
        dy = -round(lift * progress)
        for x in range(x0, x1):
            pixel = source[x, y]
            if pixel[3] == 0:
                continue
            body_pixels[x, y] = (0, 0, 0, 0)
            target_x = x + dx
            target_y = y + dy
            if 0 <= target_x < SIZE and 0 <= target_y < SIZE:
                target[target_x, target_y] = pixel
    return layer


def build_frame(master, frame_index):
    body = master.copy()
    layers = []
    for limb in LIMBS:
        offset, lift = gait_pose(frame_index, limb[3])
        layers.append(warp_limb(master, body, limb, offset, lift))
    frame = Image.new("RGBA", master.size, (0, 0, 0, 0))
    for layer in layers:
        frame.alpha_composite(layer)
    frame.alpha_composite(body)
    return frame


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: build-pet-walk-warp.py MASTER OUTPUT_DIR PREVIEW_GIF")
    master = strip_outer_white(Image.open(sys.argv[1]).convert("RGBA"))
    if master.size != (SIZE, SIZE):
        raise SystemExit(f"expected 256x256 master, got {master.size}")
    output_dir = Path(sys.argv[2])
    preview = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)
    frames = []
    for index in range(8):
        frame = build_frame(master, index)
        frame = remove_tiny_islands(
            remove_chroma_fringe(remove_small_exposed_white(frame))
        )
        frame = normalize_extent(frame)
        frame = prune_outer_artifacts(
            remove_tiny_islands(
                remove_chroma_fringe(remove_small_exposed_white(frame))
            )
        )
        frames.append(frame)
    for index, frame in enumerate(frames, start=1):
        frame.save(output_dir / f"xiaobei-ragdoll-walk-{index:02d}.png")
    frames[0].save(preview, save_all=True, append_images=frames[1:], duration=125, loop=0, disposal=2, transparency=0)
    sheet = Image.new("RGB", (SIZE * 4, SIZE * 2), "#303030")
    for index, frame in enumerate(frames):
        tile = Image.new("RGBA", frame.size, "#303030")
        tile.alpha_composite(frame)
        sheet.paste(tile.convert("RGB"), ((index % 4) * SIZE, (index // 4) * SIZE))
    sheet.save(preview.with_name(f"{preview.stem}-sheet.png"))


if __name__ == "__main__":
    main()
