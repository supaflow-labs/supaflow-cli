# Supaflow CLI Release Runbook

This runbook covers manual releases of `@getsupaflow/cli` with npm's browser-based CLI authentication. The repository's supported release entry point is `scripts/publish.sh`.

## Release contract

The release script performs one complete operation:

1. Lint and test the current version.
2. Bump `package.json`, `package-lock.json`, and `src/version.ts`.
3. Build and test the new version.
4. Create the release commit and `v<version>` tag.
5. Publish the package to npm.
6. Push `main` and the release tag to GitHub.

Run it only from a clean, synchronized `main` branch and only after the complete release has been explicitly authorized. `package.json` and `src/version.ts` must always contain the same version.

## 1. Choose the version

Resolve the SemVer bump before changing repository state:

- `patch`: backward-compatible fixes.
- `minor`: backward-compatible features.
- `major`: breaking changes.

Record the exact target version for the checks below. For example:

```bash
release_version=0.7.0
```

## 2. Verify Git and registry state

Fetch the remote and require a clean `main` whose `HEAD` matches `origin/main`:

```bash
git fetch origin --tags
git status --short --branch
git branch --show-current
git rev-parse HEAD origin/main
```

Confirm that neither the npm version nor its Git tag exists. An npm `E404` is the expected result before a new release:

```bash
npm view "@getsupaflow/cli@${release_version}" version
git tag --list "v${release_version}"
git ls-remote --tags origin "refs/tags/v${release_version}"
```

Stop if the worktree is dirty, the branch is not `main`, the two commit IDs differ, or either release identifier already exists.

## 3. Authenticate with npm in the browser

Run authentication in an interactive terminal. For an automated coding agent, the terminal must have a TTY and run outside any sandbox that prevents npm from accessing its credentials or opening the browser.

```bash
npm login --auth-type=web
```

When npm prints a one-time login URL and `Press ENTER to open in the browser`, press Enter. Complete sign-in and 2FA in the user-visible browser. Leave the terminal running; it resumes automatically after authorization.

Verify the release identity:

```bash
npm whoami
```

The expected identity for this package is `supa-flow`. Never paste npm passwords, access tokens, recovery codes, one-time URLs, or OTP values into chat, source files, issues, or release notes.

## 4. Run the release checks

Review dependency advisories and package contents. Do not run `npm audit fix` without reviewing the proposed dependency changes.

```bash
npm audit
npm audit --omit=dev
npm run lint
npm test
npm pack --dry-run
```

Inspect the dry-run file list and confirm that the package name and current pre-release version are expected. The official script repeats lint and tests before publishing.

## 5. Publish from an interactive terminal

Run the official script with the resolved bump:

```bash
./scripts/publish.sh minor
```

Use `patch` or `major` only when that is the approved bump. Keep the command attached to an interactive TTY. During `npm publish`, npm may print another one-time URL such as `https://www.npmjs.com/auth/cli/...` and wait for browser authorization. Press Enter, complete the approval in the browser, and let the same process resume. Do not start a second release command while it is waiting.

## 6. Recover safely from a partial release

First inspect the exact state:

```bash
git status --short --branch
git log -2 --oneline --decorate
npm view "@getsupaflow/cli@${release_version}" version
git ls-remote origin refs/heads/main "refs/tags/v${release_version}"
```

Use the matching recovery path:

- **Failure before the version bump:** If there is no release commit or tag and the version sources are unchanged, fix the precondition and rerun the official script.
- **Release commit and tag exist locally, but npm does not contain the version:** Do not rerun the bump script because it would create the next version. Restore browser authentication, verify `npm whoami`, and resume only the failed steps:

  ```bash
  npm publish --access public
  git push origin main
  git push origin "v${release_version}"
  ```

  Run `npm publish` in an interactive TTY so npm can pause for browser-based 2FA.
- **npm contains the version, but one or both Git pushes failed:** Never publish again. Push only the existing release commit and tag.
- **Publication result is uncertain:** Query the exact npm version before retrying. npm package versions are immutable; never rerun `npm publish` when the target version is already present.

## 7. Verify every release target

After publication and both pushes, verify npm, GitHub, and the local checkout independently:

```bash
npm view "@getsupaflow/cli@${release_version}" version
npm view @getsupaflow/cli version
git ls-remote origin refs/heads/main "refs/tags/v${release_version}"
git rev-parse HEAD origin/main "v${release_version}"
git status --short --branch
```

The exact npm version must exist, npm's default version should be the new release, remote `main` and the remote tag must resolve to the release commit, and the local worktree must be clean and synchronized.

## Trusted publishing migration

The current process is an interactive manual release. A future GitHub Actions release workflow should use npm trusted publishing with OIDC instead of a long-lived npm token. Configure and verify trusted publishing before removing the manual path or revoking existing credentials. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
