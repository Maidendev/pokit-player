#!/usr/bin/env bash
# ============================================================
# check-notarization-status.sh
# Quick status checker for MaidenPlayer v1.1.3 notarization
#
# Usage: ./scripts/check-notarization-status.sh
# ============================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ARM64_ID="31f20653-1394-4d95-af18-e0d6fe98e8d0"
X64_ID="a02e1d0e-836e-4b83-bb8b-34a213409eae"
KEY=.asc-api-key.json

if [ ! -f "$KEY" ]; then
  echo "❌ Missing $KEY — regenerating..."
  rcodesign encode-app-store-connect-api-key \
    7b481341-30a7-49d5-bf51-4294c1d3adf2 \
    J7PXFQ9BY3 \
    AuthKey_J7PXFQ9BY3.p8 > "$KEY"
  echo "✅ Regenerated $KEY"
fi

echo "==================================================="
echo "MaidenPlayer v1.1.3 Notarization Status"
echo "==================================================="
echo ""

get_status() {
  rcodesign notary-list --api-key-file "$KEY" 2>/dev/null | grep "$1" | head -1
}

echo "🍎 Apple Silicon (arm64):"
arm_status=$(get_status "$ARM64_ID")
echo "   $arm_status"
if echo "$arm_status" | grep -q "accepted"; then
  echo "   ✅ READY TO STAPLE!"
elif echo "$arm_status" | grep -q "in progress"; then
  echo "   ⏳ Still processing... (check again later)"
elif echo "$arm_status" | grep -q "invalid\|rejected"; then
  echo "   ❌ FAILED - run finish script to see log"
fi

echo ""
echo "💻 Intel (x64):"
x64_status=$(get_status "$X64_ID")
echo "   $x64_status"
if echo "$x64_status" | grep -q "accepted"; then
  echo "   ✅ READY TO STAPLE!"
elif echo "$x64_status" | grep -q "in progress"; then
  echo "   ⏳ Still processing... (check again later)"
elif echo "$x64_status" | grep -q "invalid\|rejected"; then
  echo "   ❌ FAILED - run finish script to see log"
fi

echo ""
echo "==================================================="
if echo "$arm_status $x64_status" | grep -q "accepted.*accepted"; then
  echo "✅ BOTH BUILDS APPROVED! Run:"
  echo "   ./scripts/finish-notarization.sh"
  echo "   to staple tickets and create final installers"
elif echo "$arm_status $x64_status" | grep -q "in progress"; then
  echo "⏳ Still waiting on Apple (typically 24-72h for"
  echo "   first-time developer submissions)"
  echo ""
  echo "   Check again with: ./scripts/check-notarization-status.sh"
fi
echo "==================================================="
