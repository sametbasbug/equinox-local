#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/extension"
OUT_DIR="$ROOT_DIR/backups/browser-packages"

VERSION="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!/^\d+\.\d+\.\d+$/.test(m.version || "")) process.exit(2); process.stdout.write(m.version);' "$SOURCE_DIR/manifest.json")"
OUT_PATH="$OUT_DIR/equinox-browser-$VERSION.zip"
mkdir -p "$OUT_DIR"
TMP_LIST="$(mktemp)"
TMP_DIR="$(mktemp -d "$OUT_DIR/.equinox-browser-$VERSION.XXXXXX")"
STAGE_DIR="$TMP_DIR/stage"
TMP_ZIP="$TMP_DIR/equinox-browser-$VERSION.zip"
trap 'rm -f "$TMP_LIST"; rm -rf "$TMP_DIR"' EXIT
mkdir -p "$STAGE_DIR"

cat > "$TMP_LIST" <<'FILES'
icons/icon-128.png
icons/icon-16.png
icons/icon-32.png
icons/icon-48.png
manifest.json
popup.css
popup.html
popup.js
service-worker.js
FILES

while IFS= read -r relative; do
  if [[ ! -f "$SOURCE_DIR/$relative" || -L "$SOURCE_DIR/$relative" ]]; then
    echo "Missing or unsafe Equinox Browser package file: $relative" >&2
    exit 3
  fi
  mkdir -p "$STAGE_DIR/$(dirname "$relative")"
  install -m 600 "$SOURCE_DIR/$relative" "$STAGE_DIR/$relative"
done < "$TMP_LIST"

# Normalize mtimes in the staging tree so identical source content produces the
# same Chrome Web Store ZIP and SHA-256 across package runs/checkouts.
/usr/bin/find "$STAGE_DIR" -exec /usr/bin/touch -h -t 202601010000.00 {} +
(
  cd "$STAGE_DIR"
  /usr/bin/zip -q -X "$TMP_ZIP" -@ < "$TMP_LIST"
)

ACTUAL_LIST="$(/usr/bin/unzip -Z1 "$TMP_ZIP" | LC_ALL=C sort)"
EXPECTED_LIST="$(LC_ALL=C sort "$TMP_LIST")"
if [[ "$ACTUAL_LIST" != "$EXPECTED_LIST" ]]; then
  echo "Equinox Browser package contents do not match the runtime allowlist." >&2
  exit 4
fi

if ! /usr/bin/unzip -p "$TMP_ZIP" manifest.json | node -e '
const crypto=require("node:crypto");
let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
  const m = JSON.parse(input);
  if (m.manifest_version !== 3 || m.name !== "Equinox Browser" || !m.version || typeof m.key !== "string") process.exit(5);
  const prefix=crypto.createHash("sha256").update(Buffer.from(m.key,"base64")).digest("hex").slice(0,32);
  const id=[...prefix].map(c=>String.fromCharCode(97+parseInt(c,16))).join("");
  if (id !== "npdneefcobilfkjlihghjgjnknenhfoj") process.exit(5);
});'; then
  echo "Packaged manifest validation failed." >&2
  exit 5
fi

mv -f "$TMP_ZIP" "$OUT_PATH"
rm -rf "$TMP_DIR"
trap 'rm -f "$TMP_LIST"' EXIT

SHA256="$(shasum -a 256 "$OUT_PATH" | awk '{print $1}')"
BYTES="$(stat -f '%z' "$OUT_PATH")"
printf 'Equinox Browser Chrome Web Store draft package ready.\n'
printf 'Version: %s\n' "$VERSION"
printf 'Path: %s\n' "$OUT_PATH"
printf 'Bytes: %s\n' "$BYTES"
printf 'SHA-256: %s\n' "$SHA256"
