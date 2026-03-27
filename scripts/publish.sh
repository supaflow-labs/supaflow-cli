#!/usr/bin/env bash
set -euo pipefail

# Publish @getsupaflow/cli to npm
# Usage: ./scripts/publish.sh [patch|minor|major]
# Default: patch

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")/.."

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure on main branch
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: Must be on main branch (currently on $BRANCH)."
  exit 1
fi

# Run lint and tests
echo "Running lint..."
npm run lint

echo "Running tests..."
npm test

# Bump version in package.json (npm version also creates a git tag)
echo "Bumping $BUMP_TYPE version..."
NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version | tr -d 'v')
echo "New version: $NEW_VERSION"

# Update version in src/index.ts (Commander hardcodes it)
sed -i '' "s/\.version('[^']*')/\.version('$NEW_VERSION')/" src/index.ts

# Build
echo "Building..."
npm run build

# Run tests again with new build
npm test

# Commit and tag
git add package.json package-lock.json src/index.ts
git commit -m "Release v$NEW_VERSION"
git tag "v$NEW_VERSION"

# Publish
echo "Publishing to npm..."
npm publish --access public

# Push commit and tag
git push origin main
git push origin "v$NEW_VERSION"

echo ""
echo "Published @getsupaflow/cli@$NEW_VERSION"
echo "  npm: https://www.npmjs.com/package/@getsupaflow/cli"
echo "  tag: v$NEW_VERSION"
