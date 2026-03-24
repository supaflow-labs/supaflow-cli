# @supaflow/cli

CLI for the [Supaflow](https://www.supa-flow.io) data integration platform. Manage pipelines, datasources, and jobs from the command line.

## Install

```bash
npm install -g @supaflow/cli
```

Requires Node.js 18+.

## Quick Start

```bash
# Authenticate
supaflow auth login

# Select a workspace
supaflow workspaces list
supaflow workspaces select

# List pipelines
supaflow pipelines list

# Trigger a sync
supaflow sync run <pipeline-name>

# Check job status
supaflow jobs list --filter status=running
```

## Commands

| Command | Description |
|---------|-------------|
| `supaflow auth login` | Authenticate with API key |
| `supaflow auth logout` | Clear credentials |
| `supaflow auth status` | Show auth status |
| `supaflow workspaces list` | List workspaces |
| `supaflow workspaces select` | Set active workspace |
| `supaflow datasources list` | List datasources |
| `supaflow datasources get <id>` | Get datasource details |
| `supaflow pipelines list` | List pipelines |
| `supaflow pipelines get <id>` | Get pipeline details |
| `supaflow pipelines pause <id>` | Pause a pipeline |
| `supaflow pipelines resume <id>` | Resume a pipeline |
| `supaflow pipelines delete <id>` | Delete a pipeline |
| `supaflow jobs list` | List jobs |
| `supaflow jobs get <id>` | Get job details |
| `supaflow jobs logs <id>` | Get job logs |
| `supaflow sync run <pipeline>` | Trigger a sync |

## JSON Output

Add `--json` to any command for machine-readable JSON output:

```bash
supaflow pipelines list --json
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | JSON output |
| `--workspace <id>` | Override workspace |
| `--api-key <key>` | Override API key |
| `--verbose` | Debug output |
| `--no-color` | No ANSI colors |

## License

MIT
