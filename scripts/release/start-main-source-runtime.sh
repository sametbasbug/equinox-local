#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h:h}"
HOME_DIR="$HOME"
NODE_BIN="${EQUINOX_LOCAL_DEV_NODE:-$HOME_DIR/.local/share/equinox-local-developer/bin/node}"
POINTER="${EQUINOX_LOCAL_MAIN_SOURCE_POINTER:-$HOME_DIR/Library/Application Support/Equinox Local Developer/main-update/current-source.conf}"
STABLE_CONFIG="$HOME_DIR/Library/Application Support/Equinox Local Developer/runtime/source-runtime.conf"
if [[ -n "${EQUINOX_LOCAL_MAIN_RUNTIME_CONFIG:-}" ]]; then
  DEV_CONFIG="$EQUINOX_LOCAL_MAIN_RUNTIME_CONFIG"
elif [[ -f "$STABLE_CONFIG" && ! -L "$STABLE_CONFIG" ]]; then
  DEV_CONFIG="$STABLE_CONFIG"
else
  DEV_CONFIG="${EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:-$ROOT/.equinox-local-dev-runtime.conf}"
fi
KEY_FILE="$HOME_DIR/.config/tunnel-client/secrets/equinox-local-runtime-key"
export EQUINOX_LOCAL_DEV_RUNTIME_CONFIG="$DEV_CONFIG"

[[ -f "$NODE_BIN" && -x "$NODE_BIN" ]] || { print -u2 -- "Developer Node runtime is unavailable."; exit 1; }
# Factory is a live development checkout: never pin it to a past published SHA.
# Public managed-source installations still use the authenticated SHA pointer.
FACTORY_COMPOSITION="$(/usr/bin/awk -F= '$1 == "privateCompositionModule" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
CONFIGURED_LAUNCHER="$(/usr/bin/awk -F= '$1 == "sourceLauncher" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
if [[ -n "$FACTORY_COMPOSITION" && "$CONFIGURED_LAUNCHER" == "$SCRIPT_DIR/start-main-source-runtime.sh" ]]; then
  SOURCE_ROOT="$ROOT"
else
  SOURCE_ROOT="$("$NODE_BIN" "$SCRIPT_DIR/resolve-main-source-runtime.mjs" "$POINTER" "$DEV_CONFIG")"
fi
MCP_SERVER="$SOURCE_ROOT/src/server.js"
TUNNEL_CLIENT="$(/usr/bin/awk -F= '$1 == "tunnelClient" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
ALIAS="$(/usr/bin/awk -F= '$1 == "tunnelRuntime" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
PRIVATE_MODULE="$(/usr/bin/awk -F= '$1 == "privateCompositionModule" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
PRIVATE_ROOT="$(/usr/bin/awk -F= '$1 == "privateCompositionRoot" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"

for required in "$MCP_SERVER" "$TUNNEL_CLIENT" "$KEY_FILE"; do
  [[ -f "$required" && ! -L "$required" ]] || { print -u2 -- "Main source runtime dependency is unavailable."; exit 1; }
done
[[ -n "$ALIAS" ]] || { print -u2 -- "Tunnel runtime alias is unavailable."; exit 1; }
if [[ -n "$PRIVATE_MODULE" || -n "$PRIVATE_ROOT" ]]; then
  [[ -n "$PRIVATE_MODULE" && -n "$PRIVATE_ROOT" && -f "$PRIVATE_MODULE" && ! -L "$PRIVATE_MODULE" && -d "$PRIVATE_ROOT" && ! -L "$PRIVATE_ROOT" ]] || {
    print -u2 -- "Private composition runtime snapshot is unavailable."
    exit 1
  }
  export EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE="$PRIVATE_MODULE"
  export EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT="$PRIVATE_ROOT"
else
  unset EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE
  unset EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT
fi
# Source Electron owns the lifetime of this foreground tunnel process.
# The old `runtimes connect` detached its own daemon, whose watchdog then
# caused a second recovery policy underneath Electron. Use the installed
# tunnel-client's native stdio child/exit contract instead.
[[ "$ALIAS" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { print -u2 -- "Invalid tunnel runtime alias."; exit 1; }
PROFILE_DIR="$HOME_DIR/.config/tunnel-client"
[[ -d "$PROFILE_DIR" && ! -L "$PROFILE_DIR" ]] || { print -u2 -- "Tunnel profile directory is unavailable."; exit 1; }
PROFILE_OWNER="$(/usr/bin/stat -f %u "$PROFILE_DIR")"
PROFILE_MODE="$(/usr/bin/stat -f %Lp "$PROFILE_DIR")"
[[ "$PROFILE_OWNER" == "$(/usr/bin/id -u)" && "$PROFILE_MODE" == "700" ]] || {
  print -u2 -- "Tunnel profile directory must be private and user-owned."
  exit 1
}
TUNNEL_ID="$("$TUNNEL_CLIENT" runtimes list 2>/dev/null | /usr/bin/awk -v alias="$ALIAS" '$1 == alias { print $2; exit }')"
[[ "$TUNNEL_ID" =~ ^tunnel_[a-f0-9]{32}$ ]] || { print -u2 -- "Tunnel runtime identity is unavailable."; exit 1; }

# Retire the prior detached alias before starting the new foreground owner.
# Do not stop any other runtime alias, port listener or unrelated process.
"$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
# Rebuild only the exact product-owned profile at startup. Factory uses the
# current checkout rather than a pinned previous SHA; its stdio child command
# must never remain stuck on an earlier source path after an update.
"$TUNNEL_CLIENT" init --force --sample sample_mcp_stdio_local \
  --profile "$ALIAS" --profile-dir "$PROFILE_DIR" \
  --tunnel-id "$TUNNEL_ID" --control-plane-api-key-ref "file:$KEY_FILE" \
  --mcp-command "${(qq)NODE_BIN} ${(qq)MCP_SERVER}" \
  --health-listen-addr 127.0.0.1:0 >/dev/null
# The tunnel process stays in the wrapper's own process tree. Failure exits
# to Electron's bounded runtime owner, not another daemon or a polling watcher.
exec "$TUNNEL_CLIENT" run --profile "$ALIAS" --profile-dir "$PROFILE_DIR" \
  --mcp.stdio-failure-policy exit --mcp.stdio-send-initialized-notification
