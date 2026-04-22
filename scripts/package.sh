#!/usr/bin/env bash
# Build a release ZIP for Chrome Web Store submission.
# Usage: bash scripts/package.sh
#
# Reads version from manifest.json, validates required files, and produces
# dist/tab-rotator-<version>.zip with only the files required at runtime.

set -euo pipefail

# Move to repo root (directory that contains this script's parent).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- Read version from manifest.json (no jq dependency) ---------------------
if [[ ! -f manifest.json ]]; then
  echo "error: manifest.json not found in $REPO_ROOT" >&2
  exit 1
fi

VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' manifest.json \
  | head -n1 \
  | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"

if [[ -z "${VERSION:-}" ]]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

# Semver-ish validation (allows X.Y or X.Y.Z or X.Y.Z.W, which Chrome accepts).
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  echo "error: version '$VERSION' is not in Chrome-accepted X.Y[.Z[.W]] form" >&2
  exit 1
fi

# --- Validate required files ------------------------------------------------
REQUIRED_FILES=(
  "manifest.json"
  "background.js"
  "popup.html"
  "popup.js"
  "_locales/en/messages.json"
  "_locales/ru/messages.json"
  "_locales/uz/messages.json"
  "assets/icons/icon16.png"
  "assets/icons/icon48.png"
  "assets/icons/icon128.png"
  "assets/icons/icon-on-icon16.png"
  "assets/icons/icon-on-icon48.png"
  "assets/icons/icon-on-icon128.png"
  "assets/icons/icon-off-icon16.png"
  "assets/icons/icon-off-icon48.png"
  "assets/icons/icon-off-icon128.png"
  "LICENSE"
)

missing=0
for f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "error: required file missing: $f" >&2
    missing=1
  fi
done
if [[ $missing -ne 0 ]]; then
  exit 1
fi

# --- Prepare output ---------------------------------------------------------
mkdir -p dist
OUTPUT="dist/tab-rotator-${VERSION}.zip"
rm -f "$OUTPUT"

# --- Build zip --------------------------------------------------------------
# We explicitly list top-level items to include, and use -x to exclude
# editor/VCS metadata and markdown docs from the archive.
INCLUDES=(
  "manifest.json"
  "background.js"
  "popup.html"
  "popup.js"
  "_locales"
  "assets"
  "LICENSE"
)

EXCLUDES=(
  "*.DS_Store"
  "Thumbs.db"
  "*/.DS_Store"
  "*/Thumbs.db"
)

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed. Install it (e.g. 'apt-get install zip') and retry." >&2
  exit 1
fi

zip -r -q "$OUTPUT" "${INCLUDES[@]}" -x "${EXCLUDES[@]}"

# --- Self-check -------------------------------------------------------------
if command -v unzip >/dev/null 2>&1; then
  if ! unzip -p "$OUTPUT" manifest.json | grep -q "\"version\": \"$VERSION\""; then
    echo "error: archive does not contain expected manifest version $VERSION" >&2
    exit 1
  fi
fi

SIZE_BYTES=$(wc -c < "$OUTPUT" | tr -d '[:space:]')
echo "built: $OUTPUT (version $VERSION, ${SIZE_BYTES} bytes)"
