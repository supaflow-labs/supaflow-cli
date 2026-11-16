import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareIndexedToolchainEnvironment } from '../../src/lib/connector-environment.js';

const uv = process.env.SUPAFLOW_TEST_UV;

describe.skipIf(!uv)('native index toolchain preparation', () => {
  let root: string;
  let server: Server;
  let requests: string[];
  let requirements: Buffer;
  let wheel: Buffer;
  let corrupt: boolean;
  let filename: string;
  let indexUrl: string;
  let tools: {
    uvExecutable: string;
    pythonExecutable: string;
    uvCacheDir: string;
    configurationDir: string;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'supaflow native index environment '));
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('UV_')) vi.stubEnv(key, undefined);
    }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'SSL_CLIENT_CERT',
    ])
      vi.stubEnv(key, undefined);
    const python = execFileSync(
      'python3',
      ['-I', '-S', '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' },
    ).trim();
    const file = join(root, 'env_fixture-1.0.0-py3-none-any.whl');
    execFileSync(python, [
      '-I',
      '-S',
      '-c',
      `import sys,zipfile
root='env_fixture-1.0.0.dist-info/'
with zipfile.ZipFile(sys.argv[1],'w') as archive:
    archive.writestr(root+'METADATA','Metadata-Version: 2.4\\nName: env-fixture\\nVersion: 1.0.0\\nRequires-Python: >=3.11\\n'+sys.argv[2])
    archive.writestr(root+'WHEEL','Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
    archive.writestr('env_fixture.py','VALUE = "original"\\n')
    archive.writestr('env_fixture-1.0.0.data/scripts/fixture-native','#!/bin/sh\\nexit 0\\n')
    archive.writestr(root+'RECORD',''.join(path+',,\\n' for path in archive.namelist())+root+'RECORD,,\\n')
`,
      file,
      '',
    ]);
    wheel = await readFile(file);
    filename = 'env_fixture-1.0.0-py3-none-any.whl';
    const hash = createHash('sha256').update(wheel).digest('hex');
    requirements = Buffer.from(`env-fixture==1.0.0 --hash=sha256:${hash}\n`);
    requests = [];
    corrupt = false;
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Connection', 'close');
      if (request.url === '/simple/env-fixture/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          `<a href="/wheels/${filename}#sha256=${createHash('sha256').update(wheel).digest('hex')}">fixture</a>`,
        );
      } else if (request.url === `/wheels/${filename}`) {
        response.end(corrupt ? Buffer.concat([wheel, Buffer.from('changed')]) : wheel);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected isolated TCP fixture');
    indexUrl = `http://127.0.0.1:${address.port}/simple`;
    tools = {
      uvExecutable: uv!,
      pythonExecutable: python,
      uvCacheDir: join(root, 'cache'),
      configurationDir: join(root, 'project'),
    };
    await mkdir(tools.configurationDir);
    await writeFile(
      join(tools.configurationDir, 'uv.toml'),
      `[pip]
index-url = "${indexUrl}"
target = ${JSON.stringify(join(root, 'forbidden-config-target'))}
prefix = ${JSON.stringify(join(root, 'forbidden-config-prefix'))}
system = true
link-mode = "symlink"
`,
    );
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
    vi.stubEnv('UV_CONFIG_FILE', join(tools.configurationDir, 'uv.toml'));
    vi.stubEnv('UV_TARGET', join(root, 'forbidden-env-target'));
    vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
    vi.stubEnv('UV_VENV_SEED', 'true');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function installed(python: string): string[] {
    return JSON.parse(
      execFileSync(
        python,
        [
          '-I',
          '-c',
          'import env_fixture,importlib.metadata as m,json; print(json.dumps([env_fixture.VALUE,m.version("env-fixture"),env_fixture.__file__]))',
        ],
        { encoding: 'utf8' },
      ),
    );
  }

  it('uses the configured mirror, fixed target and copies, then reuses cache offline', async () => {
    const first = await prepareIndexedToolchainEnvironment(
      join(root, 'first'),
      requirements,
      tools,
      { offline: false },
    );
    const values = installed(first.pythonExecutable);
    expect(values.slice(0, 2)).toEqual(['original', '1.0.0']);
    expect(await realpath(values[2])).toBe(
      await realpath(join(first.sitePackages, 'env_fixture.py')),
    );
    expect(await readFile(join(first.sitePackages, 'bin/fixture-native'), 'utf8')).toBe(
      '#!/bin/sh\nexit 0\n',
    );
    expect(requests).toContain('/simple/env-fixture/');
    expect(requests).toContain('/wheels/env_fixture-1.0.0-py3-none-any.whl');
    const count = requests.length;
    await writeFile(values[2], 'VALUE = "changed"\n');
    const second = await prepareIndexedToolchainEnvironment(
      join(root, 'second'),
      requirements,
      tools,
      { offline: true },
    );
    expect(installed(second.pythonExecutable).slice(0, 2)).toEqual(['original', '1.0.0']);
    expect(requests).toHaveLength(count);
    expect((await readdir(root)).some((name) => name.startsWith('forbidden'))).toBe(false);
    expect((await readdir(root)).some((name) => name.startsWith('.supaflow-environment-'))).toBe(
      false,
    );
  });

  it('fails a cold offline miss without making even one mirror request', async () => {
    await expect(
      prepareIndexedToolchainEnvironment(join(root, 'missing'), requirements, tools, {
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(requests).toEqual([]);
    expect(
      (await readdir(root)).filter(
        (name) => name === 'missing' || name.startsWith('.supaflow-environment-'),
      ),
    ).toEqual([]);
  });

  it('honors native explicit-config precedence over directory discovery', async () => {
    const projectConfig = join(tools.configurationDir, 'uv.toml');
    const original = await readFile(projectConfig, 'utf8');
    const explicitConfig = join(root, 'explicit-uv.toml');
    await writeFile(explicitConfig, original);
    await writeFile(projectConfig, original.replace('/simple"', '/unused/simple"'));
    vi.stubEnv('UV_CONFIG_FILE', explicitConfig);
    const result = await prepareIndexedToolchainEnvironment(
      join(root, 'explicit'),
      requirements,
      tools,
      { offline: false },
    );
    expect(installed(result.pythonExecutable).slice(0, 2)).toEqual(['original', '1.0.0']);
    expect(requests).toContain('/simple/env-fixture/');
    expect(requests.some((path) => path.startsWith('/unused/'))).toBe(false);
  });

  it('honors UV_NO_CONFIG while retaining the configured index environment', async () => {
    await writeFile(join(tools.configurationDir, 'uv.toml'), 'invalid = [');
    vi.stubEnv('UV_CONFIG_FILE', undefined);
    vi.stubEnv('UV_NO_CONFIG', 'true');
    vi.stubEnv('UV_INDEX_URL', indexUrl);
    const result = await prepareIndexedToolchainEnvironment(
      join(root, 'no-config'),
      requirements,
      tools,
      { offline: false },
    );
    expect(installed(result.pythonExecutable).slice(0, 2)).toEqual(['original', '1.0.0']);
    expect(requests).toContain('/simple/env-fixture/');
  });

  it.skipIf(process.platform === 'win32')(
    'runs a relocatable native binary from its exact published path',
    async () => {
      const file = join(root, 'env_fixture-1.0.0-py3-none-any.whl');
      const platform = execFileSync(
        tools.pythonExecutable,
        [
          '-I',
          '-S',
          '-c',
          'import sysconfig; print(sysconfig.get_platform().replace("-", "_").replace(".", "_"))',
        ],
        { encoding: 'utf8' },
      ).trim();
      const tag = `py3-none-${platform}`;
      execFileSync(tools.pythonExecutable, [
        '-I',
        '-S',
        '-c',
        `import sys,zipfile,pathlib
with zipfile.ZipFile(sys.argv[1]) as archive: files={name:archive.read(name) for name in archive.namelist()}
binary='env_fixture-1.0.0.data/scripts/fixture-native-binary'
record='env_fixture-1.0.0.dist-info/RECORD'
files[binary]=pathlib.Path('/usr/bin/true').read_bytes()
files['env_fixture-1.0.0.dist-info/WHEEL']=('Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: '+sys.argv[2]+'\\n').encode()
files[record]=''.join(path+',,\\n' for path in files).encode()
with zipfile.ZipFile(sys.argv[1],'w') as archive:
    for name,raw in files.items():
        info=zipfile.ZipInfo(name)
        info.external_attr=(0o100755 if name==binary else 0o100644)<<16
        archive.writestr(info,raw)
`,
        file,
        tag,
      ]);
      wheel = await readFile(file);
      filename = `env_fixture-1.0.0-${tag}.whl`;
      requirements = Buffer.from(
        `env-fixture==1.0.0 --hash=sha256:${createHash('sha256').update(wheel).digest('hex')}\n`,
      );
      const result = await prepareIndexedToolchainEnvironment(
        join(root, 'native'),
        requirements,
        tools,
        { offline: false },
      );
      expect(
        execFileSync(join(result.sitePackages, 'bin/fixture-native-binary'), [], {
          encoding: 'utf8',
        }),
      ).toBe('');
    },
  );

  it.each(['wrong-hash', 'missing-hash', 'changed-wheel'])(
    'does not publish %s from an index',
    async (kind) => {
      if (kind === 'wrong-hash')
        requirements = Buffer.from(`env-fixture==1.0.0 --hash=sha256:${'0'.repeat(64)}\n`);
      if (kind === 'missing-hash') requirements = Buffer.from('env-fixture==1.0.0\n');
      if (kind === 'changed-wheel') corrupt = true;
      await expect(
        prepareIndexedToolchainEnvironment(join(root, 'invalid'), requirements, tools, {
          offline: false,
        }),
      ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
      expect(
        (await readdir(root)).filter(
          (name) => name === 'invalid' || name.startsWith('.supaflow-environment-'),
        ),
      ).toEqual([]);
      expect((await readdir(root)).some((name) => name.startsWith('forbidden'))).toBe(false);
    },
  );

  it('checks that the supplied complete requirement set actually satisfies wheel metadata', async () => {
    const file = join(root, 'env_fixture-1.0.0-py3-none-any.whl');
    execFileSync(tools.pythonExecutable, [
      '-I',
      '-S',
      '-c',
      `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive: files={name:archive.read(name) for name in archive.namelist()}
files['env_fixture-1.0.0.dist-info/METADATA']+=b'Requires-Dist: missing-leaf>=1\\n'
with zipfile.ZipFile(sys.argv[1],'w') as archive:
    for name,raw in files.items(): archive.writestr(name,raw)
`,
      file,
    ]);
    wheel = await readFile(file);
    requirements = Buffer.from(
      `env-fixture==1.0.0 --hash=sha256:${createHash('sha256').update(wheel).digest('hex')}\n`,
    );
    await expect(
      prepareIndexedToolchainEnvironment(join(root, 'incomplete'), requirements, tools, {
        offline: false,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect((await readdir(root)).includes('incomplete')).toBe(false);
  });

  it('refuses a wheel selected through foreign platform and Python overrides', async () => {
    const file = join(root, 'env_fixture-1.0.0-py3-none-any.whl');
    const hostMinor = Number(
      execFileSync(
        tools.pythonExecutable,
        ['-I', '-S', '-c', 'import sys; print(sys.version_info.minor)'],
        { encoding: 'utf8' },
      ).trim(),
    );
    const foreignMinor = hostMinor === 13 ? 12 : 13;
    const tag = `cp3${foreignMinor}-cp3${foreignMinor}-manylinux_2_28_x86_64`;
    execFileSync(tools.pythonExecutable, [
      '-I',
      '-S',
      '-c',
      `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive: files={name:archive.read(name) for name in archive.namelist()}
files['env_fixture-1.0.0.dist-info/WHEEL']=('Wheel-Version: 1.0\\nRoot-Is-Purelib: false\\nTag: '+sys.argv[2]+'\\n').encode()
with zipfile.ZipFile(sys.argv[1],'w') as archive:
    for name,raw in files.items(): archive.writestr(name,raw)
`,
      file,
      tag,
    ]);
    wheel = await readFile(file);
    filename = `env_fixture-1.0.0-${tag}.whl`;
    requirements = Buffer.from(
      `env-fixture==1.0.0 --hash=sha256:${createHash('sha256').update(wheel).digest('hex')}\n`,
    );
    const config = join(tools.configurationDir, 'uv.toml');
    await writeFile(
      config,
      (await readFile(config, 'utf8')) +
        `\npython-version = "3.${foreignMinor}"\npython-platform = "x86_64-manylinux_2_28"\n`,
    );
    await expect(
      prepareIndexedToolchainEnvironment(join(root, 'foreign'), requirements, tools, {
        offline: false,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect((await readdir(root)).includes('foreign')).toBe(false);
    expect(requests).toContain(`/wheels/${filename}`);
  });
});
