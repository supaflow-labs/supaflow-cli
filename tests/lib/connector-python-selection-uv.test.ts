import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectConnectorPython } from '../../src/lib/connector-python-selection.js';

const uv = process.env.SUPAFLOW_TEST_UV;
if (process.env.CI && !uv) {
  throw new Error('SUPAFLOW_TEST_UV is required for the CI interpreter-selection gate');
}

describe.skipIf(!uv)('real offline uv Python selection', () => {
  let root: string;
  beforeAll(() => {
    expect(isAbsolute(uv!)).toBe(true);
    root = mkdtempSync(join(tmpdir(), 'supaflow Python selection ; '));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('selects an already installed compatible Python and reads its actual release', async () => {
    const selected = await selectConnectorPython(uv!, '>=3.11,<3.15');
    expect(isAbsolute(selected.executable)).toBe(true);
    expect(selected.version[0]).toBe(3);
    expect(selected.version[1]).toBeGreaterThanOrEqual(11);
    expect(selected.version[1]).toBeLessThan(15);
    expect(selected.implementation.length).toBeGreaterThan(0);
  });

  it('reports an unavailable minor from the offline selector', async () => {
    await expect(selectConnectorPython(uv!, '>=99')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('ignores a project pin, malformed local uv config, CWD modules and shell syntax', () => {
    execFileSync(process.execPath, [
      join(process.cwd(), 'node_modules/typescript/bin/tsc'),
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      '--skipLibCheck',
      '--outDir',
      join(root, 'compiled'),
      'src/lib/connector-python-selection.ts',
    ]);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, '.python-version'), '99.0\n');
    writeFileSync(join(root, 'uv.toml'), 'not valid TOML\n');
    writeFileSync(join(root, 'pyproject.toml'), 'not valid TOML\n');
    writeFileSync(join(root, 'json.py'), 'raise RuntimeError("must not import CWD")\n');
    const uvAlias = join(root, 'uv ; shell syntax');
    symlinkSync(uv!, uvAlias);
    const before = readdirSync(root).sort();
    const module = pathToFileURL(join(root, 'compiled/connector-python-selection.js')).href;
    const script = `import {selectConnectorPython} from ${JSON.stringify(module)}; console.log(JSON.stringify(await selectConnectorPython(${JSON.stringify(uvAlias)}, '>=3.11,<3.15')));`;
    const selected = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      }),
    );
    expect(isAbsolute(selected.executable)).toBe(true);
    expect(selected.version[0]).toBe(3);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readFileSync(join(root, '.python-version'), 'utf8')).toBe('99.0\n');
  }, 30_000);

  it('retains absolute executable and cancellation validation', async () => {
    await expect(selectConnectorPython('uv', '>=3.11')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      selectConnectorPython(uv!, '>=3.11', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
