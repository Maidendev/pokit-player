#!/usr/bin/env bash
#
# build-sdi-out.sh — compile the Blackmagic SDI output helper on macOS.
#
# Unlike braw-decode there is nothing to bundle: the DeckLink API is loaded at
# runtime by DeckLinkAPIDispatch.cpp from /Library/Frameworks/DeckLinkAPI.framework,
# which Blackmagic's Desktop Video installer provides on any machine that has a
# card. So this compiles on a machine with no driver at all, and the result
# simply reports no devices there.
#
# The SDK headers live IN the repo (native/sdi-out/sdk) under Blackmagic's
# redistribution licence, so this needs no download and CI can run it.
#
# Output: src/bin/sdi-out   universal (x86_64 + arm64)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SDK="native/sdi-out/sdk/Mac/include"
OUT="src/bin"

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "ERROR: macOS only for now — Windows needs the .idl compiled with midl." >&2; exit 1; }
[[ -f "$SDK/DeckLinkAPI.h" ]] || {
  echo "ERROR: DeckLink SDK headers missing at $SDK" >&2; exit 1; }

mkdir -p "$OUT"

echo "==> Compiling sdi-out (universal)"
# DeckLinkAPIDispatch.cpp is Blackmagic's own runtime loader and must be
# compiled in; it is what makes the driver a runtime dependency rather than a
# link-time one.
clang++ -std=c++17 -O2 \
  -arch x86_64 -arch arm64 \
  -I "$SDK" \
  -framework CoreFoundation \
  -o "$OUT/sdi-out" \
  native/sdi-out/sdi-out.cpp \
  "$SDK/DeckLinkAPIDispatch.cpp"

echo "==> Built $(lipo -archs "$OUT/sdi-out") -> $OUT/sdi-out"

echo "==> Smoke test: enumerate devices"
# On a machine without Desktop Video this prints [] and exits 0, which is the
# correct "no card here" answer, not a failure.
"$OUT/sdi-out" --list-devices
