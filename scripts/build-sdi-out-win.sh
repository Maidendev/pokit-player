#!/usr/bin/env bash
#
# build-sdi-out-win.sh — compile the Blackmagic SDI output helper on Windows.
#
# Same source as the macOS helper (native/sdi-out/sdi-out.cpp). The DeckLink
# API is a registered COM server on Windows — DeckLinkAPI64.dll, installed by
# Desktop Video — so, as on macOS, nothing is linked against the driver: with
# no Desktop Video the helper reports no devices and exits 0.
#
# What IS needed is the header. Blackmagic ships the Windows SDK as .idl files
# (committed under native/sdi-out/sdk/Win under their redistribution licence);
# midl turns DeckLinkAPI.idl — which #includes its siblings, so one run covers
# the whole API — into DeckLinkAPI_h.h plus DeckLinkAPI_i.c, the IID and CLSID
# definitions, which is compiled in.
#
# Needs cl and midl on the PATH with INCLUDE/LIB set, i.e. a Visual Studio
# x64 developer environment: locally, run this from an "x64 Native Tools
# Command Prompt" (bash scripts/build-sdi-out-win.sh); in CI the workflow
# enters vcvars64 first.
#
# Output: src/bin/sdi-out.exe   x64, static CRT (no vcruntime to ship)
#
set -euo pipefail

# Git Bash rewrites arguments that look like POSIX paths (/nologo -> C:/...).
# Every MSVC switch below is therefore written with a dash, which both tools
# accept, and conversion is switched off for good measure.
export MSYS2_ARG_CONV_EXCL="*"
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SDK="native/sdi-out/sdk/Win/include"
GEN="native/sdi-out/build/win"      # midl output and objects; git-ignored
OUT="src/bin"

command -v cl   >/dev/null || { echo "ERROR: cl not found — run inside a Visual Studio x64 developer environment" >&2; exit 1; }
command -v midl >/dev/null || { echo "ERROR: midl not found — it is part of the Windows SDK that comes with the VS C++ tools" >&2; exit 1; }
[[ -f "$SDK/DeckLinkAPI.idl" ]] || { echo "ERROR: DeckLink Windows SDK missing at $SDK" >&2; exit 1; }

mkdir -p "$GEN" "$OUT"

echo "==> midl: DeckLinkAPI.idl -> DeckLinkAPI_h.h + DeckLinkAPI_i.c"
# -env x64 for a 64-bit build. Only the header and the IID/CLSID file are
# used; the proxy/stub and dlldata files midl also writes land in $GEN and
# are ignored. -I so the #included siblings resolve; the Windows SDK's own
# unknwn.idl comes from INCLUDE.
midl -nologo -env x64 -W1 -char signed \
  -I "$SDK" \
  -h DeckLinkAPI_h.h -iid DeckLinkAPI_i.c -notlb \
  -out "$GEN" \
  "$SDK/DeckLinkAPI.idl"

[[ -f "$GEN/DeckLinkAPI_h.h" && -f "$GEN/DeckLinkAPI_i.c" ]] || {
  echo "ERROR: midl produced no header — see its output above" >&2; exit 1; }

echo "==> cl: sdi-out.exe (x64, static CRT)"
# -MT: static CRT, so the helper runs on a machine that has only what the app
#      installer put there.
# -DNOMINMAX: windows.h would otherwise define min/max as macros and break
#      std::min / std::max in the helper.
# The .c file is midl's GUID definitions; cl compiles it as C.
cl -nologo -EHsc -O2 -std:c++17 -W3 -MT \
  -D_CRT_SECURE_NO_WARNINGS -DNOMINMAX -DWIN32_LEAN_AND_MEAN \
  -I "$GEN" -I "$SDK" \
  -Fo"$GEN/" -Fe"$OUT/sdi-out.exe" \
  native/sdi-out/sdi-out.cpp "$GEN/DeckLinkAPI_i.c" \
  -link ole32.lib oleaut32.lib uuid.lib advapi32.lib version.lib

[[ -f "$OUT/sdi-out.exe" ]] || { echo "ERROR: cl produced no executable" >&2; exit 1; }
echo "==> Built $OUT/sdi-out.exe ($(stat -c %s "$OUT/sdi-out.exe" 2>/dev/null || wc -c < "$OUT/sdi-out.exe") bytes)"

echo "==> Smoke test: enumerate devices"
# Without Desktop Video this prints [] and exits 0 after a diag line saying
# the COM server is not registered — the correct "no card here" answer.
"$OUT/sdi-out.exe" --list-devices
