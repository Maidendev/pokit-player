#!/usr/bin/env bash
# ============================================================
# notarize-linux.sh — Sign + Notarize + Staple MaidenPlayer
# entirely on Linux using rcodesign (no macOS required).
#
# Apple's notarization from Linux REQUIRES an App Store Connect
# API key (.p8) — the Apple-ID + app-specific-password flow only
# works with Apple's `notarytool` on macOS.
#
# Generate an API key here (role: Developer or Admin):
#   https://appstoreconnect.apple.com/access/api
# You will get:
#   - Issuer ID   (UUID, e.g. 57246542-96fe-1a63-e053-0824d011072a)
#   - Key ID      (e.g. 2X9R4HXF34)
#   - AuthKey_<KeyID>.p8  (download once)
#
# Usage:
#   ./scripts/notarize-linux.sh \
#       --issuer <ISSUER_ID> \
#       --key-id <KEY_ID> \
#       --p8 /path/to/AuthKey_<KEY_ID>.p8
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CERT="${CSC_LINK:-Certificates.p12}"
# No default. The .p12 password is a secret and must come from the environment
# or --cert-password; a literal default here ends up committed to the repo.
CERT_PW="${CSC_KEY_PASSWORD:-}"
ENTITLEMENTS="entitlements.mac.plist"
ISSUER=""; KEY_ID=""; P8=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issuer) ISSUER="$2"; shift 2;;
    --key-id) KEY_ID="$2"; shift 2;;
    --p8)     P8="$2"; shift 2;;
    --cert)   CERT="$2"; shift 2;;
    --cert-password) CERT_PW="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$ISSUER" || -z "$KEY_ID" || -z "$P8" ]]; then
  echo "ERROR: --issuer, --key-id and --p8 are all required."
  echo "Get them at https://appstoreconnect.apple.com/access/api"
  exit 1
fi

if [[ -z "$CERT_PW" ]]; then
  echo "ERROR: certificate password not set."
  echo "Pass --cert-password, or export CSC_KEY_PASSWORD."
  exit 1
fi

command -v rcodesign >/dev/null || { echo "rcodesign not found in PATH"; exit 1; }

# 1. Encode the API key into a single JSON file rcodesign understands
API_JSON="$ROOT/.asc-api-key.json"
echo "==> Encoding App Store Connect API key..."
rcodesign encode-app-store-connect-api-key \
  "$ISSUER" "$KEY_ID" "$P8" > "$API_JSON"

APPS=( "dist/mac-arm64/MaidenPlayer.app" "dist/mac/MaidenPlayer.app" )

for APP in "${APPS[@]}"; do
  [[ -d "$APP" ]] || { echo "Skip (missing): $APP"; continue; }
  echo ""
  echo "=================================================="
  echo "  Processing: $APP"
  echo "=================================================="

  # 2. (Re)sign with hardened runtime + entitlements
  echo "==> Signing..."
  rcodesign sign \
    --p12-file "$CERT" --p12-password "$CERT_PW" \
    --code-signature-flags runtime \
    --entitlements-xml-path "$ENTITLEMENTS" \
    "$APP"

  # 3. Notarize and staple (rcodesign zips the .app, uploads, waits, staples)
  echo "==> Notarizing + stapling (this can take 1-5 min)..."
  rcodesign notary-submit \
    --api-key-file "$API_JSON" \
    --staple \
    "$APP"

  echo "==> Done: $APP is signed, notarized and stapled."
done

rm -f "$API_JSON"

# 4. Re-zip the stapled apps for distribution
echo ""
echo "==> Re-packaging notarized apps into distributable ZIPs..."
( cd dist/mac-arm64 && zip -ry -q ../MaidenPlayer-1.1.3-arm64-notarized.zip "MaidenPlayer.app" )
( cd dist/mac       && zip -ry -q ../MaidenPlayer-1.1.3-x64-notarized.zip   "MaidenPlayer.app" )

echo ""
echo "ALL DONE. Notarized, stapled, distributable artifacts:"
ls -lh dist/MaidenPlayer-1.1.3-*-notarized.zip
echo ""
echo "These ZIPs contain stapled .app bundles — they open on any Mac"
echo "with no 'unidentified developer' warning, even offline."
