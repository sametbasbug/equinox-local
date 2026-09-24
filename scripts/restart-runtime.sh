#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && /bin/pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && /bin/pwd -P)"
CONFIG="${EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:-$ROOT/.equinox-local-dev-runtime.conf}"
DEFAULT_DEV_NODE="$HOME/.local/share/equinox-local-developer/bin/node"
if [ -n "${EQUINOX_LOCAL_DEV_NODE:-}" ]; then
  DEV_NODE="$EQUINOX_LOCAL_DEV_NODE"
elif [ -x "$DEFAULT_DEV_NODE" ]; then
  DEV_NODE="$DEFAULT_DEV_NODE"
else
  DEV_NODE="$(command -v node 2>/dev/null || true)"
fi
LOG_FILE="${TMPDIR:-/tmp}/equinox-local-restart.log"
APP_PATH="$HOME/Applications/Equinox Local.app"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/applet"
PRE_RESTART_APP_PIDS=""
if [ -x "$APP_EXECUTABLE" ] && [ ! -L "$APP_EXECUTABLE" ]; then
  for app_pid in $(/usr/bin/pgrep -f "$APP_EXECUTABLE" 2>/dev/null || true); do
    app_uid="$(/bin/ps -p "$app_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
    app_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null || true)"
    if [ "$app_uid" = "$(/usr/bin/id -u)" ]; then
      case "$app_command" in
        "$APP_EXECUTABLE"|"$APP_EXECUTABLE "*) PRE_RESTART_APP_PIDS="$PRE_RESTART_APP_PIDS $app_pid" ;;
      esac
    fi
  done
fi

fail() {
  printf 'Equinox Local source restart: %s\n' "$*" >&2
  exit 1
}

RESTART_STAGE="preflight"
RESTART_LOCK_DIR="$(/usr/bin/dirname "$LOG_FILE")/equinox-local-restart.lock"
BOUNDED_PID=""

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

cleanup_restart() {
  status=$?
  if [ -n "$BOUNDED_PID" ]; then
    /bin/kill -TERM "$BOUNDED_PID" >/dev/null 2>&1 || true
    wait "$BOUNDED_PID" >/dev/null 2>&1 || true
  fi
  if [ -d "$RESTART_LOCK_DIR" ] && [ -f "$RESTART_LOCK_DIR/pid" ]; then
    lock_pid="$(/bin/cat "$RESTART_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ "$lock_pid" = "$$" ]; then
      /bin/rm -rf "$RESTART_LOCK_DIR"
    fi
  fi
  if [ "$status" -ne 0 ]; then
    printf '[%s] Equinox Local source-checkout restart failed at stage=%s exit=%s.
' "$(timestamp)" "$RESTART_STAGE" "$status" >> "$LOG_FILE"
  fi
}

interrupt_restart() {
  fail "restart helper interrupted at stage=$RESTART_STAGE"
}

run_bounded() {
  attempts="$1"
  shift
  "$@" &
  BOUNDED_PID=$!
  for _ in $(/usr/bin/seq 1 "$attempts"); do
    if ! /bin/kill -0 "$BOUNDED_PID" >/dev/null 2>&1; then
      set +e
      wait "$BOUNDED_PID"
      status=$?
      set -e
      BOUNDED_PID=""
      return "$status"
    fi
    sleep 0.25
  done
  /bin/kill -TERM "$BOUNDED_PID" >/dev/null 2>&1 || true
  sleep 0.25
  /bin/kill -KILL "$BOUNDED_PID" >/dev/null 2>&1 || true
  set +e
  wait "$BOUNDED_PID" >/dev/null 2>&1
  set -e
  BOUNDED_PID=""
  return 124
}

acquire_restart_lock() {
  if /bin/mkdir "$RESTART_LOCK_DIR" 2>/dev/null; then
    printf '%s
' "$$" > "$RESTART_LOCK_DIR/pid"
    return
  fi
  existing_pid="$(/bin/cat "$RESTART_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && /bin/kill -0 "$existing_pid" >/dev/null 2>&1; then
    fail "another source restart is already running (pid $existing_pid)"
  fi
  /bin/rm -rf "$RESTART_LOCK_DIR"
  /bin/mkdir "$RESTART_LOCK_DIR" || fail "could not acquire source restart lock"
  printf '%s
' "$$" > "$RESTART_LOCK_DIR/pid"
}

trap cleanup_restart EXIT
trap interrupt_restart HUP INT TERM
acquire_restart_lock

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
case "$DEV_NODE" in
  *[[:space:]]*) fail "developer Node runtime path must not contain whitespace" ;;
esac
[ -x "$DEV_NODE" ] || fail "configured developer Node runtime is not executable"

EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/scripts/release/sync-source-tunnel-runtime.mjs"
EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/scripts/release/sync-source-peekaboo-runtime.mjs"
EQUINOX_LOCAL_DEV_NODE="$DEV_NODE" EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$CONFIG" "$DEV_NODE" "$ROOT/scripts/release/prepare-source-app-host.mjs"

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
  OLD_PID="$(/usr/bin/pgrep -f "node $ROOT/src/server.js" | /usr/bin/head -n 1 || true)"

  # Let the MCP response reach the client before the source runtime is restarted.
  sleep 8

  # Capture only the app host's validated direct children before bootout. Do not
  # terminate them while KeepAlive is still active: doing that can make launchd
  # start a replacement app host in the narrow window before bootout.
  RESTART_STAGE="inspect-launch-agent"
  HOST_PID="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
  VALID_HOST_CHILDREN=""
  FOREGROUND_GUI_PIDS=""
  GUI_WAS_RUNNING=0
  for app_pid in $PRE_RESTART_APP_PIDS; do
    if [ "$app_pid" != "$HOST_PID" ]; then
      app_uid="$(/bin/ps -p "$app_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      app_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null || true)"
      if [ "$app_uid" = "$CURRENT_UID" ]; then
        case "$app_command" in
          "$APP_EXECUTABLE"|"$APP_EXECUTABLE "*)
            FOREGROUND_GUI_PIDS="$FOREGROUND_GUI_PIDS $app_pid"
            GUI_WAS_RUNNING=1
            ;;
        esac
      fi
    fi
  done
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

  RESTART_STAGE="launch-agent-bootout"
  if run_bounded 40 /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    :
  else
    bootout_status=$?
    [ "$bootout_status" -ne 124 ] || fail "source LaunchAgent bootout timed out"
  fi

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
  RESTART_STAGE="tunnel-stop"
  run_bounded 80 "$TUNNEL_CLIENT" runtimes stop "$RUNTIME" || fail "source tunnel stop failed or timed out"

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
  RESIDUAL_PID="$(/usr/bin/pgrep -f "node $ROOT/src/server.js" | /usr/bin/head -n 1 || true)"
  [ -z "$RESIDUAL_PID" ] || fail "source runtime left a residual Equinox Local server process before relaunch"

  RESTART_STAGE="launch-agent-bootstrap"
  BOOTSTRAPPED=0
  for _ in {1..12}; do
    if run_bounded 40 /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
      BOOTSTRAPPED=1
      break
    fi
    sleep 1
  done
  [ "$BOOTSTRAPPED" -eq 1 ] || fail "source LaunchAgent bootstrap failed after bounded retries"
  RESTART_STAGE="launch-agent-kickstart"
  run_bounded 40 /bin/launchctl kickstart "$DOMAIN/$LABEL" || fail "source LaunchAgent kickstart failed or timed out"

  RESTART_STAGE="runtime-ready"
  sleep 8
  run_bounded 80 "$TUNNEL_CLIENT" runtimes status "$RUNTIME" || fail "source tunnel status failed or timed out"

  NEW_PID="$(/usr/bin/pgrep -f "node $ROOT/src/server.js" | /usr/bin/head -n 1 || true)"
  [ -n "$NEW_PID" ] || fail "source runtime did not start a new Equinox Local server process"
  if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
    fail "source runtime restart left the previous Equinox Local server process running"
  fi

  if [ "$GUI_WAS_RUNNING" -eq 1 ]; then
    for gui_pid in $FOREGROUND_GUI_PIDS; do
      gui_uid="$(/bin/ps -p "$gui_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
      gui_command="$(/bin/ps -p "$gui_pid" -o command= 2>/dev/null || true)"
      if [ "$gui_uid" = "$CURRENT_UID" ]; then
        case "$gui_command" in
          "$APP_EXECUTABLE"|"$APP_EXECUTABLE "*) /bin/kill -TERM "$gui_pid" >/dev/null 2>&1 || true ;;
        esac
      fi
    done
    for gui_pid in $FOREGROUND_GUI_PIDS; do
      for _ in {1..40}; do
        if ! /bin/kill -0 "$gui_pid" >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      /bin/kill -0 "$gui_pid" >/dev/null 2>&1 && fail "previous Equinox Local foreground GUI did not stop cleanly"
    done

    RESTART_STAGE="foreground-gui-relaunch"
    run_bounded 40 /usr/bin/open -gn "$APP_PATH" --args --restart-shell || fail "Equinox Local foreground GUI open failed or timed out"
    NEW_GUI_PID=""
    for _ in {1..40}; do
      NEW_HOST_PID="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
      for app_pid in $(/usr/bin/pgrep -f "$APP_EXECUTABLE" 2>/dev/null || true); do
        [ "$app_pid" = "$NEW_HOST_PID" ] && continue
        app_uid="$(/bin/ps -p "$app_pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
        app_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null || true)"
        if [ "$app_uid" = "$CURRENT_UID" ]; then
          case "$app_command" in
            "$APP_EXECUTABLE"|"$APP_EXECUTABLE "*)
              NEW_GUI_PID="$app_pid"
              break
              ;;
          esac
        fi
      done
      [ -n "$NEW_GUI_PID" ] && break
      sleep 0.1
    done
    [ -n "$NEW_GUI_PID" ] || fail "Equinox Local foreground GUI did not relaunch after source restart"
  fi

  printf '[%s] Equinox Local source-checkout restart completed.\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
} >>"$LOG_FILE" 2>&1
