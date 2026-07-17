import { execFile } from 'node:child_process';

/**
 * Thin, injectable wrapper around child_process.execFile so the agent
 * command's preflight logic is unit-testable without Docker installed.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecRunner = (cmd: string, args: string[]) => Promise<ExecResult>;

export class ExecError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: string | number | null;

  constructor(message: string, opts: { stdout?: string; stderr?: string; code?: string | number | null }) {
    super(message);
    this.name = 'ExecError';
    this.stdout = opts.stdout ?? '';
    this.stderr = opts.stderr ?? '';
    this.code = opts.code ?? null;
  }
}

export const defaultRunner: ExecRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        reject(
          new ExecError(err.message, {
            stdout: stdout?.toString(),
            stderr: stderr?.toString(),
            code: nodeErr.code ?? nodeErr.errno ?? null,
          }),
        );
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });

export type ContainerStatus = 'running' | 'exited' | 'missing';

/**
 * Docker prints "No such object/container/volume/image" for genuinely
 * absent resources. Anything else (daemon down, permission denied) is a
 * real failure and must propagate -- mapping it to "missing" would make
 * `status` lie and `remove` report success without removing anything.
 */
export function isNotFound(err: unknown): boolean {
  if (!(err instanceof ExecError)) return false;
  return /no such (object|container|volume|image)/i.test(`${err.message} ${err.stderr}`);
}

export interface DockerState {
  daemonVersion: string | null;
  containerStatus: ContainerStatus;
  containerImage: string | null;
  volumeExists: boolean;
  imagePresent: boolean;
  freeDiskGb: number | null;
}

export interface PreflightCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** The named volume grows to roughly 3.5 GB (connector artifacts + Python envs). */
const MIN_FREE_DISK_GB = 5;
/** Approximate compressed pull size of supaflow/agent, used in messaging only. */
const IMAGE_PULL_HINT = '~600 MB download';

export async function getContainerStatus(run: ExecRunner, name: string): Promise<{ status: ContainerStatus; image: string | null }> {
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{.State.Status}} {{.Config.Image}}', name]);
    const [state, image] = stdout.trim().split(/\s+/, 2);
    return { status: state === 'running' ? 'running' : 'exited', image: image ?? null };
  } catch (err) {
    if (isNotFound(err)) return { status: 'missing', image: null };
    throw err;
  }
}

export async function volumeExists(run: ExecRunner, name: string): Promise<boolean> {
  try {
    await run('docker', ['volume', 'inspect', name]);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function imagePresent(run: ExecRunner, image: string): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', image]);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * The identifier the agent registered under, resolved from a running or
 * stopped container: prefer the RESOURCE_INSTANCE_ID env the CLI sets on
 * containers it creates; fall back to the entrypoint's hostname-derived
 * convention for containers created by the deployment wizard command.
 */
export async function containerIdentifier(run: ExecRunner, name: string): Promise<string | null> {
  try {
    const { stdout } = await run('docker', [
      'inspect',
      '--format',
      '{{.Id}}|{{range .Config.Env}}{{.}};{{end}}',
      name,
    ]);
    const [id, envBlob] = stdout.trim().split('|', 2);
    const envMatch = envBlob?.match(/(?:^|;)RESOURCE_INSTANCE_ID=([^;]+)/);
    if (envMatch) return envMatch[1];
    return id ? `${id.slice(0, 12)}_local_docker_agent` : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export type VolumeIdentity =
  | { kind: 'identity'; instanceIdentifier: string; agentId: string | null }
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string };

/**
 * Read the persisted agent identity out of the named volume, without
 * starting the agent. The three outcomes matter to the caller in
 * different ways and must not be conflated:
 *
 * - 'missing'  -- identity.json confirmed absent: the volume is empty or
 *   leftover, and fresh enrollment is correct.
 * - 'corrupt'  -- identity.json exists but is unreadable/incomplete: the
 *   agent itself would fail closed on it, and enrolling fresh would waste
 *   a token on a container that resumes nothing. The caller should stop
 *   and point at recovery (remove --purge).
 * - execution failures (daemon down, image pull failure, permissions)
 *   PROPAGATE: treating them as an empty volume would mint a token while
 *   the attached volume still holds a valid identity -- the agent then
 *   resumes its persisted identifier and the caller polls the new one
 *   until it times out.
 */
export async function readVolumeIdentity(
  run: ExecRunner,
  volume: string,
  image: string,
): Promise<VolumeIdentity> {
  let stdout: string;
  try {
    ({ stdout } = await run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'cat',
      '-v',
      `${volume}:/data:ro`,
      image,
      '/data/identity.json',
    ]));
  } catch (err) {
    // 'missing' requires cat's own not-found report about identity.json,
    // matched in stderr ONLY: execFile puts the full command line --
    // which itself contains /data/identity.json -- into err.message, so
    // any message-based path check is self-satisfying for every failure
    // of this probe. Exit code 1 is cat's; docker daemon/storage/pull
    // failures exit 125+ and must propagate rather than read as an empty
    // volume (that would mint a token against a volume that may still
    // hold a valid identity). The pattern covers coreutils and busybox
    // phrasings for user-supplied --image values.
    if (
      err instanceof ExecError &&
      err.code === 1 &&
      /\/data\/identity\.json'?: no such file or directory/i.test(err.stderr)
    ) {
      return { kind: 'missing' };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // Mirror IdentityJson.validateInvariants: the agent requires these
    // five fields non-blank and fails closed otherwise, so a structurally
    // incomplete identity must not be classified as resumable. agent_id
    // stays optional (absent until first successful registration).
    const REQUIRED = ['signing_identity_id', 'tenant_id', 'instance_identifier', 'cloud_provider', 'region'];
    const missing = REQUIRED.filter((f) => typeof parsed[f] !== 'string' || (parsed[f] as string).trim() === '');
    if (missing.length > 0) {
      return { kind: 'corrupt', reason: `identity.json is incomplete (missing or blank: ${missing.join(', ')})` };
    }
    return {
      kind: 'identity',
      instanceIdentifier: parsed.instance_identifier as string,
      agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
    };
  } catch {
    return { kind: 'corrupt', reason: 'identity.json is not valid JSON' };
  }
}

/** Free space on the filesystem Docker Desktop's VM disk (and pulls) grow into. */
export async function freeDiskGb(run: ExecRunner): Promise<number | null> {
  try {
    const { stdout } = await run('df', ['-Pk', '/']);
    const lines = stdout.trim().split('\n');
    const fields = lines[lines.length - 1]?.split(/\s+/);
    const availKb = fields ? Number(fields[3]) : NaN;
    return Number.isFinite(availKb) ? Math.round((availKb / 1024 / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

export async function inspectDockerState(
  run: ExecRunner,
  opts: { container: string; volume: string; image: string },
): Promise<DockerState> {
  let daemonVersion: string | null = null;
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}']);
    daemonVersion = stdout.trim() || null;
  } catch {
    daemonVersion = null;
  }

  if (!daemonVersion) {
    return {
      daemonVersion: null,
      containerStatus: 'missing',
      containerImage: null,
      volumeExists: false,
      imagePresent: false,
      freeDiskGb: await freeDiskGb(run),
    };
  }

  const [container, volume, image, disk] = await Promise.all([
    getContainerStatus(run, opts.container),
    volumeExists(run, opts.volume),
    imagePresent(run, opts.image),
    freeDiskGb(run),
  ]);

  return {
    daemonVersion,
    containerStatus: container.status,
    containerImage: container.image,
    volumeExists: volume,
    imagePresent: image,
    freeDiskGb: disk,
  };
}

/**
 * Doctor-style dependency checks for `agent start`. Every check reports;
 * only `fail` blocks. The caller decides how to render.
 */
export async function buildPreflight(
  run: ExecRunner,
  opts: { container: string; volume: string; image: string },
): Promise<{ checks: PreflightCheck[]; state: DockerState; ok: boolean }> {
  const checks: PreflightCheck[] = [];

  let binaryOk = true;
  try {
    await run('docker', ['--version']);
    checks.push({ name: 'docker binary', status: 'ok', detail: 'found on PATH' });
  } catch (err) {
    binaryOk = false;
    const missing = err instanceof ExecError && err.code === 'ENOENT';
    checks.push({
      name: 'docker binary',
      status: 'fail',
      detail: missing
        ? 'not found on PATH. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux).'
        : 'could not be executed',
    });
  }

  const state = binaryOk
    ? await inspectDockerState(run, opts)
    : {
        daemonVersion: null,
        containerStatus: 'missing' as ContainerStatus,
        containerImage: null,
        volumeExists: false,
        imagePresent: false,
        freeDiskGb: null,
      };

  if (binaryOk) {
    checks.push(
      state.daemonVersion
        ? { name: 'docker daemon', status: 'ok', detail: `running (server ${state.daemonVersion})` }
        : { name: 'docker daemon', status: 'fail', detail: 'not reachable. Start Docker and retry.' },
    );
  }

  if (state.freeDiskGb === null) {
    checks.push({ name: 'disk space', status: 'warn', detail: 'could not determine free space' });
  } else if (state.freeDiskGb < MIN_FREE_DISK_GB) {
    checks.push({
      name: 'disk space',
      status: 'warn',
      detail: `${state.freeDiskGb} GB free; the agent needs ~${MIN_FREE_DISK_GB} GB (image pull + connector data volume)`,
    });
  } else {
    checks.push({ name: 'disk space', status: 'ok', detail: `${state.freeDiskGb} GB free` });
  }

  if (state.daemonVersion) {
    checks.push(
      state.imagePresent
        ? { name: `image ${opts.image}`, status: 'ok', detail: 'present locally' }
        : { name: `image ${opts.image}`, status: 'ok', detail: `will be pulled (${IMAGE_PULL_HINT})` },
    );

    if (state.containerStatus === 'running') {
      checks.push({ name: `container ${opts.container}`, status: 'ok', detail: 'already running' });
    } else if (state.containerStatus === 'exited') {
      checks.push({ name: `container ${opts.container}`, status: 'ok', detail: 'exists (stopped); will be started' });
    } else {
      checks.push({ name: `container ${opts.container}`, status: 'ok', detail: 'not present; will be created' });
    }

    checks.push(
      state.volumeExists
        ? {
            name: `volume ${opts.volume}`,
            status: 'ok',
            detail: 'exists; agent identity will be resumed (use "agent remove --purge" first to enroll fresh)',
          }
        : { name: `volume ${opts.volume}`, status: 'ok', detail: 'will be created; holds the agent identity and connector data' },
    );
  }

  return { checks, state, ok: !checks.some((c) => c.status === 'fail') };
}
