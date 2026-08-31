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
EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/../scripts/release/prepare-source-app-host.mjs"

LABEL=""
RUNTIME=""
TUNNEL_CLIENT=""
SOURCE_LAUNCHER=""
SEEN_LABEL=0
SEEN_RUNTIME=0
SEEN_CLIENT=0
SEEN_SOURCE_LAUNCHER=0

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
    sourceLauncher)
      [ "$SEEN_SOURCE_LAUNCHER" -eq 0 ] || fail "developer runtime config repeats sourceLauncher"
      SOURCE_LAUNCHER="$value"
      SEEN_SOURCE_LAUNCHER=1
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
case "$SOURCE_LAUNCHER" in
  /*) ;;
  *) fail "sourceLauncher must be an absolute path" ;;
esac
[ -f "$SOURCE_LAUNCHER" ] && [ ! -L "$SOURCE_LAUNCHER" ] || fail "configured sourceLauncher is missing or unsafe"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$PLIST" ] && [ ! -L "$PLIST" ] || fail "configured LaunchAgent plist is missing or unsafe"
DOMAIN="gui/$CURRENT_UID"

{
  printf '\n[%s] Equinox Local source-checkout restart started.\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"

  # Match the server command by its stable script path, not process.execPath. The
  # tunnel runtime may launch the same Node binary through a different symlink.
  OLD_PID="$(/usr/bin/pgrep -f "node $ROOT/server.js" | /usr/bin/head -n 1 || true)"

  # Let the MCP response reach the client before the source runtime is restarted.
  sleep 8

  "$TUNNEL_CLIENT" runtimes stop "$RUNTIME" || true

  # A pre-v3 native host did not forward launchd termination signals to its
  # runtime child. Stop that exact direct child first so bootout cannot orphan
  # the wrapper/Peekaboo tree during the one-time migration to the fixed host.
  HOST_PID="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
  if [[ "$HOST_PID" =~ ^[0-9]+$ ]] && [ "$HOST_PID" -gt 1 ]; then
    HOST_CHILDREN="$(/usr/bin/pgrep -P "$HOST_PID" 2>/dev/null || true)"
    for child_pid in $HOST_CHILDREN; do
      child_uid="$(/bin/ps -p "$child_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      child_ppid="$(/bin/ps -p "$child_pid" -o ppid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      if [ "$child_uid" = "$CURRENT_UID" ] && [ "$child_ppid" = "$HOST_PID" ]; then
        /bin/kill -TERM "$child_pid" >/dev/null 2>&1 || true
      fi
    done
    for child_pid in $HOST_CHILDREN; do
      for _ in {1..40}; do
        if ! /bin/kill -0 "$child_pid" >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      if /bin/kill -0 "$child_pid" >/dev/null 2>&1; then
        fail "source runtime child did not stop cleanly before LaunchAgent bootout"
      fi
    done
  fi

  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

  # launchctl bootout is asynchronous. Wait for the old job to disappear before
  # bootstrapping the replacement; otherwise macOS can transiently return EIO.
  for _ in {1..40}; do
    if ! /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    fail "source LaunchAgent did not finish bootout"
  fi

  BOOTSTRAPPED=0
  for _ in {1..12}; do
    if /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
      BOOTSTRAPPED=1
      break
    fi
    sleep 1
  done
  [ "$BOOTSTRAPPED" -eq 1 ] || fail "source LaunchAgent bootstrap failed after bounded retries"
  /bin/launchctl kickstart "$DOMAIN/$LABEL"

  sleep 8
  "$TUNNEL_CLIENT" runtimes status "$RUNTIME"

  NEW_PID="$(/usr/bin/pgrep -f "node $ROOT/server.js" | /usr/bin/head -n 1 || true)"
  [ -n "$NEW_PID" ] || fail "source runtime did not start a new Equinox Local server process"
  if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
    fail "source runtime restart left the previous Equinox Local server process running"
  fi

  printf '[%s] Equinox Local source-checkout restart completed.\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
} >>"$LOG_FILE" 2>&1
