#!/usr/bin/env bash
# bump-version.sh — Bump version across all 3 packages and package-locks atomically
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.9.0

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Current versions:"
  for pkg in package.json plugin/package.json memory-plugin/package.json; do
    echo "  $pkg: $(python3 - <<'PY' "$REPO_ROOT/$pkg"
import json, sys
print(json.load(open(sys.argv[1]))['version'])
PY
)"
  done
  exit 1
fi

if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: '$VERSION' doesn't look like a valid version (expected X.Y.Z or X.Y.Z-tag)"
  exit 1
fi

python3 - <<'PY' "$REPO_ROOT" "$VERSION"
from pathlib import Path
import json
import sys

root = Path(sys.argv[1])
version = sys.argv[2]
packages = [
    'package.json',
    'plugin/package.json',
    'memory-plugin/package.json',
]
locks = [
    'package-lock.json',
    'plugin/package-lock.json',
    'memory-plugin/package-lock.json',
]

print(f'Bumping all packages to {version}...')
for rel in packages:
    path = root / rel
    data = json.loads(path.read_text())
    old = data['version']
    data['version'] = version
    deps = data.get('dependencies')
    if isinstance(deps, dict) and deps.get('@psiclawops/hypermem') and rel != 'package.json':
        deps['@psiclawops/hypermem'] = version
    path.write_text(json.dumps(data, indent=2) + '\n')
    print(f'  {rel}: {old} -> {version}')

print('\nSyncing package-lock.json files...')
for rel in locks:
    path = root / rel
    if not path.exists():
        print(f'  SKIP {rel} (not found)')
        continue
    data = json.loads(path.read_text())
    old = data.get('version')
    data['version'] = version
    packages_block = data.get('packages')
    if isinstance(packages_block, dict) and '' in packages_block and isinstance(packages_block[''], dict):
        packages_block['']['version'] = version
        deps = packages_block[''].get('dependencies')
        if isinstance(deps, dict) and deps.get('@psiclawops/hypermem') and rel != 'package-lock.json':
            deps['@psiclawops/hypermem'] = version
    deps = data.get('dependencies')
    if isinstance(deps, dict) and isinstance(deps.get('@psiclawops/hypermem'), dict) and rel != 'package-lock.json':
        deps['@psiclawops/hypermem']['version'] = version
    path.write_text(json.dumps(data, indent=2) + '\n')
    print(f'  {rel}: {old} -> {version}')
PY

echo ""
echo "Validating version parity..."
node "$REPO_ROOT/scripts/validate-version-parity.mjs"

echo ""
echo "Versions bumped. Next steps:"
echo "  git add package.json plugin/package.json memory-plugin/package.json package-lock.json plugin/package-lock.json memory-plugin/package-lock.json src/version.ts scripts/validate-version-parity.mjs"
echo "  git commit -m 'release: v$VERSION'"
echo "  git push"

echo ""
echo "To also publish to npm, re-run with --publish:"
echo "  $0 $VERSION --publish"

if [ "${2:-}" = "--publish" ]; then
  echo ""
  echo "Publishing to npm..."
  for dir in "." "plugin" "memory-plugin"; do
    PKG="$REPO_ROOT/$dir"
    if [ -f "$PKG/package.json" ]; then
      NAME=$(python3 - <<'PY' "$PKG/package.json"
import json, sys
print(json.load(open(sys.argv[1]))['name'])
PY
)
      echo "  Publishing $NAME@$VERSION..."
      (cd "$PKG" && npm publish --access public 2>&1 | tail -1)
    fi
  done
  echo "Done."
fi
