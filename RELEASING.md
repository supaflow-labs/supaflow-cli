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

## Prepare the connector authoring bundle

Use the platform's existing public wheel producer and
`create_public_package_index` validation before preparing CLI authoring assets.
The source commit identifies the reviewed platform code used to build the four
public wheels. Resolve exact bootstrap dependencies, including uv, with the
existing uv hashed-requirements flow used by
`tests/connector-packed-authoring.test.ts`. Production requirements must use
portable index pins and hashes. Local file URLs and unpinned requirements fail
bundle preparation.

The platform command below creates the existing two-file CLI asset format.
Supply the reviewed execution target inventory explicitly. Its JSON is a list
of `{name, environment, wheelTags}` objects, matching the CLI target contract.
The host protocol and Python ranges must match the tested SDK/runtime selection.

```bash
/path/to/platform/python/.venv/bin/python \
  /path/to/platform/python/scripts/prepare_cli_authoring_bundle.py \
  --wheel-dir /absolute/path/to/four-public-wheels \
  --requirements /absolute/path/to/hashed-bootstrap-requirements.txt \
  --targets /absolute/path/to/execution-targets.json \
  --source-commit <reviewed-platform-sha> --cli-version <cli-version> \
  --uv-version <pinned-uv-version> --requires-python '<tested-authoring-range>' \
  --project-python '<tested-project-range>' \
  --execution-python '<tested-execution-range>' --host-protocol <tested-protocol> \
  --output /absolute/path/to/new-bundle
```

Review `toolchain.json` and `requirements.txt`, then place them in
`assets/connectors` for the CLI build's existing asset-copy step. The producer
checks that the requirements contain the exact reviewed public wheel versions
and hashes, plus the selected uv pin. It creates a fresh output directory and
does not publish packages or change the authoring feature flag.

The packed authoring test now calls this producer. In addition to its existing
wheel and interpreter environment variables, set
`SUPAFLOW_TEST_BUNDLE_PRODUCER` to the absolute platform script path.
Public package availability, authoring activation and CLI publication remain
the existing separately reviewed release steps.
