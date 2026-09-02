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
EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/../scripts/release/sync-source-peekaboo-runtime.mjs"
EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/../scripts/release/prepare-source-app-host.mjs"

LABEL=""
RUNTIME=""
TUNNEL_CLIENT=""
PEEKABOO_PATH=""
SOURCE_LAUNCHER=""
SEEN_LABEL=0
SEEN_RUNTIME=0
SEEN_CLIENT=0
SEEN_PEEKABOO=0
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
    peekabooPath)
      [ "$SEEN_PEEKABOO" -eq 0 ] || fail "developer runtime config repeats peekabooPath"
      PEEKABOO_PATH="$value"
      SEEN_PEEKABOO=1
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
case "$PEEKABOO_PATH" in
  /*) ;;
  *) fail "peekabooPath must be an absolute executable path" ;;
esac
[ -x "$PEEKABOO_PATH" ] && [ ! -L "$PEEKABOO_PATH" ] || fail "configured Peekaboo is not executable after synchronization"
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

  # Capture only the app host's validated direct children before bootout. Do not
  # terminate them while KeepAlive is still active: doing that can make launchd
  # start a replacement app host in the narrow window before bootout.
  HOST_PID="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
  VALID_HOST_CHILDREN=""
  if [[ "$HOST_PID" =~ ^[0-9]+$ ]] && [ "$HOST_PID" -gt 1 ]; then
    HOST_CHILDREN="$(/usr/bin/pgrep -P "$HOST_PID" 2>/dev/null || true)"
    for child_pid in $HOST_CHILDREN; do
      child_uid="$(/bin/ps -p "$child_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      child_ppid="$(/bin/ps -p "$child_pid" -o ppid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      child_command="$(/bin/ps -p "$child_pid" -o command= 2>/dev/null || true)"
      if [ "$child_uid" = "$CURRENT_UID" ] && [ "$child_ppid" = "$HOST_PID" ] && [[ "$child_command" == *"$HOME/Library/Application Support/Equinox Local/equinox-local-app-runtime"* ]]; then
        VALID_HOST_CHILDREN="$VALID_HOST_CHILDREN $child_pid"
      fi
    done
  fi

  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

  # launchctl bootout is asynchronous. Wait for KeepAlive ownership to disappear
  # before touching the captured wrapper children or the tunnel runtime.
  for _ in {1..40}; do
    if ! /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    fail "source LaunchAgent did not finish bootout"
  fi

  for child_pid in $VALID_HOST_CHILDREN; do
    child_uid="$(/bin/ps -p "$child_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
    if [ "$child_uid" = "$CURRENT_UID" ]; then
      /bin/kill -TERM "$child_pid" >/dev/null 2>&1 || true
    fi
  done
  for child_pid in $VALID_HOST_CHILDREN; do
    for _ in {1..40}; do
      if ! /bin/kill -0 "$child_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if /bin/kill -0 "$child_pid" >/dev/null 2>&1; then
      fail "source runtime child did not stop cleanly after LaunchAgent bootout"
    fi
  done

  # Stop the tunnel only after KeepAlive is gone. Stopping it while the
  # LaunchAgent is still active lets the source launcher race us and create a
  # replacement server before bootout, leaving that replacement orphaned.
  "$TUNNEL_CLIENT" runtimes stop "$RUNTIME" || true

  # Do not relaunch while any previous source server is still alive. The
  # tunnel runtime can take a moment to finish process teardown after reporting
  # stopped, so wait for the exact old PID and then fail closed on any residual
  # server process rather than accepting a restart-window orphan as the new PID.
  if [ -n "$OLD_PID" ]; then
    for _ in {1..40}; do
      if ! /bin/kill -0 "$OLD_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    /bin/kill -0 "$OLD_PID" >/dev/null 2>&1 && fail "previous Equinox Local server process did not stop before relaunch"
  fi
  RESIDUAL_PID="$(/usr/bin/pgrep -f "node $ROOT/server.js" | /usr/bin/head -n 1 || true)"
  [ -z "$RESIDUAL_PID" ] || fail "source runtime left a residual Equinox Local server process before relaunch"

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
