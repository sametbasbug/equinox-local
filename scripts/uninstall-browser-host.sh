#!/bin/bash
set -euo pipefail

HOST_NAME="dev.equinox.browser"
RUNTIME_DIR="$HOME/Library/Application Support/Equinox Local"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

TARGETS=(
  "$MANIFEST_DIR/$HOST_NAME.json"
  "$RUNTIME_DIR/equinox-browser-native-host"
  "$RUNTIME_DIR/equinox-browser-native-host.js"
  "$RUNTIME_DIR/equinox-browser-native-host-runtime.js"
  "$RUNTIME_DIR/equinox-browser-socket.js"
)

for target in "${TARGETS[@]}"; do
  if [[ -L "$target" ]]; then
    echo "Refusing to remove symlinked Equinox Browser install target: $target" >&2
    exit 2
  fi
done

rm -f "${TARGETS[@]}"
printf 'Uninstalled Equinox Browser native host files.\n'
printf 'Equinox Local runtime data and sockets were left untouched.\n'
