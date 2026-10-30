# Supaflow CLI Guidelines

## SDLC, PR requirements, and review

- For ordinary work, use a task branch and a PR to `main`; preserve existing changes and keep unrelated commits out of the PR. Read applicable scoped instructions, implement the smallest agreed change, run the relevant local checks, and review the whole diff. Commit/push only within explicit user approval; merge only when authorized, using a merge commit. Separately authorized release-script exceptions below remain exceptions.
- Fill in [.github/pull_request_template.md](.github/pull_request_template.md). Include the request/specification source, testable acceptance criteria, before/after behavior, deliberate product constraints with rationale, non-goals, verification evidence and gaps, and relevant cross-repository dependencies. Copy essential decisions into the PR; reviewers may not have the workspace or conversation. Update the description when scope or decisions change.
- Reviewers must assess the implementation against that contract and this repository's invariants. Report a defect only with a concrete scenario, code evidence, and a violated requirement or invariant. Accepted product constraints are not missing features; optional enhancements and ambiguous requirements are separate questions. An intentional constraint cannot excuse a regression, security flaw, or data-integrity defect.
- Address valid findings with focused fixes and appropriate regression coverage. For a disputed finding, record the requirement and evidence supporting its disposition before resolving it; involve the owner when the requirement is unclear. Do not repeatedly reopen a resolved decision without new evidence, change product behavior merely to quiet a reviewer, or dismiss unresolved defects to pass a gate.
- Before merging, require successful applicable checks, resolved conversations, and completed review of the current PR head/base. New commits need fresh evidence. Do not bypass GitHub rules, forge a passing status, or substitute a review request/reaction for completed review. After merge, return to clean updated `main`, remove only this task's merged branches/worktrees, and preserve unrelated work.

- Ordinary feature changes use PRs to `main` with the build, tests, lint, and review evidence described below. This repository is outside the devops repositories' installed `PR checks`/Codex gate rollout; inspect live settings rather than claiming those checks are mandatory here.
- npm publication remains the separately authorized release-script exception in `RELEASING.md`. Before running it, verify current branch rules still permit its direct release commit/push; if they do not, stop and reconcile the release procedure instead of bypassing protection. Feature-merge approval does not authorize npm publication.

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
- `RELEASING.md` is the authoritative operator runbook for manual npm releases, browser authentication, partial-release recovery, and post-release verification.
- Do not hand-publish. Use `scripts/publish.sh` only when the user explicitly authorizes the complete release operation: version changes, a direct commit on `main`, tag creation, npm publication, and both Git pushes.
- Before invoking the script, resolve the requested bump and exact target version. Fetch `origin`; require a clean `main` whose `HEAD` matches `origin/main`; verify `npm whoami` is the authorized `supa-flow` release identity; verify the target version is absent from npm and its `v<version>` tag is absent locally and remotely; review `npm audit` and `npm audit --omit=dev`; then build/test and inspect `npm pack --dry-run`. These are operator preflights: the current script does not perform them all.
- Run npm login and the release script in an interactive TTY outside restrictive sandboxes. If `npm whoami` fails, run `npm login --auth-type=web`, press Enter when npm offers its one-time URL, and leave credential entry and 2FA to the user in a visible browser. During `npm publish`, handle the same `Authenticate your account at ...` browser prompt in the original TTY so the waiting publish resumes. Never expose or persist credentials, OTPs, recovery codes, or one-time authentication URLs.
- If the script has already created the exact release commit and tag but npm publication failed and the target version is confirmed absent, do not rerun the bump script. After restoring authentication, resume only `npm publish --access public` in an interactive TTY, verify the registry, and then push the existing `main` commit and tag. This is the only manual-publish recovery exception.
- The current script publishes to npm before pushing its release commit and tag. If either Git push fails after npm publication, the package version is already live while the remote commit/tag may be missing. Verify the published version, remote `main`, remote tag, and clean worktree immediately after the run; do not rerun publication to repair a push failure.
- Feature work reaches `main` through the workspace's merge-commit PR flow. Do not describe version-bump or deployment mechanics in ordinary feature commits or PR prose.

## Pipeline configuration contract

- Follow the pipeline configuration rules in `../supaflow-platform/AGENTS.md` for changes to the shared Java configuration contract.
- `src/lib/pipeline-config.ts` maintains explicit defaults/accepted keys and user-facing init JSON/reference fields. New backend fields are not discovered automatically. Update both lists, capability ownership when applicable, and stdio MCP `config_summary` for settings the user needs to review before creation.
- Cover ordinary CLI creation and stdio MCP guided creation, including default values and explicit overrides. Verify hosted MCP separately in `supaflow-app`; it uses the app's shared defaults rather than these CLI lists.

## Pipeline prefix contract

- `pipelines create` resolves the non-custom default prefix to the lowercased source connector type before persistence.
- The prefix is immutable after creation. Preserve an explicitly custom empty prefix as the valid “use the destination default namespace” choice; never persist an empty non-custom prefix.
- Keep CLI behavior aligned with platform reservation/execution logic and app defaults when this contract changes.
