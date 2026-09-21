#!/usr/bin/env python3
"""Remove generated outer halos from pet frames without touching white fur."""

import importlib.util
from pathlib import Path
import sys

from PIL import Image


def load_edge_tools(script_path):
    spec = importlib.util.spec_from_file_location("pet_walk_warp", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: clean-pet-asset-edges.py PET_ASSET_DIR")
    root = Path(sys.argv[1])
    tools = load_edge_tools(Path(__file__).with_name("build-pet-walk-warp.py"))
    count = 0
    for path in sorted(root.glob("*/*.png")):
        if path.parent.name == "Walk":
            continue
        image = Image.open(path).convert("RGBA")
        # Original action frames contain fine ears, cheek fur and whisker pixels.
        # Morphological silhouette pruning removes those real parts, so non-Walk
        # actions only receive chroma cleanup and detached-speck cleanup.
        cleaned = tools.remove_tiny_islands(
            tools.remove_chroma_fringe(image)
        )
        cleaned.save(path)
        count += 1
    print(f"cleaned {count} pet frames")


if __name__ == "__main__":
    main()
