import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeConnectorPython } from '../../src/lib/connector-python-probe.js';

let root: string;
let python: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'supaflow Python probe ; '));
  const environment = join(root, 'empty environment');
  execFileSync('python3', ['-I', '-m', 'venv', '--without-pip', environment]);
  python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('package-free Python interpreter probe', () => {
  it('reports a clean interpreter without SDK, pip or toolchain packages', async () => {
    const output = await probeConnectorPython(python);
    expect(realpathSync(output.executable)).toBe(realpathSync(python));
    expect(output.version).toHaveLength(3);
    expect(output.version.every((part) => Number.isSafeInteger(part))).toBe(true);
    expect(output.implementation).toBe('cpython');
    execFileSync(python, [
      '-I',
      '-S',
      '-B',
      '-c',
      "import importlib.util; assert all(importlib.util.find_spec(name) is None for name in ('pip','supaflow_python_sdk','supaflow_connector_toolchain'))",
    ]);
  });

  it('refuses implicit PATH/CWD executable lookup', async () => {
    await expect(probeConnectorPython('python3')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('skips CWD modules and site hooks without changing the project', () => {
    const shadow = join(root, 'shadow');
    mkdirSync(shadow);
    writeFileSync(join(shadow, 'json.py'), 'raise RuntimeError("CWD must not import")\n');
    const site = execFileSync(
      python,
      ['-I', '-B', '-c', "import sysconfig; print(sysconfig.get_path('purelib'))"],
      { encoding: 'utf8' },
    ).trim();
    const trap = "from pathlib import Path; Path('site-hook-ran').write_text('must not run')\n";
    writeFileSync(join(site, 'sitecustomize.py'), trap);
    writeFileSync(
      join(site, 'hook.pth'),
      'import pathlib; pathlib.Path("site-hook-ran").write_text("must not run")\n',
    );
    try {
      // Compile only these bootstrap modules, then exercise them outside the
      // checkout so isolation is observed by an actual Python child.
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
        'src/lib/connector-python-probe.ts',
      ]);
      const url = pathToFileURL(join(root, 'compiled/connector-python-probe.js')).href;
      const program = `import {probeConnectorPython} from ${JSON.stringify(url)}; console.log(JSON.stringify(await probeConnectorPython(${JSON.stringify(python)})));`;
      const output = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', program], {
          cwd: shadow,
          encoding: 'utf8',
        }),
      );
      expect(realpathSync(output.executable)).toBe(realpathSync(python));
      expect(readdirSync(shadow)).toEqual(['json.py']);
      expect(existsSync(join(site, '__pycache__'))).toBe(false);
      expect(readFileSync(join(shadow, 'json.py'), 'utf8')).toContain('CWD must not import');
    } finally {
      rmSync(join(site, 'sitecustomize.py'));
      rmSync(join(site, 'hook.pth'));
    }
  }, 30_000);

  it.each(['', 'bad\0python'])('rejects an invalid executable %j', async (executable) => {
    await expect(probeConnectorPython(executable)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reports an unavailable executable safely', async () => {
    await expect(probeConnectorPython(join(root, 'missing'))).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('honors cancellation before starting a process', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeConnectorPython(join(root, 'missing'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid timeout %s', async (timeoutMs) => {
    await expect(probeConnectorPython(python, { timeoutMs })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
