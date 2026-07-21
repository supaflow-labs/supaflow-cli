import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '../lib/middleware.js';
import { formatGetJson, formatTable, printOutput, relativeTime } from '../lib/output.js';
import { CliError, ErrorCode, handleError } from '../lib/errors.js';
import {
  buildPreflight,
  clearStoppedAgentSyncLock,
  containerEnvValue,
  containerIdentifier,
  createAgentDataVolume,
  defaultRunner,
  getContainerStatus,
  readVolumeIdentity,
  volumeExists,
  type ExecRunner,
  type PreflightCheck,
} from '../lib/docker.js';

const DEFAULT_CONTAINER = 'supaflow-agent';
const DEFAULT_IMAGE = 'supaflow/supaflow-agent:latest';
const REGISTRATION_POLL_MS = 5000;

const NEEDS_APPROVAL = new Set(['registered', 'pending_approval']);

type StartMode = 'already_running' | 'resumed' | 'resumed_from_volume' | 'enrolled';

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

/**
 * Stable, unique identifier for a CLI-enrolled agent. Set explicitly as
 * RESOURCE_INSTANCE_ID so it survives container re-creation (the image's
 * hostname-derived fallback changes on every `docker run`, which would
 * register a brand-new agent instead of resuming the enrolled one). The
 * random tail keeps two hosts using the same --name from colliding.
 */
function newInstanceIdentifier(container: string): string {
  return `${container}-${randomBytes(3).toString('hex')}`;
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
  container: string,
  timeoutMs: number,
  onTick?: () => void,
): Promise<AgentRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await fetchAgentRow(supabase, identifier);
    if (row) return row;
    if (Date.now() > deadline) {
      throw new CliError(
        `Agent "${identifier}" did not register within ${Math.round(timeoutMs / 1000)}s. ` +
          `Check the container logs: docker logs ${container}`,
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

/**
 * Bootstrap URL for the agent container's OTP mode. The published image
 * carries a production default, but the CLI still passes one so its command
 * is self-contained and works with older or custom images: the explicit
 * --api-url override verbatim when given, otherwise the app URL this CLI
 * session talks to. In the derived case a localhost host is rewritten to
 * host.docker.internal -- inside the container, localhost is the container
 * itself, not the machine running the local app.
 */
export function resolveAgentApiUrl(override?: string): string {
  if (override) return override;
  const appUrl = process.env.SUPAFLOW_APP_URL || 'https://app.supa-flow.io';
  return appUrl.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i,
    '$1host.docker.internal',
  );
}

/** docker run arguments mirroring the deployment wizard's generated command. */
export function buildRunArgs(opts: {
  container: string;
  volume: string;
  image: string;
  instanceId?: string;
  token?: string;
  apiUrl?: string;
  pull?: 'always' | 'missing' | 'never';
}): string[] {
  const args = [
    'run',
    '-d',
  ];
  if (opts.pull) args.push(`--pull=${opts.pull}`);
  args.push(
    '--name',
    opts.container,
    '--restart',
    'unless-stopped',
    '-v',
    `${opts.volume}:/data`,
  );
  if (opts.instanceId) args.push('-e', `RESOURCE_INSTANCE_ID=${opts.instanceId}`);
  if (opts.token) args.push('-e', `AGENT_REGISTRATION_TOKEN=${opts.token}`);
  if (opts.apiUrl) {
    args.push('-e', `SUPAFLOW_API_URL=${opts.apiUrl}`);
    if (opts.apiUrl.includes('host.docker.internal')) {
      // Docker Desktop resolves host.docker.internal natively; native
      // Docker Engine on Linux only gets it via an explicit host-gateway
      // mapping (harmless on Desktop, where it maps to the same gateway).
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }
  }
  args.push(opts.image);
  return args;
}

export interface UpgradeAgentResult {
  container: string;
  volume: string;
  previous_image: string | null;
  image: string;
  agent_identifier: string;
  pulled: boolean;
}

/**
 * Replace an existing CLI/wizard Docker container while preserving its named
 * data volume and persisted identity. Pull happens before the running
 * container is touched, so registry failures leave the current agent online.
 */
export async function upgradeAgentContainer(
  run: ExecRunner,
  opts: {
    container: string;
    volume: string;
    image: string;
    apiUrl?: string;
    pull: boolean;
  },
): Promise<UpgradeAgentResult> {
  const current = await getContainerStatus(run, opts.container);
  if (current.status === 'missing') {
    throw new CliError(
      `No container named "${opts.container}" found. Run "supaflow agent start" to deploy one.`,
      ErrorCode.NOT_FOUND,
    );
  }
  if (!(await volumeExists(run, opts.volume))) {
    throw new CliError(
      `Container "${opts.container}" has no persistent volume named "${opts.volume}". ` +
        'Refusing to upgrade because its identity and keystore cannot be preserved.',
      ErrorCode.INVALID_INPUT,
    );
  }

  const existingApiUrl = await containerEnvValue(run, opts.container, 'SUPAFLOW_API_URL');
  const effectiveApiUrl = opts.apiUrl ?? existingApiUrl ?? resolveAgentApiUrl();
  if (opts.pull) await run('docker', ['pull', opts.image]);

  const identity = await readVolumeIdentity(run, opts.volume, opts.image, 'never');
  if (identity.kind === 'missing') {
    throw new CliError(
      `Volume "${opts.volume}" has no agent identity. Refusing to replace the existing container.`,
      ErrorCode.INVALID_INPUT,
    );
  }
  if (identity.kind === 'corrupt') {
    throw new CliError(
      `Volume "${opts.volume}" holds an unreadable agent identity (${identity.reason}). ` +
        'Refusing to replace the existing container.',
      ErrorCode.INVALID_INPUT,
    );
  }

  if (current.status === 'running') await run('docker', ['stop', opts.container]);
  try {
    await clearStoppedAgentSyncLock(run, opts.volume, opts.image);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (current.status === 'running') {
      try {
        await run('docker', ['start', opts.container]);
        throw new CliError(
          `Image upgrade preparation failed while clearing the stopped agent's connector sync lock: ${message}. ` +
            'The existing container was restarted and left unchanged.',
          ErrorCode.API_ERROR,
        );
      } catch (restartError) {
        if (restartError instanceof CliError) throw restartError;
        const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
        throw new CliError(
          `Image upgrade preparation failed while clearing the stopped agent's connector sync lock: ${message}. ` +
            `Restarting the existing container also failed: ${restartMessage}. ` +
            `The container was not removed; run "docker start ${opts.container}" to recover.`,
          ErrorCode.API_ERROR,
        );
      }
    }
    throw new CliError(
      `Image upgrade preparation failed while clearing the stopped agent's connector sync lock: ${message}. ` +
        'The existing stopped container was left unchanged.',
      ErrorCode.API_ERROR,
    );
  }
  await run('docker', ['rm', opts.container]);
  try {
    await run(
      'docker',
      buildRunArgs({
        container: opts.container,
        volume: opts.volume,
        image: opts.image,
        instanceId: identity.instanceIdentifier,
        apiUrl: effectiveApiUrl,
        pull: 'never',
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (current.image) {
      try {
        await run(
          'docker',
          buildRunArgs({
            container: opts.container,
            volume: opts.volume,
            image: current.image,
            instanceId: identity.instanceIdentifier,
            apiUrl: effectiveApiUrl,
            pull: 'never',
          }),
        );
        throw new CliError(
          `Image upgrade failed: ${message}. The previous image "${current.image}" was restored, ` +
            `and the persistent volume "${opts.volume}" was preserved.`,
          ErrorCode.API_ERROR,
        );
      } catch (rollbackError) {
        if (rollbackError instanceof CliError) throw rollbackError;
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new CliError(
          `Image upgrade failed: ${message}. Restoring the previous image also failed: ${rollbackMessage}. ` +
            `The persistent volume "${opts.volume}" is intact; run "supaflow agent start --name ${opts.container} ` +
            `--image ${current.image}" to recover.`,
          ErrorCode.API_ERROR,
        );
      }
    }
    throw new CliError(
      `Image upgrade failed after removing the old container: ${message}. ` +
        `The persistent volume "${opts.volume}" is intact; run "supaflow agent start --name ${opts.container} ` +
        `--image ${opts.image}" to recover.`,
      ErrorCode.API_ERROR,
    );
  }

  return {
    container: opts.container,
    volume: opts.volume,
    previous_image: current.image,
    image: opts.image,
    agent_identifier: identity.instanceIdentifier,
    pulled: opts.pull,
  };
}

export function registerAgentsCommands(program: Command, run: ExecRunner = defaultRunner): void {
  const agent = program.command('agent').description('Run and manage a local Docker agent');

  agent
    .command('start')
    .description('Start a local Docker agent (enrolls a new one on first run)')
    .option('--name <container>', 'Container name (volume becomes <name>-data)', DEFAULT_CONTAINER)
    .option('--image <image>', 'Agent image', DEFAULT_IMAGE)
    .option(
      '--api-url <url>',
      'Bootstrap URL the agent uses to reach Supaflow (default: the app URL this CLI targets, localhost rewritten to host.docker.internal)',
    )
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

        if (
          preflight.state.containerStatus !== 'missing' &&
          preflight.state.containerImage &&
          preflight.state.containerImage !== opts.image
        ) {
          throw new CliError(
            `Container "${container}" uses image "${preflight.state.containerImage}", ` +
              `but this start requested "${opts.image}". Run "supaflow agent upgrade --name ${container} ` +
              `--image ${opts.image}" to replace it while preserving its identity.`,
            ErrorCode.INVALID_INPUT,
          );
        }

        if (preflight.state.containerStatus === 'missing' && !preflight.state.volumeExists) {
          await createAgentDataVolume(run, volume, container);
          if (!outputOptions.json) console.log(`Created persistent agent data volume "${volume}".`);
        }

        // Resolve how to bring the container up. Every path converges on
        // the registration lookup + approval block below, so `--approve`
        // works for an already-running pending agent too.
        let mode: StartMode | null = null;
        let identifier: string | null = null;

        if (preflight.state.containerStatus === 'running') {
          mode = 'already_running';
          identifier = await containerIdentifier(run, container);
        } else if (preflight.state.containerStatus === 'exited') {
          // A stopped container keeps its env and identity; docker start
          // resumes the same agent without a token.
          await run('docker', ['start', container]);
          mode = 'resumed';
          identifier = await containerIdentifier(run, container);
        } else if (preflight.state.volumeExists) {
          // Only resume from a volume that actually holds an identity.
          // A confirmed-empty volume goes through fresh enrollment; a
          // corrupt identity fails loudly (enrolling fresh would waste a
          // token on a container that resumes nothing); probe execution
          // failures propagate.
          const identity = await readVolumeIdentity(run, volume, opts.image);
          if (identity.kind === 'identity') {
            if (!outputOptions.json) {
              console.log(`Existing agent identity found in "${volume}" (${identity.instanceIdentifier}); resuming it.`);
              console.log('To enroll a brand-new agent instead, run "supaflow agent remove --purge" first.');
            }
            await run(
              'docker',
              buildRunArgs({
                container,
                volume,
                image: opts.image,
                instanceId: identity.instanceIdentifier,
                apiUrl: resolveAgentApiUrl(opts.apiUrl),
              }),
            );
            mode = 'resumed_from_volume';
            identifier = identity.instanceIdentifier;
          } else if (identity.kind === 'corrupt') {
            throw new CliError(
              `Volume "${volume}" holds an unreadable agent identity (${identity.reason}). ` +
                'Recover with "supaflow agent remove --purge" to enroll a brand-new agent, ' +
                'then deactivate the old agent on Settings > Agents.',
              ErrorCode.INVALID_INPUT,
            );
          } else if (!outputOptions.json) {
            console.log(`Volume "${volume}" exists but holds no agent identity; enrolling a new agent.`);
          }
        }

        if (!mode) {
          // Fresh enrollment: mint a single-use registration token
          // (requires an org:admin API key) and run the same command the
          // deployment wizard generates, plus a CLI-owned stable
          // RESOURCE_INSTANCE_ID.
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

          identifier = newInstanceIdentifier(container);
          if (!outputOptions.json) {
            console.log(`Registration token issued (region: ${enrollment.region}). Starting the agent container...`);
          }
          await run(
            'docker',
            buildRunArgs({
              container,
              volume,
              image: opts.image,
              instanceId: identifier,
              token,
              apiUrl: resolveAgentApiUrl(opts.apiUrl),
            }),
          );
          mode = 'enrolled';
          if (!outputOptions.json) {
            console.log(`Container started. Waiting for agent "${identifier}" to register...`);
            console.log('(first start generates encryption keys locally -- this typically takes about a minute)');
          }
        }

        if (!identifier) {
          throw new CliError(
            `Could not determine the agent identifier for container "${container}".`,
            ErrorCode.API_ERROR,
          );
        }

        // Converged tail: wait for the registration record, then decide
        // on approval regardless of which path brought the agent up.
        let row = await pollForAgentRow(supabase, identifier, container, timeoutMs, () => {
          if (!outputOptions.json) process.stderr.write('.');
        });
        if (!outputOptions.json) process.stderr.write('\n');

        let approved = false;
        if (NEEDS_APPROVAL.has(row.lifecycle_status)) {
          let shouldApprove = opts.approve;
          if (shouldApprove === undefined && !outputOptions.json && process.stdin.isTTY) {
            shouldApprove = await promptYesNo(`Agent "${identifier}" is ${row.lifecycle_status}. Approve it to run jobs now?`);
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
          mode,
          agent_id: row.agent_id,
          agent_identifier: row.agent_identifier,
          lifecycle_status: row.lifecycle_status,
          approved,
          container,
          volume,
        };
        if (outputOptions.json) {
          printOutput(formatGetJson(result));
          return;
        }

        const modeLine: Record<StartMode, string> = {
          already_running: `Agent container "${container}" was already running.`,
          resumed: `Restarted "${container}"; the agent resumes its existing identity.`,
          resumed_from_volume: `Recreated "${container}" from the existing identity volume.`,
          enrolled: `Agent enrolled.`,
        };
        console.log(modeLine[mode]);
        if (approved) {
          console.log('Agent approved. It picks up the approval within ~30 seconds and starts accepting jobs.');
          console.log('Check it with: supaflow agent status');
        } else if (NEEDS_APPROVAL.has(row.lifecycle_status)) {
          console.log(`Agent status: ${row.lifecycle_status}.`);
          console.log('Approve it on Settings > Agents (or rerun "supaflow agent start --approve") before it can run jobs.');
        } else {
          console.log(`Agent status: ${row.lifecycle_status}.`);
        }
      }),
    );

  agent
    .command('upgrade')
    .description('Pull and install a newer agent image while preserving the agent identity volume')
    .option('--name <container>', 'Container name (volume is <name>-data)', DEFAULT_CONTAINER)
    .option('--image <image>', 'Agent image', DEFAULT_IMAGE)
    .option('--api-url <url>', 'Override the existing container bootstrap URL')
    .option('--no-pull', 'Use the requested image already present locally')
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const opts = cmd.optsWithGlobals() as {
        name: string;
        image: string;
        apiUrl?: string;
        pull: boolean;
        json?: boolean;
      };
      const json = opts.json ?? false;
      try {
        const result = await upgradeAgentContainer(run, {
          container: opts.name,
          volume: volumeNameFor(opts.name),
          image: opts.image,
          apiUrl: opts.apiUrl,
          pull: opts.pull,
        });
        if (json) {
          printOutput(formatGetJson({ status: 'upgraded', ...result }));
        } else {
          const pullText = result.pulled ? 'pulled and installed' : 'installed from the local image cache';
          console.log(`Agent "${result.container}" ${pullText}: ${result.image}`);
          console.log(`Identity preserved in "${result.volume}" (${result.agent_identifier}).`);
        }
      } catch (error) {
        handleError(error, json);
      }
    });

  agent
    .command('stop')
    .description('Stop the local Docker agent container')
    .option('--name <container>', 'Container name', DEFAULT_CONTAINER)
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const opts = cmd.optsWithGlobals();
      const json = opts.json ?? false;
      try {
        const { status } = await getContainerStatus(run, opts.name);
        if (status === 'missing') {
          throw new CliError(`No container named "${opts.name}" found.`, ErrorCode.NOT_FOUND);
        }
        if (status === 'exited') {
          if (json) printOutput(formatGetJson({ container: opts.name, status: 'already_stopped' }));
          else console.log(`Container "${opts.name}" is already stopped.`);
          return;
        }
        await run('docker', ['stop', opts.name]);
        if (json) printOutput(formatGetJson({ container: opts.name, status: 'stopped' }));
        else console.log(`Stopped "${opts.name}". Restart it any time with "supaflow agent start" -- the identity is preserved.`);
      } catch (error) {
        handleError(error, json);
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
          const identifier = await containerIdentifier(run, opts.name);
          if (identifier) agentRow = await fetchAgentRow(supabase, identifier);
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
      const json = opts.json ?? false;
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
          child.on('exit', (code, signal) => {
            // Interactive interrupts of --follow are a normal way to leave.
            if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve();
            else reject(new CliError(`docker logs exited with code ${code ?? `signal ${signal}`}`, ErrorCode.API_ERROR));
          });
        });
      } catch (error) {
        handleError(error, json);
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
      const json = opts.json ?? false;
      try {
        const container = opts.name as string;
        const volume = volumeNameFor(container);
        const { status } = await getContainerStatus(run, container);
        const volPresent = await volumeExists(run, volume);

        if (status === 'missing' && !volPresent) {
          if (json) printOutput(formatGetJson({ container, volume, removed_container: false, removed_volume: false }));
          else console.log(`Nothing to remove: no "${container}" container or "${volume}" volume.`);
          return;
        }

        if (!opts.yes) {
          // Never prompt outside an interactive TTY (and never in --json
          // mode) -- require the explicit --yes instead.
          if (json || !process.stdin.isTTY) {
            throw new CliError('Refusing to remove without --yes in non-interactive mode.', ErrorCode.INVALID_INPUT);
          }
          const what = opts.purge
            ? `container "${container}" AND identity volume "${volume}" (next start enrolls a NEW agent)`
            : `container "${container}" (identity volume kept; next start resumes the same agent)`;
          const confirmed = await promptYesNo(`Remove ${what}?`);
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }

        const removedContainer = status !== 'missing';
        if (removedContainer) await run('docker', ['rm', '-f', container]);
        const removedVolume = Boolean(opts.purge && volPresent);
        if (removedVolume) await run('docker', ['volume', 'rm', volume]);

        if (json) {
          printOutput(formatGetJson({ container, volume, removed_container: removedContainer, removed_volume: removedVolume }));
          return;
        }
        console.log(opts.purge ? `Removed "${container}" and "${volume}".` : `Removed "${container}" (volume "${volume}" kept).`);
        if (opts.purge) {
          console.log('Note: deactivate the old agent on Settings > Agents so it no longer appears in your tenant.');
        }
      } catch (error) {
        handleError(error, json);
      }
    });
}
