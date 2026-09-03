#!/usr/bin/env bash
#
# Builds LGPL ffmpeg + ffprobe for macOS and installs them into src/bin/.
#
#   ./scripts/build-ffmpeg-macos.sh
#
# WHY WE BUILD THIS ONE OURSELVES
#
# Windows and Linux get BtbN's official LGPL builds. macOS has no equivalent:
# Homebrew, evermeet.cx and osxexperts all ship --enable-gpl builds, and the
# arm64 binary the old ffmpeg-static package downloaded was additionally
# flagged --enable-nonfree, which made it non-redistributable outright. So the
# only way to get a lawful macOS binary is to compile one.
#
# The configure line below is the point of the whole exercise. It does NOT
# pass --enable-gpl (GPL is off by default in FFmpeg), and it links no
# GPL-only library — no x264, no x265, no Xvid, no Rubber Band, no vid.stab.
# Encoding is handled by VideoToolbox, which is part of macOS.
#
# BUILD ARCHITECTURE
#
# Build natively, on a runner of the target architecture. Do not cross-build
# and do not reuse one architecture's binary for the other: shipping an arm64
# ffmpeg inside the Intel DMG is precisely the bug this replaces, and it fails
# at runtime on an Intel Mac rather than at build time where it would be seen.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/src/bin"
WORK_DIR="${FFMPEG_BUILD_DIR:-$ROOT/.ffmpeg-build}"

VERSION="$(node -p "require('$ROOT/scripts/ffmpeg-sources.json').source.version")"
URL="$(node -p "require('$ROOT/scripts/ffmpeg-sources.json').source.url")"
PINNED_SHA="$(node -p "require('$ROOT/scripts/ffmpeg-sources.json').source.sha256 || ''")"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  SUFFIX="darwin-arm64" ;;
  x86_64) SUFFIX="darwin-x64"   ;;
  *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS (got $(uname -s))." >&2
  echo "Windows and Linux binaries come from 'npm run ffmpeg:fetch'." >&2
  exit 1
fi

echo "Building LGPL FFmpeg $VERSION for $SUFFIX"

mkdir -p "$WORK_DIR" "$BIN_DIR"
cd "$WORK_DIR"

TARBALL="ffmpeg-$VERSION.tar.xz"
if [[ ! -f "$TARBALL" ]]; then
  echo "Downloading $URL"
  curl -fsSL -o "$TARBALL" "$URL"
fi

ACTUAL_SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
if [[ -z "$PINNED_SHA" || "$PINNED_SHA" == "null" ]]; then
  echo "" >&2
  echo "No source checksum is pinned for FFmpeg $VERSION." >&2
  echo "Computed: $ACTUAL_SHA" >&2
  echo "" >&2
  echo "Verify this against ffmpeg.org's published checksum, then record it in" >&2
  echo "scripts/ffmpeg-sources.json under source.sha256 and re-run." >&2
  echo "Failing closed rather than trusting a first download." >&2
  exit 1
fi
if [[ "$ACTUAL_SHA" != "$PINNED_SHA" ]]; then
  echo "SOURCE CHECKSUM MISMATCH" >&2
  echo "  expected $PINNED_SHA" >&2
  echo "  actual   $ACTUAL_SHA" >&2
  exit 1
fi
echo "Source checksum OK"

SRC_DIR="ffmpeg-$VERSION"
rm -rf "$SRC_DIR"
tar -xf "$TARBALL"
cd "$SRC_DIR"

# ---------------------------------------------------------------------------
# LGPL configure line.
#
# Deliberately absent: --enable-gpl, --enable-nonfree, and every GPL-only
# external library. scripts/verify-ffmpeg-license.js re-checks the built
# artefact, so a mistake here fails the build rather than shipping.
#
# --enable-videotoolbox gives hardware H.264 encode and decode on every Mac
# that runs macOS 10.13+, which covers everything Electron 28 supports. It is
# an OS framework, so it adds no third-party licence obligation and no
# external dependency to build.
# ---------------------------------------------------------------------------
./configure \
  --prefix="$WORK_DIR/prefix-$SUFFIX" \
  --arch="$ARCH" \
  --cc=clang \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --disable-network \
  --disable-autodetect \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-zlib \
  --enable-coreimage \
  --enable-avfoundation \
  --enable-runtime-cpudetect

make -j"$(sysctl -n hw.ncpu)"

install -m 0755 ffmpeg  "$BIN_DIR/ffmpeg-$SUFFIX"
install -m 0755 ffprobe "$BIN_DIR/ffprobe-$SUFFIX"

# The LGPL text has to travel with the binaries we redistribute.
install -m 0644 COPYING.LGPLv2.1 "$BIN_DIR/FFMPEG-LICENSE.txt"

cd "$ROOT"

echo ""
echo "Installed:"
echo "  src/bin/ffmpeg-$SUFFIX"
echo "  src/bin/ffprobe-$SUFFIX"
echo ""

node "$ROOT/scripts/verify-ffmpeg-license.js"
