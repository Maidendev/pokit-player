#!/bin/bash
# ─────────────────────────────────────────────────────────
# MaidenPlayer — Verify macOS Code Signing & Notarization
#
# Usage:
#   ./scripts/verify-signing.sh [path-to-app]
#
# If no path is given, looks for MaidenPlayer.app in dist/
# ─────────────────────────────────────────────────────────

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

APP_PATH="${1:-}"

# Auto-detect .app in dist/
if [ -z "$APP_PATH" ]; then
  if [ -d "dist/mac-arm64/MaidenPlayer.app" ]; then
    APP_PATH="dist/mac-arm64/MaidenPlayer.app"
  elif [ -d "dist/mac/MaidenPlayer.app" ]; then
    APP_PATH="dist/mac/MaidenPlayer.app"
  else
    echo -e "${RED}Error: No .app found. Provide path as argument or build first.${NC}"
    echo "Usage: $0 /path/to/MaidenPlayer.app"
    exit 1
  fi
fi

echo -e "${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  MaidenPlayer — Signing Verification Report${NC}"
echo -e "${CYAN}════════════════════════════════════════════════${NC}"
echo ""
echo -e "App: ${YELLOW}${APP_PATH}${NC}"
echo ""

# ─── 1. Code Signature Check ───────────────────
echo -e "${CYAN}1. Code Signature${NC}"
echo "─────────────────────────────────────────────"
if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
  echo -e "${GREEN}✅ Code signature is valid${NC}"
else
  echo -e "${RED}❌ Code signature verification FAILED${NC}"
fi
echo ""

# ─── 2. Signing Identity ──────────────────────
echo -e "${CYAN}2. Signing Identity${NC}"
echo "─────────────────────────────────────────────"
codesign --display --verbose=4 "$APP_PATH" 2>&1 | grep -E "Authority|TeamIdentifier|Identifier|Sealed|Format|Timestamp"
echo ""

# ─── 3. Entitlements ─────────────────────────
echo -e "${CYAN}3. Entitlements${NC}"
echo "─────────────────────────────────────────────"
codesign --display --entitlements - "$APP_PATH" 2>&1
echo ""

# ─── 4. Hardened Runtime ────────────────────
echo -e "${CYAN}4. Hardened Runtime${NC}"
echo "─────────────────────────────────────────────"
FLAGS=$(codesign --display --verbose "$APP_PATH" 2>&1 | grep "flags")
echo "$FLAGS"
if echo "$FLAGS" | grep -q "runtime"; then
  echo -e "${GREEN}✅ Hardened runtime is enabled${NC}"
else
  echo -e "${YELLOW}⚠️  Hardened runtime NOT detected${NC}"
fi
echo ""

# ─── 5. Gatekeeper Assessment ──────────────
echo -e "${CYAN}5. Gatekeeper Assessment${NC}"
echo "─────────────────────────────────────────────"
if spctl --assess --type execute --verbose=4 "$APP_PATH" 2>&1; then
  echo -e "${GREEN}✅ Gatekeeper accepts this app${NC}"
else
  echo -e "${YELLOW}⚠️  Gatekeeper does not accept this app (may need notarization)${NC}"
fi
echo ""

# ─── 6. Notarization Check ─────────────────
echo -e "${CYAN}6. Notarization Ticket${NC}"
echo "─────────────────────────────────────────────"
if stapler validate "$APP_PATH" 2>&1; then
  echo -e "${GREEN}✅ Notarization ticket is stapled${NC}"
else
  echo -e "${YELLOW}⚠️  No notarization ticket found (app may not be notarized)${NC}"
fi
echo ""

# ─── 7. Bundled Binaries Check ──────────────
echo -e "${CYAN}7. Bundled Binary Signatures${NC}"
echo "─────────────────────────────────────────────"
HELPERS=$(find "$APP_PATH" -name "*.app" -o -name "MaidenPlayer" -path "*/MacOS/*" | head -10)
for helper in $HELPERS; do
  echo -n "  $(basename "$helper"): "
  if codesign --verify --strict "$helper" 2>/dev/null; then
    echo -e "${GREEN}signed${NC}"
  else
    echo -e "${YELLOW}unsigned or ad-hoc${NC}"
  fi
done

# Check ffmpeg binaries
FFMPEG_BINS=$(find "$APP_PATH" -name "ffmpeg-darwin*" 2>/dev/null)
for bin in $FFMPEG_BINS; do
  echo -n "  $(basename "$bin"): "
  if codesign --verify "$bin" 2>/dev/null; then
    echo -e "${GREEN}signed${NC}"
  else
    echo -e "${YELLOW}unsigned (expected — listed in signIgnore)${NC}"
  fi
done
echo ""

echo -e "${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Verification complete${NC}"
echo -e "${CYAN}════════════════════════════════════════════════${NC}"
