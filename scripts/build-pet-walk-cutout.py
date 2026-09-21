#!/usr/bin/env python3
"""Animate one locked Xiaobei master by moving its own leg cutouts."""

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageEnhance


SIZE = 256
LEG_Y = 176
GROUND_Y = 240


def extract(master, box, darken=1.0):
    left, top, right, bottom = box
    limb = Image.new("RGBA", master.size, (0, 0, 0, 0))
    crop = master.crop(box)
    if darken != 1:
        rgb = ImageEnhance.Brightness(crop.convert("RGB")).enhance(darken)
        rgb.putalpha(crop.getchannel("A"))
        crop = rgb
    limb.alpha_composite(crop, (left, top))
    return limb


def shift(image, x, y):
    moved = Image.new("RGBA", image.size, (0, 0, 0, 0))
    moved.alpha_composite(image, (x, y))
    return moved


def pose(frame, phase):
    local = (frame - phase) % 8
    if local == 0:
        return -7, -3
    if local == 1:
        return 8, -8
    return round(8 - (local - 1) * 2.5), 0


def clear_original_legs(master):
    body = master.copy()
    pixels = body.load()
    for y in range(188, SIZE):
        for x in range(42, 239):
            pixels[x, y] = (0, 0, 0, 0)
    return body


def build(master, index):
    # Both near and far limbs come from this exact master; far limbs are only dimmed.
    rear = extract(master, (42, LEG_Y, 126, 245))
    front = extract(master, (157, LEG_Y, 239, 245))
    rear_far = extract(master, (42, LEG_Y, 126, 245), 0.82)
    front_far = extract(master, (157, LEG_Y, 239, 245), 0.84)
    body = clear_original_legs(master)
    frame = Image.new("RGBA", master.size, (0, 0, 0, 0))

    for limb, phase in ((rear_far, 0), (front_far, 4), (rear, 2), (front, 6)):
        x, y = pose(index, phase)
        frame.alpha_composite(shift(limb, x, y))
    frame.alpha_composite(body)

    # Close only the small cut seam under the torso; all identity-bearing pixels remain untouched.
    draw = ImageDraw.Draw(frame)
    draw.line([(83, 187), (171, 188)], fill=(255, 255, 255, 255), width=7)
    draw.line([(87, 186), (168, 187)], fill=(45, 36, 30, 255), width=3)
    return frame


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: build-pet-walk-cutout.py MASTER OUTPUT_DIR PREVIEW_GIF")
    master = Image.open(sys.argv[1]).convert("RGBA")
    output_dir = Path(sys.argv[2])
    preview = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)
    frames = [build(master, index) for index in range(8)]
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
