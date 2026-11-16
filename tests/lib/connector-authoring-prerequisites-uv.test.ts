import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { discoverConnectorAuthoringPrerequisites } from '../../src/lib/connector-authoring-prerequisites.js';

const uv = process.env.SUPAFLOW_TEST_UV;

it.each(['uv', './uv', 'bin/uv', ''])(
  'rejects explicit non-absolute uv through the shared process guard: %j',
  async (uvExecutable) => {
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.11', { uvExecutable }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  },
);

it.skipIf(!uv)(
  'discovers native installed uv and compatible Python without a persistent uv cache',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'supaflow native prerequisites ; '));
    try {
      const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
      await symlink(uv!, join(root, name));
      vi.stubEnv('UV_CACHE_DIR', join(root, 'must-not-create-cache'));
      vi.stubEnv(
        'PATH',
        `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      );
      const result = await discoverConnectorAuthoringPrerequisites('>=3.11');
      expect(result.uvExecutable).toBe(join(root, name));
      expect(result.uvVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.python.version[0]).toBe(3);
      expect(result.python.version[1]).toBeGreaterThanOrEqual(11);
      expect(dirname(result.python.executable)).not.toBe(root);
      expect(await readdir(root)).toEqual([name]);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
