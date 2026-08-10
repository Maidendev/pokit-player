#!/usr/bin/env bash
# Background orchestrator: wait on known submission IDs, then staple + package.
set -uo pipefail
cd /home/ubuntu/professional_video_player
KEY=.asc-api-key.json
LOG=/tmp/watch_notarize.log
ARM64_ID="31f20653-1394-4d95-af18-e0d6fe98e8d0"
X64_ID="a02e1d0e-836e-4b83-bb8b-34a213409eae"
echo "[$(date -u +%T)] watcher started (arm64=$ARM64_ID x64=$X64_ID)" > "$LOG"

poll_status() { rcodesign notary-list --api-key-file "$KEY" 2>/dev/null | grep "$1" | grep -oE "(in progress|accepted|invalid|rejected)$"; }

wait_for() {  # $1=id $2=label
  local id="$1" label="$2" st
  for i in $(seq 1 160); do          # up to ~160*25s ≈ 66 min
    st=$(poll_status "$id")
    echo "[$(date -u +%T)] $label: ${st:-unknown}" >> "$LOG"
    case "$st" in
      accepted) return 0 ;;
      invalid|rejected) return 2 ;;
    esac
    sleep 25
  done
  return 1
}

ARM64_OK=0; X64_OK=0
if wait_for "$ARM64_ID" "arm64"; then
  rcodesign staple "dist/mac-arm64/PokitPlayer.app" >> "$LOG" 2>&1 && { echo "[$(date -u +%T)] arm64 STAPLED" >> "$LOG"; ARM64_OK=1; }
fi
if wait_for "$X64_ID" "x64"; then
  rcodesign staple "dist/mac/PokitPlayer.app" >> "$LOG" 2>&1 && { echo "[$(date -u +%T)] x64 STAPLED" >> "$LOG"; X64_OK=1; }
fi

cd dist
[ "$ARM64_OK" = "1" ] && ( cd mac-arm64 && zip -ry -q ../PokitPlayer-1.1.3-arm64-notarized.zip "PokitPlayer.app" ) && echo "[$(date -u +%T)] arm64 zip done" >> "$LOG"
[ "$X64_OK" = "1" ]   && ( cd mac       && zip -ry -q ../PokitPlayer-1.1.3-x64-notarized.zip   "PokitPlayer.app" ) && echo "[$(date -u +%T)] x64 zip done" >> "$LOG"
echo "[$(date -u +%T)] watcher FINISHED arm64=$ARM64_OK x64=$X64_OK" >> "$LOG"
touch /tmp/watch_notarize.done
