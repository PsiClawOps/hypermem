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
echo "Versions bumped. Next steps:"
echo "  git add package.json plugin/package.json memory-plugin/package.json"
echo "  git commit -m 'release: v$VERSION'"
echo "  git push"

if [ "${2:-}" = "--publish" ]; then
  echo ""
  echo "Publishing to npm..."
  for dir in "." "plugin" "memory-plugin"; do
    PKG="$REPO_ROOT/$dir"
    if [ -f "$PKG/package.json" ]; then
      NAME=$(grep '"name"' "$PKG/package.json" | head -1 | sed 's/.*: "//;s/".*//')
      echo "  Publishing $NAME@$VERSION..."
      (cd "$PKG" && npm publish --access public 2>&1 | tail -1)
    fi
  done
  echo "Done."
else
  echo ""
  echo "To also publish to npm, re-run with --publish:"
  echo "  $0 $VERSION --publish"
fi
