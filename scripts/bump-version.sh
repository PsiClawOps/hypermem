#!/usr/bin/env bash
# bump-version.sh — Bump version across all 3 packages atomically
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.9.0

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Current versions:"
  for pkg in package.json plugin/package.json memory-plugin/package.json; do
    echo "  $pkg: $(grep '"version"' "$REPO_ROOT/$pkg" | head -1 | sed 's/.*: "//;s/".*//')"
  done
  exit 1
fi

# Validate semver-ish format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: '$VERSION' doesn't look like a valid version (expected X.Y.Z or X.Y.Z-tag)"
  exit 1
fi

PACKAGES=(
  "package.json"
  "plugin/package.json"
  "memory-plugin/package.json"
)

echo "Bumping all packages to $VERSION..."
for pkg in "${PACKAGES[@]}"; do
  FILE="$REPO_ROOT/$pkg"
  if [ ! -f "$FILE" ]; then
    echo "  SKIP $pkg (not found)"
    continue
  fi
  OLD=$(grep '"version"' "$FILE" | head -1 | sed 's/.*: "//;s/".*//')
  sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$VERSION\"/" "$FILE"
  echo "  $pkg: $OLD -> $VERSION"
done

echo ""
echo "Done. Don't forget:"
echo "  1. git add package.json plugin/package.json memory-plugin/package.json"
echo "  2. git commit -m 'release: v$VERSION'"
echo "  3. npm publish (from each package dir if publishing separately)"
