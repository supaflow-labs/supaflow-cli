# CLAUDE.md

Guidance for Claude Code working in the `@getsupaflow/cli` repository.

For workspace-level rules (domain name, commit style, **merge-commit-only** PR
strategy, no AI attribution / no emojis), see the [workspace CLAUDE.md](../CLAUDE.md).

## What this repo is

`@getsupaflow/cli` -- the published CLI for the Supaflow platform (`supaflow ...`),
plus a bundled MCP server (`supaflow mcp`) that AI agents use. The MCP server keeps
a subprocess boundary: each tool call shells out to a child `node <cli> <args> --json`
so CLI stdout stays isolated and the `mcp` parent emits only JSON-RPC.

- Entry / bin: `bin/supaflow.mjs` -> `dist/index.js` (built from `src/index.ts`)
- MCP server: `src/mcp/server.ts`
- Commands: `src/commands/*.ts`; shared logic: `src/lib/*.ts`
- Tests: `tests/**` (vitest)

## Dev commands

```bash
npm run build      # tsup -> dist/ (also the prepublish step)
npm test           # builds, then runs vitest (note: test script builds first)
npm run lint       # eslint src/
npm run format     # prettier
```

`npm test` builds first on purpose (`ignore-scripts` in CI skips lifecycle hooks),
so it exercises the actual bundled output, not just source.

## Version is single-source-of-truth

The CLI version lives in **two files that must stay identical**:
`package.json` `"version"` and `src/version.ts` `VERSION` (the latter feeds both
`supaflow --version` and the MCP server metadata). Do not bump one by hand without
the other -- `scripts/publish.sh` keeps them in sync for you (see below).

## Publishing a release

Use the release script -- never `npm publish` by hand (hand-publishing skips the
version sync, tag, and guards).

```bash
./scripts/publish.sh [patch|minor|major]   # default: patch
```

What it does, in order (`scripts/publish.sh`):

1. **Guards**: aborts unless the working tree is clean AND you are on `main`.
   Releases must come from `main` so the npm tarball and the `vX.Y.Z` git tag point
   at commits reachable from `main` (workspace merge-commit rule).
2. Runs `npm run lint` and `npm test`.
3. `npm version <bump> --no-git-tag-version` -> bumps `package.json`.
4. `sed` updates `src/version.ts` `VERSION` to match.
5. Builds, then runs `npm test` again against the new build.
6. Commits `Release vX.Y.Z`, tags `vX.Y.Z`.
7. `npm publish --access public` (the package is a public npm scope, `@getsupaflow`).
8. Pushes `main` and the tag to origin.

Prerequisites:

- **npm auth** as the `supa-flow` npm user (`npm whoami` should print `supa-flow`).
- A normal merged feature branch on `main` first -- the release commit is the only
  commit that goes directly to `main` (it is a version bump + tag, not feature work).

### Choosing the bump

- **patch** -- bug fixes and behavior corrections that do NOT require clients to
  upgrade (old installs keep working). This is the common case.
- **minor / major** -- new commands/flags or behavior that clients must upgrade to
  use.

Note: a separate `>=` **minimum-version gate** lives in the Supaflow plugin / setup
hook (not in this repo). Bump it ONLY on releases that force clients to upgrade
(e.g. the `0.2.0` release that shipped `supaflow mcp`) -- never on an ordinary patch.

## Pipeline prefix default (gotcha)

`pipelines create` defaults `pipeline_prefix` to the lowercased source connector
type via `resolvePipelinePrefix()` (`src/lib/pipeline-config.ts`) when the user did
not explicitly choose one (`is_custom_prefix !== true`). The prefix is the
destination schema and is **permanent after creation**, so the create path resolves
it before persisting -- it must never store an empty prefix for a non-custom config.
An explicit empty prefix (`is_custom_prefix: true`, `pipeline_prefix: ""`) is a valid
"mirror the destination's default schema" choice and is preserved. See the platform
`supaflow-platform/CLAUDE.md` "Pipeline Prefix Management" for the full picture.
