# Supaflow CLI Guidelines

## Scope and structure

- The workspace rules in `../AGENTS.md` also apply.
- This repository publishes `@getsupaflow/cli` and its bundled MCP server. The executable is `bin/supaflow.mjs`, source is under `src/`, and tests are under `tests/`.
- Preserve the MCP subprocess boundary: tool calls invoke the CLI as a child with JSON output so CLI stdout cannot corrupt the parent JSON-RPC stream.

## Development and verification

- Use `npm run build`, `npm test`, and `npm run lint` for verification. `npm test` intentionally builds first so tests exercise bundled output.
- `npm run format` is a mutating command: it runs Prettier with `--write` across all of `src/` and `tests/`. Use it only when formatting those trees is intentionally in scope, check repository status first, and review the resulting diff for unrelated rewrites. For a non-mutating formatting check with installed dependencies, use `./node_modules/.bin/prettier --check src/ tests/` instead.
- Preserve `ignore-scripts` supply-chain protection. Review dependency and lockfile changes, run `npm audit`, and do not apply an automatic audit fix without reviewing the resulting upgrades.
- Local API commands must set `SUPAFLOW_APP_URL=http://localhost:3000` in the same invocation. Check `supaflow auth status` before attempting login, and do not display or copy API keys.

## Versioning and publishing

- `package.json` and `src/version.ts` are the two version sources and must remain identical.
- Do not hand-publish. Use `scripts/publish.sh` only when the user explicitly authorizes the complete release operation: version changes, a direct commit on `main`, tag creation, npm publication, and both Git pushes.
- Before invoking the script, resolve the requested bump and exact target version. Fetch `origin`; require a clean `main` whose `HEAD` matches `origin/main`; verify `npm whoami` is an authorized release identity for `@getsupaflow`; verify the target version is absent from npm and its `v<version>` tag is absent locally and remotely; then build/test and inspect `npm pack --dry-run`. These are operator preflights: the current script does not perform them all.
- The current script publishes to npm before pushing its release commit and tag. If either Git push fails after npm publication, the package version is already live while the remote commit/tag may be missing. Verify the published version, remote `main`, remote tag, and clean worktree immediately after the run; do not rerun publication to repair a push failure.
- Feature work reaches `main` through the workspace's merge-commit PR flow. Do not describe version-bump or deployment mechanics in ordinary feature commits or PR prose.

## Pipeline prefix contract

- `pipelines create` resolves the non-custom default prefix to the lowercased source connector type before persistence.
- The prefix is immutable after creation. Preserve an explicitly custom empty prefix as the valid “use the destination default namespace” choice; never persist an empty non-custom prefix.
- Keep CLI behavior aligned with platform reservation/execution logic and app defaults when this contract changes.
