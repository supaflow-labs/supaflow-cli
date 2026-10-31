# Supaflow CLI release runbook

A release has two separately authorized steps: merge the version-preparation PR into protected `main`, then publish that reviewed version to npm. `scripts/publish.sh` never bumps versions, creates commits, or pushes `main`.

## 1. Prepare the version through a PR

Fetch the integration base, preserve unrelated work, and start a task branch from updated `main`. Resolve the exact approved SemVer version before making changes. For example:

```bash
git switch -c release/0.9.0
npm version 0.9.0 --no-git-tag-version --ignore-scripts
```

Update `src/version.ts` to the same version. Verify `package.json`, both root version entries in `package-lock.json`, and `src/version.ts` match. Review the dependency audit, run `npm run lint`, `npm test`, `node --test tests/publish-script.node.mjs`, and `npm pack --dry-run`. Inspect the package contents.

Present the exact diff, commit and push the task branch only when authorized, and open a PR to `main` recording the approved version, requirements, tests and publication boundaries. Require successful `PR checks`, completed current-head `Codex review / main`, and resolved conversations. Merge with a merge commit only when authorized. Never bypass the branch rule or direct-push a version bump.

Return to clean `main` and update with `git pull --ff-only`. Merging this PR does not authorize npm publication.

## 2. Authenticate and publish the reviewed version

Only after explicit authorization for npm publication and its Git tag, verify the target version and the exact reviewed commit. Review `npm audit` and `npm audit --omit=dev`; do not run an unreviewed automatic audit fix.

Use an interactive TTY. Check `npm whoami`; the authorized identity is `supa-flow`. If authentication is missing, run `npm login --auth-type=web` and complete browser authentication in the authorized visible browser. Leave credential entry and 2FA to the user; never copy one-time URLs, OTPs or tokens into records. Keep the same TTY open when npm publication asks for browser approval.

```bash
./scripts/publish.sh 0.9.0
```

Use the approved exact version, not `patch`, `minor` or `major`. The script checks clean `main` against the live remote, consistent version sources, absent local/remote tag, release identity and confirmed registry absence. It runs lint, build/tests and a package dry run, rechecks the checkout, publishes to npm, verifies the exact registry version, and creates/pushes only `v<version>` at the checked commit. `npm test` builds the package even when lifecycle scripts are disabled. Do not run another release while this process awaits browser approval.

## 3. Recover without republishing

Inspect the exact version, commit, worktree, registry state and local/remote tag first:

```bash
npm view @getsupaflow/cli@0.9.0 version
git status --short --branch
git log -2 --oneline
git ls-remote origin refs/heads/main refs/tags/v0.9.0
```

- Before publication: fix the failed prerequisite and rerun the same exact version only after confirming it remains absent from npm and no release tag exists.
- Publication uncertain or registry access failed: stop and establish whether the exact npm version exists. A network/authentication error is not absence.
- Version exists on npm but tag creation/push failed: do not publish again. Verify the exact reviewed release commit used by the failed run. If absent, create `git tag v0.9.0 <verified-release-commit>`; if present locally, verify it points there. Push only `git push origin refs/tags/v0.9.0:refs/tags/v0.9.0`. Never overwrite an existing conflicting tag, push main, or choose a newer commit just because main advanced.

For legacy partial releases made by the old direct-push script, preserve the release commit/tag and published package. Reconcile any missing version commit through a PR; do not bypass protected main or republish an immutable npm version.

## 4. Verify completion

Verify the exact npm version and default dist-tag, the remote release tag pointing to the checked commit, and the clean local checkout. Main may advance through other reviewed PRs after publication; the tag remains bound to the release commit. Record PR, commit, package version and tag evidence without credentials. No automated npm publication is configured by the PR-check workflow.
