#!/usr/bin/env bash
# ============================================================
# finish-notarization.sh
# Completes notarization for PokitPlayer v1.1.3 once Apple's
# Notary service finishes processing the already-submitted apps.
#
# WHY THIS EXISTS:
#   The apps were correctly signed (Developer ID) and SUBMITTED to
#   Apple. In 2026 Apple frequently holds first-time-developer
#   submissions 24-72h for "in-depth analysis". This script checks
#   the submission status and, once "accepted", staples the ticket
#   and produces final distributable zips. Safe to run repeatedly.
#
# WORKS ON LINUX (uses rcodesign) OR MACOS (can use xcrun instead).
#
# Usage (Linux, from project root):
#   ./scripts/finish-notarization.sh
#
# Requires: .asc-api-key.json  (regenerate via the command in
#           NOTARIZATION_STATUS.md if it was deleted), and the
#           signed app bundles in dist/mac-arm64 and dist/mac.
# ============================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
KEY=.asc-api-key.json
ARM64_ID="31f20653-1394-4d95-af18-e0d6fe98e8d0"
X64_ID="a02e1d0e-836e-4b83-bb8b-34a213409eae"

[ -f "$KEY" ] || { echo "Missing $KEY — regenerate it (see NOTARIZATION_STATUS.md)"; exit 1; }

status_of(){ rcodesign notary-list --api-key-file "$KEY" 2>/dev/null | grep "$1" | grep -oE "(in progress|accepted|invalid|rejected)$"; }

finish(){  # $1=id $2=appPath $3=label $4=zipName
  local st; st=$(status_of "$1")
  echo ">> $3 [$1]: ${st:-unknown}"
  case "$st" in
    accepted)
      echo "   stapling..."
      rcodesign staple "$2" && echo "   STAPLED OK"
      ( cd "$(dirname "$2")" && zip -ry -q "../$4" "$(basename "$2")" ) && echo "   packaged dist/$4"
      ;;
    invalid|rejected)
      echo "   FAILED Apple validation. Fetching log:"
      rcodesign notary-log --api-key-file "$KEY" "$1" 2>&1 | tail -30
      ;;
    *) echo "   still processing — re-run later." ;;
  esac
}

finish "$ARM64_ID" "dist/mac-arm64/PokitPlayer.app" "arm64" "PokitPlayer-1.1.3-arm64-notarized.zip"
finish "$X64_ID"   "dist/mac/PokitPlayer.app"        "x64"   "PokitPlayer-1.1.3-x64-notarized.zip"
echo "Done. Final artifacts (if accepted):"
ls -lh dist/PokitPlayer-1.1.3-*-notarized.zip 2>/dev/null || echo "  (none yet)"
