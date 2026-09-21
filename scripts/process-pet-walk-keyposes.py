#!/usr/bin/env python3
"""Normalize green-screen Xiaobei gait key poses into runtime frames."""

from pathlib import Path
import sys

from PIL import Image


FRAME_SIZE = 256
TARGET_WIDTH = 238
TARGET_HEIGHT = 214
BASELINE = 240


def remove_green(image):
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, _ = pixels[x, y]
            if green > 85 and green > red * 1.16 and green > blue * 1.12:
                pixels[x, y] = (red, green, blue, 0)
    return rgba


def normalize(image):
    keyed = remove_green(image)
    bounds = keyed.getbbox()
    if not bounds:
        raise ValueError("key pose contains no visible subject")
    subject = keyed.crop(bounds)
    scale = min(TARGET_WIDTH / subject.width, TARGET_HEIGHT / subject.height)
    size = (max(1, round(subject.width * scale)), max(1, round(subject.height * scale)))
    subject = subject.resize(size, Image.Resampling.NEAREST)
    frame = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
    left = (FRAME_SIZE - subject.width) // 2
    top = BASELINE - subject.height
    frame.alpha_composite(subject, (left, top))
    return frame


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: process-pet-walk-keyposes.py OUTPUT_DIR PREVIEW_GIF INPUT...")
    output_dir = Path(sys.argv[1])
    preview = Path(sys.argv[2])
    inputs = [Path(value) for value in sys.argv[3:]]
    output_dir.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)

    frames = [normalize(Image.open(path)) for path in inputs]
    for index, frame in enumerate(frames, start=1):
        frame.save(output_dir / f"xiaobei-ragdoll-walk-{index:02d}.png")

    frames[0].save(
        preview,
        save_all=True,
        append_images=frames[1:],
        duration=145,
        loop=0,
        disposal=2,
        transparency=0,
    )

    sheet = Image.new("RGB", (FRAME_SIZE * len(frames), FRAME_SIZE), "#303030")
    for index, frame in enumerate(frames):
        tile = Image.new("RGBA", frame.size, "#303030")
        tile.alpha_composite(frame)
        sheet.paste(tile.convert("RGB"), (index * FRAME_SIZE, 0))
    sheet.save(preview.with_name(f"{preview.stem}-sheet.png"))


if __name__ == "__main__":
    main()
