#!/usr/bin/env bash
# ABOUTME: Launch pi with CPU profiling enabled. Wraps both the V8 --cpu-prof
# ABOUTME: and the pi-agents PI_AGENTS_CPU_PROFILE programmatic profiler.
#
# Usage:
#   scripts/profile-agent.sh              # default: programmatic, writes to /tmp/pi-agents-profiles/
#   scripts/profile-agent.sh --v8          # V8 --cpu-prof (whole-process)
#   scripts/profile-agent.sh --0x          # 0x flamegraph (html output)
#   scripts/profile-agent.sh --clinic      # clinic doctor (comprehensive)
#   scripts/profile-agent.sh --help
#
# All extra args and flags after the mode flag are forwarded to pi.
#
# Environment overrides:
#   PROFILE_DIR         output dir (default /tmp/pi-agents-profiles)
#   PROFILE_INTERVAL_US sampling interval in µs (default 1000)
#   PROFILE_DURATION_MS auto-stop after N ms (default 0 = manual)

set -euo pipefail

PROFILE_DIR="${PROFILE_DIR:-/tmp/pi-agents-profiles}"
PROFILE_INTERVAL_US="${PROFILE_INTERVAL_US:-1000}"
PROFILE_DURATION_MS="${PROFILE_DURATION_MS:-0}"

MODE="programmatic"
PI_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --v8)        MODE="v8"; shift ;;
    --0x)        MODE="0x"; shift ;;
    --clinic)    MODE="clinic"; shift ;;
    --programmatic) MODE="programmatic"; shift ;;
    --help|-h)
      sed -n '3,/^$/p' "$0" | head -20
      exit 0
      ;;
    *)           PI_ARGS+=("$1"); shift ;;
  esac
done

mkdir -p "$PROFILE_DIR"

echo "=== pi CPU profile ==="
echo "  mode:     $MODE"
echo "  output:   $PROFILE_DIR"
echo "  interval: ${PROFILE_INTERVAL_US}µs"
[[ "$PROFILE_DURATION_MS" -gt 0 ]] && echo "  duration: ${PROFILE_DURATION_MS}ms"
echo ""

# Resolve the pi binary. Prefer the local workspace install, fall back to global.
PI_BIN="$(command -v pi 2>/dev/null || true)"
if [[ -z "$PI_BIN" ]]; then
  echo "error: 'pi' not found in PATH" >&2
  exit 1
fi

case "$MODE" in
  programmatic)
    export PI_AGENTS_CPU_PROFILE=1
    export PI_AGENTS_CPU_PROFILE_DIR="$PROFILE_DIR"
    export PI_AGENTS_CPU_PROFILE_INTERVAL_US="$PROFILE_INTERVAL_US"
    export PI_AGENTS_CPU_PROFILE_DURATION_MS="$PROFILE_DURATION_MS"
    exec "$PI_BIN" "${PI_ARGS[@]}"
    ;;

  v8)
    exec node \
      --cpu-prof \
      --cpu-prof-dir="$PROFILE_DIR" \
      --cpu-prof-interval="$PROFILE_INTERVAL_US" \
      "$PI_BIN" "${PI_ARGS[@]}"
    ;;

  0x)
    if ! command -v npx &>/dev/null; then
      echo "error: npx not found (needed for 0x)" >&2
      exit 1
    fi
    exec npx 0x \
      -o "$PROFILE_DIR" \
      -- node --cpu-prof --cpu-prof-dir="$PROFILE_DIR" "$PI_BIN" "${PI_ARGS[@]}"
    ;;

  clinic)
    if ! command -v npx &>/dev/null; then
      echo "error: npx not found (needed for clinic)" >&2
      exit 1
    fi
    exec npx clinic doctor \
      --dest="$PROFILE_DIR" \
      -- node "$PI_BIN" "${PI_ARGS[@]}"
    ;;

  *)
    echo "error: unknown mode '$MODE'" >&2
    exit 1
    ;;
esac
