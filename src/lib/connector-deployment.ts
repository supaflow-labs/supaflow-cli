import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, ErrorCode } from './errors.js';
import { defaultRunner, getContainerStatus, type ExecRunner } from './docker.js';
import { readBuiltConnector } from './connector-registration.js';

// Extract the helper from the running agent's own build, just like its existing
// internal wheel installer. Arguments travel separately from shell source.
const INSTALL = `set -eo pipefail
work=$1
python="\${SUPAFLOW_PYTHON_EXECUTABLE:-/app/python-venv/bin/python3}"
"$python" -I -B -c 'from zipfile import ZipFile; import pathlib, sys; pathlib.Path(sys.argv[1]).write_bytes(ZipFile("/app/app.jar").read("BOOT-INF/classes/scripts/internal-wheel-admin.sh"))' "$work/admin.sh"
bash "$work/admin.sh" install-local-wheel \\
  "\${AGENT_CONNECTOR_PATH:-\${AGENT_EXTERNAL_PATH:-/data}/supaflow-agent/global/connectors}" \\
  /app/app.jar "$(command -v java)" "$python" \\
  /app/agent-execution-compatibility.json "$work/artifact"
`;

/** Local Docker transport only: no CLI session, registration or server lookup. */
export async function deployBuiltConnector(
  options: { artifact: string; name: string; runtimeWheels?: string },
  run: ExecRunner = defaultRunner,
) {
  const built = await readBuiltConnector(options.artifact);
  const artifact = await realpath(resolve(options.artifact));
  const runtimeWheels = options.runtimeWheels
    ? await realpath(resolve(options.runtimeWheels))
    : undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.name)) {
    throw new CliError('Invalid agent container name.', ErrorCode.INVALID_INPUT);
  }
  if ((await getContainerStatus(run, options.name)).status !== 'running') {
    throw new CliError(
      'Start the target Docker agent before local deployment.',
      ErrorCode.INVALID_INPUT,
    );
  }
  const { stdout } = await run('docker', [
    'exec',
    options.name,
    'mktemp',
    '-d',
    '/tmp/connector-deploy.XXXXXXXX',
  ]);
  const work = stdout.trim();
  if (!/^\/tmp\/connector-deploy\.[A-Za-z0-9]+$/.test(work)) {
    throw new CliError('Could not create agent deployment staging.', ErrorCode.API_ERROR);
  }
  try {
    await run('docker', ['cp', artifact, `${options.name}:${work}/artifact`]);
    if (runtimeWheels) {
      await run('docker', [
        'cp',
        `${runtimeWheels}/.`,
        `${options.name}:${work}/artifact/runtime-wheels`,
      ]);
    }
    await run('docker', ['exec', options.name, 'bash', '-c', INSTALL, 'connector-deploy', work]);
  } catch {
    throw new CliError(
      'Local deployment failed. Check the artifact, agent compatibility and exact SDK/runtime wheels. ' +
        'Use --runtime-wheels for wheels not already present on the agent; use a new version when changing a deployed artifact.',
      ErrorCode.API_ERROR,
    );
  } finally {
    try {
      await run('docker', ['exec', options.name, 'rm', '-rf', '--', work]);
    } catch {
      process.stderr.write(
        'Warning: temporary deployment files could not be removed from the agent.\n',
      );
    }
  }
  return { status: 'prepared', artifact_lock_sha256: built.lockSha256, container: options.name };
}
