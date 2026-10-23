#!/usr/bin/env bash
# Sync this standalone bridge bundle from an AI-DLC source checkout.
#
#   AIDLC_SRC=/path/to/aidlc-workflows ./sync.sh
#
# Copies the plugin files, refreshes SYNC.json with the AI-DLC release and
# source commit, then prints what changed. It never commits or tags; release
# steps are in README.md.
set -euo pipefail

SRC="${AIDLC_SRC:-$HOME/projects/aidlc-workflows}"
PLUGIN_SRC="$SRC/harness/deepseek/dsh-plugin"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$PLUGIN_SRC/index.js" ] || { echo "not an AI-DLC checkout with the DSH plugin: $SRC" >&2; exit 1; }
[ -f "$PLUGIN_SRC/package.json" ] || { echo "missing $PLUGIN_SRC/package.json" >&2; exit 1; }

current_version="$(node -p "require('$HERE/package.json').version" 2>/dev/null || true)"

cp "$PLUGIN_SRC/index.js" "$HERE/index.js"
cp "$PLUGIN_SRC/cordis.patch.yml" "$HERE/cordis.patch.yml"
cp "$PLUGIN_SRC/icon.svg" "$HERE/icon.svg"
cp "$PLUGIN_SRC/package.json" "$HERE/package.json"
mkdir -p "$HERE/locale"
cp "$PLUGIN_SRC"/locale/*.json "$HERE/locale/"

# This repository versions the bundle independently of the in-project copy
# (which carries the constant 1.0.0), so restore its own release version.
if [ -n "$current_version" ]; then
  node -e 'const fs=require("node:fs");const p=process.argv[1];const v=process.argv[2];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version=v;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$HERE/package.json" "$current_version"
fi

version="$(sed -n 's/.*AIDLC_VERSION = "\([^"]*\)".*/\1/p' "$SRC/core/tools/aidlc-version.ts" | head -n 1)"
[ -n "$version" ] || { echo "could not read AIDLC_VERSION from $SRC/core/tools/aidlc-version.ts" >&2; exit 1; }
commit="$(git -C "$SRC" rev-parse --short HEAD)"
repo="$(git -C "$SRC" config --get remote.origin.url || true)"

cat > "$HERE/SYNC.json" <<EOF
{
  "aidlcVersion": "$version",
  "aidlcSourceCommit": "$commit",
  "aidlcSourceRepository": "$repo",
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "synced from $SRC (AI-DLC $version, commit $commit)"
git -C "$HERE" status --short
git -C "$HERE" diff --stat
