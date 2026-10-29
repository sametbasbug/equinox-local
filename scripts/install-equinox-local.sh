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
MAIN_VERIFY_SHA256="7a34d70e65c5b641c63baba1b5bd00f6b64ab9237d47f01fabce67702c4f99a5"
MAIN_VERIFY_BYTES=9728
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

# Node canonicalizes macOS /tmp to /private/tmp when evaluating import.meta.url.
# The pinned verifier checks its entrypoint against process.argv[1]; staging
# under the real path is required or it silently exits without downloading.
TEMP_ROOT="$(/usr/bin/mktemp -d /private/tmp/equinox-local-install.XXXXXX)" || fail "could not create a private temporary directory"

# Preserve the previous product-owned executable roots until the exact signed
# replacement has returned its healthy completion receipt. This is failure
# recovery for the SAME installer, not a separate updater or version rollback.
REINSTALL_BACKUP_ROOT=""
REINSTALL_BACKUP_OWNED=false
REINSTALL_SERVICE_STOPPED=false
REINSTALL_HAD_OLD_AGENT=false
REINSTALL_NEW_INSTALL_STARTED=false
REINSTALL_COMMITTED=false
# These are only the product-owned executables/launchers that the signed
# bootstrap rewrites. User configuration, TCC grants and download data stay.
owned_executable_path() {
  case "$1" in
    current|releases|runtime|main-update|equinox-local-app-runtime|equinox-browser-native-host)
      printf '%s/%s' "$INSTALL_ROOT" "$1" ;;
    control-center-app) printf '%s' "$CONTROL_CENTER_APP" ;;
    launch-agent) printf '%s' "$HOME_DIR/Library/LaunchAgents/dev.equinox.local.plist" ;;
    native-host-manifest) printf '%s' "$HOME_DIR/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.equinox.browser.json" ;;
    *) return 1 ;;
  esac
}
REINSTALL_EXECUTABLES=(current releases runtime main-update control-center-app equinox-local-app-runtime launch-agent equinox-browser-native-host native-host-manifest)
cleanup() {
  if [ "$REINSTALL_COMMITTED" != true ] && [ "$REINSTALL_BACKUP_OWNED" = true ] &&
     [ -n "$REINSTALL_BACKUP_ROOT" ] &&
     [ -d "$REINSTALL_BACKUP_ROOT" ] && [ ! -L "$REINSTALL_BACKUP_ROOT" ]; then
    # Never stop a still-healthy old service merely because preservation
    # failed before the installer took ownership of the service.
    if [ "$REINSTALL_SERVICE_STOPPED" = true ]; then
      /bin/launchctl bootout "gui/$CURRENT_UID/dev.equinox.local" >/dev/null 2>&1 || true
    fi
    local recovery_ok=true
    for entry in "${REINSTALL_EXECUTABLES[@]}"; do
      saved="$REINSTALL_BACKUP_ROOT/$entry"
      if [ -e "$saved" ] || [ -L "$saved" ]; then
        current="$(owned_executable_path "$entry")"
        if ! { /bin/rm -rf "$current" && /bin/mv "$saved" "$current"; }; then
          recovery_ok=false
          printf 'Equinox Local installer: recovery failed; preserved %s at %s\n' "$entry" "$saved" >&2
        fi
      elif [ "$REINSTALL_NEW_INSTALL_STARTED" = true ]; then
        # No prior entry existed. Remove only the product-owned entry the
        # failed fresh installer may have created; never touch user state.
        if ! /bin/rm -rf "$(owned_executable_path "$entry")"; then
          recovery_ok=false
          printf 'Equinox Local installer: failed to clean new executable: %s\n' "$entry" >&2
        fi
      fi
    done
    if [ "$recovery_ok" = true ] && [ -z "$(/bin/ls -A "$REINSTALL_BACKUP_ROOT" 2>/dev/null)" ]; then
      /bin/rmdir "$REINSTALL_BACKUP_ROOT" || true
      if [ "$REINSTALL_SERVICE_STOPPED" = true ] && [ "$REINSTALL_HAD_OLD_AGENT" = true ]; then
        if ! /bin/launchctl bootstrap "gui/$CURRENT_UID" "$HOME_DIR/Library/LaunchAgents/dev.equinox.local.plist" >/dev/null 2>&1; then
          printf 'Equinox Local installer: old executable files restored, but launchd bootstrap failed; restart the old service manually.\n' >&2
        elif ! /bin/launchctl kickstart "gui/$CURRENT_UID/dev.equinox.local" >/dev/null 2>&1; then
          printf 'Equinox Local installer: old executable files restored, but launchd kickstart failed; restart the old service manually.\n' >&2
        fi
      fi
    fi
  fi
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
# Never remove user state/config, workspace, secrets, downloads or logs.
# Native executable roots are retained by same-volume rename. If the new
# signed installer or its health receipt fails, the EXIT handler restores A.
REINSTALL_BACKUP_ROOT="$INSTALL_ROOT/.equinox-main-reinstall-preserved"
if [ -e "$REINSTALL_BACKUP_ROOT" ] || [ -L "$REINSTALL_BACKUP_ROOT" ]; then
  fail "previous interrupted installation may be recoverable; refusing to replace $REINSTALL_BACKUP_ROOT"
fi
# Reject unsafe prior entries BEFORE stopping the currently healthy service.
# `mv` must be a same-volume rename, not a slow copy-and-delete of a live app.
REINSTALL_VOLUME="$(/usr/bin/stat -f '%d' "$INSTALL_ROOT")" || fail "cannot identify installer volume"
for entry in "${REINSTALL_EXECUTABLES[@]}"; do
  old="$(owned_executable_path "$entry")"
  if [ -L "$old" ] && [ "$entry" != "current" ]; then
    fail "unsafe prior executable entry: $entry"
  fi
  if [ -e "$old" ] || [ -L "$old" ]; then
    [ "$(/usr/bin/stat -f '%u' "$old" 2>/dev/null)" = "$CURRENT_UID" ] ||
      fail "prior executable belongs to another user: $entry"
    [ "$(/usr/bin/stat -f '%d' "$old" 2>/dev/null)" = "$REINSTALL_VOLUME" ] ||
      fail "prior executable is not on the installation volume: $entry"
  fi
done
# Make the recovery directory BEFORE touching the running service. Failure
# here must leave the previous healthy installation running.
/bin/mkdir -m 700 "$REINSTALL_BACKUP_ROOT" || fail "cannot preserve previous executable roots"
REINSTALL_BACKUP_OWNED=true
if [ -f "$(owned_executable_path launch-agent)" ]; then REINSTALL_HAD_OLD_AGENT=true; fi
# Stop only the product's launchd service after the above fail-closed checks.
REINSTALL_SERVICE_STOPPED=true
/bin/launchctl bootout "gui/$CURRENT_UID/dev.equinox.local" >/dev/null 2>&1 || true
for entry in "${REINSTALL_EXECUTABLES[@]}"; do
  old="$(owned_executable_path "$entry")"
  if [ -L "$old" ] && [ "$entry" != "current" ]; then
    fail "unsafe prior executable directory: $entry"
  fi
  if [ -e "$old" ] || [ -L "$old" ]; then
    [ "$(/usr/bin/stat -f '%u' "$old" 2>/dev/null)" = "$CURRENT_UID" ] ||
      fail "prior executable belongs to another user: $entry"
    /bin/mv "$old" "$REINSTALL_BACKUP_ROOT/$entry" || fail "could not preserve previous executable: $entry"
  fi
done
# Every old entry has now been moved; a failed replacement may safely remove
# new product-owned entries that did not exist before this installation.
REINSTALL_NEW_INSTALL_STARTED=true
MAIN_NODE="$TEMP_ROOT/node-v$MAIN_NODE_VERSION-$TARGET/bin/node"
MAIN_INSTALLER="$TEMP_ROOT/main-extracted/release/equinox-local-first-install.js"
MAIN_ARCHIVE="$TEMP_ROOT/main-native.tar.gz"
MAIN_POINTER="$TEMP_ROOT/main-signed-pointer.json"
/usr/bin/env -i HOME="$HOME_DIR" USER="$CURRENT_USER" LOGNAME="$CURRENT_USER" \
  TMPDIR="/tmp" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  "$MAIN_NODE" "$MAIN_INSTALLER" --install-main-fresh \
  --signed-pointer-file "$MAIN_POINTER" --archive "$MAIN_ARCHIVE" ||
  fail "fresh signed Main installation failed; attempting to restore previous executables"
REINSTALL_COMMITTED=true
# Cleanup failures never invalidate a healthy exact-SHA signed installation.
/bin/rm -rf "$REINSTALL_BACKUP_ROOT" ||
  info "old executable cleanup deferred: $REINSTALL_BACKUP_ROOT"
info "signed Main installation is healthy; opening Equinox Local"
if [ -d "$CONTROL_CENTER_APP" ] && [ ! -L "$CONTROL_CENTER_APP" ]; then
  /usr/bin/open "$CONTROL_CENTER_APP" >/dev/null 2>&1 || true
fi
info "done"
exit 0
