import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  validateConnectorToolchainBundle,
  type ConnectorToolchainBundle,
} from './connector-bootstrap.js';
import type { ConnectorAgentTarget } from './connector-toolchain.js';
import { ToolchainTransportError } from './connector-python-process.js';
import { VERSION } from '../version.js';

export interface ConnectorAuthoringBundle extends ConnectorToolchainBundle {
  cliVersion: string;
  projectRequiresPython: string;
  requiredHostProtocol: number;
  agentExecutionPython: string;
  agentTargets: readonly ConnectorAgentTarget[];
  templateVersions: { 'custom-source': 1; 'api-source': 1; 'sql-source': 1 };
}

/** Read CLI-owned assets only. Python remains the target/range semantic validator. */
export async function readConnectorAuthoringBundle(directory: string): Promise<{
  bundle: ConnectorAuthoringBundle;
  requirements: Buffer;
}> {
  try {
    if (!isAbsolute(directory) || directory.includes('\0')) throw new Error();
    const requirementsFile = join(directory, 'requirements.txt');
    const [manifest, requirements] = await Promise.all([
      readFile(join(directory, 'toolchain.json')),
      readFile(requirementsFile),
    ]);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
    validateConnectorToolchainBundle(value, requirements);
    const bundle = value as ConnectorAuthoringBundle;
    if (
      bundle.cliVersion !== VERSION ||
      [bundle.projectRequiresPython, bundle.agentExecutionPython].some(
        (value) => typeof value !== 'string' || !value.trim() || value.includes('\0'),
      ) ||
      !Number.isSafeInteger(bundle.requiredHostProtocol) ||
      bundle.requiredHostProtocol < 1 ||
      !Array.isArray(bundle.agentTargets) ||
      bundle.agentTargets.length === 0 ||
      bundle.templateVersions === null ||
      typeof bundle.templateVersions !== 'object' ||
      Object.keys(bundle.templateVersions).sort().join(',') !==
        'api-source,custom-source,sql-source' ||
      Object.values(bundle.templateVersions).some((version) => version !== 1)
    )
      throw new Error();
    return { bundle, requirements };
  } catch {
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Bundled connector authoring assets are missing, corrupt or incompatible; reinstall the CLI',
    );
  }
}
