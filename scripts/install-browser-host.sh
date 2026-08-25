#!/bin/bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST_SOURCE="$ROOT_DIR/src/equinox-browser-native-host.js"
HOST_RUNTIME_SOURCE="$ROOT_DIR/src/equinox-browser-native-host-runtime.js"
PRODUCTION_EXTENSION_ID="npdneefcobilfkjlihghjgjnknenhfoj"
LEGACY_EXTENSION_ID="kdjmfldngbfaillaamoinegmogfkhdfn"
HOST_NAME="dev.equinox.browser"
RUNTIME_DIR="$HOME/Library/Application Support/Equinox Local"
HOST_WRAPPER="$RUNTIME_DIR/equinox-browser-native-host"
HOST_SCRIPT="$RUNTIME_DIR/equinox-browser-native-host.js"
HOST_RUNTIME="$RUNTIME_DIR/equinox-browser-native-host-runtime.js"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
NODE_BIN="$(command -v node)"

if (( $# > 0 )); then
  REQUESTED_EXTENSION_IDS=("$@")
else
  REQUESTED_EXTENSION_IDS=("$PRODUCTION_EXTENSION_ID")
fi

EXTENSION_IDS=()
for extension_id in "${REQUESTED_EXTENSION_IDS[@]}"; do
  if [[ ! "$extension_id" =~ ^[a-p]{32}$ ]]; then
    echo "Invalid Chrome extension id: $extension_id" >&2
    exit 2
  fi
  duplicate=false
  for existing_id in "${EXTENSION_IDS[@]:-}"; do
    if [[ "$existing_id" == "$extension_id" ]]; then
      duplicate=true
      break
    fi
  done
  if [[ "$duplicate" == false ]]; then
    EXTENSION_IDS+=("$extension_id")
  fi
done

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node runtime not found or not executable: $NODE_BIN" >&2
  exit 3
fi
if [[ ! -f "$HOST_SOURCE" || -L "$HOST_SOURCE" || ! -f "$HOST_RUNTIME_SOURCE" || -L "$HOST_RUNTIME_SOURCE" ]]; then
  echo "Equinox Browser native host sources are missing or unsafe." >&2
  exit 4
fi

mkdir -p "$RUNTIME_DIR"
mkdir -p "$MANIFEST_DIR"
install -m 600 "$HOST_SOURCE" "$HOST_SCRIPT"
install -m 600 "$HOST_RUNTIME_SOURCE" "$HOST_RUNTIME"

WRAPPER_TMP="$HOST_WRAPPER.tmp.$$"
MANIFEST_TMP="$MANIFEST_PATH.tmp.$$"
trap 'rm -f "$WRAPPER_TMP" "$MANIFEST_TMP"' EXIT

cat > "$WRAPPER_TMP" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$HOST_SCRIPT" "\$@"
EOF
chmod 700 "$WRAPPER_TMP"
mv -f "$WRAPPER_TMP" "$HOST_WRAPPER"

{
  printf '{\n'
  printf '  "name": "%s",\n' "$HOST_NAME"
  printf '  "description": "Equinox Browser native messaging bridge",\n'
  printf '  "path": "%s",\n' "$HOST_WRAPPER"
  printf '  "type": "stdio",\n'
  printf '  "allowed_origins": [\n'
  last_index=$(( ${#EXTENSION_IDS[@]} - 1 ))
  for i in "${!EXTENSION_IDS[@]}"; do
    comma=","
    if (( i == last_index )); then comma=""; fi
    printf '    "chrome-extension://%s/"%s\n' "${EXTENSION_IDS[$i]}" "$comma"
  done
  printf '  ]\n'
  printf '}\n'
} > "$MANIFEST_TMP"

chmod 600 "$MANIFEST_TMP"
mv -f "$MANIFEST_TMP" "$MANIFEST_PATH"
printf 'Installed Equinox Browser native host:\n%s\n' "$MANIFEST_PATH"
printf 'Native host wrapper: %s\n' "$HOST_WRAPPER"
printf 'Pinned Node runtime: %s\n' "$NODE_BIN"
printf 'Allowed extensions:\n'
printf '  %s\n' "${EXTENSION_IDS[@]}"
