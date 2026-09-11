#!/usr/bin/env bash
#
# build-braw-decode.sh — compile the Blackmagic RAW helper on macOS.
#
# CMakeLists.txt is the cross-platform build; this is the direct clang route,
# so a machine without CMake installed can still produce the helper. Both put
# the result in the same place.
#
# Prerequisite: scripts/extract-braw-sdk.sh has unpacked the SDK into
# native/braw-decode/sdk/.
#
# Outputs:
#   src/bin/braw-decode                     universal (x86_64 + arm64)
#   src/bin/BlackmagicRawAPI.framework      the runtime library, beside it
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SDK="native/braw-decode/sdk/Mac"
OUT="src/bin"

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "ERROR: macOS only. Use CMakeLists.txt on Windows and Linux." >&2; exit 1; }

[[ -f "$SDK/Include/BlackmagicRawAPI.h" ]] || {
  echo "ERROR: SDK headers missing. Run scripts/extract-braw-sdk.sh first." >&2; exit 1; }

mkdir -p "$OUT"

echo "==> Compiling braw-decode (universal)"
# Universal so the one binary serves both the Intel and Apple Silicon bundles;
# the shipped framework carries both slices already, so this is free.
#
# The framework is LINKED, not dlopen'd: only CreateBlackmagicRawFactoryInstance
# is exported (the ...FromPath variants the SDK samples call are declared in the
# header but absent from the macOS framework), so the dynamic loader has to find
# it. -rpath @loader_path is what lets it be found beside the executable.
clang++ -std=c++17 -O2 \
  -arch x86_64 -arch arm64 \
  -I "$SDK/Include" \
  -F "$SDK/Libraries" \
  -framework CoreFoundation \
  -framework BlackmagicRawAPI \
  -Wl,-rpath,@loader_path \
  -o "$OUT/braw-decode" \
  native/braw-decode/braw-decode.cpp

echo "==> Copying BlackmagicRawAPI.framework beside it"
# The whole bundle, not just the top-level binary: the framework loads its own
# inner decoders (DecoderMetal, DecoderOpenCL, the AVX helpers) relative to
# itself, and fails at decode time without them.
rm -rf "$OUT/BlackmagicRawAPI.framework"
cp -R "$SDK/Libraries/BlackmagicRawAPI.framework" "$OUT/"

echo "==> Built $(lipo -archs "$OUT/braw-decode") -> $OUT/braw-decode"

if [[ -f "native/braw-decode/sdk/Media/sample.braw" ]]; then
  echo "==> Smoke test against the SDK's sample clip"
  "$OUT/braw-decode" --info "native/braw-decode/sdk/Media/sample.braw" \
    | python3 -c 'import json,sys
d = json.load(sys.stdin)
print("    {} {}x{} {} fps, {} frames".format(
    d["codecFriendly"], d["width"], d["height"], d["frameRate"], d["frameCount"]))'
fi
