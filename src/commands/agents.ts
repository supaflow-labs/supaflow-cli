import { Command } from 'commander';
import { spawn } from 'node:child_process';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '../lib/middleware.js';
import { formatGetJson, formatTable, printOutput, relativeTime } from '../lib/output.js';
import { CliError, ErrorCode, handleError } from '../lib/errors.js';
import {
  buildPreflight,
  defaultRunner,
  getContainerStatus,
  volumeExists,
  type ExecRunner,
  type PreflightCheck,
} from '../lib/docker.js';

const DEFAULT_CONTAINER = 'supaflow-agent';
const DEFAULT_IMAGE = 'supaflow/agent:latest';
const REGISTRATION_POLL_MS = 5000;
/** Container-side suffix appended by the agent image's entrypoint to the container id. */
const IDENTIFIER_SUFFIX = '_local_docker_agent';

const NEEDS_APPROVAL = new Set(['registered', 'pending_approval']);

interface AgentRow {
  agent_id: string;
  agent_identifier: string;
  lifecycle_status: string;
  connectivity_status: string | null;
  last_heartbeat_at: string | null;
}

function volumeNameFor(container: string): string {
  return `${container}-data`;
}

function printChecks(checks: PreflightCheck[]): void {
  const symbol = { ok: 'ok', warn: 'WARN', fail: 'FAIL' } as const;
  const rows = checks.map((c) => [symbol[c.status], c.name, c.detail]);
  printOutput(formatTable(['', 'CHECK', 'DETAIL'], rows));
}

async function fetchAgentRow(supabase: SupabaseClient, identifier: string): Promise<AgentRow | null> {
  const { data, error } = await supabase
    .from('agent_monitoring')
    .select('agent_id, agent_identifier, lifecycle_status, connectivity_status, last_heartbeat_at')
    .eq('agent_identifier', identifier)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRow | null) ?? null;
}

async function pollForAgentRow(
  supabase: SupabaseClient,
  identifier: string,
  timeoutMs: number,
  onTick?: () => void,
): Promise<AgentRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await fetchAgentRow(supabase, identifier);
    if (row) return row;
    if (Date.now() > deadline) {
      throw new CliError(
        `Agent did not register within ${Math.round(timeoutMs / 1000)}s. ` +
          `Check the container logs: docker logs ${DEFAULT_CONTAINER}`,
        ErrorCode.API_ERROR,
      );
    }
    onTick?.();
    await new Promise((r) => setTimeout(r, REGISTRATION_POLL_MS));
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} (y/N): `);
  rl.close();
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

/** docker run arguments mirroring the deployment wizard's generated command. */
export function buildRunArgs(opts: {
  container: string;
  volume: string;
  image: string;
  token?: string;
  apiUrl?: string;
}): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    opts.container,
    '--restart',
    'unless-stopped',
    '-v',
    `${opts.volume}:/data`,
  ];
  if (opts.token) args.push('-e', `AGENT_REGISTRATION_TOKEN=${opts.token}`);
  if (opts.apiUrl) args.push('-e', `SUPAFLOW_API_URL=${opts.apiUrl}`);
  args.push(opts.image);
  return args;
}

export function registerAgentsCommands(program: Command, run: ExecRunner = defaultRunner): void {
  const agent = program.command('agent').description('Run and manage a local Docker agent');

  agent
    .command('start')
    .description('Start a local Docker agent (enrolls a new one on first run)')
    .option('--name <container>', 'Container name (volume becomes <name>-data)', DEFAULT_CONTAINER)
    .option('--image <image>', 'Agent image', DEFAULT_IMAGE)
    .option('--api-url <url>', 'Supaflow app URL override for the agent (local dev)')
    .option('--approve', 'Approve the agent automatically after it registers')
    .option('--no-approve', 'Do not approve; leave the agent pending on the agents page')
    .option('--timeout <seconds>', 'How long to wait for registration', '180')
    .action(
      withAuth(async (ctx, opts: { name: string; image: string; apiUrl?: string; approve?: boolean; timeout: string }) => {
        const { supabase, outputOptions } = ctx;
        const container = opts.name;
        const volume = volumeNameFor(container);
        const timeoutMs = Math.max(30, parseInt(opts.timeout, 10) || 180) * 1000;

        // Doctor-style dependency preflight: docker binary, daemon, disk
        // headroom, image availability, container/volume state.
        const preflight = await buildPreflight(run, { container, volume, image: opts.image });
        if (!outputOptions.json) printChecks(preflight.checks);
        if (!preflight.ok) {
          throw new CliError('Preflight failed. Fix the checks marked FAIL and retry.', ErrorCode.INVALID_INPUT);
        }

        // Already running: nothing to do.
        if (preflight.state.containerStatus === 'running') {
          const info = { container, status: 'already_running' };
          if (outputOptions.json) printOutput(formatGetJson(info));
          else console.log(`Agent container "${container}" is already running. Use "supaflow agent status" to inspect it.`);
          return;
        }

        // Stopped container: resume it. The named volume holds the agent
        // identity, so this re-attests without a new token or re-approval.
        if (preflight.state.containerStatus === 'exited') {
          await run('docker', ['start', container]);
          if (outputOptions.json) printOutput(formatGetJson({ container, status: 'resumed' }));
          else console.log(`Restarted "${container}". The agent resumes its existing identity and reconnects in seconds.`);
          return;
        }

        // No container, but the identity volume exists: recreate the
        // container WITHOUT a token. The persisted identity takes
        // precedence, so requesting a fresh enrollment token here would
        // waste it -- the agent re-attests from the volume.
        if (preflight.state.volumeExists) {
          if (!outputOptions.json) {
            console.log('Existing agent identity volume found; resuming it (no new enrollment token needed).');
            console.log('To enroll a brand-new agent instead, run "supaflow agent remove --purge" first.');
          }
          await run('docker', buildRunArgs({ container, volume, image: opts.image, apiUrl: opts.apiUrl }));
          if (outputOptions.json) printOutput(formatGetJson({ container, status: 'resumed_from_volume' }));
          else console.log(`Started "${container}" from the existing identity volume.`);
          return;
        }

        // Fresh enrollment: mint a single-use registration token (requires
        // an org:admin API key) and run the same command the deployment
        // wizard generates.
        const { data: enrollment, error: rpcError } = await supabase.rpc('generate_agent_enrollment_token');
        if (rpcError) {
          const msg = /admin/i.test(rpcError.message)
            ? 'Enrolling an agent requires an API key created by an org admin. ' +
              'Ask an admin to enroll the agent, or use an admin API key.'
            : `Could not generate a registration token: ${rpcError.message}`;
          throw new CliError(msg, ErrorCode.FORBIDDEN);
        }
        const token = enrollment?.token as string | undefined;
        if (!token) {
          throw new CliError('Enrollment token response was malformed (no token).', ErrorCode.API_ERROR);
        }

        if (!outputOptions.json) {
          console.log(`Registration token issued (region: ${enrollment.region}). Starting the agent container...`);
        }
        const { stdout } = await run(
          'docker',
          buildRunArgs({ container, volume, image: opts.image, token, apiUrl: opts.apiUrl }),
        );
        const containerId = stdout.trim().slice(0, 12);
        const identifier = `${containerId}${IDENTIFIER_SUFFIX}`;

        if (!outputOptions.json) {
          console.log(`Container started (${containerId}). Waiting for the agent to register...`);
          console.log('(first start generates encryption keys locally -- this typically takes about a minute)');
        }

        let row = await pollForAgentRow(supabase, identifier, timeoutMs, () => {
          if (!outputOptions.json) process.stderr.write('.');
        });
        if (!outputOptions.json) process.stderr.write('\n');

        // Approval: prompt in interactive mode, honor --approve/--no-approve,
        // never prompt in --json mode.
        let approved = false;
        if (NEEDS_APPROVAL.has(row.lifecycle_status)) {
          let shouldApprove = opts.approve;
          if (shouldApprove === undefined && !outputOptions.json && process.stdin.isTTY) {
            shouldApprove = await promptYesNo(`Agent "${identifier}" registered. Approve it to run jobs now?`);
          }
          if (shouldApprove) {
            const { error: approveError } = await supabase.rpc('approve_agent', { p_agent_id: row.agent_id });
            if (approveError) {
              throw new CliError(`Agent registered but approval failed: ${approveError.message}`, ErrorCode.FORBIDDEN);
            }
            approved = true;
            row = (await fetchAgentRow(supabase, identifier)) ?? row;
          }
        }

        const result = {
          agent_id: row.agent_id,
          agent_identifier: row.agent_identifier,
          lifecycle_status: row.lifecycle_status,
          approved,
          container,
          volume,
        };
        if (outputOptions.json) {
          printOutput(formatGetJson(result));
        } else if (approved) {
          console.log(`Agent approved. It picks up the approval within ~30 seconds and starts accepting jobs.`);
          console.log(`Check it with: supaflow agent status`);
        } else {
          console.log(`Agent registered (status: ${row.lifecycle_status}).`);
          console.log('Approve it on Settings > Agents (or rerun with --approve) before it can run jobs.');
        }
      }),
    );

  agent
    .command('stop')
    .description('Stop the local Docker agent container')
    .option('--name <container>', 'Container name', DEFAULT_CONTAINER)
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const opts = cmd.optsWithGlobals();
      try {
        const { status } = await getContainerStatus(run, opts.name);
        if (status === 'missing') {
          throw new CliError(`No container named "${opts.name}" found.`, ErrorCode.NOT_FOUND);
        }
        if (status === 'exited') {
          console.log(`Container "${opts.name}" is already stopped.`);
          return;
        }
        await run('docker', ['stop', opts.name]);
        console.log(`Stopped "${opts.name}". Restart it any time with "supaflow agent start" -- the identity is preserved.`);
      } catch (error) {
        handleError(error, opts.json ?? false);
      }
    });

  agent
    .command('status')
    .description('Show local container state and the agent record')
    .option('--name <container>', 'Container name', DEFAULT_CONTAINER)
    .action(
      withAuth(async (ctx, opts: { name: string }) => {
        const { supabase, outputOptions } = ctx;

        const container = await getContainerStatus(run, opts.name);
        let agentRow: AgentRow | null = null;
        if (container.status !== 'missing') {
          const { stdout } = await run('docker', ['inspect', '--format', '{{.Id}}', opts.name]);
          agentRow = await fetchAgentRow(supabase, `${stdout.trim().slice(0, 12)}${IDENTIFIER_SUFFIX}`);
        }

        const result = {
          container: opts.name,
          container_status: container.status,
          image: container.image,
          agent_id: agentRow?.agent_id ?? null,
          lifecycle_status: agentRow?.lifecycle_status ?? null,
          connectivity_status: agentRow?.connectivity_status ?? null,
          last_heartbeat_at: agentRow?.last_heartbeat_at ?? null,
        };

        if (outputOptions.json) {
          printOutput(formatGetJson(result));
        } else if (container.status === 'missing') {
          console.log(`No container named "${opts.name}". Run "supaflow agent start" to deploy one.`);
        } else {
          printOutput(
            formatTable(
              ['CONTAINER', 'STATE', 'LIFECYCLE', 'CONNECTIVITY', 'LAST HEARTBEAT'],
              [
                [
                  opts.name,
                  container.status,
                  agentRow?.lifecycle_status ?? '(not registered)',
                  agentRow?.connectivity_status ?? '-',
                  agentRow?.last_heartbeat_at ? relativeTime(agentRow.last_heartbeat_at) : '-',
                ],
              ],
            ),
          );
        }
      }),
    );

  agent
    .command('logs')
    .description('Show local agent container logs')
    .option('--name <container>', 'Container name', DEFAULT_CONTAINER)
    .option('-f, --follow', 'Follow log output')
    .option('--tail <lines>', 'Number of trailing lines', '200')
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const opts = cmd.optsWithGlobals();
      try {
        const { status } = await getContainerStatus(run, opts.name);
        if (status === 'missing') {
          throw new CliError(`No container named "${opts.name}" found.`, ErrorCode.NOT_FOUND);
        }
        const dockerArgs = ['logs', '--tail', String(opts.tail)];
        if (opts.follow) dockerArgs.push('--follow');
        dockerArgs.push(opts.name);
        await new Promise<void>((resolve, reject) => {
          const child = spawn('docker', dockerArgs, { stdio: 'inherit' });
          child.on('error', reject);
          child.on('exit', () => resolve());
        });
      } catch (error) {
        handleError(error, opts.json ?? false);
      }
    });

  agent
    .command('remove')
    .description('Remove the local agent container (and, with --purge, its identity volume)')
    .option('--name <container>', 'Container name', DEFAULT_CONTAINER)
    .option('--purge', 'Also delete the identity volume -- the next start enrolls a brand-new agent')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const opts = cmd.optsWithGlobals();
      try {
        const container = opts.name as string;
        const volume = volumeNameFor(container);
        const { status } = await getContainerStatus(run, container);
        const volPresent = await volumeExists(run, volume);

        if (status === 'missing' && !volPresent) {
          console.log(`Nothing to remove: no "${container}" container or "${volume}" volume.`);
          return;
        }

        if (!opts.yes) {
          const what = opts.purge
            ? `container "${container}" AND identity volume "${volume}" (next start enrolls a NEW agent)`
            : `container "${container}" (identity volume kept; next start resumes the same agent)`;
          const confirmed = await promptYesNo(`Remove ${what}?`);
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }

        if (status !== 'missing') await run('docker', ['rm', '-f', container]);
        if (opts.purge && volPresent) await run('docker', ['volume', 'rm', volume]);

        console.log(opts.purge ? `Removed "${container}" and "${volume}".` : `Removed "${container}" (volume "${volume}" kept).`);
        if (opts.purge) {
          console.log('Note: deactivate the old agent on Settings > Agents so it no longer appears in your tenant.');
        }
      } catch (error) {
        handleError(error, opts.json ?? false);
      }
    });
}
