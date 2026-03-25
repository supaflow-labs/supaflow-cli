# @supaflow/cli

CLI for the [Supaflow](https://www.supa-flow.io) data integration platform. Manage datasources, pipelines, jobs, schedules, and more from the command line or through AI agents.

## Command Map

| Group | Commands | What it does |
|-------|----------|-------------|
| `auth` | login, logout, status | Authenticate with API key |
| `workspaces` | list, select | Choose active workspace |
| `connectors` | list | Browse available connector types |
| `datasources` | list, get, init, create, catalog, test, edit, delete, disable, enable, refresh | Full datasource lifecycle |
| `projects` | list, create | Manage pipeline projects |
| `pipelines` | list, get, create, edit, delete, disable, enable, sync, schema (list, select) | Full pipeline lifecycle |
| `schedules` | list, create, edit, delete, enable, disable, run, history | Cron-based scheduling |
| `jobs` | list, get, logs | Monitor async job execution |
| `encrypt` | (value or --file) | Encrypt sensitive values |

## Prerequisites

**A Supaflow account** is required. Sign up at [app.supa-flow.io/sign-up](https://app.supa-flow.io/sign-up) if you don't have one.

**Node.js 18 or later** is required. Check your version:

```bash
node --version
# v18.x.x or higher
```

If you don't have Node.js, install it from [nodejs.org](https://nodejs.org/) or via a package manager:

```bash
# macOS (Homebrew)
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Windows (winget)
winget install OpenJS.NodeJS.LTS
```

## Install

```bash
npm install -g @supaflow/cli
```

Verify the installation:

```bash
supaflow --version
```

## Authentication

### Step 1: Create an API Key

1. Log in to the Supaflow web app at [app.supa-flow.io](https://app.supa-flow.io)
2. Navigate to **Settings** (gear icon in the sidebar)
3. Click **API Keys** in the settings menu
4. Click **Create key**
5. Give it a name (e.g., "CLI Access") and click **Create**
6. Copy the generated key (starts with `ak_`) -- it is only shown once

API keys are scoped to the organization that is active when you create them. To access a different organization's workspaces, create a separate key while that organization is active.

### Step 2: Authenticate the CLI

```bash
supaflow auth login
# Paste your API key when prompted

supaflow auth status
# Shows: Authenticated (source: config)
```

The API key is stored in `~/.supaflow/config.json`. You can also set `SUPAFLOW_API_KEY` as an environment variable instead of running `login`.

After authenticating, select a workspace:

```bash
supaflow workspaces list
supaflow workspaces select
```

All subsequent commands operate within the selected workspace.

## Global Flags

Every command supports these flags:

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output (for agents and scripts) |
| `--workspace <id>` | Override the active workspace for this command |
| `--api-key <key>` | Override the stored API key for this command |
| `--supabase-url <url>` | Override Supabase project URL (dev/testing; requires `SUPAFLOW_SUPABASE_ANON_KEY` env var) |
| `--verbose` | Enable debug output |
| `--no-color` | Suppress ANSI colors (auto-detected when stdout is not a TTY) |

## JSON Output Contract

When `--json` is used:

- **List commands** return `{ "data": [...], "total": N, "limit": N, "offset": N }`
- **Get/create/edit commands** return the raw object
- **Errors** return `{ "error": { "code": "ERROR_CODE", "message": "..." } }` with non-zero exit code

Error codes: `NOT_AUTHENTICATED` (exit 2), `NO_WORKSPACE` (exit 2), `NOT_FOUND`, `INVALID_INPUT`, `FORBIDDEN`, `API_ERROR`, `NETWORK_ERROR`, `RATE_LIMITED` (all exit 1).

**Example: list with --json**
```json
{
  "data": [
    { "id": "8a3f1b2c-...", "name": "My Pipeline", "state": "active" }
  ],
  "total": 1,
  "limit": 25,
  "offset": 0
}
```

**Example: error with --json**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Pipeline \"nonexistent\" not found."
  }
}
```

---

## Connectors

List available connector types before creating datasources:

```bash
supaflow connectors list
```

Output shows connector type (used in `--connector` flag), display name, and version:

```
TYPE         NAME           VERSION
POSTGRES     PostgreSQL     1.0.46
SNOWFLAKE    Snowflake      1.0.46
S3           S3             1.0.46
HUBSPOT      HubSpot        1.0.46
...
```

---

## Datasources

Datasources are connections to external systems (databases, APIs, cloud storage). Each datasource stores encrypted connection credentials.

### Creating a Datasource

Datasource creation is a two-step process: scaffold an env file, then create from it.

**Step 1: Scaffold the env file**

```bash
supaflow datasources init --connector postgres --name "My Postgres"
# Creates: my_postgres.env
```

The generated file contains all connector properties with annotations:

```env
# Supaflow Datasource: My Postgres
# Connector: POSTGRES
# API Name: my_postgres
# Description: PostgreSQL datasource

# === Authentication ===

# Database Host (required)
host=
# Database Port (required, default: 5432)
port=5432
# Database Name (required)
database=
# Username (required)
username=
# Password (required, sensitive)
# Use ${VAR} to avoid storing secrets in this file
password=
```

**Step 2: Fill in values and create**

Use `${VAR}` references for secrets (resolved from your shell environment at create time):

```env
host=db.example.com
port=5432
database=mydb
username=${DB_USER}
password=${DB_PASSWORD}
```

Then create the datasource. This tests the connection first and only saves on success:

```bash
supaflow datasources create --from my_postgres.env
# Testing connection... (this may take up to a minute)
# Connection successful.
# Datasource "My Postgres" created. ID: 8a3f1b2c-...
```

If you put a plaintext secret in the file, the CLI automatically encrypts it on disk before submission. The file is rewritten with `enc:` prefixed encrypted values so secrets never remain in cleartext.

### Browsing Discovered Objects

After a datasource is created, the platform discovers its schema (tables, objects). View and export them:

```bash
# List discovered objects
supaflow datasources catalog my_postgres

# Export as JSON for pipeline creation
supaflow datasources catalog my_postgres --output objects.json

# Trigger a fresh discovery first
supaflow datasources catalog my_postgres --refresh --output objects.json
```

The exported `objects.json` can be edited (toggle `"selected": false` for objects to exclude) and passed to `pipelines create --objects`.

### Other Datasource Commands

```bash
supaflow datasources list                          # List all datasources
supaflow datasources get <identifier>              # View details (by UUID or api_name)
supaflow datasources test <identifier>             # Re-test connection
supaflow datasources edit <identifier> --from <file>  # Update configs from env file (tests first)
supaflow datasources edit <identifier> --from <file> --skip-test  # Update without testing
supaflow datasources disable <identifier>          # Set state to inactive
supaflow datasources enable <identifier>           # Set state to active
supaflow datasources refresh <identifier>          # Trigger schema refresh
supaflow datasources delete <identifier>           # Soft delete
```

### Encrypting Sensitive Values

Encrypt a single value or all sensitive fields in an env file:

```bash
# Encrypt one value
supaflow encrypt "my-secret"
# Output: enc:eyJ2IjoxLC...

# Encrypt all sensitive fields in an env file
supaflow encrypt --file my_postgres.env
# Encrypted 1 sensitive field in my_postgres.env (password)
```

The `enc:` prefix is recognized by `datasources create` and `datasources edit` -- encrypted values are passed through to the server without re-encryption.

---

## Projects

Pipelines belong to projects. A project defines the destination warehouse (Snowflake, S3, etc.) that all its pipelines write to.

```bash
# List projects
supaflow projects list

# Create a project (destination is the warehouse datasource)
supaflow projects create --name "My Project" --destination snowflake_prod
```

The `--destination` flag accepts a datasource UUID or api_name. The project type defaults to `pipeline`.

---

## Pipelines

Pipelines move data from a source datasource to a destination (defined by the project). Each pipeline selects which objects (tables) to sync and how.

### Creating a Pipeline

```bash
# Minimal: create with all discovered objects selected
supaflow pipelines create \
  --name "Postgres to Snowflake" \
  --source my_postgres \
  --project my_project

# With specific object selection
supaflow pipelines create \
  --name "Postgres to Snowflake" \
  --source my_postgres \
  --project my_project \
  --objects objects.json

# With custom pipeline config
supaflow pipelines create \
  --name "Postgres to Snowflake" \
  --source my_postgres \
  --project my_project \
  --objects objects.json \
  --config pipeline-config.json
```

The `--source` and `--project` flags accept UUID or api_name. The destination is resolved from the project's warehouse datasource.

**What happens during create:**
1. Resolves source, destination, and project
2. Fetches the active pipeline version
3. Merges config defaults with any overrides from `--config`
4. Inserts the pipeline in draft state
5. Triggers schema discovery on the source
6. Saves object selections (all objects if `--objects` not provided)
7. Activates the pipeline

### Object Selection File

Generate with `datasources catalog --output`:

```json
[
  { "fully_qualified_name": "public.accounts", "selected": true, "fields": null },
  { "fully_qualified_name": "public.contacts", "selected": true, "fields": null },
  { "fully_qualified_name": "public.internal_logs", "selected": false, "fields": null }
]
```

- `selected: true` includes the object in the pipeline
- `selected: false` excludes it
- `fields: null` syncs all fields (recommended). To select specific fields, provide an array of `{ "name": "field_name", "selected": true/false }`.

### Pipeline Config File

Override pipeline defaults with a JSON file:

```json
{
  "ingestion_mode": "HISTORICAL",
  "load_mode": "TRUNCATE_AND_LOAD",
  "schema_evolution_mode": "BLOCK_ALL",
  "perform_hard_deletes": true
}
```

Only include fields you want to override. Unspecified fields use defaults:

| Setting | Default | Options |
|---------|---------|---------|
| `pipeline_type` | `REPLICATION` | `REPLICATION`, `ACTIVATION` |
| `ingestion_mode` | `HISTORICAL_PLUS_INCREMENTAL` | `HISTORICAL`, `INCREMENTAL`, `HISTORICAL_PLUS_INCREMENTAL` |
| `load_mode` | `MERGE` | `MERGE`, `APPEND`, `TRUNCATE_AND_LOAD`, `OVERWRITE` |
| `error_handling` | `MODERATE` | `STRICT`, `MODERATE` |
| `schema_evolution_mode` | `ALLOW_ALL` | `ALLOW_ALL`, `BLOCK_ALL`, `COLUMN_LEVEL_ONLY` |
| `destination_table_handling` | `MERGE` | `MERGE`, `FAIL`, `DROP` |
| `perform_hard_deletes` | `false` | `true`, `false` |
| `full_sync_frequency` | `WEEKLY` | `NEVER`, `DAILY`, `WEEKLY`, `MONTHLY`, `EVERY_RUN` |
| `full_resync_frequency` | `NEVER` | `NEVER`, `DAILY`, `WEEKLY`, `MONTHLY` |

Note: `ACTIVATION` pipelines always use `BLOCK_ALL` schema evolution (enforced by the CLI).

### Running a Pipeline

```bash
# Incremental sync (default)
supaflow pipelines sync <identifier>

# Full resync (reset cursors, re-sync all data)
supaflow pipelines sync <identifier> --full-resync

# Full resync + drop and recreate destination tables
supaflow pipelines sync <identifier> --full-resync --reset-target
```

The sync command returns a job ID. Monitor it with:

```bash
supaflow jobs get <job-id>
```

### Managing Schemas

View and update which objects a pipeline syncs:

```bash
# List selected objects
supaflow pipelines schema list <identifier>

# List all objects (including deselected)
supaflow pipelines schema list <identifier> --all

# Update selections from a JSON file
supaflow pipelines schema select <identifier> --from objects.json
```

### Other Pipeline Commands

```bash
supaflow pipelines list                            # List all pipelines
supaflow pipelines list --state active             # Filter by state
supaflow pipelines get <identifier>                # View details
supaflow pipelines edit <identifier> --config <file>  # Update config
supaflow pipelines edit <identifier> --name "New Name"  # Update name
supaflow pipelines disable <identifier>            # Set state to inactive
supaflow pipelines enable <identifier>             # Set state to active
supaflow pipelines delete <identifier>             # Soft delete
```

---

## Schedules

Schedules trigger pipelines (or tasks/orchestrations) on a cron schedule.

### Creating a Schedule

```bash
supaflow schedules create \
  --name "Hourly Sales Sync" \
  --pipeline sales_to_snowflake \
  --cron "0 * * * *" \
  --timezone "America/New_York" \
  --description "Sync sales data every hour"
```

The `--cron` flag takes a standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week). All schedules execute in UTC. The `--timezone` is for display purposes.

Common cron patterns:

| Pattern | Cron | Description |
|---------|------|-------------|
| Every hour | `0 * * * *` | At minute 0 of every hour |
| Every 6 hours | `0 */6 * * *` | At minute 0 every 6 hours |
| Daily at midnight | `0 0 * * *` | At 00:00 UTC |
| Daily at noon | `0 12 * * *` | At 12:00 UTC |
| Weekdays at 9am | `0 9 * * 1-5` | Mon-Fri at 09:00 UTC |
| Weekly on Sunday | `0 0 * * 0` | Sunday at 00:00 UTC |

### Other Schedule Commands

```bash
supaflow schedules list                            # List all schedules
supaflow schedules list --state active             # Filter by state
supaflow schedules edit <identifier> --cron "0 2 * * *"  # Update cron
supaflow schedules edit <identifier> --name "New Name" --description "Updated"  # Update metadata
supaflow schedules edit <identifier> --timezone "UTC"  # Change display timezone
supaflow schedules edit <identifier> --pipeline other_pipeline  # Change target
supaflow schedules disable <identifier>            # Pause the schedule
supaflow schedules enable <identifier>             # Resume the schedule
supaflow schedules run <identifier>                # Trigger immediate execution
supaflow schedules history <identifier>            # View execution history
supaflow schedules history <identifier> --limit 20 # More history entries
supaflow schedules delete <identifier>             # Soft delete
```

---

## Jobs

Jobs are async execution records for pipeline syncs, datasource tests, and schema refreshes. Every `pipelines sync`, `datasources create`, `datasources test`, and `datasources refresh` command creates a job.

```bash
# List recent jobs
supaflow jobs list

# Filter by status
supaflow jobs list --filter status=running
supaflow jobs list --filter status=failed

# Filter by pipeline
supaflow jobs list --filter pipeline=<pipeline-uuid>

# View job details with per-object metrics
supaflow jobs get <job-id>
```

Job details show the three-stage pipeline execution:

```
Job:      13cfe303-c67e-...
Type:     pipeline_run
Status:   completed
Duration: 58s

Object Details:
OBJECT                    INGESTION   STAGING     LOADING     ROWS
public.accounts           completed   completed   completed   14
public.contacts           completed   completed   completed   16
public.tasks              completed   completed   completed   3
```

Each object goes through ingestion (read from source), staging (write to temp), and loading (merge into destination).

```bash
# View job response/logs
supaflow jobs logs <job-id>
```

---

## End-to-End Example

Set up a complete data pipeline from scratch:

```bash
# 1. Authenticate and select workspace
supaflow auth login
supaflow workspaces select

# 2. See available connectors
supaflow connectors list

# 3. Create source datasource
supaflow datasources init --connector postgres --name "Production DB"
# Edit production_db.env with connection details
supaflow datasources create --from production_db.env

# 4. Create destination datasource
supaflow datasources init --connector snowflake --name "Data Warehouse"
# Edit data_warehouse.env with connection details
supaflow datasources create --from data_warehouse.env

# 5. Create a project (ties pipelines to a destination)
supaflow projects create --name "Analytics" --destination data_warehouse

# 6. Browse source objects and select what to sync
supaflow datasources catalog production_db --output objects.json
# Edit objects.json to select/deselect tables

# 7. Create the pipeline
supaflow pipelines create \
  --name "Production to Warehouse" \
  --source production_db \
  --project analytics \
  --objects objects.json

# 8. Run the first sync
supaflow pipelines sync production_to_warehouse

# 9. Monitor the job
supaflow jobs get <job-id>

# 10. Schedule recurring syncs
supaflow schedules create \
  --name "Hourly Sync" \
  --pipeline production_to_warehouse \
  --cron "0 * * * *"
```

---

## Identifiers

Most commands accept either a **UUID** or an **api_name** as the identifier:

```bash
# These are equivalent
supaflow pipelines get 8a3f1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c
supaflow pipelines get production_to_warehouse
```

Schedules resolve by **name** (not api_name), since schedule names are unique per workspace. All other resources resolve by `api_name`.

## Troubleshooting

**"Not authenticated"** -- Run `supaflow auth login` or set `SUPAFLOW_API_KEY`. If using an API key, verify it hasn't been revoked in the web app.

**"No workspace selected"** -- Run `supaflow workspaces select`. For scripts, set `SUPAFLOW_WORKSPACE_ID`.

**"Invalid, revoked, or expired API key"** -- The API key was revoked or the Clerk organization changed. Create a new key in **Settings > API Keys**.

**"Bootstrap endpoint unavailable"** -- The CLI can't reach `app.supa-flow.io` to exchange your API key for a session token. Check your network. For local development, set `SUPAFLOW_SUPABASE_URL` and `SUPAFLOW_SUPABASE_ANON_KEY` environment variables to bypass the bootstrap endpoint.

**"configs cannot be NULL or empty"** -- The datasource test command reads stored configs. If the datasource was created with empty configs, edit it first with valid connection details.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPAFLOW_API_KEY` | API key (alternative to `supaflow auth login`) |
| `SUPAFLOW_WORKSPACE_ID` | Workspace ID (alternative to `supaflow workspaces select`) |
| `SUPAFLOW_APP_URL` | Override app URL (default: `https://app.supa-flow.io`) |
| `SUPAFLOW_SUPABASE_URL` | Override Supabase URL (dev/testing) |
| `SUPAFLOW_SUPABASE_ANON_KEY` | Override Supabase anon key (dev/testing) |

## License

MIT
