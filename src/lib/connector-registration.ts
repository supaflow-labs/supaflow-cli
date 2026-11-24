import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function regularFile(root: string, name: string, limit?: number): Promise<string> {
  const path = join(root, name);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    (await realpath(path)) !== path ||
    (limit !== undefined && info.size > limit)
  ) {
    throw new Error();
  }
  return path;
}

export async function readBuiltConnector(artifact: string) {
  const maxMetadataBytes = 128 * 1024;
  let manifest: string;
  let lock: string;
  try {
    const root = await realpath(resolve(artifact));
    const utf8 = (bytes: Buffer) =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    lock = utf8(await readFile(await regularFile(root, 'connector.lock', maxMetadataBytes)));
    const parsed = JSON.parse(lock);
    manifest = utf8(await readFile(await regularFile(root, 'connector.yaml', maxMetadataBytes)));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.manifest?.path !== 'connector.yaml' ||
      parsed.manifest.sha256 !== hash(manifest) ||
      !/^wheels\/[A-Za-z0-9_.+!-]+\.whl$/.test(parsed.connectorWheel?.path ?? '')
    ) {
      throw new Error();
    }
    const runtime = await readFile(await regularFile(root, 'runtime.lock', maxMetadataBytes));
    const projection = await readFile(
      await regularFile(root, 'deps/pyproject.toml', maxMetadataBytes),
    );
    const dependency = await readFile(await regularFile(root, 'deps/uv.lock', 8 * 1024 * 1024));
    const dependencyHash = hash(
      JSON.stringify({
        'deps/pyproject.toml': hash(projection),
        'deps/uv.lock': hash(dependency),
      }),
    );
    const wheelHash = createHash('sha256');
    for await (const chunk of createReadStream(
      await regularFile(root, parsed.connectorWheel.path),
    )) {
      wheelHash.update(chunk);
    }
    if (
      hash(runtime) !== parsed.runtimeLockSha256 ||
      dependencyHash !== parsed.dependencyLockSha256 ||
      wheelHash.digest('hex') !== parsed.connectorWheel.sha256
    )
      throw new Error();
  } catch {
    throw new CliError(
      'Invalid built artifact or lock mismatch. Run supaflow connectors build and retry.',
      ErrorCode.INVALID_INPUT,
    );
  }

  return { manifest, lock, lockSha256: hash(lock) };
}

export async function registeredConnectorStatus(
  artifact: string,
  versionId: string,
  supabase: SupabaseClient,
) {
  const built = await readBuiltConnector(artifact);
  const { data, error } = await supabase.rpc('get_connector_version', {
    connectorVersionId: versionId,
  });
  if (error) throw new CliError(error.message, ErrorCode.API_ERROR);
  const version = Array.isArray(data) ? data[0] : undefined;
  return {
    version_id: versionId,
    artifact_lock_sha256: built.lockSha256,
    status: !version
      ? 'unavailable'
      : version.wheel_lock_sha256 === built.lockSha256
        ? 'registered'
        : 'different_artifact',
  };
}

export async function registerBuiltConnector(artifact: string, token: string) {
  const { manifest, lock } = await readBuiltConnector(artifact);
  let response: Response;
  try {
    response = await fetch(
      new URL(
        '/api/cli/connectors/register',
        process.env.SUPAFLOW_APP_URL || 'https://app.supa-flow.io',
      ),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest, lock }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new CliError('Unable to reach the connector registration API.', ErrorCode.NETWORK_ERROR);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CliError(
      typeof result?.error === 'string' ? result.error : 'Connector registration failed.',
      response.status === 403
        ? ErrorCode.FORBIDDEN
        : [400, 409].includes(response.status)
          ? ErrorCode.INVALID_INPUT
          : ErrorCode.API_ERROR,
    );
  }
  if (
    typeof result?.connector_id !== 'string' ||
    typeof result.version_id !== 'string' ||
    typeof result.type !== 'string' ||
    typeof result.version !== 'string' ||
    typeof result.created !== 'boolean' ||
    result.lock_sha256 !== hash(lock)
  ) {
    throw new CliError(
      'The connector registration response could not be verified.',
      ErrorCode.API_ERROR,
    );
  }
  return result;
}
