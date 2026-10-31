#!/usr/bin/env bash
set -euo pipefail

# Publish an already-reviewed version from protected main. Never commits or pushes main.
# Usage: ./scripts/publish.sh <exact-version>
VERSION="${1:-}"
if [[ $# != 1 || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <exact-version> (prepare the version through a PR first)" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

verify_checkout() {
  [[ -z "$(git status --porcelain)" ]] || { echo 'Error: Working tree must be clean.' >&2; exit 1; }
  [[ "$(git branch --show-current)" == main ]] || { echo 'Error: Publish only from main.' >&2; exit 1; }
  local remote_main
  remote_main=$(git ls-remote --exit-code origin refs/heads/main)
  [[ "${remote_main%%[[:space:]]*}" == "$(git rev-parse HEAD)" ]] || { echo 'Error: HEAD must match remote main.' >&2; exit 1; }
}
verify_checkout
RELEASE_HEAD=$(git rev-parse HEAD)
node --input-type=module - "$VERSION" <<'NODE'
import fs from 'node:fs';
const expected = process.argv[2];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const source = fs.readFileSync('src/version.ts', 'utf8').match(/export const VERSION = '([^']+)';/)?.[1];
if (pkg.name !== '@getsupaflow/cli' || [pkg.version, lock.version, lock.packages?.['']?.version, source].some(v => v !== expected)) {
  console.error('Error: Package, lockfile and source versions must match the approved version. Prepare changes through a PR.');
  process.exit(1);
}
NODE

TAG="v$VERSION"
if git show-ref --verify --quiet "refs/tags/$TAG"; then
  echo 'Error: Local release tag exists; follow partial-release recovery.' >&2; exit 1
fi
remote_tag=$(git ls-remote origin "refs/tags/$TAG")
[[ -z "$remote_tag" ]] || { echo 'Error: Remote release tag exists.' >&2; exit 1; }
[[ "$(npm whoami)" == supa-flow ]] || { echo 'Error: Expected npm release identity supa-flow.' >&2; exit 1; }

# Only a confirmed E404 permits a new publication; authentication/network errors block it.
registry_result=$(mktemp)
trap 'rm -f "$registry_result"' EXIT
if npm view "@getsupaflow/cli@$VERSION" version --json >"$registry_result" 2>/dev/null; then
  echo 'Error: Version already exists on npm; do not republish.' >&2; exit 1
fi
node --input-type=module - "$registry_result" <<'NODE'
import fs from 'node:fs';
try {
  if (JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).error?.code === 'E404') process.exit(0);
} catch {}
console.error('Error: Could not confirm version absence on npm. Resolve registry access before publishing.');
process.exit(1);
NODE

npm run lint
npm test
npm pack --dry-run
verify_checkout
[[ "$(git rev-parse HEAD)" == "$RELEASE_HEAD" ]] || { echo 'Error: Release commit changed during checks.' >&2; exit 1; }

npm publish --access public
npm view "@getsupaflow/cli@$VERSION" version --json | node --input-type=module -e '
let data=""; for await (const chunk of process.stdin) data+=chunk;
if (JSON.parse(data)!==process.argv[1]) process.exit(1);
' "$VERSION"
# Bind the tag to the checked commit even if another task moves the checkout.
git tag "$TAG" "$RELEASE_HEAD"
git push origin "refs/tags/$TAG:refs/tags/$TAG"
printf 'Published @getsupaflow/cli@%s from %s; main was not pushed.\n' "$VERSION" "$RELEASE_HEAD"
