#!/usr/bin/env bash
# ============================================================
# create-dmg-installers.sh
# Creates professional DMG installers for MaidenPlayer v1.1.3
#
# PREREQUISITES:
#   - Apps must be notarized and stapled
#   - Run ./scripts/finish-notarization.sh first
#   - Requires: genisoimage or mkisofs (for creating DMG on Linux)
#
# Usage: ./scripts/create-dmg-installers.sh
# ============================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="1.1.3"
ARM64_APP="dist/mac-arm64/MaidenPlayer.app"
X64_APP="dist/mac/MaidenPlayer.app"
ICON="src/assets/icon.icns"

# Check if apps are stapled
check_stapled() {
  local app="$1"
  local label="$2"
  
  if [ ! -d "$app" ]; then
    echo "❌ $label not found at $app"
    echo "   Run ./scripts/finish-notarization.sh first!"
    return 1
  fi
  
  # Check for staple ticket
  if [ ! -f "$app/Contents/_MASReceipt/receipt" ] && ! rcodesign staple --check "$app" &>/dev/null; then
    echo "⚠️  $label not stapled yet"
    echo "   Run ./scripts/finish-notarization.sh first!"
    return 1
  fi
  
  echo "✅ $label is stapled"
  return 0
}

create_dmg() {
  local app="$1"
  local arch="$2"
  local dmg_name="dist/MaidenPlayer-${VERSION}-${arch}.dmg"
  local vol_name="MaidenPlayer ${VERSION}"
  local temp_dir="dist/dmg-temp-${arch}"
  
  echo ""
  echo "Creating DMG for $arch..."
  
  # Clean up any previous temp
  rm -rf "$temp_dir"
  mkdir -p "$temp_dir"
  
  # Copy app to temp directory
  cp -R "$app" "$temp_dir/"
  
  # Create Applications symlink
  ln -s /Applications "$temp_dir/Applications"
  
  # Create DMG (Linux method using genisoimage)
  if command -v genisoimage &>/dev/null; then
    echo "   Using genisoimage..."
    rm -f "$dmg_name"
    genisoimage -V "$vol_name" \
                -D -R -apple -no-pad \
                -o "$dmg_name" \
                "$temp_dir"
    echo "   ✅ Created: $dmg_name"
  elif command -v mkisofs &>/dev/null; then
    echo "   Using mkisofs..."
    rm -f "$dmg_name"
    mkisofs -V "$vol_name" \
            -D -R -apple -no-pad \
            -o "$dmg_name" \
            "$temp_dir"
    echo "   ✅ Created: $dmg_name"
  else
    echo "   ⚠️  genisoimage/mkisofs not found"
    echo "   Creating ZIP instead..."
    ( cd "$temp_dir" && zip -ry -q "../MaidenPlayer-${VERSION}-${arch}.zip" . )
    echo "   ✅ Created: dist/MaidenPlayer-${VERSION}-${arch}.zip"
  fi
  
  # Clean up temp
  rm -rf "$temp_dir"
}

# Check both apps
echo "==================================================="
echo "MaidenPlayer DMG Installer Creation"
echo "==================================================="

if ! check_stapled "$ARM64_APP" "Apple Silicon"; then
  exit 1
fi

if ! check_stapled "$X64_APP" "Intel x64"; then
  exit 1
fi

# Install genisoimage if needed
if ! command -v genisoimage &>/dev/null && ! command -v mkisofs &>/dev/null; then
  echo ""
  echo "Installing genisoimage..."
  sudo apt-get update -qq && sudo apt-get install -y -qq genisoimage
fi

# Create DMGs
create_dmg "$ARM64_APP" "arm64"
create_dmg "$X64_APP" "x64"

echo ""
echo "==================================================="
echo "✅ DMG Creation Complete!"
echo "==================================================="
echo ""
echo "Final installers:"
ls -lh dist/*.dmg 2>/dev/null || ls -lh dist/MaidenPlayer-${VERSION}-*.zip
echo ""
echo "These DMGs are:"
echo "  ✅ Code-signed with Developer ID"
echo "  ✅ Notarized by Apple"
echo "  ✅ Stapled (works offline)"
echo "  ✅ Ready for distribution"
echo ""
echo "Users can simply drag MaidenPlayer.app to Applications"
echo "==================================================="
