#!/usr/bin/env python3
"""Suppress green-screen spill on the pet's light fur without touching the silhouette.

`clean-pet-asset-edges.py` delegates to `remove_chroma_fringe()`, which only looks at
pixels within 2px of a transparent pixel and removes them by setting alpha to 0. That
leaves the *interior* spill untouched: the feline coat keeps a measurable green cast
(up to G+16 over max(R,B)) on ~28k opaque pixels, which reads as a faint green tinge on
the white fur. Deleting those pixels instead would eat the coat, which is exactly how
the ears got clipped earlier.

This pass only rewrites the green channel: for pixels where green dominates the other
two channels, green is clamped down to max(red, blue). Alpha, red and blue are never
modified, so the silhouette and every real detail stay pixel-identical.

usage: fix-pet-green-spill.py PET_ASSET_DIR [--threshold N] [--dry-run]
"""

import argparse
from pathlib import Path
import sys

from PIL import Image


def fix_frame(frame, threshold):
    """Return (new_frame, changed_pixels). threshold is the minimum cast to rewrite."""
    cleaned = frame.copy()
    pixels = cleaned.load()
    width, height = cleaned.size
    changed = 0
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            ceiling = red if red > blue else blue
            if green - ceiling < threshold:
                continue
            pixels[x, y] = (red, ceiling, blue, alpha)
            changed += 1
    return cleaned, changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("asset_dir")
    parser.add_argument("--threshold", type=int, default=2,
                        help="minimum green cast (G - max(R,B)) to rewrite; default 2")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.asset_dir)
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")

    total_changed = 0
    total_pixels = 0
    rows = []
    for path in sorted(root.glob("*/*.png")):
        image = Image.open(path).convert("RGBA")
        cleaned, changed = fix_frame(image, args.threshold)
        total_changed += changed
        total_pixels += image.size[0] * image.size[1]
        rows.append((path.parent.name, path.name, changed))
        if changed and not args.dry_run:
            cleaned.save(path)

    action = "would fix" if args.dry_run else "fixed"
    for anim, name, changed in rows:
        if changed:
            print(f"  {anim:14s} {name}: {changed}")
    print(f"{action} {total_changed} pixels across {len(rows)} frames "
          f"(threshold={args.threshold})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
