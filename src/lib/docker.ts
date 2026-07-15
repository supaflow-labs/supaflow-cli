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
  } catch {
    return { status: 'missing', image: null };
  }
}

export async function volumeExists(run: ExecRunner, name: string): Promise<boolean> {
  try {
    await run('docker', ['volume', 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

export async function imagePresent(run: ExecRunner, image: string): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
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
