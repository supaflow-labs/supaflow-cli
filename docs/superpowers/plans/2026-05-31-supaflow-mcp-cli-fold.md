# Fold the Supaflow MCP server into the CLI (`supaflow mcp`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Desktop MCP adapter as a `supaflow mcp` subcommand of `@getsupaflow/cli`, so one `npm install -g @getsupaflow/cli` provides both `supaflow ...` and the MCP server, with a single version axis.

**Architecture:** Port `supaflow-claude-plugin/servers/supaflow-mcp/server.mjs` into the CLI as `src/mcp/server.ts`, imported via a new `supaflow mcp` command. The server keeps the **subprocess boundary**: each MCP tool call shells out to a child `node <cli-entry> <args> --json`, so the CLI's ~109 stdout writes stay isolated in child processes and the `mcp` parent process emits **only** JSON-RPC on stdout. The self-invocation replaces today's fragile `PATH` lookup for `supaflow`. The plugin stays thin (skills, setup gate, docs) and is updated to register `command: "supaflow", args: ["mcp"]` — but only after the CLI release that ships `mcp` is published.

**Tech Stack:** TypeScript (strict), tsup (single ESM entry, bundles the import graph + `dts`), commander, `@modelcontextprotocol/sdk`, vitest. Two repos: `supaflow-cli` (`@getsupaflow/cli`) and `supaflow-claude-plugin`.

---

## Cross-repo version-coupling sequence (read before starting)

The two repos must change in this order, or the setup gate will point users at a command that does not exist yet:

1. **`supaflow-cli`** — Tasks 1-6: implement `supaflow mcp`, test, bump to `0.2.0`, **publish to npm**.
2. **`supaflow-claude-plugin`** — Tasks 7-8: only after step 1 is on npm, update the host-registration docs/setup gate to `supaflow mcp`, bump `MIN_CLI_VERSION` to `0.2.0`, and (Task 8, optional) add the terminal-path plugin `.mcp.json` for Playwright-style auto-launch. Separate commits in the plugin repo.

Each repo is its own git repo with its own branch/PR (workspace root is not a repo). Use a merge-commit when merging (no squash/rebase), per workspace policy. **Do not commit Tasks 1-5 directly to `main`** — create a feature branch in `supaflow-cli` first (`git checkout -b feat/supaflow-mcp`); Tasks 1-5 commit there, Task 6 merges the PR and publishes **from `main`**. Same for the plugin repo (Tasks 7-8).

## File Structure

**Repo: `supaflow-cli` (`@getsupaflow/cli`)**
- Create: `src/version.ts` — single `VERSION` constant, used by both `program.version()` and the MCP `Server` info.
- Create: `src/mcp/server.ts` — ported from the plugin's `server.mjs`; exports `TOOLS`, `listToolDefinitions`, `createServer`, `main`, and the existing pure helpers.
- Create: `src/commands/mcp.ts` — registers the `mcp` subcommand; its action `await main()` and writes nothing to stdout.
- Modify: `src/index.ts` — import `VERSION`, use it in `.version()`, register the `mcp` command.
- Modify: `package.json` — add `@modelcontextprotocol/sdk` to `dependencies`; bump `version` to `0.2.0`.
- Test: `tests/mcp-tools.test.ts` — the MCP contract suite, migrated from the plugin's `tests/fast/test-mcp-contract.sh` (tool surface, exclusions, annotations, exact argv mapping, plan binding).
- Test: `tests/mcp-stdio.test.ts` — subprocess smoke: clean stdout, a real tool call via a stub CLI, and a no-auto-run-guard regression.
- Test fixture: `tests/fixtures/stub-cli.mjs` — deterministic stand-in CLI for the hermetic tool-call test.

**Repo: `supaflow-claude-plugin` (Tasks 7-8, gated on the CLI publish)**
- Delete: `servers/supaflow-mcp/` — the prototype now lives in the CLI; removing it prevents a second drifting copy (Task 7).
- Delete: `tests/fast/test-mcp-contract.sh` — imports the deleted `server.mjs`; its assertions are migrated to `supaflow-cli` (Task 4).
- Modify: `README.md` — drop the two pointers to `servers/supaflow-mcp/` (lines 33, 68); point Desktop users at `supaflow mcp` (Task 7).
- Modify: `skills/using-supaflow/setup-preamble.md` — "No valid surface" + MCP gate reference `supaflow mcp` host registration; clarify terminal vs Desktop `.mcp.json` (Tasks 7, 8).
- Modify: `hooks/check-setup.sh` — `MIN_CLI_VERSION="0.2.0"`.
- Create: `.mcp.json` (Task 8, optional) — terminal-path auto-launch of `supaflow mcp`.
- Test: `tests/fast/test-terminal-mcp-json.sh` (Task 8).

---

### Task 1: Single version source + MCP SDK dependency

**Files:**
- Create: `src/version.ts`
- Modify: `src/index.ts:13-24`
- Modify: `package.json:18,37-40`

- [ ] **Step 1: Create the version module**

```ts
// src/version.ts
// Single source of truth for the CLI + MCP server version.
// Keep in sync with package.json "version".
export const VERSION = '0.2.0';
```

- [ ] **Step 2: Use it in the commander root**

In `src/index.ts`, add the import at the top and replace the hardcoded version:

```ts
import { Command } from 'commander';
import { VERSION } from './version.js';
// ...existing command imports...

const program = new Command();

program
  .name('supaflow')
  .description('CLI for Supaflow data integration platform')
  .version(VERSION)
  .option('--json', 'Output as JSON')
  .option('--workspace <id>', 'Override active workspace')
  .option('--api-key <key>', 'Override stored API key')
  .option('--supabase-url <url>', 'Override Supabase project URL (dev/testing)')
  .option('--verbose', 'Enable debug output')
  .option('--no-color', 'Suppress ANSI colors');
```

- [ ] **Step 3: Add the MCP SDK as a runtime dependency**

tsup marks `dependencies` as external, so the SDK must be a real dependency (not bundled). In `package.json`, add to `dependencies` and bump `version`:

```json
  "version": "0.2.0",
  "dependencies": {
    "commander": "^13.0.0",
    "@supabase/supabase-js": "^2.39.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
```

- [ ] **Step 4: Install and verify the build still compiles**

Run: `cd /Users/puneetgupta/supaflow-workspace/supaflow-cli && npm install && npm run build`
Expected: build succeeds, `dist/index.js` is regenerated, `supaflow --version` prints `0.2.0` (run `node dist/index.js --version`).

- [ ] **Step 5: Commit**

```bash
git add src/version.ts src/index.ts package.json package-lock.json
git commit -m "chore: add version module and @modelcontextprotocol/sdk dependency"
```

---

### Task 2: Port the MCP server into the CLI as `src/mcp/server.ts`

This **moves** already-verified logic, but it is not a pure copy: the import-time auto-run guard must be deleted, and the file must be typed for `strict` mode. Do not rewrite the tool table or the guided-create handlers — keep their bodies as-is.

**Files:**
- Create: `src/mcp/server.ts` (from `../supaflow-claude-plugin/servers/supaflow-mcp/server.mjs`)

- [ ] **Step 1: Copy the source file**

```bash
cd /Users/puneetgupta/supaflow-workspace/supaflow-cli
mkdir -p src/mcp
cp ../supaflow-claude-plugin/servers/supaflow-mcp/server.mjs src/mcp/server.ts
```

- [ ] **Step 2: Delete the import-time auto-run guard (REQUIRED — otherwise it breaks the CLI)**

The bottom of `server.mjs` self-starts the server when it is the entry module:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
```

After tsup bundles `server.ts` into `dist/index.js`, `fileURLToPath(import.meta.url) === process.argv[1]` is true for **every** `node dist/index.js ...` invocation — both the MCP parent's child tool calls (`node dist/index.js auth status --json`) **and** ordinary CLI commands. Left in, it would start the stdio server on every command and collide with `program.parse()`. **Delete the entire `if (...) { await main(); }` block.** Only `src/commands/mcp.ts` (Task 3) may call `main()`. Keep `main` exported.

- [ ] **Step 3: Replace the `PATH` lookup with self-invocation**

Delete the `CHILD_ENV` block (the `/opt/homebrew/bin:/usr/local/bin` PATH hack) and rewrite `execSupaflowArgv` to re-invoke this package's own CLI entry. Bundled, `import.meta.url` resolves to `dist/index.js`:

```ts
import { fileURLToPath } from 'node:url';

// Re-invoke THIS package's CLI for each tool call (subprocess boundary).
// Bundled, import.meta.url === dist/index.js; the env override keeps tests hermetic.
const CLI_ENTRY = process.env.SUPAFLOW_CLI_ENTRY ?? fileURLToPath(import.meta.url);

async function execSupaflowArgv(argv: string[], timeoutMs = 60000): Promise<string> {
  const { stdout } = await execFileP(process.execPath, [CLI_ENTRY, ...argv], {
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}
```

- [ ] **Step 4: Source the server version from the shared constant**

Replace `const SERVER_VERSION = "0.2.0";` with:

```ts
import { VERSION } from '../version.js';
const SERVER_VERSION = VERSION;
```

- [ ] **Step 5: Typing pass for `strict` mode (real work, not cosmetic)**

`tsconfig.json` has `strict: true`, which enables `noImplicitAny` and `useUnknownInCatchVariables`. The ported file needs three categories of annotation; add the shared types, then iterate `tsc --noEmit` to zero.

(a) Tool-spec + argv helpers. Tool args are validated by `inputSchema` at the MCP layer, so `any` for handler/build args is acceptable:

```ts
type ToolArgs = Record<string, any>;

interface ToolSpec {
  name: string;
  description: string;
  readOnly?: boolean;
  write?: boolean;
  destructive?: boolean;
  json?: boolean;
  timeoutMs?: number;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  build?: (args: ToolArgs) => string[];
  handler?: (args: ToolArgs) => Promise<unknown>;
}
```

Annotate: `const S = (v: unknown) => String(v);`, `opt(argv: string[], flag: string, val: unknown)`, `bool(argv: string[], flag: string, val: unknown)`, `multi(argv: string[], flag: string, vals: unknown)`, and `export const TOOLS: ToolSpec[] = [ ... ]`.

(b) The ~25 helper/handler parameters that are currently implicit `any`. Use `string` for identifiers/labels, `string[]` for argv, `Record<string, any>` for domain objects, `ToolArgs` for tool inputs. Examples: `parseJson(text: string, label: string)`, `parseCliJson(text: string, label: string)`, `assertPlanId(planId: string)`, `planPaths(planId: string)`, `loadPlan(planId: string)`, `configSummary(config: Record<string, any>)`, `safeDatasourceIdentity(ds: Record<string, any>)`, `safeProjectIdentity(project: Record<string, any>)`, `resolveDatasourceIdentity(identifier: string)`, `resolveProjectIdentity(identifier: string)`, `normalizeObjectPreviewLimit(value: unknown)`, `validatePlanBinding(plan: Record<string, any>, current: Record<string, any>)`, `validatePlanWorkspace(plan: Record<string, any>, currentWorkspace: Record<string, any>)`, `applyConfigPatch(baseConfig: Record<string, any>, patch: Record<string, any> = {})`, `applyObjectSelection(objects: Record<string, any>[], selection: Record<string, any>)`, `buildPipelineCreateFromPlanArgv(opts: { name: string; description?: string; source: string; project: string; configFile: string; objectsFile: string })`, `objectNames(objects: Record<string, any>[])`, `toolResult(message: string, structuredContent?: unknown)`, `getToolSpec(name: string)`, `buildSupaflowArgv(name: string, args: ToolArgs = {})`, `runSupaflow(spec: ToolSpec, args: ToolArgs)`, `preparePipelineCreate(args: ToolArgs)`, `createPipelineFromPlan(args: ToolArgs)`.

(c) The three `catch` clauses (`parseJson` ~line 64, `createPipelineFromPlan` verification ~line 1260, `createServer` handler ~line 1318). Under `useUnknownInCatchVariables` the bound variable is `unknown`, so `err.message` / `err.stdout` will not compile. Annotate each as `catch (err: any)`.

- [ ] **Step 6: Confirm stdout stays clean**

The server must never write to stdout itself (the stdio transport owns it):

Run: `grep -nE "console\.(log|info|debug)|process\.stdout" src/mcp/server.ts`
Expected: no matches.

- [ ] **Step 7: Typecheck to zero**

Run: `npx tsc --noEmit`
Expected: no errors. Resolve any remaining `strictNullChecks` complaints with optional chaining / guards (the file already uses `?.` and `Array.isArray` in most spots).

- [ ] **Step 8: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): port stdio MCP server into CLI (drop auto-run guard, self-invocation, strict types)"
```

---

### Task 3: Register the `supaflow mcp` command

**Files:**
- Create: `src/commands/mcp.ts`
- Modify: `src/index.ts:1-37`

- [ ] **Step 1: Create the command module**

```ts
// src/commands/mcp.ts
import type { Command } from 'commander';
import { main } from '../mcp/server.js';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the stdio MCP server for Claude Desktop host registration. Emits only JSON-RPC on stdout.')
    .action(async () => {
      // stdout is reserved for MCP JSON-RPC framing. Do NOT print here.
      // The stdio transport keeps the process alive by reading stdin.
      await main();
    });
}
```

- [ ] **Step 2: Wire it into the root**

In `src/index.ts`, add the import alongside the other command imports and register it before `program.parse()`:

```ts
import { registerMcpCommand } from './commands/mcp.js';
// ...after the other register*Commands(program) calls...
registerMcpCommand(program);

program.parse();
```

- [ ] **Step 3: Build and confirm the command exists**

Run: `npm run build && node dist/index.js mcp --help`
Expected: help text for `mcp` prints (and exits; `--help` does not start the server).

- [ ] **Step 4: Commit**

```bash
git add src/commands/mcp.ts src/index.ts
git commit -m "feat(cli): add 'supaflow mcp' subcommand"
```

---

### Task 4: Migrate the MCP contract suite into the CLI

The plugin's `tests/fast/test-mcp-contract.sh` is the real contract (tool surface, exclusions, annotations, exact argv mapping, config/selection/plan-binding). Port its assertions to vitest against `src/mcp/server.ts`. This supersedes that shell test, which Task 7 deletes.

**Files:**
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write the test (porting the assertions from `test-mcp-contract.sh:29-131`)**

```ts
// tests/mcp-tools.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  listToolDefinitions,
  buildSupaflowArgv,
  buildPipelineCreateFromPlanArgv,
  normalizeObjectPreviewLimit,
  applyConfigPatch,
  applyObjectSelection,
  validatePlanBinding,
  validatePlanWorkspace,
} from '../src/mcp/server.js';

const defByName = new Map(listToolDefinitions().map((d) => [d.name, d]));

describe('MCP tool surface', () => {
  it('exposes 44 unique tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(TOOLS.length).toBe(44);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the guided pair and excludes auth/encrypt tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('pipelines_prepare_create');
    expect(names).toContain('pipelines_create_from_plan');
    expect(names).not.toContain('auth_login');
    expect(names).not.toContain('auth_logout');
    expect(names).not.toContain('encrypt');
  });

  it('closes every input schema', () => {
    expect(listToolDefinitions().every((t) => t.inputSchema && t.inputSchema.additionalProperties === false)).toBe(true);
  });
});

describe('annotations', () => {
  it('marks reads read-only and deletes destructive', () => {
    expect(defByName.get('auth_status')!.annotations.readOnlyHint).toBe(true);
    expect(defByName.get('pipelines_prepare_create')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('pipelines_create_from_plan')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('datasources_get')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('datasources_catalog')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('pipelines_create')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('docs')!.annotations.readOnlyHint).toBe(false);
    for (const t of ['pipelines_delete', 'datasources_delete', 'schedules_delete']) {
      expect(defByName.get(t)!.annotations.destructiveHint).toBe(true);
    }
  });

  it('gives the guided tools output schemas', () => {
    expect(defByName.get('pipelines_prepare_create')!.outputSchema).toBeTruthy();
    expect(defByName.get('pipelines_create_from_plan')!.outputSchema).toBeTruthy();
  });
});

describe('guided defaults + delete safety wording', () => {
  it('defaults the prepare-create object preview to 1000', () => {
    const schema = defByName.get('pipelines_prepare_create')!.inputSchema as any;
    expect(schema.properties.object_preview_limit.default).toBe(1000);
  });

  it('requires skill-side confirmation in the delete description (not the MCP prompt)', () => {
    const desc = TOOLS.find((t) => t.name === 'pipelines_delete')!.description;
    expect(/skill must get explicit user confirmation before this tool call/i.test(desc)).toBe(true);
    expect(/MCP approval prompt is the confirmation/i.test(desc)).toBe(false);
  });
});

describe('argv mapping', () => {
  // Assert the token array directly (tokens like "Test create" contain spaces, so a joined string is ambiguous).
  it('builds exact argv for representative tools', () => {
    expect(buildSupaflowArgv('datasources_get', { identifier: 'pg', output_file: '/tmp/pg.env' }))
      .toEqual(['datasources', 'get', 'pg', '--output', '/tmp/pg.env', '--json']);
    expect(buildSupaflowArgv('datasources_catalog', { identifier: 'pg', output_file: '/tmp/objects.json', refresh: true, with_fields: true }))
      .toEqual(['datasources', 'catalog', 'pg', '--output', '/tmp/objects.json', '--refresh', '--with-fields', '--json']);
    expect(buildSupaflowArgv('pipelines_delete', { identifier: 'orders' }))
      .toEqual(['pipelines', 'delete', 'orders', '--yes', '--json']);
    expect(buildSupaflowArgv('pipelines_sync', { identifier: 'orders', full_resync: true, reset_target: true }))
      .toEqual(['pipelines', 'sync', 'orders', '--full-resync', '--reset-target', '--json']);
    expect(buildSupaflowArgv('docs', { topic: 'postgres', output_file: '/tmp/postgres-docs.md', refresh: true }))
      .toEqual(['docs', 'postgres', '--output', '/tmp/postgres-docs.md', '--refresh']); // docs omits --json
  });

  it('always passes the prepared objects file in guided create', () => {
    expect(buildPipelineCreateFromPlanArgv({
      name: 'Orders', description: 'Test create', source: 'sql_server',
      project: 'postgres_project', configFile: '/tmp/config.json', objectsFile: '/tmp/objects.json',
    })).toEqual([
      'pipelines', 'create', '--name', 'Orders', '--source', 'sql_server', '--project', 'postgres_project',
      '--config', '/tmp/config.json', '--objects', '/tmp/objects.json', '--description', 'Test create', '--json',
    ]);
  });
});

describe('preview limit + selection + plan binding', () => {
  it('clamps the preview limit to 1..1000', () => {
    expect(normalizeObjectPreviewLimit(undefined)).toBe(1000);
    expect(normalizeObjectPreviewLimit(618)).toBe(618);
    expect(normalizeObjectPreviewLimit(5000)).toBe(1000);
    expect(normalizeObjectPreviewLimit(0)).toBe(1);
  });

  it('marks a changed pipeline_prefix as custom', () => {
    const patched = applyConfigPatch({ pipeline_prefix: 'postgres', ingestion_mode: 'incremental' }, { pipeline_prefix: 'analytics' });
    expect(patched.pipeline_prefix).toBe('analytics');
    expect(patched.is_custom_prefix).toBe(true);
  });

  it('keeps only included objects and rejects unknown ones', () => {
    const sel = applyObjectSelection(
      [{ fully_qualified_name: 'public.accounts' }, { fully_qualified_name: 'public.orders' }],
      { mode: 'subset', include: ['public.orders'] },
    );
    expect(sel.objects.map((o: any) => `${o.fully_qualified_name}:${o.selected}`)).toEqual(['public.accounts:false', 'public.orders:true']);
    expect(() => applyObjectSelection([{ fully_qualified_name: 'public.accounts' }], { mode: 'subset', include: ['public.missing'] })).toThrow();
  });

  it('enforces workspace/source/project plan binding', () => {
    const plan = { workspace: { id: 'ws_1' }, resolved: { source: { id: 'src_1' }, project: { id: 'proj_1' } } };
    expect(validatePlanBinding(plan, { workspace: { id: 'ws_1' }, source: { id: 'src_1' }, project: { id: 'proj_1' } })).toBe(true);
    expect(() => validatePlanWorkspace(plan, { id: 'ws_2' })).toThrow();
    expect(() => validatePlanBinding({ schema_version: 1 }, { workspace: { id: 'ws_1' }, source: { id: 'src_1' }, project: { id: 'proj_1' } })).toThrow();
  });
});
```

- [ ] **Step 2: Run (the code already exists from Task 2)**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS. If `toBe(44)` fails, count `TOOLS` and update it here and in Task 5 in the same commit (see open verification items).

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-tools.test.ts
git commit -m "test(mcp): migrate MCP contract suite from plugin into CLI"
```

---

### Task 5: Stdio tests — clean stdout, a real tool call, and no auto-run guard

Three runtime guards: (1) the `mcp` process emits only JSON-RPC; (2) a real `tools/call` works end-to-end through self-invocation (Task 2 Step 3); (3) the bundle does **not** behave as a server when run as a plain CLI command — the regression for a reintroduced auto-run guard (Task 2 Step 2). Note: the stub-CLI test (2) exercises the self-invocation plumbing but cannot catch the guard, because the child it spawns is the stub, not `dist/index.js`; test (3) is what actually catches the guard.

**Files:**
- Test fixture: `tests/fixtures/stub-cli.mjs`
- Test: `tests/mcp-stdio.test.ts`

- [ ] **Step 1: Write a stub CLI fixture (hermetic — no auth/network)**

`tests/fixtures/stub-cli.mjs` stands in for the real CLI via `SUPAFLOW_CLI_ENTRY`, so a tool call returns known JSON without a backend:

```js
// tests/fixtures/stub-cli.mjs — emits deterministic JSON for `auth status`.
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ authenticated: true, workspace_id: 'ws_test', workspace_name: 'Test' }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, argv: args }));
process.exit(0);
```

- [ ] **Step 2: Write the stdio test**

```ts
// tests/mcp-stdio.test.ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist/index.js');
const STUB = path.resolve(HERE, 'fixtures/stub-cli.mjs');

const rpc = (obj: unknown) => JSON.stringify(obj) + '\n';
const init = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
const initialized = rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

function collect(stream: NodeJS.ReadableStream): { value: string } {
  const acc = { value: '' };
  stream.on('data', (d) => (acc.value += d.toString()));
  return acc;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('supaflow mcp stdio', () => {
  it('emits only valid JSON-RPC and lists 44 tools', async () => {
    const child = spawn(process.execPath, [DIST, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = collect(child.stdout);
    child.stdin.write(init); child.stdin.write(initialized);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    await sleep(1500); child.kill();

    const lines = out.value.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe('2.0'); // throws if non-JSON leaked
    expect(lines.map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result?.tools?.length).toBe(44);
  }, 10000);

  it('runs a real tools/call through self-invocation (stub CLI)', async () => {
    const child = spawn(process.execPath, [DIST, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SUPAFLOW_CLI_ENTRY: STUB },
    });
    const out = collect(child.stdout);
    child.stdin.write(init); child.stdin.write(initialized);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'auth_status', arguments: {} } }));
    await sleep(1500); child.kill();

    const resp = out.value.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).find((m) => m.id === 3);
    const text = resp?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('authenticated');
    expect(text).toContain('ws_test');
  }, 10000);

  it('does NOT act as an MCP server when run as a plain CLI command', async () => {
    // Catches a reintroduced import-time auto-run guard: a plain invocation must never
    // answer JSON-RPC. `connectors list` errors offline but must not server-respond.
    const child = spawn(process.execPath, [DIST, 'connectors', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = collect(child.stdout);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }));
    await sleep(1500); child.kill();

    const sawServerResponse = out.value.split('\n').filter((l) => l.trim()).some((l) => {
      try { const m = JSON.parse(l); return m.id === 9 && m.result?.tools; } catch { return false; }
    });
    expect(sawServerResponse).toBe(false);
  }, 10000);
});
```

- [ ] **Step 3: Build, then run**

Run: `npm run build && npx vitest run tests/mcp-stdio.test.ts`
Expected: PASS. (Test 1 `JSON.parse` failure = stdout leak; test 2 failure = self-invocation broken; test 3 failure = the auto-run guard is back.)

- [ ] **Step 4: Commit**

```bash
git add tests/mcp-stdio.test.ts tests/fixtures/stub-cli.mjs
git commit -m "test(mcp): stdio discipline, real tool call via stub, no auto-run guard"
```

---

### Task 6: Merge to `main`, then verify + publish + tag `@getsupaflow/cli@0.2.0` from `main`

**Files:** none (release task). Publish and tag **must** run from `main` after the PR merges, so npm and the `v0.2.0` tag point at commits reachable from `main` (workspace merge-commit rule).

- [ ] **Step 1: Pre-merge gate on the feature branch**

Run: `npm run lint && npm test && npm run build`
Expected: all pass. Push `feat/supaflow-mcp` and open a PR into `main`.

- [ ] **Step 2: Merge the PR with a merge-commit (no squash/rebase)**

```bash
gh pr merge --merge   # NEVER --squash / --rebase, per workspace policy
```

- [ ] **Step 3: Switch to `main` and confirm it is the release source**

```bash
git checkout main
git pull --ff-only
git status                       # must be clean
git log --oneline -1             # the merge commit
node -e "console.log(require('./package.json').version)"   # -> 0.2.0
git diff --quiet HEAD -- package.json && echo "version committed on main"
```
Expected: clean tree on `main`, version `0.2.0`. If `main` is not at `0.2.0`, stop — the PR did not carry the version bump.

- [ ] **Step 4: Build from main, pack, and install the tarball globally to verify both surfaces**

```bash
npm ci && npm run build
npm pack
npm install -g ./getsupaflow-cli-0.2.0.tgz
supaflow --version            # -> 0.2.0
supaflow mcp --help           # -> prints mcp help, exits
```
Expected: the globally installed `supaflow` resolves both the normal CLI and `mcp` (confirms self-invocation from the real global install path, not just `dist/`).

- [ ] **Step 5: Publish from `main`**

Run: `npm publish --access public`
Expected: `@getsupaflow/cli@0.2.0` is live on npm. Record the version — Task 7 depends on it.

- [ ] **Step 6: Tag the merge commit on `main`**

```bash
git tag v0.2.0          # tags current HEAD = the merge commit on main
git push origin v0.2.0
```

---

### Task 7: Switch the plugin to `supaflow mcp` and delete the prototype (GATED on Task 6 publish)

Do not start until `@getsupaflow/cli@0.2.0` is on npm. Separate repo, separate commits. This **removes** `servers/supaflow-mcp/` rather than keeping it as a legacy copy (one source of truth; no drift). Any Desktop user who hand-registered the absolute `server.mjs` path must switch to `supaflow mcp` — acceptable for a prototype. If you instead want a deprecation window, keep the dir with a banner and skip the deletions below (and leave `test-mcp-contract.sh` in place).

**Files (repo `supaflow-claude-plugin`):**
- Delete: `servers/supaflow-mcp/`
- Delete: `tests/fast/test-mcp-contract.sh` (migrated to `supaflow-cli` in Task 4)
- Modify: `README.md` (lines 33, 68)
- Modify: `skills/using-supaflow/setup-preamble.md`
- Modify: `hooks/check-setup.sh:17`

- [ ] **Step 1: Fold the host-registration block into the plugin README, then delete the prototype**

Before deleting, move the only still-relevant content from `servers/supaflow-mcp/README.md` — the Desktop host-config block — into the plugin `README.md`, rewritten for the CLI subcommand:

```json
{
  "mcpServers": {
    "supaflow": {
      "command": "supaflow",
      "args": ["mcp"]
    }
  }
}
```

Then remove the directory and the now-dead contract test:

```bash
cd /Users/puneetgupta/supaflow-workspace/supaflow-claude-plugin
git rm -r servers/supaflow-mcp
git rm tests/fast/test-mcp-contract.sh
```

- [ ] **Step 2: Drop the README pointers to the deleted dir**

In `README.md`, rewrite line 33 (the "Desktop MCP server ... in `servers/supaflow-mcp/`" bullet) and line 68 (the "See `servers/supaflow-mcp/README.md`" sentence) to point at `supaflow mcp` host registration (the JSON above). Keep the rule that plugin `.mcp.json` is wrong for Desktop.

- [ ] **Step 3: Update the setup gate's host-registration guidance**

In `skills/using-supaflow/setup-preamble.md`, update the "No valid surface" guidance (~line 23) and section 1A so the Desktop fix path is "install/update `@getsupaflow/cli` to 0.2.0+ and register `supaflow mcp` in `claude_desktop_config.json`". Remove the reference to `servers/supaflow-mcp/README.md`. Keep the plugin-`.mcp.json`-is-wrong-for-Desktop rule.

- [ ] **Step 4: Bump the CLI minimum so the gate covers MCP compatibility**

In `hooks/check-setup.sh`:

```bash
MIN_CLI_VERSION="0.2.0"
```

- [ ] **Step 5: Run the plugin tests (fast is the default — no positional arg)**

Run: `cd /Users/puneetgupta/supaflow-workspace/supaflow-claude-plugin && bash tests/run-tests.sh`
Expected: PASS. `test-mcp-contract.sh` is gone (migrated); `test-mcp-skill-gate.sh` still passes (the Desktop `.mcp.json` rejection rule remains). Then confirm no dangling references: `grep -rn "servers/supaflow-mcp" . --exclude-dir=.git` returns nothing.

- [ ] **Step 6: Commit (plugin repo)**

```bash
git add -A
git commit -m "refactor(mcp): register 'supaflow mcp', delete bundled prototype, require CLI 0.2.0"
```

---

### Task 8 (optional): Terminal-path plugin `.mcp.json` for Playwright-style auto-launch

This makes **terminal Claude Code** behave like the Playwright plugin: install the plugin -> `mcp__supaflow__*` tools appear, no manual config. A plugin `.mcp.json` runs on the host in terminal CC (unlike Claude Desktop, where it would run in the cowork VM), so it can see the host CLI and `~/.supaflow/config.json`. **Desktop is unchanged — it still requires the host registration from Task 7** (the VM wall is not closeable here). Gated on the Task 6 publish, since it launches `supaflow mcp`.

**Files (repo `supaflow-claude-plugin`):**
- Create: `.mcp.json`
- Modify: `skills/using-supaflow/setup-preamble.md` (section 0 + the Desktop rule)
- Test: `tests/fast/test-terminal-mcp-json.sh`

- [ ] **Step 1: Create the plugin `.mcp.json`**

Use the **documented** plugin shape: a top-level `"mcpServers"` object (per the [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)). Use `command: "supaflow"` (the gate-installed global CLI) rather than `npx`, so the launched server is the same version as the installed CLI and there is no per-session network fetch:

```json
{
  "mcpServers": {
    "supaflow": {
      "command": "supaflow",
      "args": ["mcp"]
    }
  }
}
```

Notes to record in the commit message (JSON cannot hold comments):
- The official Playwright plugin ships a *direct-keyed* form (`{ "playwright": {...} }`) with no `mcpServers` wrapper, so the loader is evidently lenient — but the docs and the bundled Codex examples use the `mcpServers` wrapper, so default to that.
- `npx -y @getsupaflow/cli mcp` was rejected: it reintroduces a version axis (npx may resolve a different version than the globally installed CLI) and adds a startup network dependency. The setup gate already guarantees the global `supaflow` is installed and on `PATH`.

**Prerequisite:** before relying on this in distribution, empirically confirm in a real terminal Claude Code session that the plugin loads this `.mcp.json` and `mcp__supaflow__*` tools appear (see open verification items).

- [ ] **Step 2: Clarify terminal vs Desktop in the setup gate**

In `skills/using-supaflow/setup-preamble.md`, under "### Terminal CLI path -- fallback when MCP is absent" (around line 17-19), add:

```markdown
In terminal Claude Code, this plugin's `.mcp.json` auto-launches the host `supaflow mcp` server, so `mcp__supaflow__*` tools are normally present here too and are preferred over `Bash(supaflow *)`. The bash path remains valid when the CLI is installed but the MCP server has not started yet (e.g. before the first install, or pending a session restart).
```

And extend the existing Desktop rule (the "do NOT suggest plugin `.mcp.json`" line, ~line 23) so the two statements do not appear to contradict:

```markdown
(Terminal Claude Code is different: there the plugin `.mcp.json` runs on the host and is the intended MCP surface. The "no plugin `.mcp.json`" rule is specific to Claude Desktop, where it would run inside the cowork VM.)
```

- [ ] **Step 3: Write the test**

Use the helpers that actually exist in `tests/test-helpers.sh` (`assert_file_contains`, `assert_json_has_field`, `print_summary`; sourcing the helpers also sets `$PLUGIN_ROOT`). There is no `assert_file_exists` or `pass` helper.

```bash
# tests/fast/test-terminal-mcp-json.sh
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../test-helpers.sh"   # sets $PLUGIN_ROOT, exports helpers

MCP_JSON="$PLUGIN_ROOT/.mcp.json"

# Server is declared under the documented "mcpServers" key and launches `supaflow mcp`.
assert_json_has_field "$MCP_JSON" "data['mcpServers']['supaflow']['command'] == 'supaflow' or sys.exit(1)" \
  "mcp.json: supaflow server command is 'supaflow'"
assert_json_has_field "$MCP_JSON" "data['mcpServers']['supaflow']['args'] == ['mcp'] or sys.exit(1)" \
  "mcp.json: supaflow server args are ['mcp']"

# The Desktop-specific rejection of plugin .mcp.json must still be present.
assert_file_contains "$PLUGIN_ROOT/skills/using-supaflow/setup-preamble.md" \
  "do NOT suggest plugin \`.mcp.json\`" "Desktop rule still present"

print_summary
```

Note: `assert_json_has_field` evaluates the expression with `data` (parsed JSON) and `sys` in scope, then always `sys.exit(0)` — it fails **only** on an exception (e.g. a `KeyError` from a missing key), not on a merely falsy result. So a bare `== 'supaflow'` would always pass as long as the keys exist; the `or sys.exit(1)` guard is what turns a `False` comparison into the non-zero exit that the helper reports as FAIL.

- [ ] **Step 4: Run the plugin tests (fast is the default — no positional arg)**

Run: `cd /Users/puneetgupta/supaflow-workspace/supaflow-claude-plugin && bash tests/run-tests.sh`
Expected: PASS, including the new `test-terminal-mcp-json.sh` and the existing `test-mcp-skill-gate.sh`.

- [ ] **Step 5: Commit (plugin repo)**

```bash
git add .mcp.json skills/using-supaflow/setup-preamble.md tests/fast/test-terminal-mcp-json.sh
git commit -m "feat(mcp): auto-launch 'supaflow mcp' in terminal Claude Code via plugin .mcp.json"
```

---

## Self-Review

**Spec coverage:**
- "Fold into CLI as `supaflow mcp`" -> Tasks 2-3.
- "One package provides both `supaflow` and `supaflow mcp`" -> Task 3 + Task 6 Step 4 (global-install verify).
- "Publish/tag reachable from `main` (merge-commit rule)" -> Task 6 Steps 2-3, 5-6 + the branch note in the cross-repo sequence.
- "Stable Desktop host config (`command: supaflow, args: [mcp]`)" -> Task 7 Step 1.
- "Plugin stays thin (Desktop)" -> only docs/gate change in Task 7; no Desktop `.mcp.json`.
- "Playwright-style auto-launch in terminal" -> Task 8 (optional); terminal-only, Desktop unchanged.
- "CLI version check covers MCP compatibility" -> Task 1 (shared `VERSION`) + Task 7 Step 4 (`MIN_CLI_VERSION`).
- "Do not publish a separate `@getsupaflow/mcp`" -> honored; the private package is never published, and Task 7 **deletes** the bundled prototype dir entirely (no second copy to drift).
- "No tech debt / single source of truth" -> Task 7 deletes `servers/supaflow-mcp/`; Task 4 migrates the **full** contract suite into the CLI (surface, exclusions, closed schemas, annotations incl. `datasources_catalog`/`pipelines_create` read-only, `datasources_get` argv, prepare-create preview default, delete-wording safety, plan binding) so no assertion is lost.
- "Import-time auto-run guard removed" -> Task 2 Step 2 (deletion) + Task 5 test 3 (regression).
- "stdout = JSON-RPC only" -> Task 2 Step 6 (static grep), Task 5 test 1 (runtime).
- "Real tool call works via self-invocation" -> Task 5 test 2 (hermetic stub).
- "Subprocess boundary / drop PATH hack" -> Task 2 Step 3.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" left. The one allowed adjustment (the `toBe(44)` count) has an explicit fallback in Task 4 Step 2 and the open verification items. The Task 2 typing pass enumerates concrete signatures rather than saying "add types."

**Type consistency:** `VERSION` (Task 1) is imported the same way in `src/index.ts` (Step 2) and `src/mcp/server.ts` (Task 2 Step 4). `main` is exported by `server.mjs` today and imported by `mcp.ts` (Task 3); Task 2 Step 2 explicitly keeps it exported while deleting the auto-run call. `listToolDefinitions`/`TOOLS`/`buildSupaflowArgv`/`buildPipelineCreateFromPlanArgv`/`normalizeObjectPreviewLimit`/`applyConfigPatch`/`applyObjectSelection`/`validatePlanBinding`/`validatePlanWorkspace` are existing exports asserted in Task 4. `SUPAFLOW_CLI_ENTRY` is defined and consumed only in `server.ts` (Task 2 Step 3) and is the same name set by the Task 5 stub test.

## Open verification items for the implementer
- Confirm the exact `TOOLS` count before trusting `toBe(44)`; the server README claims 44 (42 raw + 2 guided). If the count differs, update both test assertions (Tasks 4 and 5) in the same commit and note it.
- **(Task 8) `.mcp.json` shape loads in practice.** The plan uses the documented top-level `"mcpServers"` shape, but the official Playwright plugin ships a direct-keyed form, so the loader's exact requirements are unconfirmed. Before relying on Task 8 in distribution, install the plugin in a real terminal Claude Code session and confirm `mcp__supaflow__*` tools appear. If the documented shape does not load, fall back to the direct-keyed form (`{ "supaflow": { ... } }`) and update the Task 8 file + `assert_json_has_field` paths to match.
- **(Task 8) Desktop-cowork coexistence.** When a Claude Code session runs inside Claude Desktop's cowork VM with the plugin installed, the plugin `.mcp.json` will attempt to launch `supaflow mcp` *in the VM* (no host CLI there, so it fails), while the host-registered server is bridged in as `mcp__supaflow__*`. Both use the server name `supaflow`. Verify in a real cowork session that this produces no duplicate-name error and that `mcp__supaflow__auth_status` still resolves to the host (returns live auth). If a collision or broken-server entry appears: the skills hardcode the `mcp__supaflow__*` namespace, so renaming is not an option — instead document that Desktop-cowork users rely on the host registration (Task 7) and treat the failed VM launch as benign, or gate Task 8 to terminal-only distribution. Do not ship Task 8 until this is confirmed.
