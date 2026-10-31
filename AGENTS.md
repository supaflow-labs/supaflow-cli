# Supaflow CLI Guidelines

## SDLC, PR requirements, and review

- For ordinary work, use a task branch and a PR to `main`; preserve existing changes and keep unrelated commits out of the PR. Read applicable scoped instructions, implement the smallest agreed change, run the relevant local checks, and review the whole diff. Commit/push only within explicit user approval; merge only when authorized, using a merge commit. Separately authorized release-script exceptions below remain exceptions.
- Fill in [.github/pull_request_template.md](.github/pull_request_template.md). Include the request/specification source, testable acceptance criteria, before/after behavior, deliberate product constraints with rationale, non-goals, verification evidence and gaps, and relevant cross-repository dependencies. Copy essential decisions into the PR; reviewers may not have the workspace or conversation. Update the description when scope or decisions change.
- Reviewers must assess the implementation against that contract and this repository's invariants. Report a defect only with a concrete scenario, code evidence, and a violated requirement or invariant. Accepted product constraints are not missing features; optional enhancements and ambiguous requirements are separate questions. An intentional constraint cannot excuse a regression, security flaw, or data-integrity defect.
- Address valid findings with focused fixes and appropriate regression coverage. For a disputed finding, record the requirement and evidence supporting its disposition before resolving it; involve the owner when the requirement is unclear. Do not repeatedly reopen a resolved decision without new evidence, change product behavior merely to quiet a reviewer, or dismiss unresolved defects to pass a gate.
- Before merging, require successful applicable checks, resolved conversations, and completed review of the current PR head/base. New commits need fresh evidence. Do not bypass GitHub rules, forge a passing status, or substitute a review request/reaction for completed review. After merge, return to clean updated `main`, remove only this task's merged branches/worktrees, and preserve unrelated work.

- Ordinary feature and version-preparation changes use PRs to `main`; npm publication remains separately authorized. The publisher never commits or pushes `main`.

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
- Prepare version changes on a task branch, review the exact diff, and merge its PR through the required checks/review. Keep package.json, package-lock.json and src/version.ts synchronized.
- Use `scripts/publish.sh <exact-version>` only with explicit npm-publication/tag authorization, from a clean `main` matching remote `main`. The script verifies version sources, npm identity `supa-flow`, registry absence, and tag absence, runs checks, publishes, then pushes only the release tag.
- Follow `RELEASING.md` for interactive npm browser authentication and partial-publication recovery. Never expose credentials, OTPs, or one-time URLs. A registry/network error is not evidence that a version is absent.
- If npm publication succeeded but tag creation/push failed, verify the exact registry version and reviewed release commit and push only the missing tag. Never bump, republish, or direct-push main to recover.
- Feature work reaches `main` through the workspace's merge-commit PR flow. Do not describe version-bump or deployment mechanics in ordinary feature commits or PR prose.

## Pipeline configuration contract

- Follow the pipeline configuration rules in `../supaflow-platform/AGENTS.md` for changes to the shared Java configuration contract.
- `src/lib/pipeline-config.ts` maintains explicit defaults/accepted keys and user-facing init JSON/reference fields. New backend fields are not discovered automatically. Update both lists, capability ownership when applicable, and stdio MCP `config_summary` for settings the user needs to review before creation.
- Cover ordinary CLI creation and stdio MCP guided creation, including default values and explicit overrides. Verify hosted MCP separately in `supaflow-app`; it uses the app's shared defaults rather than these CLI lists.

## Pipeline prefix contract

- `pipelines create` resolves the non-custom default prefix to the lowercased source connector type before persistence.
- The prefix is immutable after creation. Preserve an explicitly custom empty prefix as the valid “use the destination default namespace” choice; never persist an empty non-custom prefix.
- Keep CLI behavior aligned with platform reservation/execution logic and app defaults when this contract changes.

## Main branch enforcement

- The main-branch protection rollout requires PRs, resolved conversations, merge commits, `PR checks` and `Codex review / main`, with no bypass actors. Verify live rule activation and successful current-head evidence before claiming enforcement.
- `.github/workflows/pr-checks.yml` defines the offline CI coverage. These checks do not prove live credentials, deployments, or database/data correctness. No live test or publication is authorized by CI.
- Keep the Codex connector enabled for this repository and request a fresh review when necessary. Missing or incomplete review is not a pass.

- Choose the intended target branch when opening a PR. If its base branch is changed, close it and open a new PR against the intended base; the review gate rejects retargeted PRs because review summaries identify the head but not the reviewed base.
