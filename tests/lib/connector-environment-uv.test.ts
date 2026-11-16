import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOfflineConnectorEnvironment } from '../../src/lib/connector-environment.js';

const uv = process.env.SUPAFLOW_TEST_UV;

describe.skipIf(!uv)('real offline environment preparation', () => {
  let root: string;
  let wheel: string;
  let python: string;
  let requirements: Buffer;
  let tools: {
    uvExecutable: string;
    pythonExecutable: string;
    wheelDir: string;
    uvCacheDir: string;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'supaflow real env ; '));
    const wheels = join(root, 'wheels');
    await mkdir(wheels);
    wheel = join(wheels, 'env_fixture-1.0.0-py3-none-any.whl');
    python = execFileSync('python3', ['-I', '-S', '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
    execFileSync(python, [
      '-I',
      '-S',
      '-c',
      `import sys,zipfile
root='env_fixture-1.0.0.dist-info/'
with zipfile.ZipFile(sys.argv[1],'w') as archive:
    archive.writestr(root+'METADATA','Metadata-Version: 2.4\\nName: env-fixture\\nVersion: 1.0.0\\nRequires-Python: >=3.11\\n')
    archive.writestr(root+'WHEEL','Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
    archive.writestr(root+'entry_points.txt','[console_scripts]\\nenv-fixture = env_fixture:main\\n')
    archive.writestr(root+'RECORD','')
    archive.writestr('env_fixture.py','import sys\\nVALUE = "original"\\ndef main():\\n    print(sys.prefix)\\n')
`,
      wheel,
    ]);
    const digest = createHash('sha256')
      .update(await readFile(wheel))
      .digest('hex');
    requirements = Buffer.from(`env-fixture==1.0.0 --hash=sha256:${digest}\n`);
    tools = {
      uvExecutable: uv!,
      pythonExecutable: python,
      wheelDir: wheels,
      uvCacheDir: join(root, 'cache'),
    };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes a relocatable runnable environment and isolates copied files from cache reuse', async () => {
    const output = join(root, 'published');
    vi.stubEnv('UV_TARGET', join(root, 'forbidden-target'));
    vi.stubEnv('UV_VENV_SEED', 'true');
    vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
    const selected = await prepareOfflineConnectorEnvironment(output, requirements, tools);
    const script = join(
      output,
      process.platform === 'win32' ? 'Scripts/env-fixture.exe' : 'bin/env-fixture',
    );
    expect(await realpath(execFileSync(script, [], { encoding: 'utf8' }).trim())).toBe(
      await realpath(output),
    );
    const code =
      'import env_fixture,importlib.metadata as m,json; print(json.dumps([env_fixture.VALUE,m.version("env-fixture"),env_fixture.__file__]))';
    const [value, version, module] = JSON.parse(
      execFileSync(selected, ['-I', '-c', code], { encoding: 'utf8' }),
    );
    expect([value, version]).toEqual(['original', '1.0.0']);
    expect(
      execFileSync(
        selected,
        [
          '-I',
          '-c',
          'import importlib.util as u; assert u.find_spec("pip") is None; assert u.find_spec("setuptools") is None',
        ],
        { encoding: 'utf8' },
      ),
    ).toBe('');
    const verificationEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')),
    );
    expect(
      execFileSync(
        uv!,
        ['pip', 'freeze', '--python', selected, '--offline', '--no-config', '--no-cache'],
        {
          encoding: 'utf8',
          env: verificationEnv,
        },
      ).trim(),
    ).toBe('env-fixture==1.0.0');
    execFileSync(
      uv!,
      ['pip', 'check', '--python', selected, '--offline', '--no-config', '--no-cache'],
      { env: verificationEnv },
    );
    await writeFile(module, 'VALUE = "changed"\n');
    const second = await prepareOfflineConnectorEnvironment(
      join(root, 'second'),
      requirements,
      tools,
    );
    expect(JSON.parse(execFileSync(second, ['-I', '-c', code], { encoding: 'utf8' }))[0]).toBe(
      'original',
    );
    expect((await readdir(root)).some((name) => name.startsWith('.supaflow-environment-'))).toBe(
      false,
    );
    expect((await readdir(root)).includes('forbidden-target')).toBe(false);
  });

  it.each(['missing-wheel', 'changed-wheel', 'missing-hash', 'missing-dependency'])(
    'does not publish invalid input: %s',
    async (kind) => {
      if (kind === 'missing-wheel') await rm(wheel);
      if (kind === 'changed-wheel') {
        vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
        execFileSync(python, [
          '-I',
          '-S',
          '-c',
          "import sys,zipfile; a=zipfile.ZipFile(sys.argv[1],'a'); a.writestr('added.txt','changed'); a.close()",
          wheel,
        ]);
      }
      if (kind === 'missing-hash') requirements = Buffer.from('env-fixture==1.0.0\n');
      if (kind === 'missing-dependency') {
        execFileSync(python, [
          '-I',
          '-S',
          '-c',
          `import sys,zipfile,pathlib
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(p) as archive: files={name:archive.read(name) for name in archive.namelist()}
key='env_fixture-1.0.0.dist-info/METADATA'; files[key]+=b'Requires-Dist: missing-leaf>=1\\n'
with zipfile.ZipFile(p,'w') as archive:
    for name,raw in files.items(): archive.writestr(name,raw)
`,
          wheel,
        ]);
        requirements = Buffer.from(
          `env-fixture==1.0.0 --hash=sha256:${createHash('sha256')
            .update(await readFile(wheel))
            .digest('hex')}\n`,
        );
      }
      await expect(
        prepareOfflineConnectorEnvironment(join(root, 'must-not-exist'), requirements, tools),
      ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
      expect(
        (await readdir(root)).filter(
          (name) => name === 'must-not-exist' || name.startsWith('.supaflow-environment-'),
        ),
      ).toEqual([]);
    },
  );
});
