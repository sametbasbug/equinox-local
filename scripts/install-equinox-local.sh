#!/bin/bash
set -euo pipefail
umask 077

UPDATE_BASE="https://local.sametbasbug.dev/downloads/updates"
CONTROL_CENTER_URL="http://127.0.0.1:24891/"
MAX_MANIFEST_BYTES=16384
MAX_ARTIFACT_BYTES=1073741824

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

MANIFEST_URL="$UPDATE_BASE/bootstrap-$TARGET.txt"
TEMP_ROOT="$(/usr/bin/mktemp -d /tmp/equinox-local-install.XXXXXX)" || fail "could not create a private temporary directory"
MANIFEST_PATH="$TEMP_ROOT/bootstrap.txt"
ARTIFACT_PATH="$TEMP_ROOT/release.tar.gz"
STAGE=""

cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ] && [ ! -L "$STAGE" ]; then
    /bin/rm -rf "$STAGE" 2>/dev/null || true
  fi
  /bin/rm -rf "$TEMP_ROOT" 2>/dev/null || true
}

handle_signal() {
  trap - HUP INT TERM
  exit 130
}

trap cleanup EXIT
trap handle_signal HUP INT TERM

info "checking the stable $TARGET bootstrap manifest"
/usr/bin/curl \
  --fail --silent --show-error \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 30 \
  --max-filesize "$MAX_MANIFEST_BYTES" \
  --output "$MANIFEST_PATH" \
  "$MANIFEST_URL" || fail "could not download the bootstrap manifest"

MANIFEST_BYTES="$(/usr/bin/stat -f '%z' "$MANIFEST_PATH")"
[ "$MANIFEST_BYTES" -gt 0 ] && [ "$MANIFEST_BYTES" -le "$MAX_MANIFEST_BYTES" ] || fail "bootstrap manifest size is invalid"

SCHEMA_VERSION=""
CHANNEL=""
MANIFEST_TARGET=""
VERSION=""
ARTIFACT_URL=""
ARTIFACT_SHA256=""
ARTIFACT_BYTES=""
SEEN_SCHEMA=0
SEEN_CHANNEL=0
SEEN_TARGET=0
SEEN_VERSION=0
SEEN_URL=0
SEEN_SHA=0
SEEN_BYTES=0

while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  case "$line" in
    *$'\r'*) fail "bootstrap manifest contains unsupported line endings" ;;
    *=*) key="${line%%=*}"; value="${line#*=}" ;;
    *) fail "bootstrap manifest contains a malformed line" ;;
  esac
  case "$key" in
    schemaVersion)
      [ "$SEEN_SCHEMA" -eq 0 ] || fail "bootstrap manifest repeats schemaVersion"
      SCHEMA_VERSION="$value"; SEEN_SCHEMA=1 ;;
    channel)
      [ "$SEEN_CHANNEL" -eq 0 ] || fail "bootstrap manifest repeats channel"
      CHANNEL="$value"; SEEN_CHANNEL=1 ;;
    target)
      [ "$SEEN_TARGET" -eq 0 ] || fail "bootstrap manifest repeats target"
      MANIFEST_TARGET="$value"; SEEN_TARGET=1 ;;
    version)
      [ "$SEEN_VERSION" -eq 0 ] || fail "bootstrap manifest repeats version"
      VERSION="$value"; SEEN_VERSION=1 ;;
    artifactUrl)
      [ "$SEEN_URL" -eq 0 ] || fail "bootstrap manifest repeats artifactUrl"
      ARTIFACT_URL="$value"; SEEN_URL=1 ;;
    artifactSha256)
      [ "$SEEN_SHA" -eq 0 ] || fail "bootstrap manifest repeats artifactSha256"
      ARTIFACT_SHA256="$value"; SEEN_SHA=1 ;;
    artifactBytes)
      [ "$SEEN_BYTES" -eq 0 ] || fail "bootstrap manifest repeats artifactBytes"
      ARTIFACT_BYTES="$value"; SEEN_BYTES=1 ;;
    *) fail "bootstrap manifest contains an unsupported field: $key" ;;
  esac
done < "$MANIFEST_PATH"

[ "$SEEN_SCHEMA" -eq 1 ] && [ "$SCHEMA_VERSION" = "1" ] || fail "unsupported bootstrap manifest schema"
[ "$SEEN_CHANNEL" -eq 1 ] && [ "$CHANNEL" = "stable" ] || fail "unexpected bootstrap channel"
[ "$SEEN_TARGET" -eq 1 ] && [ "$MANIFEST_TARGET" = "$TARGET" ] || fail "bootstrap manifest target does not match this Mac"
[ "$SEEN_VERSION" -eq 1 ] || fail "bootstrap manifest version is missing"
printf '%s\n' "$VERSION" | /usr/bin/grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail "bootstrap manifest version is invalid"
[ "$SEEN_SHA" -eq 1 ] || fail "bootstrap manifest SHA-256 is missing"
printf '%s\n' "$ARTIFACT_SHA256" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || fail "bootstrap manifest SHA-256 is invalid"
[ "$SEEN_BYTES" -eq 1 ] || fail "bootstrap manifest artifact size is missing"
case "$ARTIFACT_BYTES" in
  ''|*[!0-9]*) fail "bootstrap manifest artifact size is invalid" ;;
esac
[ "$ARTIFACT_BYTES" -gt 0 ] && [ "$ARTIFACT_BYTES" -le "$MAX_ARTIFACT_BYTES" ] || fail "bootstrap artifact size is outside the allowed range"
EXPECTED_ARTIFACT_URL="$UPDATE_BASE/equinox-local-$VERSION-$TARGET.tar.gz"
[ "$SEEN_URL" -eq 1 ] && [ "$ARTIFACT_URL" = "$EXPECTED_ARTIFACT_URL" ] || fail "bootstrap artifact URL escaped the pinned Equinox Local HTTPS path"

info "downloading Equinox Local $VERSION"
/usr/bin/curl \
  --fail --silent --show-error \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 600 \
  --max-filesize "$ARTIFACT_BYTES" \
  --output "$ARTIFACT_PATH" \
  "$ARTIFACT_URL" || fail "could not download the Equinox Local release"

ACTUAL_BYTES="$(/usr/bin/stat -f '%z' "$ARTIFACT_PATH")"
[ "$ACTUAL_BYTES" = "$ARTIFACT_BYTES" ] || fail "downloaded release size does not match the bootstrap manifest"
ACTUAL_SHA256="$(/usr/bin/shasum -a 256 "$ARTIFACT_PATH" | /usr/bin/awk '{print $1}')"
[ "$ACTUAL_SHA256" = "$ARTIFACT_SHA256" ] || fail "downloaded release SHA-256 verification failed"

INSTALL_ROOT="$HOME_DIR/Library/Application Support/Equinox Local"
STAGING_ROOT="$INSTALL_ROOT/staging"
require_private_directory "$INSTALL_ROOT"
require_private_directory "$STAGING_ROOT"
STAGE="$(/usr/bin/mktemp -d "$STAGING_ROOT/bootstrap-$VERSION.XXXXXX")" || fail "could not create the managed staging directory"
/bin/chmod 700 "$STAGE" 2>/dev/null || true

info "installing the verified release"
/usr/bin/tar -xzf "$ARTIFACT_PATH" -C "$STAGE" --no-same-owner || fail "could not extract the verified Equinox Local release"
SOURCE_RELEASE="$STAGE/release"
[ -d "$SOURCE_RELEASE" ] && [ ! -L "$SOURCE_RELEASE" ] || fail "verified release archive has an invalid root"
NODE="$SOURCE_RELEASE/runtime/node/bin/node"
FIRST_INSTALL="$SOURCE_RELEASE/equinox-local-first-install.js"
[ -x "$NODE" ] || fail "bundled Node runtime is missing"
[ -f "$FIRST_INSTALL" ] && [ ! -L "$FIRST_INSTALL" ] || fail "first-install helper is missing"

RESULT="$(/usr/bin/env -i \
  HOME="$HOME_DIR" \
  USER="$CURRENT_USER" \
  LOGNAME="$CURRENT_USER" \
  TMPDIR="/tmp" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  "$NODE" "$FIRST_INSTALL" --staged-release "$SOURCE_RELEASE")" || fail "managed first-install activation failed"

printf '%s\n' "$RESULT"
info "installation is ready; opening Control Center"
/usr/bin/open "$CONTROL_CENTER_URL" >/dev/null 2>&1 || true
info "done"
