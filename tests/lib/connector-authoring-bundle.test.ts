import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';
import { readConnectorAuthoringBundle } from '../../src/lib/connector-authoring-bundle.js';

const requirements = Buffer.from('fixture==1 --hash=sha256:' + 'a'.repeat(64) + '\n');
const manifest = {
  schemaVersion: 1,
  cliVersion: VERSION,
  requiresPython: '>=3.11,<3.15',
  toolchainVersion: '0.1.0',
  sdkVersion: '1.0.73.dev0',
  runtimeVersion: '0.1.0',
  testkitVersion: '0.1.0',
  uvVersion: '0.13.4',
  requirementsSha256: createHash('sha256').update(requirements).digest('hex'),
  projectRequiresPython: '>=3.12,<3.15',
  agentExecutionPython: '>=3.14,<3.15',
  requiredHostProtocol: 2,
  templateVersions: { 'custom-source': 1, 'api-source': 1, 'sql-source': 1 },
  agentTargets: [
    {
      name: 'fixture-inventory',
      environment: { sys_platform: 'linux' },
      wheelTags: ['py3-none-any'],
    },
  ],
};
let root: string;
const save = (value: unknown) => writeFile(join(root, 'toolchain.json'), JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supaflow bundle ; '));
  await save(manifest);
  await writeFile(join(root, 'requirements.txt'), requirements);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('reads fixed CLI-owned files and carries target facts unchanged for Python validation', async () => {
  expect(await readConnectorAuthoringBundle(root)).toEqual({
    bundle: manifest,
    requirements,
  });
});

it.each([
  { schemaVersion: 2 },
  { cliVersion: '0.0.0' },
  { requiresPython: '' },
  { sdkVersion: null },
  { toolchainVersion: 'file:/untrusted' },
  { uvVersion: undefined },
  { requirementsSha256: 'b'.repeat(64) },
  { projectRequiresPython: ' ' },
  { agentExecutionPython: '\0' },
  { requiredHostProtocol: 0 },
  { requiredHostProtocol: 1.5 },
  { requiredHostProtocol: Number.MAX_SAFE_INTEGER + 1 },
  { agentTargets: [] },
  { agentTargets: null },
  { templateVersions: null },
  { templateVersions: [] },
  { templateVersions: { 'custom-source': 2, 'api-source': 1, 'sql-source': 1 } },
  { templateVersions: { 'custom-source': 1, 'api-source': 1 } },
  { templateVersions: { ...manifest.templateVersions, unknown: 1 } },
])('rejects incompatible bundle fields %j with an actionable diagnostic', async (change) => {
  await save({ ...manifest, ...change });
  await expect(readConnectorAuthoringBundle(root)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('reinstall the CLI'),
  });
});

it.each(['null', '[]', 'false', '{broken', Buffer.from([0xff])])(
  'rejects malformed manifest %j',
  async (raw) => {
    await writeFile(join(root, 'toolchain.json'), raw);
    await expect(readConnectorAuthoringBundle(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  },
);

it.each(['toolchain.json', 'requirements.txt'])('rejects a missing bundled %s', async (name) => {
  await rm(join(root, name));
  await expect(readConnectorAuthoringBundle(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it.each([Buffer.from('edited'), Buffer.alloc(0)])(
  'rejects changed requirements bytes',
  async (raw) => {
    await writeFile(join(root, 'requirements.txt'), raw);
    await expect(readConnectorAuthoringBundle(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  },
);

it.each(['relative/assets', 'bad\0path'])(
  'rejects an invalid asset directory %j',
  async (directory) => {
    await expect(readConnectorAuthoringBundle(directory)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  },
);
