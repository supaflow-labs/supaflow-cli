// Supaflow stdio MCP server (runs as `supaflow mcp`).
//
// Exposes the Supaflow CLI as mcp__supaflow__* tools by shelling out to the
// host `supaflow` binary. Runs ON THE HOST (register in claude_desktop_config.json),
// where the CLI and ~/.supaflow/config.json already live -- so no per-session
// install and no per-session `auth login`. Tools are bridged into Claude
// Desktop's cowork VM the same way Playwright is.
//
// The TOOLS table mirrors `supaflow` 1:1 (verified against the CLI source, since
// `supaflow <group> <sub> --help` is broken in v0.1.13). Every data/action tool
// runs with `--json`; `docs` returns markdown.
//
// Deliberately NOT exposed:
//   - auth login   (its --key would pass your API key through a tool call)
//   - auth logout  (would clear the host auth this server relies on)
//   - encrypt      (local env-file utility, not a workspace operation)
// Auth is taken from SUPAFLOW_API_KEY/SUPAFLOW_WORKSPACE_ID (this server's env)
// or the host ~/.supaflow/config.json.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { VERSION } from "../version.js";

const execFileP = promisify(execFile);
const SERVER_VERSION = VERSION;
const DEFAULT_PLAN_ROOT = process.env.SUPAFLOW_MCP_PLAN_DIR || path.join(os.tmpdir(), "supaflow-mcp-plans");
const DEFAULT_OBJECT_PREVIEW_LIMIT = 1000;
const MAX_OBJECT_PREVIEW_LIMIT = 1000;

// Re-invoke THIS package's CLI for each tool call (subprocess boundary).
// Bundled, import.meta.url === dist/index.js; the env override keeps tests hermetic.
const CLI_ENTRY = process.env.SUPAFLOW_CLI_ENTRY ?? fileURLToPath(import.meta.url);

// Parent global-flag overrides (--workspace / --api-key / --supabase-url), forwarded to every
// child CLI invocation so tool calls hit the same workspace/identity/backend the server was
// launched with. Set by main(); empty for the default `supaflow mcp` registration.
let CHILD_OVERRIDE_ENV: Record<string, string> = {};
let CHILD_OVERRIDE_ARGV: string[] = [];

// ---- shared types (loose: tool args are validated by inputSchema at the MCP layer) ----
// MCP tools marshal dynamically-typed CLI args / JSON validated by inputSchema at the
// protocol boundary (deep dynamic access), so a single loose bag type is intentional here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type ToolArgs = Json;

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
  handler?: (args: ToolArgs) => Promise<CallToolResult>;
}

// ---- argv builder helpers (keep the table declarative + exact) ----
const S = (v: unknown) => String(v);
function opt(argv: string[], flag: string, val: unknown) {
  if (val !== undefined && val !== null && val !== "") argv.push(flag, S(val));
}
function bool(argv: string[], flag: string, val: unknown) {
  if (val === true) argv.push(flag);
}
function multi(argv: string[], flag: string, vals: unknown) {
  if (Array.isArray(vals)) for (const v of vals) argv.push(flag, S(v));
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text || "{}");
  } catch (err) {
    throw new Error(`Failed to parse ${label} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseCliJson(text: string, label: string) {
  const data = parseJson(text, label);
  if (data && typeof data === "object" && data.error) {
    const message = data.error.message || JSON.stringify(data.error);
    throw new Error(`${label} failed: ${message}`);
  }
  return data;
}

function ensurePlanRoot() {
  fs.mkdirSync(DEFAULT_PLAN_ROOT, { recursive: true, mode: 0o700 });
}

function assertPlanId(planId: string) {
  if (typeof planId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(planId)) {
    throw new Error("Invalid plan_id.");
  }
}

function planPaths(planId: string) {
  assertPlanId(planId);
  const dir = path.join(DEFAULT_PLAN_ROOT, planId);
  return {
    dir,
    planFile: path.join(dir, "plan.json"),
    configFile: path.join(dir, "pipeline-config.json"),
    referenceFile: path.join(dir, "pipeline-config-reference.txt"),
    objectsFile: path.join(dir, "pipeline-objects.json"),
    selectedObjectsFile: path.join(dir, "pipeline-selected-objects.json"),
  };
}

function loadPlan(planId: string) {
  const paths = planPaths(planId);
  if (!fs.existsSync(paths.planFile)) {
    throw new Error(`Pipeline create plan "${planId}" not found or expired.`);
  }
  return { paths, plan: parseJson(fs.readFileSync(paths.planFile, "utf8"), "pipeline plan") };
}

function configSummary(config: Json) {
  return {
    pipeline_prefix: config?.pipeline_prefix,
    ingestion_mode: config?.ingestion_mode,
    load_mode: config?.load_mode,
    schema_evolution_mode: config?.schema_evolution_mode,
    perform_hard_deletes: config?.perform_hard_deletes,
    full_sync_frequency: config?.full_sync_frequency ?? null,
    error_handling: config?.error_handling ?? null,
  };
}

function safeDatasourceIdentity(ds: Json) {
  return {
    id: ds?.id || "",
    api_name: ds?.api_name || "",
    name: ds?.name || "",
    state: ds?.state || "",
    connector_name: ds?.connector_name || "",
    connector_type: ds?.connector_type || "",
    workspace_id: ds?.workspace_id || "",
  };
}

function safeProjectIdentity(project: Json) {
  return {
    id: project?.id || "",
    api_name: project?.api_name || "",
    name: project?.name || "",
    state: project?.state || "",
    warehouse_datasource_id: project?.warehouse_datasource_id || "",
    warehouse_name: project?.warehouse_name || "",
    warehouse_connector_name: project?.warehouse_connector_name || "",
  };
}

async function getCurrentWorkspace() {
  const status = parseCliJson(await execSupaflowArgv(["auth", "status", "--json"], 60000), "auth status");
  if (status.authenticated !== true) {
    throw new Error("Supaflow CLI is not authenticated. Run supaflow auth login in your own terminal.");
  }
  if (!status.workspace_id) {
    throw new Error("No Supaflow workspace is selected. Run supaflow workspaces select in your own terminal.");
  }
  return {
    id: status.workspace_id,
    name: status.workspace_name || "",
  };
}

async function resolveDatasourceIdentity(identifier: string) {
  const ds = parseCliJson(await execSupaflowArgv(["datasources", "get", identifier, "--json"], 120000), "datasources get");
  const identity = safeDatasourceIdentity(ds);
  if (!identity.id) {
    throw new Error(`Datasource "${identifier}" did not resolve to an id.`);
  }
  return identity;
}

async function resolveProjectIdentity(identifier: string) {
  const projects = parseCliJson(await execSupaflowArgv(["projects", "list", "--json"], 120000), "projects list");
  const rows = Array.isArray(projects?.data) ? projects.data : [];
  const project = rows.find((p: Json) => p?.id === identifier || p?.api_name === identifier);
  if (!project) {
    throw new Error(`Project "${identifier}" not found in the active workspace.`);
  }
  const identity = safeProjectIdentity(project);
  if (!identity.id) {
    throw new Error(`Project "${identifier}" did not resolve to an id.`);
  }
  if (!identity.warehouse_datasource_id) {
    throw new Error(`Project "${identity.name || identifier}" has no destination datasource configured.`);
  }
  return identity;
}

export function normalizeObjectPreviewLimit(value: unknown) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_OBJECT_PREVIEW_LIMIT), 10);
  const limit = Number.isNaN(parsed) ? DEFAULT_OBJECT_PREVIEW_LIMIT : parsed;
  return Math.min(Math.max(limit, 1), MAX_OBJECT_PREVIEW_LIMIT);
}

export function validatePlanBinding(plan: Json, current: Json) {
  const expectedWorkspaceId = plan?.workspace?.id;
  const expectedSourceId = plan?.resolved?.source?.id;
  const expectedProjectId = plan?.resolved?.project?.id;

  if (!expectedWorkspaceId || !expectedSourceId || !expectedProjectId) {
    throw new Error("Prepared pipeline plan is missing workspace/source/project bindings. Re-run pipelines_prepare_create.");
  }
  validatePlanWorkspace(plan, current?.workspace);
  if (current?.source?.id !== expectedSourceId) {
    throw new Error(
      `Source datasource changed since prepare: expected ${expectedSourceId}, got ${current?.source?.id || "none"}. Re-run pipelines_prepare_create.`,
    );
  }
  if (current?.project?.id !== expectedProjectId) {
    throw new Error(
      `Project changed since prepare: expected ${expectedProjectId}, got ${current?.project?.id || "none"}. Re-run pipelines_prepare_create.`,
    );
  }
  return true;
}

export function validatePlanWorkspace(plan: Json, currentWorkspace: Json) {
  const expectedWorkspaceId = plan?.workspace?.id;
  if (!expectedWorkspaceId || !plan?.resolved?.source?.id || !plan?.resolved?.project?.id) {
    throw new Error("Prepared pipeline plan is missing workspace/source/project bindings. Re-run pipelines_prepare_create.");
  }
  if (currentWorkspace?.id !== expectedWorkspaceId) {
    throw new Error(
      `Active workspace changed since prepare: expected ${expectedWorkspaceId}, got ${currentWorkspace?.id || "none"}. Re-run pipelines_prepare_create in the target workspace.`,
    );
  }
  return true;
}

export function applyConfigPatch(baseConfig: Json, patch: Json = {}) {
  const next = { ...(baseConfig || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    next[key] = value;
  }
  if (
    Object.prototype.hasOwnProperty.call(patch || {}, "pipeline_prefix") &&
    patch.pipeline_prefix !== baseConfig?.pipeline_prefix
  ) {
    next.is_custom_prefix = true;
  }
  return next;
}

export function applyObjectSelection(objects: Json[], selection: Json) {
  if (!selection || selection.mode === "all") {
    return {
      mode: "all",
      objects: objects.map((o) => ({ ...o, selected: true })),
      selected: objects.map((o) => o.fully_qualified_name),
      missing: [],
    };
  }

  if (selection.mode !== "subset") {
    throw new Error('object_selection.mode must be "all" or "subset".');
  }

  const include = Array.isArray(selection.include) ? selection.include : [];
  if (include.length === 0) {
    throw new Error('object_selection.include is required when mode is "subset".');
  }

  const available = new Set(objects.map((o) => o.fully_qualified_name));
  const missing = include.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown object(s) in selection: ${missing.join(", ")}`);
  }

  const includeSet = new Set(include);
  return {
    mode: "subset",
    objects: objects.map((o) => ({ ...o, selected: includeSet.has(o.fully_qualified_name) })),
    selected: include,
    missing: [],
  };
}

export function buildPipelineCreateFromPlanArgv({ name, description, source, project, configFile, objectsFile }: { name: string; description?: string; source: string; project: string; configFile: string; objectsFile: string }) {
  const argv = [
    "pipelines",
    "create",
    "--name",
    name,
    "--source",
    source,
    "--project",
    project,
    "--config",
    configFile,
    "--objects",
    objectsFile,
  ];
  if (description) {
    argv.push("--description", description);
  }
  argv.push("--json");
  return argv;
}

function objectNames(objects: Json[]) {
  return objects.map((o) => o.fully_qualified_name).filter((name) => typeof name === "string" && name.length > 0);
}

function toolResult(message: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}

const idSchema = (label = "UUID or api_name") => ({
  type: "object",
  properties: { identifier: { type: "string", description: label } },
  required: ["identifier"],
  additionalProperties: false,
});
const jobIdSchema = {
  type: "object",
  properties: { id: { type: "string", description: "Job UUID" } },
  required: ["id"],
  additionalProperties: false,
};

const pipelinePrepareCreateOutputSchema = {
  type: "object",
  properties: {
    plan_id: { type: "string" },
    plan_dir: { type: "string" },
    workspace_id: { type: "string" },
    workspace_name: { type: "string" },
    source: { type: "string" },
    source_id: { type: "string" },
    source_api_name: { type: "string" },
    project: { type: "string" },
    project_id: { type: "string" },
    project_api_name: { type: "string" },
    destination_id: { type: "string" },
    source_name: { type: "string" },
    source_type: { type: "string" },
    destination_name: { type: "string" },
    project_name: { type: "string" },
    config: { type: "object", additionalProperties: true },
    config_summary: { type: "object", additionalProperties: true },
    object_count: { type: "number" },
    objects_preview: { type: "array", items: { type: "string" } },
    objects_truncated: { type: "boolean" },
    host_files: { type: "object", additionalProperties: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "plan_id",
    "plan_dir",
    "workspace_id",
    "workspace_name",
    "source",
    "source_id",
    "source_api_name",
    "project",
    "project_id",
    "project_api_name",
    "destination_id",
    "source_name",
    "source_type",
    "destination_name",
    "project_name",
    "config",
    "config_summary",
    "object_count",
    "objects_preview",
    "objects_truncated",
    "host_files",
    "warnings",
  ],
  additionalProperties: false,
};

const pipelineCreateFromPlanOutputSchema = {
  type: "object",
  properties: {
    plan_id: { type: "string" },
    pipeline: { type: "object", additionalProperties: true },
    config_summary: { type: "object", additionalProperties: true },
    object_selection: { type: "object", additionalProperties: true },
    verification: { type: "object", additionalProperties: true },
  },
  required: ["plan_id", "pipeline", "config_summary", "object_selection", "verification"],
  additionalProperties: false,
};

// ---- the tool table: 1:1 with the CLI ----
export const TOOLS: ToolSpec[] = [
  // ---------- read-only ----------
  {
    name: "auth_status",
    description: "Show current authentication status and the active workspace.",
    readOnly: true,
    build: () => ["auth", "status"],
  },
  {
    name: "workspaces_list",
    description: "List accessible workspaces.",
    readOnly: true,
    build: () => ["workspaces", "list"],
  },
  {
    name: "connectors_list",
    description: "List available connector types (use the `type` for datasource init).",
    readOnly: true,
    build: () => ["connectors", "list"],
  },
  {
    name: "datasources_list",
    description: "List datasources in the active workspace. Returns { data, total, limit, offset }.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 25). Use 200 for broad scans.", default: 25 },
        offset: { type: "number", description: "Pagination offset.", default: 0 },
        filter: { type: "array", items: { type: "string" }, description: "field=value filters (repeatable)." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["datasources", "list"];
      opt(v, "--limit", a.limit);
      opt(v, "--offset", a.offset);
      multi(v, "--filter", a.filter);
      return v;
    },
  },
  {
    name: "datasources_get",
    description:
      "Get datasource details by UUID or api_name. Pass output_file to export a host-side env file for datasources_edit. Sensitive values are stored encrypted and export as `enc:` envelopes, never cleartext, so the exported file contains no plaintext secrets.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "UUID or api_name" },
        output_file: {
          type: "string",
          description:
            "Host path for exported env file used by datasources_edit. Sensitive fields are written as `enc:` encrypted envelopes, never cleartext -- safe to write to disk.",
        },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["datasources", "get", a.identifier];
      opt(v, "--output", a.output_file);
      return v;
    },
  },
  {
    name: "datasources_catalog",
    description:
      "List discovered objects for a datasource. Can be large -- pass output_file to write objects.json to disk instead of returning it inline.",
    readOnly: false,
    timeoutMs: 180000,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Datasource UUID or api_name" },
        output_file: { type: "string", description: "Write selectable objects JSON to this host path (for pipeline creation)." },
        refresh: { type: "boolean", description: "Trigger a schema refresh before listing." },
        with_fields: { type: "boolean", description: "Include full per-object field-level metadata (large)." },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["datasources", "catalog", a.identifier];
      opt(v, "--output", a.output_file);
      bool(v, "--refresh", a.refresh);
      bool(v, "--with-fields", a.with_fields);
      return v;
    },
  },
  {
    name: "pipelines_list",
    description: "List pipelines in the active workspace. Returns { data, total, limit, offset }.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 25 },
        offset: { type: "number", default: 0 },
        state: { type: "string", description: "Filter by state (e.g. active, inactive)." },
        sort: { type: "string", description: "name | state | created_at | updated_at | last_sync_at", default: "name" },
        order: { type: "string", enum: ["asc", "desc"], default: "asc" },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "list"];
      opt(v, "--limit", a.limit);
      opt(v, "--offset", a.offset);
      opt(v, "--state", a.state);
      opt(v, "--sort", a.sort);
      opt(v, "--order", a.order);
      return v;
    },
  },
  {
    name: "pipelines_get",
    description: "Get pipeline details by UUID or api_name.",
    readOnly: true,
    inputSchema: idSchema(),
    build: (a) => ["pipelines", "get", a.identifier],
  },
  {
    name: "pipelines_schema_list",
    description: "List a pipeline's selectable objects (raw array consumable by pipelines create --objects and schema select --from).",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Pipeline UUID or api_name" },
        all: { type: "boolean", description: "Include deselected objects." },
        with_fields: { type: "boolean", description: "Include per-object field selections in the raw JSON output." },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "schema", "list", a.identifier];
      bool(v, "--all", a.all);
      bool(v, "--with-fields", a.with_fields);
      return v;
    },
  },
  {
    name: "projects_list",
    description: "List projects in the active workspace.",
    readOnly: true,
    build: () => ["projects", "list"],
  },
  {
    name: "jobs_list",
    description: "List jobs in the active workspace.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "array", items: { type: "string" }, description: "status=<v>, type=<v>, pipeline=<uuid> (repeatable)." },
        limit: { type: "number", default: 25 },
        offset: { type: "number", default: 0 },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["jobs", "list"];
      multi(v, "--filter", a.filter);
      opt(v, "--limit", a.limit);
      opt(v, "--offset", a.offset);
      return v;
    },
  },
  {
    name: "jobs_status",
    description: "Lightweight job status by id (for polling). Returns id, job_status, status_message, job_response.",
    readOnly: true,
    inputSchema: jobIdSchema,
    build: (a) => ["jobs", "status", a.id],
  },
  {
    name: "jobs_get",
    description: "Get a job by UUID including per-object metrics (execution_duration_ms, ended_at, object_details).",
    readOnly: true,
    inputSchema: jobIdSchema,
    build: (a) => ["jobs", "get", a.id],
  },
  {
    name: "jobs_logs",
    description: "Show stored job response/logs for a job.",
    readOnly: true,
    inputSchema: jobIdSchema,
    build: (a) => ["jobs", "logs", a.id],
  },
  {
    name: "agent_start",
    description:
      "Start (or enroll) a local Docker agent. Preflights docker binary/daemon/disk/image, resumes an existing container or identity volume when present, otherwise enrolls a fresh agent via a registration token (requires an org:admin API key). Pass approve=true to authorize it to run jobs; default leaves it pending on the agents page.",
    write: true,
    timeoutMs: 420000,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Container name (default supaflow-agent; volume becomes <name>-data)." },
        image: { type: "string", description: "Agent image (default supaflow/supaflow-agent:latest)." },
        api_url: { type: "string", description: "Supaflow app URL override for the agent (local dev)." },
        approve: { type: "boolean", description: "true approves after registration; false (or omitted) leaves it pending." },
        timeout: { type: "number", description: "Registration wait in seconds (default 180)." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "start"];
      opt(argv, "--name", a.name);
      opt(argv, "--image", a.image);
      opt(argv, "--api-url", a.api_url);
      if (a.approve === true) argv.push("--approve");
      else argv.push("--no-approve");
      opt(argv, "--timeout", a.timeout);
      return argv;
    },
  },
  {
    name: "agent_upgrade",
    description:
      "Available in CLI 0.5.0+. Pull and install a newer local Docker agent image while preserving the named identity/keystore volume. This stops and replaces the current container, so the skill must get explicit user confirmation before this tool call; MCP approval alone is not the workflow confirmation. Pulling and identity validation finish before the existing container is stopped. The replacement startup is checked and restoration of the previous immutable image is attempted on failure. Set pull=false only to install a local image that is already present.",
    write: true,
    destructive: true,
    timeoutMs: 420000,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Container name (default supaflow-agent; volume is <name>-data)." },
        image: { type: "string", description: "Agent image (default supaflow/supaflow-agent:latest)." },
        api_url: { type: "string", description: "Override the bootstrap URL preserved from the current container; required when the existing container has no SUPAFLOW_API_URL." },
        pull: { type: "boolean", description: "Pull from the registry before upgrading (default true)." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "upgrade"];
      opt(argv, "--name", a.name);
      opt(argv, "--image", a.image);
      opt(argv, "--api-url", a.api_url);
      if (a.pull === false) argv.push("--no-pull");
      return argv;
    },
  },
  {
    name: "agent_stop",
    description: "Stop the local Docker agent container. Identity is preserved; agent_start resumes it without a new token.",
    write: true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Container name (default supaflow-agent)." } },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "stop"];
      opt(argv, "--name", a.name);
      return argv;
    },
  },
  {
    name: "agent_status",
    description: "Local Docker agent status: container state joined with the agent record (lifecycle_status, connectivity_status, last_heartbeat_at).",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Container name (default supaflow-agent)." } },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "status"];
      opt(argv, "--name", a.name);
      return argv;
    },
  },
  {
    name: "agent_logs",
    description: "Trailing logs from the local Docker agent container (raw text, not JSON).",
    readOnly: true,
    json: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Container name (default supaflow-agent)." },
        tail: { type: "number", description: "Number of trailing lines (default 200)." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "logs"];
      opt(argv, "--name", a.name);
      opt(argv, "--tail", a.tail);
      return argv;
    },
  },
  {
    name: "agent_remove",
    description:
      "Remove the local Docker agent container. The skill must get explicit user confirmation before this tool call; MCP approval alone is not the workflow confirmation. purge=true ADDITIONALLY deletes the identity volume -- warn the user this is identity-losing: the next agent_start enrolls a brand-new agent needing re-approval, and the old agent record must be deactivated on the agents page.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Container name (default supaflow-agent)." },
        purge: { type: "boolean", description: "Also delete the identity volume." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const argv = ["agent", "remove", "--yes"];
      opt(argv, "--name", a.name);
      bool(argv, "--purge", a.purge);
      return argv;
    },
  },
  {
    name: "schedules_list",
    description: "List schedules in the active workspace. Uses cron_schedule, target_type, target_id.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", description: "Filter by state (active, inactive)." } },
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["schedules", "list"];
      opt(v, "--state", a.state);
      return v;
    },
  },
  {
    name: "schedules_history",
    description: "View execution history for a schedule.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Schedule UUID or name" },
        limit: { type: "number", description: "Number of executions to show.", default: 10 },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["schedules", "history", a.identifier];
      opt(v, "--limit", a.limit);
      return v;
    },
  },
  {
    name: "docs",
    description:
      "Show Supaflow documentation for a connector or topic. Pass output_file for large docs; use list:true to list topics.",
    readOnly: false,
    json: false,
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Connector or topic name." },
        list: { type: "boolean", description: "List all available topics." },
        output_file: { type: "string", description: "Write documentation to this host file instead of returning it inline." },
        refresh: { type: "boolean", description: "Force refresh the docs cache before reading." },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["docs"];
      if (a.topic) v.push(a.topic);
      bool(v, "--list", a.list);
      opt(v, "--output", a.output_file);
      bool(v, "--refresh", a.refresh);
      return v;
    },
  },

  // ---------- write / action ----------
  {
    name: "datasources_init",
    description: "Scaffold a .env file for a new datasource (writes a template; you fill in credentials).",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string", description: "Connector type (e.g. postgres, snowflake, s3)." },
        name: { type: "string", description: "Datasource name." },
        output_file: { type: "string", description: "Output .env path (default <api_name>.env)." },
      },
      required: ["connector", "name"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["datasources", "init", "--connector", a.connector, "--name", a.name];
      opt(v, "--output", a.output_file);
      return v;
    },
  },
  {
    name: "datasources_create",
    description: "Create a datasource from a (user-prepared) env file; tests the connection first.",
    write: true,
    timeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: { from_file: { type: "string", description: "Path to the env file." } },
      required: ["from_file"],
      additionalProperties: false,
    },
    build: (a) => ["datasources", "create", "--from", a.from_file],
  },
  {
    name: "datasources_edit",
    description: "Update a datasource from an env file.",
    write: true,
    timeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Datasource UUID or api_name" },
        from_file: { type: "string", description: "Path to the env file." },
        skip_test: { type: "boolean", description: "Save without testing the connection." },
      },
      required: ["identifier", "from_file"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["datasources", "edit", a.identifier, "--from", a.from_file];
      bool(v, "--skip-test", a.skip_test);
      return v;
    },
  },
  {
    name: "datasources_test",
    description: "Test the connection for an existing datasource.",
    write: true,
    timeoutMs: 120000,
    inputSchema: idSchema("Datasource UUID or api_name"),
    build: (a) => ["datasources", "test", a.identifier],
  },
  {
    name: "datasources_enable",
    description: "Enable a datasource (set state to active).",
    write: true,
    inputSchema: idSchema("Datasource UUID or api_name"),
    build: (a) => ["datasources", "enable", a.identifier],
  },
  {
    name: "datasources_disable",
    description: "Disable a datasource (set state to inactive).",
    write: true,
    inputSchema: idSchema("Datasource UUID or api_name"),
    build: (a) => ["datasources", "disable", a.identifier],
  },
  {
    name: "datasources_delete",
    description:
      "Delete a datasource. The skill must get explicit user confirmation before this tool call; MCP approval alone is not the workflow confirmation.",
    write: true,
    destructive: true,
    inputSchema: idSchema("Datasource UUID or api_name"),
    build: (a) => ["datasources", "delete", a.identifier],
  },
  {
    name: "datasources_refresh",
    description: "Trigger a schema refresh for a datasource (waits for completion).",
    write: true,
    timeoutMs: 180000,
    inputSchema: idSchema("Datasource UUID or api_name"),
    build: (a) => ["datasources", "refresh", a.identifier],
  },
  {
    name: "pipelines_init",
    description: "Generate a pipeline config file from source + project destination capabilities. ALWAYS use before pipelines_create.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source datasource (UUID or api_name)." },
        project: { type: "string", description: "Project (UUID or api_name; destination resolved from project)." },
        output_file: { type: "string", description: "Output path (default pipeline-config.json).", default: "pipeline-config.json" },
      },
      required: ["source", "project"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "init", "--source", a.source, "--project", a.project];
      opt(v, "--output", a.output_file);
      return v;
    },
  },
  {
    name: "pipelines_prepare_create",
    description:
      "Guided Desktop-safe pipeline creation step 1. Generates host-side config/catalog files internally and returns structured JSON for review; does not create a pipeline.",
    write: true,
    timeoutMs: 240000,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source datasource UUID or api_name." },
        project: { type: "string", description: "Project UUID or api_name; destination is resolved from project." },
        object_preview_limit: {
          type: "number",
          description: "Max object names to return in structured preview (default 1000, max 1000). Full catalog remains in the host-side plan.",
          default: DEFAULT_OBJECT_PREVIEW_LIMIT,
        },
        refresh_catalog: {
          type: "boolean",
          description: "Trigger schema refresh before catalog export. Use only after the user asks for a refresh.",
        },
      },
      required: ["source", "project"],
      additionalProperties: false,
    },
    outputSchema: pipelinePrepareCreateOutputSchema,
    handler: preparePipelineCreate,
  },
  {
    name: "pipelines_create_from_plan",
    description:
      "Guided Desktop-safe pipeline creation step 2. Creates a pipeline from a prepared plan after explicit user confirmation; MCP writes required host files internally and verifies selected objects.",
    write: true,
    timeoutMs: 180000,
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "plan_id returned by pipelines_prepare_create." },
        name: { type: "string", description: "Pipeline name confirmed by the user." },
        description: { type: "string", description: "Optional pipeline description." },
        confirmed: {
          type: "boolean",
          enum: [true],
          description: "Must be true only after the user explicitly confirms the final config and object scope.",
        },
        config_patch: {
          type: "object",
          description: "Shallow config overrides relative to the prepared config.",
          additionalProperties: true,
        },
        object_selection: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["all", "subset"] },
            include: {
              type: "array",
              items: { type: "string" },
              description: "Fully-qualified object names to include when mode is subset.",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      required: ["plan_id", "name", "confirmed", "object_selection"],
      additionalProperties: false,
    },
    outputSchema: pipelineCreateFromPlanOutputSchema,
    handler: createPipelineFromPlan,
  },
  {
    name: "pipelines_create",
    description: "Create a new pipeline. Use pipelines_init first and present config + object scope for confirmation.",
    write: true,
    timeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pipeline name." },
        source: { type: "string", description: "Source datasource (UUID or api_name)." },
        project: { type: "string", description: "Project (UUID or api_name; destination comes from project)." },
        config_file: { type: "string", description: "JSON file with pipeline config overrides." },
        objects_file: { type: "string", description: "JSON file with object selections (default: select all discovered)." },
        description: { type: "string", description: "Pipeline description." },
      },
      required: ["name", "source", "project"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "create", "--name", a.name, "--source", a.source, "--project", a.project];
      opt(v, "--config", a.config_file);
      opt(v, "--objects", a.objects_file);
      opt(v, "--description", a.description);
      return v;
    },
  },
  {
    name: "pipelines_edit",
    description: "Update pipeline configuration.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Pipeline UUID or api_name" },
        config_file: { type: "string", description: "JSON file with config overrides." },
        name: { type: "string", description: "Update pipeline name." },
        description: { type: "string", description: "Update pipeline description." },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "edit", a.identifier];
      opt(v, "--config", a.config_file);
      opt(v, "--name", a.name);
      opt(v, "--description", a.description);
      return v;
    },
  },
  {
    name: "pipelines_schema_select",
    description: "Set a pipeline's object selection from a JSON file (use selected-only pipelines_schema_list output by default; use all:true only when adding currently deselected objects).",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Pipeline UUID or api_name" },
        from_file: { type: "string", description: "JSON file with object selections." },
      },
      required: ["identifier", "from_file"],
      additionalProperties: false,
    },
    build: (a) => ["pipelines", "schema", "select", a.identifier, "--from", a.from_file],
  },
  {
    name: "pipelines_schema_add",
    description: "Add a single object to a pipeline's selection.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Pipeline UUID or api_name" },
        object: { type: "string", description: "Fully-qualified object name to add." },
      },
      required: ["identifier", "object"],
      additionalProperties: false,
    },
    build: (a) => ["pipelines", "schema", "add", a.identifier, a.object],
  },
  {
    name: "pipelines_enable",
    description: "Enable a pipeline (set state to active).",
    write: true,
    inputSchema: idSchema("Pipeline UUID or api_name"),
    build: (a) => ["pipelines", "enable", a.identifier],
  },
  {
    name: "pipelines_disable",
    description: "Disable a pipeline (set state to inactive).",
    write: true,
    inputSchema: idSchema("Pipeline UUID or api_name"),
    build: (a) => ["pipelines", "disable", a.identifier],
  },
  {
    name: "pipelines_delete",
    description:
      "Delete a pipeline (soft delete). The skill must get explicit user confirmation before this tool call; MCP approval alone is not the workflow confirmation.",
    write: true,
    destructive: true,
    inputSchema: idSchema("Pipeline UUID or api_name"),
    build: (a) => ["pipelines", "delete", a.identifier, "--yes"],
  },
  {
    name: "pipelines_sync",
    description: "Trigger a pipeline sync. Returns the job; poll with jobs_status.",
    write: true,
    timeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Pipeline UUID or api_name" },
        full_resync: { type: "boolean", description: "Reset cursors and re-sync all data from scratch." },
        reset_target: { type: "boolean", description: "Drop and recreate destination tables (use with full_resync)." },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["pipelines", "sync", a.identifier];
      bool(v, "--full-resync", a.full_resync);
      bool(v, "--reset-target", a.reset_target);
      return v;
    },
  },
  {
    name: "projects_create",
    description: "Create a new project (links pipelines to a destination warehouse).",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name." },
        destination: { type: "string", description: "Destination datasource UUID or api_name." },
        type: { type: "string", enum: ["pipeline", "ingestion", "transformation", "activation"], default: "pipeline" },
      },
      required: ["name", "destination"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["projects", "create", "--name", a.name, "--destination", a.destination];
      opt(v, "--type", a.type);
      return v;
    },
  },
  {
    name: "schedules_create",
    description: "Create a schedule (cron is 5-field, UTC). Target one of pipeline/task/orchestration.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name." },
        cron: { type: "string", description: "Cron expression (5-field, UTC)." },
        pipeline: { type: "string", description: "Target pipeline (UUID or api_name)." },
        task: { type: "string", description: "Target task (UUID or api_name)." },
        orchestration: { type: "string", description: "Target orchestration (UUID or api_name)." },
        timezone: { type: "string", description: "Display timezone (e.g. America/New_York).", default: "UTC" },
        description: { type: "string" },
      },
      required: ["name", "cron"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["schedules", "create", "--name", a.name, "--cron", a.cron];
      opt(v, "--pipeline", a.pipeline);
      opt(v, "--task", a.task);
      opt(v, "--orchestration", a.orchestration);
      opt(v, "--timezone", a.timezone);
      opt(v, "--description", a.description);
      return v;
    },
  },
  {
    name: "schedules_edit",
    description: "Update a schedule.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Schedule UUID or name" },
        name: { type: "string" },
        cron: { type: "string" },
        timezone: { type: "string" },
        description: { type: "string" },
        pipeline: { type: "string" },
        task: { type: "string" },
        orchestration: { type: "string" },
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => {
      const v = ["schedules", "edit", a.identifier];
      opt(v, "--name", a.name);
      opt(v, "--cron", a.cron);
      opt(v, "--timezone", a.timezone);
      opt(v, "--description", a.description);
      opt(v, "--pipeline", a.pipeline);
      opt(v, "--task", a.task);
      opt(v, "--orchestration", a.orchestration);
      return v;
    },
  },
  {
    name: "schedules_delete",
    description:
      "Delete a schedule. The skill must get explicit user confirmation before this tool call; MCP approval alone is not the workflow confirmation.",
    write: true,
    destructive: true,
    inputSchema: idSchema("Schedule UUID or name"),
    build: (a) => ["schedules", "delete", a.identifier],
  },
  {
    name: "schedules_enable",
    description: "Enable a schedule (set state to active).",
    write: true,
    inputSchema: idSchema("Schedule UUID or name"),
    build: (a) => ["schedules", "enable", a.identifier],
  },
  {
    name: "schedules_disable",
    description: "Disable a schedule (set state to inactive).",
    write: true,
    inputSchema: idSchema("Schedule UUID or name"),
    build: (a) => ["schedules", "disable", a.identifier],
  },
  {
    name: "schedules_run",
    description: "Trigger immediate execution of a schedule.",
    write: true,
    timeoutMs: 120000,
    inputSchema: idSchema("Schedule UUID or name"),
    build: (a) => ["schedules", "run", a.identifier],
  },
  {
    name: "workspaces_select",
    description: "Set the active workspace (by UUID, api_name, or name). Changes host CLI state for subsequent calls.",
    write: true,
    inputSchema: {
      type: "object",
      properties: { identifier: { type: "string", description: "Workspace UUID, api_name, or name." } },
      required: ["identifier"],
      additionalProperties: false,
    },
    build: (a) => ["workspaces", "select", a.identifier],
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getToolSpec(name: string) {
  return BY_NAME.get(name) || null;
}

export function buildSupaflowArgv(name: string, args: ToolArgs = {}) {
  const spec = BY_NAME.get(name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  if (!spec.build) throw new Error(`Tool ${name} does not map directly to one CLI argv.`);
  const argv = [...spec.build(args || {})];
  if (spec.json !== false) argv.push("--json");
  return argv;
}

async function execSupaflowArgv(argv: string[], timeoutMs = 60000): Promise<string> {
  const { stdout } = await execFileP(process.execPath, [CLI_ENTRY, ...CHILD_OVERRIDE_ARGV, ...argv], {
    env: { ...process.env, ...CHILD_OVERRIDE_ENV },
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}

/**
 * Raw-text variant for json:false tools (e.g. agent_logs): container/CLI
 * output may land on either stream (docker logs mirrors the container's
 * own stdout/stderr split), so returning stdout alone silently drops
 * anything the process wrote to stderr.
 */
async function execSupaflowArgvRaw(argv: string[], timeoutMs = 60000): Promise<string> {
  const { stdout, stderr } = await execFileP(process.execPath, [CLI_ENTRY, ...CHILD_OVERRIDE_ARGV, ...argv], {
    env: { ...process.env, ...CHILD_OVERRIDE_ENV },
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (!stderr || !stderr.trim()) return stdout;
  if (!stdout || !stdout.trim()) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

async function runSupaflow(spec: ToolSpec, args: ToolArgs) {
  const argv = buildSupaflowArgv(spec.name, args);
  if (spec.json === false) return execSupaflowArgvRaw(argv, spec.timeoutMs || 60000);
  return execSupaflowArgv(argv, spec.timeoutMs || 60000);
}

async function preparePipelineCreate(args: ToolArgs) {
  ensurePlanRoot();
  const planId = crypto.randomUUID();
  const paths = planPaths(planId);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const workspace = await getCurrentWorkspace();
  const sourceIdentity = await resolveDatasourceIdentity(args.source);
  const projectIdentity = await resolveProjectIdentity(args.project);

  const initArgv = [
    "pipelines",
    "init",
    "--source",
    sourceIdentity.id,
    "--project",
    projectIdentity.id,
    "--output",
    paths.configFile,
    "--json",
  ];
  const init = parseCliJson(await execSupaflowArgv(initArgv, 120000), "pipelines init");
  const config = init.config || parseJson(fs.readFileSync(paths.configFile, "utf8"), "pipeline config");

  const catalogArgv = ["datasources", "catalog", sourceIdentity.id, "--output", paths.objectsFile];
  if (args.refresh_catalog === true) catalogArgv.push("--refresh");
  catalogArgv.push("--json");
  const catalog = parseCliJson(await execSupaflowArgv(catalogArgv, 240000), "datasources catalog");
  const objects = fs.existsSync(paths.objectsFile)
    ? parseJson(fs.readFileSync(paths.objectsFile, "utf8"), "pipeline objects")
    : [];
  if (!Array.isArray(objects)) {
    throw new Error("datasources catalog output file did not contain an object array.");
  }

  const names = objectNames(objects);
  const previewLimit = normalizeObjectPreviewLimit(args.object_preview_limit);
  const warnings: string[] = [];
  if (names.length === 0) {
    warnings.push("No discovered source objects were found. Refresh the datasource catalog before creating a pipeline.");
  }

  const plan = {
    schema_version: 2,
    created_at: new Date().toISOString(),
    requested: {
      source: args.source,
      project: args.project,
    },
    workspace,
    source: sourceIdentity.api_name || sourceIdentity.id,
    project: projectIdentity.api_name || projectIdentity.id,
    resolved: {
      source: sourceIdentity,
      project: projectIdentity,
      destination: {
        id: projectIdentity.warehouse_datasource_id,
        name: projectIdentity.warehouse_name,
        connector_name: projectIdentity.warehouse_connector_name,
      },
    },
    init,
    catalog,
    config,
    files: {
      config: paths.configFile,
      reference: paths.referenceFile,
      objects: paths.objectsFile,
      selected_objects: paths.selectedObjectsFile,
    },
  };
  fs.writeFileSync(paths.planFile, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });

  const structuredContent = {
    plan_id: planId,
    plan_dir: paths.dir,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    source: sourceIdentity.api_name || sourceIdentity.id,
    source_id: sourceIdentity.id,
    source_api_name: sourceIdentity.api_name,
    project: projectIdentity.api_name || projectIdentity.id,
    project_id: projectIdentity.id,
    project_api_name: projectIdentity.api_name,
    destination_id: projectIdentity.warehouse_datasource_id,
    source_name: init.source || "",
    source_type: init.source_type || "",
    destination_name: init.destination || "",
    project_name: init.project || "",
    config,
    config_summary: configSummary(config),
    object_count: names.length,
    objects_preview: names.slice(0, previewLimit),
    objects_truncated: names.length > previewLimit,
    host_files: {
      config: paths.configFile,
      reference: paths.referenceFile,
      objects: paths.objectsFile,
      plan: paths.planFile,
    },
    warnings,
  };

  return toolResult(
    `Prepared pipeline create plan ${planId}. Review config_summary and object scope before calling pipelines_create_from_plan.`,
    structuredContent,
  );
}

async function createPipelineFromPlan(args: ToolArgs) {
  if (args.confirmed !== true) {
    throw new Error("confirmed must be true after explicit user confirmation.");
  }

  const { paths, plan } = loadPlan(args.plan_id);
  const currentWorkspace = await getCurrentWorkspace();
  validatePlanWorkspace(plan, currentWorkspace);
  const currentSource = await resolveDatasourceIdentity(plan.resolved.source.id);
  const currentProject = await resolveProjectIdentity(plan.resolved.project.id);
  validatePlanBinding(plan, {
    workspace: currentWorkspace,
    source: currentSource,
    project: currentProject,
  });
  const baseConfig = plan.config || parseJson(fs.readFileSync(paths.configFile, "utf8"), "pipeline config");
  const finalConfig = applyConfigPatch(baseConfig, args.config_patch || {});
  fs.writeFileSync(paths.configFile, JSON.stringify(finalConfig, null, 2) + "\n", "utf8");

  const objects = parseJson(fs.readFileSync(paths.objectsFile, "utf8"), "pipeline objects");
  if (!Array.isArray(objects)) {
    throw new Error("Prepared object file did not contain an object array.");
  }

  const selection = applyObjectSelection(objects, args.object_selection);
  fs.writeFileSync(paths.selectedObjectsFile, JSON.stringify(selection.objects, null, 2) + "\n", "utf8");
  const createArgv = buildPipelineCreateFromPlanArgv({
    name: args.name,
    description: args.description,
    source: plan.resolved.source.id,
    project: plan.resolved.project.id,
    configFile: paths.configFile,
    objectsFile: paths.selectedObjectsFile,
  });

  const created = parseCliJson(await execSupaflowArgv(createArgv, 180000), "pipelines create");

  let verification: {
    status: string;
    selected_count: number | null;
    excluded_count: number | null;
    selected_preview: string[];
    error: string | null;
  } = {
    status: "not_verified",
    selected_count: null,
    excluded_count: null,
    selected_preview: [],
    error: null,
  };
  try {
    const verifyIdentifier = created.api_name || created.id;
    const verifyOut = await execSupaflowArgv(["pipelines", "schema", "list", verifyIdentifier, "--json"], 120000);
    const schema = parseCliJson(verifyOut, "pipelines schema list");
    if (Array.isArray(schema)) {
      const selected = schema.filter((o) => o.selected !== false).map((o) => o.fully_qualified_name);
      verification = {
        status: "verified",
        selected_count: selected.length,
        excluded_count: null,
        selected_preview: selected.slice(0, DEFAULT_OBJECT_PREVIEW_LIMIT),
        error: null,
      };
    } else {
      verification.error = "Schema verification did not return an array.";
    }
  } catch (err) {
    verification.error = err instanceof Error ? err.message : String(err);
  }

  const structuredContent = {
    plan_id: args.plan_id,
    pipeline: created,
    config_summary: configSummary(finalConfig),
    object_selection: {
      mode: selection.mode,
      selected_count: selection.mode === "all" ? objects.length : selection.selected.length,
      total_count: objects.length,
      selected_preview: selection.selected.slice(0, DEFAULT_OBJECT_PREVIEW_LIMIT),
      objects_file: paths.selectedObjectsFile,
    },
    verification,
  };

  return toolResult(`Created pipeline ${created.api_name || created.name || created.id}. Verification status: ${verification.status}.`, structuredContent);
}

export function listToolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: "object", properties: {}, additionalProperties: false },
    outputSchema: t.outputSchema,
    annotations: {
      readOnlyHint: !!t.readOnly,
      destructiveHint: !!t.destructive,
      idempotentHint: !!t.readOnly,
      openWorldHint: true,
    },
  }));
}

export function createServer() {
  const server = new Server(
    { name: "supaflow", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    const spec = BY_NAME.get(name);
    if (!spec) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    try {
      if (spec.handler) {
        return await spec.handler(args);
      }
      const out = await runSupaflow(spec, args);
      return { content: [{ type: "text", text: out || "(no output)" }] };
    } catch (err) {
      // CLI errors emit {"error":{code,message}} on stdout with a non-zero exit.
      const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string }; message?: string };
      const body =
        e?.stdout?.toString?.().trim() ||
        e?.stderr?.toString?.().trim() ||
        e?.message ||
        String(err);
      return { isError: true, content: [{ type: "text", text: body }] };
    }
  });

  return server;
}

export async function main(overrides: { env?: Record<string, string>; argv?: string[] } = {}) {
  CHILD_OVERRIDE_ENV = overrides.env ?? {};
  CHILD_OVERRIDE_ARGV = overrides.argv ?? [];
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
