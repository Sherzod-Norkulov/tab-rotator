#!/usr/bin/env bash
set -euo pipefail
umask 077

# Package exactly committed runtime files and the committed packager. This does
# not use untracked/ignored payloads or modified files in the runner checkout.
package_tracked() (
  set -euo pipefail
  snapshot="$(mktemp -d "${RUNNER_TEMP:?Runner-owned scratch directory required}/tab-tracked.XXXXXXXX")"
  trap 'rm -rf -- "$snapshot"' EXIT
  runtime=(manifest.json background.js popup.html popup.js _locales assets LICENSE scripts/package.sh)
  if git ls-tree -r HEAD -- "${runtime[@]}" | awk '$1 == "120000" { found=1 } END { exit found ? 0 : 1 }'; then
    printf 'Committed runtime symlinks are not supported in the release ZIP.\n' >&2
    exit 1
  fi
  mkdir "$snapshot/tree"
  git archive --format=tar --output="$snapshot/source.tar" HEAD -- "${runtime[@]}"
  tar -xf "$snapshot/source.tar" -C "$snapshot/tree"
  (cd "$snapshot/tree" && bash scripts/package.sh)
  version="$(python3 -c 'import json,re,sys;v=json.load(open(sys.argv[1]))["version"];assert re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}",v);print(v)' "$snapshot/tree/manifest.json")"
  mkdir -p dist
  python3 - "$snapshot/tree/dist/tab-rotator-$version.zip" "dist/tab-rotator-$version.zip" <<'COPY_ZIP'
import shutil,sys
with open(sys.argv[1], 'rb') as source, open(sys.argv[2], 'xb') as target:
    shutil.copyfileobj(source, target, 64 * 1024)
COPY_ZIP
)

# Expose only the pure packaging function to the bounded scratch regression.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi
python3 -I -B scripts/ci/artifact.py context
python3 -B scripts/ci/test-handoff.py
python3 -I -B scripts/ci/test-release-state.py
python3 -I -B scripts/ci/test-tracked-package.py
for file in manifest.json _locales/en/messages.json _locales/ru/messages.json _locales/uz/messages.json; do
  python3 -c 'import json,sys;json.load(open(sys.argv[1],encoding="utf-8"))' "$file"
done
# The official runner ships the pinned Node24 binary alongside its bin directory.
node_binary="$(dirname "$(dirname "$RUNNER_WORKSPACE")")/externals/node24/bin/node"
test -x "$node_binary"
"$node_binary" --check background.js
"$node_binary" --check popup.js
package_tracked
python3 -I -B scripts/ci/artifact.py store
git diff --exit-code HEAD
