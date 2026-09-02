#!/usr/bin/env bash
#
# MaidenPlayer — Signed & Notarized macOS Build Script
# ===================================================
#
# This script takes your Apple Developer credentials, configures the signing
# environment, and produces a fully SIGNED and NOTARIZED macOS build
# (.dmg + .zip for both Apple Silicon / arm64 and Intel / x64).
#
# ⚠️  This MUST be run on a macOS machine. Code signing and notarization
#     require Apple's `codesign`, `notarytool`, and `stapler` tools which
#     only exist on macOS.
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#
#   ./scripts/sign-and-build-mac.sh \
#       --cert            /path/to/DeveloperID.p12 \
#       --cert-password   "your-p12-export-password" \
#       --apple-id        "you@example.com" \
#       --apple-password  "abcd-efgh-ijkl-mnop" \
#       --team-id         "ABCDE12345" \
#       [--arch           universal | arm64 | x64]   # default: universal
#
# You can also supply any value through environment variables instead of
# flags (flags take precedence):
#
#   CSC_LINK / CERT_FILE            -> path to the .p12 certificate
#   CSC_KEY_PASSWORD / CERT_PASSWORD-> password used when exporting the .p12
#   APPLE_ID                        -> Apple ID email
#   APPLE_ID_PASSWORD / APP_PASSWORD-> app-specific password
#   APPLE_TEAM_ID / TEAM_ID         -> 10-character Team ID
#
# ---------------------------------------------------------------------------
set -euo pipefail

# ── Resolve project root (this script lives in <root>/scripts) ─────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Defaults (may be overridden by env vars then by CLI flags) ─────────────
CERT_FILE="${CSC_LINK:-${CERT_FILE:-}}"
CERT_PASSWORD="${CSC_KEY_PASSWORD:-${CERT_PASSWORD:-}}"
APPLE_ID_VALUE="${APPLE_ID:-}"
APP_PASSWORD="${APPLE_ID_PASSWORD:-${APP_PASSWORD:-}}"
TEAM_ID="${APPLE_TEAM_ID:-${TEAM_ID:-}}"
ARCH="universal"

# ── Parse CLI flags ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cert)            CERT_FILE="$2"; shift 2 ;;
    --cert-password)   CERT_PASSWORD="$2"; shift 2 ;;
    --apple-id)        APPLE_ID_VALUE="$2"; shift 2 ;;
    --apple-password)  APP_PASSWORD="$2"; shift 2 ;;
    --team-id)         TEAM_ID="$2"; shift 2 ;;
    --arch)            ARCH="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '/^!/d'
      exit 0 ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      echo "   Run with --help to see usage." >&2
      exit 1 ;;
  esac
done

# ── Colour helpers ─────────────────────────────────────────────────────────
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
info() { echo "${CYN}▶ $*${RST}"; }
ok()   { echo "${GRN}✅ $*${RST}"; }
warn() { echo "${YLW}⚠️  $*${RST}"; }
err()  { echo "${RED}❌ $*${RST}" >&2; }

echo ""
echo "${CYN}══════════════════════════════════════════════════════════${RST}"
echo "${CYN}   MaidenPlayer — Signed & Notarized macOS Build${RST}"
echo "${CYN}══════════════════════════════════════════════════════════${RST}"
echo ""

# ── Platform check ─────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This script must be run on macOS."
  err "Code signing & notarization require Apple's codesign / notarytool tools."
  err "Current OS: $(uname -s). Aborting."
  exit 1
fi

# ── Validate required inputs ───────────────────────────────────────────────
MISSING=0
check() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    err "Missing required value: $name"
    MISSING=1
  fi
}
check "certificate (--cert)"            "$CERT_FILE"
check "cert password (--cert-password)" "$CERT_PASSWORD"
check "Apple ID (--apple-id)"           "$APPLE_ID_VALUE"
check "app password (--apple-password)" "$APP_PASSWORD"
check "Team ID (--team-id)"             "$TEAM_ID"

if [[ "$MISSING" -eq 1 ]]; then
  echo ""
  err "One or more required credentials are missing. Run with --help for usage."
  exit 1
fi

# Strip a leading "file://" if the user passed CSC_LINK style path
CERT_FILE="${CERT_FILE#file://}"

if [[ ! -f "$CERT_FILE" ]]; then
  err "Certificate file not found: $CERT_FILE"
  exit 1
fi

# Normalise to an absolute path
CERT_FILE="$(cd "$(dirname "$CERT_FILE")" && pwd)/$(basename "$CERT_FILE")"

# Validate Team ID format (10 alphanumeric chars)
if [[ ! "$TEAM_ID" =~ ^[A-Za-z0-9]{10}$ ]]; then
  warn "Team ID '$TEAM_ID' does not look like a standard 10-character ID."
  warn "Continuing anyway — double-check if signing fails."
fi

info "Certificate : $CERT_FILE"
info "Apple ID    : $APPLE_ID_VALUE"
info "Team ID     : $TEAM_ID"
info "Architecture: $ARCH"
echo ""

# ── Inspect the certificate (optional, informational) ──────────────────────
info "Verifying certificate can be opened with the supplied password..."
if openssl pkcs12 -in "$CERT_FILE" -nodes -passin "pass:$CERT_PASSWORD" -info >/dev/null 2>&1; then
  ok "Certificate opened successfully."
else
  warn "Could not parse the .p12 with the given password via openssl."
  warn "If this is a .cer (not .p12) or the password is wrong, signing will fail."
fi
echo ""

# ── Ensure dependencies are installed ──────────────────────────────────────
if [[ ! -d node_modules ]]; then
  info "Installing npm dependencies..."
  npm install
fi
if [[ ! -d node_modules/@electron/notarize ]]; then
  info "Installing @electron/notarize (required for notarization)..."
  npm install --no-save @electron/notarize
fi
echo ""

# ── Export the signing + notarization environment ──────────────────────────
# electron-builder reads CSC_LINK / CSC_KEY_PASSWORD to import & use the cert.
# scripts/notarize.js (afterSign hook) reads APPLE_ID / APPLE_ID_PASSWORD /
# APPLE_TEAM_ID to notarize and staple the result.
export CSC_LINK="$CERT_FILE"
export CSC_KEY_PASSWORD="$CERT_PASSWORD"
export CSC_IDENTITY_AUTO_DISCOVERY=true
export APPLE_ID="$APPLE_ID_VALUE"
export APPLE_ID_PASSWORD="$APP_PASSWORD"
export APPLE_APP_SPECIFIC_PASSWORD="$APP_PASSWORD"
export APPLE_TEAM_ID="$TEAM_ID"

# ── Choose the electron-builder arch flags ─────────────────────────────────
case "$ARCH" in
  universal|both) ARCH_FLAGS="--arm64 --x64" ;;
  arm64|apple)    ARCH_FLAGS="--arm64" ;;
  x64|intel)      ARCH_FLAGS="--x64" ;;
  *)
    err "Unknown --arch value: $ARCH (use universal | arm64 | x64)"
    exit 1 ;;
esac

info "Starting signed build: electron-builder --mac $ARCH_FLAGS"
echo "${YLW}   (This signs each binary, then notarizes with Apple — may take several minutes.)${RST}"
echo ""

npx electron-builder --mac $ARCH_FLAGS

echo ""
ok "Build finished. Running signing verification..."
echo ""

# ── Post-build verification ────────────────────────────────────────────────
if [[ -x scripts/verify-signing.sh ]]; then
  scripts/verify-signing.sh || warn "verify-signing.sh reported issues (see above)."
fi

echo ""
echo "${GRN}══════════════════════════════════════════════════════════${RST}"
ok "Signed & notarized installers are in: $ROOT_DIR/dist"
echo "${GRN}══════════════════════════════════════════════════════════${RST}"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || true
echo ""
echo "Next: verify Gatekeeper acceptance with:"
echo "   spctl -a -vvv -t install \"dist/MaidenPlayer-1.1.2-arm64.dmg\""
echo ""
