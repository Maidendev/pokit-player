#!/usr/bin/env bash
#
# extract-braw-sdk.sh — unpack the Blackmagic RAW SDK from the installers.
#
# Blackmagic do not ship the SDK as a plain archive. It is a payload inside the
# Blackmagic RAW *installer*, and the download is behind a Blackmagic account,
# so it cannot be fetched automatically. Put the installers in
# native/braw-decode/sdk/ and this pulls the SDK out of them WITHOUT installing
# anything system-wide:
#
#   native/braw-decode/sdk/Blackmagic_RAW_<ver>.dmg          (macOS)
#   native/braw-decode/sdk/Install Blackmagic RAW <ver>.msi  (Windows)
#
# Result:
#
#   native/braw-decode/sdk/Mac/Include      BlackmagicRawAPI.h
#   native/braw-decode/sdk/Mac/Libraries    BlackmagicRawAPI.framework (universal)
#   native/braw-decode/sdk/Win/Include      BlackmagicRawAPIDispatch.h
#   native/braw-decode/sdk/Linux/Include    BlackmagicRawAPI.h, LinuxCOM.h
#   native/braw-decode/sdk/Media            sample.braw, for testing
#
# Samples and PDFs are skipped — only what the build and the tests need.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT/native/braw-decode/sdk"
WORK="${TMPDIR:-/tmp}/braw-sdk-extract.$$"
MOUNT=""

cleanup() {
  [[ -n "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  # pkgutil --expand-full reproduces the payload's permissions, which include
  # read-only directories, so they have to be made writable before removal.
  [[ -d "$WORK" ]] && chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

info() { echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die \
  "This script needs macOS: it uses hdiutil and pkgutil to open the .dmg payload.
   On Windows, extract the .msi with 'msiexec /a <msi> /qb TARGETDIR=<dir>' or 7-Zip
   and copy the 'Blackmagic RAW SDK' folder to $SDK_DIR."

DMG=$(find "$SDK_DIR" -maxdepth 1 -iname "*.dmg" | head -1) || true
[[ -n "${DMG:-}" ]] || die "No .dmg found in $SDK_DIR
   Download Blackmagic RAW from
   https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software
   and put the installer there."

mkdir -p "$WORK"

info "Mounting $(basename "$DMG")"
# -nobrowse keeps it out of Finder; -readonly guarantees the image is untouched.
MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" 2>/dev/null \
          | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
[[ -n "$MOUNT" ]] || die "Could not mount $DMG"

PKG=$(find "$MOUNT" -maxdepth 1 -iname "*.pkg" | head -1)
[[ -n "$PKG" ]] || die "No .pkg inside the disk image"

# --expand-full unpacks the payload to a directory. It does NOT run the
# installer, so nothing is written outside $WORK.
info "Expanding $(basename "$PKG") (not installing)"
pkgutil --expand-full "$PKG" "$WORK/expanded" >/dev/null

SRC=$(find "$WORK/expanded" -type d -name "Blackmagic RAW SDK" | head -1)
[[ -n "$SRC" ]] || die "No 'Blackmagic RAW SDK' folder in the installer payload"

info "Found SDK payload"
for part in Mac/Include Mac/Libraries Win/Include Linux/Include Media; do
  if [[ -e "$SRC/$part" ]]; then
    mkdir -p "$SDK_DIR/$(dirname "$part")"
    rm -rf "$SDK_DIR/$part"
    cp -R "$SRC/$part" "$SDK_DIR/$part"
    echo "    $part  ($(du -sh "$SDK_DIR/$part" | cut -f1))"
  else
    echo "    $part  — not present, skipped"
  fi
done

# The licence has to travel with anything we redistribute.
for doc in "License.rtf" "Third Party Licenses.rtf"; do
  [[ -f "$SRC/Documents/$doc" ]] && cp "$SRC/Documents/$doc" "$SDK_DIR/" || true
done

HDR="$SDK_DIR/Mac/Include/BlackmagicRawAPI.h"
FW="$SDK_DIR/Mac/Libraries/BlackmagicRawAPI.framework"
[[ -f "$HDR" ]] || die "Header missing after extraction: $HDR"
[[ -d "$FW" ]]  || die "Framework missing after extraction: $FW"

echo
info "Ready. Framework architectures: $(lipo -archs "$FW/Versions/A/BlackmagicRawAPI" 2>/dev/null || echo unknown)"
info "Build with: cmake -S native/braw-decode -B native/braw-decode/build && cmake --build native/braw-decode/build"
