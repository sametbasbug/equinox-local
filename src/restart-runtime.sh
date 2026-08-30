#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")" && /bin/pwd -P)"
CONFIG="${EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:-$ROOT/.equinox-local-dev-runtime.conf}"
DEV_NODE="${EQUINOX_LOCAL_DEV_NODE:-$(command -v node 2>/dev/null || true)}"
LOG_FILE="${TMPDIR:-/tmp}/equinox-local-restart.log"

fail() {
  printf 'Equinox Local source restart: %s\n' "$*" >&2
  exit 1
}

[ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] || fail "private developer runtime config is missing: $CONFIG"
CURRENT_UID="$(/usr/bin/id -u)"
[ "$(/usr/bin/stat -f '%u' "$CONFIG")" = "$CURRENT_UID" ] || fail "developer runtime config is not owned by the current user"
CONFIG_MODE="$(/usr/bin/stat -f '%Lp' "$CONFIG")"
case "$CONFIG_MODE" in
  600|400) ;;
  *) fail "developer runtime config must have mode 0600 or 0400" ;;
esac
case "$DEV_NODE" in
  /*) ;;
  *) fail "EQUINOX_LOCAL_DEV_NODE must be an absolute executable path" ;;
esac
[ -x "$DEV_NODE" ] || fail "configured developer Node runtime is not executable"

EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/../scripts/release/sync-source-tunnel-runtime.mjs"

LABEL=""
RUNTIME=""
TUNNEL_CLIENT=""
SEEN_LABEL=0
SEEN_RUNTIME=0
SEEN_CLIENT=0

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ""|\#*) continue ;;
    *=*) key="${line%%=*}"; value="${line#*=}" ;;
    *) fail "developer runtime config contains a malformed line" ;;
  esac

  case "$key" in
    launchAgentLabel)
      [ "$SEEN_LABEL" -eq 0 ] || fail "developer runtime config repeats launchAgentLabel"
      LABEL="$value"
      SEEN_LABEL=1
      ;;
    tunnelRuntime)
      [ "$SEEN_RUNTIME" -eq 0 ] || fail "developer runtime config repeats tunnelRuntime"
      RUNTIME="$value"
      SEEN_RUNTIME=1
      ;;
    tunnelClient)
      [ "$SEEN_CLIENT" -eq 0 ] || fail "developer runtime config repeats tunnelClient"
      TUNNEL_CLIENT="$value"
      SEEN_CLIENT=1
      ;;
    *)
      fail "developer runtime config contains an unsupported field: $key"
      ;;
  esac
done < "$CONFIG"

[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "launchAgentLabel is invalid"
[[ "$RUNTIME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "tunnelRuntime is invalid"
case "$TUNNEL_CLIENT" in
  /*) ;;
  *) fail "tunnelClient must be an absolute executable path" ;;
esac
[ -x "$TUNNEL_CLIENT" ] || fail "configured tunnelClient is not executable after synchronization"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$PLIST" ] && [ ! -L "$PLIST" ] || fail "configured LaunchAgent plist is missing or unsafe"
DOMAIN="gui/$CURRENT_UID"

{
  printf '\n[%s] Equinox Local source-checkout restart started.\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"

  # Let the MCP response reach the client before the source runtime is restarted.
  sleep 8

  "$TUNNEL_CLIENT" runtimes stop "$RUNTIME" || true

  /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || \
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST"

  /bin/launchctl kickstart -k "$DOMAIN/$LABEL"

  sleep 8
  "$TUNNEL_CLIENT" runtimes status "$RUNTIME"

  printf '[%s] Equinox Local source-checkout restart completed.\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
} >>"$LOG_FILE" 2>&1
