#!/usr/bin/env python3
"""
generate-icons.py — regenerate the MaidenPlayer app icon set from the master logo.

The four files in src/assets/ are binaries, so a diff tells you nothing about
how they were made. This script is the record: run it after changing
LOGO/Maiden PLAYER_icon.png and the whole set is rebuilt consistently.

    python scripts/generate-icons.py

Requires Pillow (pip install pillow). Runs anywhere — the .icns is written
directly rather than shelling out to macOS `iconutil`.

Outputs:
    src/assets/icon.png       512x512   (Linux target, and generic use)
    src/assets/icon_1024.png  1024x1024 (master reference)
    src/assets/icon.ico       16..256   (Windows target + file associations)
    src/assets/icon.icns      16..1024  (macOS target)
"""

import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "LOGO" / "Maiden PLAYER_icon.png"
OUT = ROOT / "src" / "assets"

# Windows .ico members.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# macOS .icns members: (OSType, pixel dimension). The @2x retina types (ic11,
# ic12, ic13, ic14) carry the same pixels as their 1x counterparts at double
# resolution, which is why sizes repeat.
ICNS_TYPES = [
    (b"icp4", 16),
    (b"ic11", 32),
    (b"icp5", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic13", 256),
    (b"ic08", 256),
    (b"ic14", 512),
    (b"ic09", 512),
    (b"ic10", 1024),
]


def main():
    if not SRC.exists():
        sys.exit(f"Master logo not found: {SRC}")

    src = Image.open(SRC).convert("RGBA")
    print(f"source: {SRC.name} {src.size} {src.mode}")
    if src.size[0] != src.size[1]:
        print("  warning: source is not square; icons will be distorted")

    OUT.mkdir(parents=True, exist_ok=True)

    cache = {}

    def resized(n):
        if n not in cache:
            cache[n] = src.resize((n, n), Image.LANCZOS)
        return cache[n]

    def png_bytes(n):
        buf = io.BytesIO()
        resized(n).save(buf, "PNG", optimize=True)
        return buf.getvalue()

    resized(512).save(OUT / "icon.png", "PNG", optimize=True)
    resized(1024).save(OUT / "icon_1024.png", "PNG", optimize=True)
    resized(256).save(OUT / "icon.ico", "ICO", sizes=[(n, n) for n in ICO_SIZES])

    # .icns is a flat sequence of length-prefixed, PNG-payload chunks behind an
    # 8-byte header holding the total file length.
    body = b""
    for ostype, dim in ICNS_TYPES:
        data = png_bytes(dim)
        body += ostype + struct.pack(">I", len(data) + 8) + data
    (OUT / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)

    for name in ("icon.png", "icon_1024.png", "icon.ico", "icon.icns"):
        path = OUT / name
        im = Image.open(path)
        extra = f"  members={sorted(im.ico.sizes())}" if name.endswith(".ico") else ""
        print(f"  {name:15} {str(im.size):12} {im.mode}  {path.stat().st_size:>9,} bytes{extra}")


if __name__ == "__main__":
    main()
