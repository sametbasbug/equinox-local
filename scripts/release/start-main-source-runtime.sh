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
SOURCE_ROOT="$("$NODE_BIN" "$SCRIPT_DIR/resolve-main-source-runtime.mjs" "$POINTER" "$DEV_CONFIG")"
MCP_SERVER="$SOURCE_ROOT/src/server.js"
WATCHDOG="$SOURCE_ROOT/scripts/release/watch-source-runtime.mjs"
TUNNEL_CLIENT="$(/usr/bin/awk -F= '$1 == "tunnelClient" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
ALIAS="$(/usr/bin/awk -F= '$1 == "tunnelRuntime" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
PRIVATE_MODULE="$(/usr/bin/awk -F= '$1 == "privateCompositionModule" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"
PRIVATE_ROOT="$(/usr/bin/awk -F= '$1 == "privateCompositionRoot" { print substr($0, index($0, "=") + 1); exit }' "$DEV_CONFIG")"

for required in "$MCP_SERVER" "$WATCHDOG" "$TUNNEL_CLIENT" "$KEY_FILE"; do
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
TUNNEL_ID="$("$TUNNEL_CLIENT" runtimes list 2>/dev/null | /usr/bin/awk -v alias="$ALIAS" '$1 == alias { print $2; exit }')"
[[ -n "$TUNNEL_ID" ]] || { print -u2 -- "Tunnel runtime identity is unavailable."; exit 1; }

"$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
"$TUNNEL_CLIENT" runtimes connect \
  --alias "$ALIAS" \
  --profile "$ALIAS" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-api-key "file:$KEY_FILE" \
  --mcp-command "$NODE_BIN $MCP_SERVER"

sleep 2
"$TUNNEL_CLIENT" runtimes status "$ALIAS" 2>/dev/null | /usr/bin/awk '$2 == "ready" { ready=1 } END { exit !ready }' || {
  print -u2 -- "Tunnel runtime did not become ready."
  exit 1
}
exec "$NODE_BIN" "$WATCHDOG" "$DEV_CONFIG"
