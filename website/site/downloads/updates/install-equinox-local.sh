#!/bin/bash
set -euo pipefail
umask 077

CONTROL_CENTER_URL="http://127.0.0.1:24891/"

fail() {
  printf 'Equinox Local installer: %s\n' "$*" >&2
  exit 1
}

info() {
  printf 'Equinox Local installer: %s\n' "$*"
}

require_command() {
  [ -x "$1" ] || fail "required macOS tool is unavailable: $1"
}

require_private_directory() {
  local directory="$1"
  /bin/mkdir -p "$directory"
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "unsafe managed directory: $directory"
  local owner
  owner="$(/usr/bin/stat -f '%u' "$directory")"
  [ "$owner" = "$CURRENT_UID" ] || fail "managed directory is not owned by the current user: $directory"
  /bin/chmod 700 "$directory" 2>/dev/null || true
}

for argument in "$@"; do
  case "$argument" in
    --help|-h)
      printf '%s\n' 'Usage: install-equinox-local.sh' \
        'Downloads the newest production-signed Main and reinstalls only program files.' \
        'User settings and data are retained; the prior installed version is irrelevant.'
      exit 0 ;;
    *) fail "unknown argument: $argument (use --help)" ;;
  esac
done

[ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "macOS is required"
CURRENT_UID="$(/usr/bin/id -u)"
[ "$CURRENT_UID" -gt 0 ] || fail "do not run this installer with sudo or as root"
CURRENT_USER="$(/usr/bin/id -un)"

HOME_DIR="${HOME:-}"
case "$HOME_DIR" in
  /*) ;;
  *) fail "a trusted absolute HOME directory is required" ;;
esac
[ -d "$HOME_DIR" ] && [ ! -L "$HOME_DIR" ] || fail "the current HOME directory is unsafe"
[ "$(/usr/bin/stat -f '%u' "$HOME_DIR")" = "$CURRENT_UID" ] || fail "the current HOME directory is not owned by the current user"
CONTROL_CENTER_APP="$HOME_DIR/Applications/Equinox Local.app"

for command in /usr/bin/curl /usr/bin/shasum /usr/bin/stat /usr/bin/tar /usr/bin/mktemp /usr/bin/uname /usr/bin/id /usr/bin/env /usr/bin/open /usr/bin/grep /usr/bin/awk; do
  require_command "$command"
done
/usr/bin/curl --help all 2>/dev/null | /usr/bin/grep -q -- '--max-filesize' || fail "this macOS curl is too old for bounded downloads"

ARCH="$(/usr/bin/uname -m)"
case "$ARCH" in
  arm64) TARGET="darwin-arm64" ;;
  x86_64) TARGET="darwin-x64" ;;
  *) fail "unsupported Mac architecture: $ARCH" ;;
esac

# Same original pinned signed Main archive verifier used by PowerShell.
MAIN_VERIFY_URL="https://local.sametbasbug.dev/downloads/updates/install-main-verify.mjs"
MAIN_VERIFY_SHA256="df0aea950440d6efad47b92398a0a8bdc4a63d4db0a26d4db05a0b137c9989c8"
MAIN_VERIFY_BYTES=9396
MAIN_NODE_VERSION="26.12.1"
case "$TARGET" in
  darwin-arm64)
    MAIN_NODE_ARCHIVE_BYTES=58334853
    MAIN_NODE_ARCHIVE_SHA256="1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8" ;;
  darwin-x64)
    MAIN_NODE_ARCHIVE_BYTES=59800211
    MAIN_NODE_ARCHIVE_SHA256="b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff" ;;
  *) fail "unsupported Main bootstrap architecture" ;;
esac

# No trust is given to JavaScript merely because it arrives over HTTPS.
# Source digest and pinned Node official distribution are verified BEFORE
# either binary or downloaded JS code executes.
prepare_verified_main() {
  local verifier="$TEMP_ROOT/install-main-verify.mjs"
  local node_archive="$TEMP_ROOT/node.tar.gz"
  local node_root="node-v$MAIN_NODE_VERSION-$TARGET"
  local node_url="https://nodejs.org/dist/v$MAIN_NODE_VERSION/$node_root.tar.gz"
  info "checking pinned Main verification code"
  /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 40 --max-filesize "$MAIN_VERIFY_BYTES" \
    --output "$verifier" "$MAIN_VERIFY_URL" || fail "Main verifier download failed"
  [ "$(/usr/bin/stat -f '%z' "$verifier")" = "$MAIN_VERIFY_BYTES" ] ||
    fail "Main verifier byte count mismatch"
  [ "$(/usr/bin/shasum -a 256 "$verifier" | /usr/bin/awk '{print $1}')" = "$MAIN_VERIFY_SHA256" ] ||
    fail "Main verifier trusted code SHA-256 mismatch"
  info "checking pinned Node $MAIN_NODE_VERSION ($TARGET)"
  /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 240 --max-filesize "$MAIN_NODE_ARCHIVE_BYTES" \
    --output "$node_archive" "$node_url" || fail "pinned Node download failed"
  [ "$(/usr/bin/stat -f '%z' "$node_archive")" = "$MAIN_NODE_ARCHIVE_BYTES" ] ||
    fail "pinned Node byte count mismatch"
  [ "$(/usr/bin/shasum -a 256 "$node_archive" | /usr/bin/awk '{print $1}')" = "$MAIN_NODE_ARCHIVE_SHA256" ] ||
    fail "pinned Node SHA-256 mismatch"
  /usr/bin/tar -xzf "$node_archive" -C "$TEMP_ROOT" --no-same-owner ||
    fail "verified Node archive extraction failed"
  local node="$TEMP_ROOT/$node_root/bin/node"
  [ -f "$node" ] && [ ! -L "$node" ] && [ -x "$node" ] ||
    fail "verified Node executable missing"
  local archive="$TEMP_ROOT/main-native.tar.gz"
  local receipt
  receipt="$(/usr/bin/env -i HOME="$HOME_DIR" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "$node" "$verifier" --target "$TARGET" --output "$archive" \
    --pointer-output "$TEMP_ROOT/main-signed-pointer.json")" ||
    fail "production-signed Main selector or native archive verification failed"
  [ -f "$archive" ] && [ ! -L "$archive" ] ||
    fail "verified Main native archive was not produced"
  local signed_fields
  signed_fields="$(printf '%s' "$receipt" | /usr/bin/env -i HOME="$HOME_DIR" PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$node" -e '
    const fs=require("node:fs");
    const entry=JSON.parse(fs.readFileSync(0,"utf8"));
    if (!/^[a-f0-9]{40}$/.test(entry.sourceSha) ||
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(entry.version) ||
        entry.target!==process.argv[1]) process.exit(1);
    process.stdout.write(entry.sourceSha+" "+entry.version);
  ' "$TARGET")" || fail "signed Main receipt has an invalid source identity"
  local signed_sha signed_version
  read -r signed_sha signed_version <<< "$signed_fields"
  local extracted="$TEMP_ROOT/main-extracted"
  /bin/mkdir -m 700 "$extracted" ||
    fail "could not create Main native inspection directory"
  /usr/bin/tar -xzf "$archive" -C "$extracted" --no-same-owner ||
    fail "could not unpack verified Main candidate"
  local candidate="$extracted/release"
  local inspector="$candidate/equinox-local-first-install.js"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] &&
    [ -f "$inspector" ] && [ ! -L "$inspector" ] ||
    fail "verified Main candidate lacks a normal native release/inspector"
  /usr/bin/env -i HOME="$HOME_DIR" PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$node" "$inspector" --inspect-signed-main     --staged-release "$candidate" --source-sha "$signed_sha"     --version "$signed_version" --target "$TARGET" \
    --signed-pointer-file "$TEMP_ROOT/main-signed-pointer.json" >/dev/null ||
    fail "Main native release metadata does not match the signed full SHA"
  printf '%s\n' "$receipt"
}

TEMP_ROOT="$(/usr/bin/mktemp -d /tmp/equinox-local-install.XXXXXX)" || fail "could not create a private temporary directory"

cleanup() {
  /bin/rm -rf "$TEMP_ROOT" 2>/dev/null || true
}

handle_signal() {
  trap - HUP INT TERM
  exit 130
}

trap cleanup EXIT
trap handle_signal HUP INT TERM

prepare_verified_main
info "replacing product executables with signed Main (settings preserved)"
INSTALL_ROOT="$HOME_DIR/Library/Application Support/Equinox Local"
require_private_directory "$INSTALL_ROOT"
# Stop only the product's launchd service; never interrupt other processes.
/bin/launchctl bootout "gui/$CURRENT_UID/dev.equinox.local" >/dev/null 2>&1 || true
# Never remove user state/config, workspace, secrets, downloads or logs.
# The immutable native store and old Git source are executable caches too.
for entry in current releases runtime main-update; do
  old="$INSTALL_ROOT/$entry"
  if [ -L "$old" ] && [ "$entry" != "current" ]; then
    fail "unsafe prior executable directory: $entry"
  fi
  if [ -e "$old" ] || [ -L "$old" ]; then
    [ "$(/usr/bin/stat -f '%u' "$old" 2>/dev/null)" = "$CURRENT_UID" ] ||
      fail "prior executable belongs to another user: $entry"
    /bin/rm -rf "$old" || fail "could not retire previous executable: $entry"
  fi
done
MAIN_NODE="$TEMP_ROOT/node-v$MAIN_NODE_VERSION-$TARGET/bin/node"
MAIN_INSTALLER="$TEMP_ROOT/main-extracted/release/equinox-local-first-install.js"
MAIN_ARCHIVE="$TEMP_ROOT/main-native.tar.gz"
MAIN_POINTER="$TEMP_ROOT/main-signed-pointer.json"
/usr/bin/env -i HOME="$HOME_DIR" USER="$CURRENT_USER" LOGNAME="$CURRENT_USER" \
  TMPDIR="/tmp" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  "$MAIN_NODE" "$MAIN_INSTALLER" --install-main-fresh \
  --signed-pointer-file "$MAIN_POINTER" --archive "$MAIN_ARCHIVE" ||
  fail "fresh signed Main installation failed; settings retained, rerun the same installer"
info "signed Main installation is healthy; opening Equinox Local"
if [ -d "$CONTROL_CENTER_APP" ] && [ ! -L "$CONTROL_CENTER_APP" ]; then
  /usr/bin/open "$CONTROL_CENTER_APP" >/dev/null 2>&1 || true
fi
info "done"
exit 0
