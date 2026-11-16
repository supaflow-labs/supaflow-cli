import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareIndexedToolchainEnvironment,
  prepareLockedProjectEnvironment,
} from '../../src/lib/connector-environment.js';
import { runPythonProcess } from '../../src/lib/connector-python-process.js';

const uv = process.env.SUPAFLOW_TEST_UV;

describe.skipIf(!uv)('native index toolchain preparation', () => {
  let root: string;
  let server: Server;
  let requests: string[];
  let requirements: Buffer;
  let wheel: Buffer;
  let corrupt: boolean;
  let authentication: boolean;
  let authorizedRequests: number;
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
      process.env.SUPAFLOW_TEST_PYTHON ?? 'python3',
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
    archive.writestr('env_fixture.py','import sys\\nVALUE = "original"\\ndef main():\\n    print(sys.prefix)\\n')
    archive.writestr(root+'entry_points.txt','[console_scripts]\\nenv-fixture = env_fixture:main\\n')
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
    authentication = false;
    authorizedRequests = 0;
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Connection', 'close');
      if (request.url === '/simple/env-fixture/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          `<a href="/wheels/${filename}#sha256=${createHash('sha256').update(wheel).digest('hex')}">fixture</a>`,
        );
      } else if (request.url === `/wheels/${filename}`) {
        if (
          authentication &&
          request.headers.authorization !==
            `Basic ${Buffer.from('TEST_USER:TEST_ONLY_PASSWORD').toString('base64')}`
        ) {
          response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
          response.end();
          return;
        }
        if (authentication) authorizedRequests++;
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

  async function nativePylock(refresh = false): Promise<Buffer> {
    const input = join(root, 'requirements.in');
    const output = join(root, 'pylock.toml');
    await writeFile(input, requirements);
    await runPythonProcess(
      uv!,
      [
        'pip',
        'compile',
        input,
        '--python',
        tools.pythonExecutable,
        '--default-index',
        indexUrl,
        '--only-binary=:all:',
        '--generate-hashes',
        '--format',
        'pylock.toml',
        '--preview-features',
        'pylock',
        '--no-header',
        '--output-file',
        output,
        '--no-config',
        '--no-python-downloads',
        '--cache-dir',
        join(root, 'compile-cache'),
        '--quiet',
        ...(refresh ? ['--refresh'] : []),
      ],
      null,
      (_raw, status) => {
        expect(status).toBe(0);
      },
      {
        stderr: 'ignore',
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')),
        ),
      },
    );
    return readFile(output);
  }

  it('installs native project lock URLs into a normal relocatable venv and reuses copies offline', async () => {
    const lock = await nativePylock();
    requests.length = 0;
    const output = join(root, 'project-venv');
    const python = await prepareLockedProjectEnvironment(output, lock, tools, { offline: false });
    expect(requests).toEqual([`/wheels/${filename}`]);
    const script = join(
      output,
      process.platform === 'win32' ? 'Scripts/env-fixture.exe' : 'bin/env-fixture',
    );
    expect(await realpath(execFileSync(script, [], { encoding: 'utf8' }).trim())).toBe(
      await realpath(output),
    );
    expect(installed(python).slice(0, 2)).toEqual(['original', '1.0.0']);
    await writeFile(installed(python)[2], 'VALUE = "changed"\n');
    requests.length = 0;
    const second = await prepareLockedProjectEnvironment(
      join(root, 'second-project-venv'),
      lock,
      tools,
      { offline: true },
    );
    expect(installed(second).slice(0, 2)).toEqual(['original', '1.0.0']);
    expect(requests).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith('forbidden'))).toBe(false);
  });

  it('syncs a normal project venv in place, reuses it offline and applies a new native solution', async () => {
    const lock = await nativePylock();
    const output = join(root, 'project .venv ;');
    const python = await prepareLockedProjectEnvironment(output, lock, tools, {
      offline: false,
      reuseExisting: true,
    });
    await writeFile(join(output, 'sentinel'), 'keep environment');
    requests.length = 0;
    expect(
      await prepareLockedProjectEnvironment(output, lock, tools, {
        offline: true,
        reuseExisting: true,
      }),
    ).toBe(python);
    expect(requests).toEqual([]);
    const updated = join(root, 'env_fixture-2.0.0-py3-none-any.whl');
    execFileSync(tools.pythonExecutable, [
      '-I',
      '-S',
      '-c',
      `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2],'w') as target:
    for name in source.namelist():
        raw=source.read(name).replace(b'1.0.0',b'2.0.0').replace(b'"original"',b'"upgraded"')
        target.writestr(name.replace('1.0.0','2.0.0'),raw)
`,
      join(root, filename),
      updated,
    ]);
    wheel = await readFile(updated);
    filename = 'env_fixture-2.0.0-py3-none-any.whl';
    requirements = Buffer.from(
      `env-fixture==2.0.0 --hash=sha256:${createHash('sha256').update(wheel).digest('hex')}\n`,
    );
    const next = await nativePylock(true);
    requests.length = 0;
    expect(
      await prepareLockedProjectEnvironment(output, next, tools, {
        offline: false,
        reuseExisting: true,
      }),
    ).toBe(python);
    expect(installed(python).slice(0, 2)).toEqual(['upgraded', '2.0.0']);
    expect(requests.every((path) => path === `/wheels/${filename}`)).toBe(true);
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('keep environment');
    expect((await readdir(root)).some((name) => name.startsWith('.supaflow-environment-'))).toBe(
      false,
    );
  });

  it('does not run installed startup hooks during the reuse probe', async () => {
    const lock = await nativePylock();
    const output = join(root, 'hook-environment');
    const python = await prepareLockedProjectEnvironment(output, lock, tools, { offline: false });
    const library = execFileSync(
      python,
      ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
      { encoding: 'utf8' },
    ).trim();
    const marker = join(root, 'startup-hook-ran');
    await writeFile(
      join(library, 'test-startup-hook.pth'),
      `import pathlib; pathlib.Path(${JSON.stringify(marker)}).touch(); print("startup hook")\n`,
    );
    // Fail the installer deliberately, so this tests only the package-free
    // pre-install probe. Native uv may execute environment hooks itself.
    await expect(
      prepareLockedProjectEnvironment(
        output,
        lock,
        { ...tools, uvExecutable: process.execPath },
        {
          offline: true,
          reuseExisting: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect((await readdir(root)).includes('startup-hook-ran')).toBe(false);
  });

  it('rejects a native system-site venv before syncing and preserves its configuration', async () => {
    const lock = await nativePylock();
    const output = join(root, 'system-site');
    execFileSync(
      uv!,
      [
        'venv',
        output,
        '--python',
        tools.pythonExecutable,
        '--system-site-packages',
        '--no-seed',
        '--offline',
        '--no-config',
        '--no-cache',
        '--no-python-downloads',
        '--quiet',
      ],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')),
        ),
      },
    );
    const configuration = await readFile(join(output, 'pyvenv.cfg'));
    requests.length = 0;
    await expect(
      prepareLockedProjectEnvironment(output, lock, tools, { offline: false, reuseExisting: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toEqual([]);
    expect(await readFile(join(output, 'pyvenv.cfg'))).toEqual(configuration);
  });

  it('rejects a shadowing interpreter config before it can enable system site packages', async () => {
    const lock = await nativePylock();
    const output = join(root, 'shadow-config');
    await prepareLockedProjectEnvironment(output, lock, tools, { offline: false });
    const configuration = await readFile(join(output, 'pyvenv.cfg'));
    const shadow = join(
      output,
      process.platform === 'win32' ? 'Scripts/pyvenv.cfg' : 'bin/pyvenv.cfg',
    );
    await writeFile(
      shadow,
      configuration
        .toString('utf8')
        .replace('include-system-site-packages = false', 'include-system-site-packages = true'),
    );
    expect(await readFile(shadow, 'utf8')).toContain('include-system-site-packages = true');
    requests.length = 0;
    await expect(
      prepareLockedProjectEnvironment(output, lock, tools, { offline: false, reuseExisting: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toEqual([]);
    expect(await readFile(join(output, 'pyvenv.cfg'))).toEqual(configuration);
    expect(await readFile(shadow, 'utf8')).toContain('include-system-site-packages = true');
  });

  it.each(['offline', 'corrupt', 'hashless'])(
    'never publishes a native project environment after %s failure',
    async (kind) => {
      let lock = await nativePylock();
      const coldTools = { ...tools, uvCacheDir: join(root, 'cold-cache') };
      requests.length = 0;
      if (kind === 'corrupt') corrupt = true;
      if (kind === 'hashless')
        lock = Buffer.from(lock.toString('utf8').replace(/,\s*hashes\s*=\s*\{[^}]+\}/g, ''));
      if (kind === 'hashless') expect(lock).not.toEqual(await readFile(join(root, 'pylock.toml')));
      vi.stubEnv('UV_HTTP_RETRIES', '0');
      await expect(
        prepareLockedProjectEnvironment(join(root, 'failed-project-venv'), lock, coldTools, {
          offline: kind === 'offline',
        }),
      ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
      if (kind === 'offline') expect(requests).toEqual([]);
      expect(
        (await readdir(root)).filter(
          (name) => name === 'failed-project-venv' || name.startsWith('.supaflow-environment-'),
        ),
      ).toEqual([]);
    },
  );

  it('uses native uv credentials for a locked private-mirror URL', async () => {
    const lock = await nativePylock();
    const credentials = join(root, 'test-credentials');
    vi.stubEnv('UV_CREDENTIALS_DIR', credentials);
    vi.stubEnv('UV_KEYRING_PROVIDER', 'disabled');
    vi.stubEnv('UV_HTTP_RETRIES', '0');
    // Verify the native storage override before login can write anything.
    await runPythonProcess(
      uv!,
      ['auth', 'dir', '--no-config', '--no-cache'],
      null,
      (raw, status) => {
        expect(status).toBe(0);
        expect(raw.toString('utf8').trim()).toBe(credentials);
      },
      { stderr: 'ignore' },
    );
    authentication = true;
    requests.length = 0;
    await expect(
      prepareLockedProjectEnvironment(
        join(root, 'unauthorized-project'),
        lock,
        { ...tools, uvCacheDir: join(root, 'unauthorized-cache') },
        { offline: false },
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(requests).toContain(`/wheels/${filename}`);
    expect(authorizedRequests).toBe(0);
    expect((await readdir(root)).includes('unauthorized-project')).toBe(false);
    await runPythonProcess(
      uv!,
      [
        'auth',
        'login',
        indexUrl.replace('/simple', ''),
        '--username',
        'TEST_USER',
        '--password',
        'TEST_ONLY_PASSWORD',
        '--keyring-provider',
        'disabled',
        '--no-config',
        '--no-cache',
      ],
      null,
      (_raw, status) => {
        expect(status).toBe(0);
      },
      { stderr: 'ignore' },
    );
    requests.length = 0;
    const selected = await prepareLockedProjectEnvironment(
      join(root, 'private-project'),
      lock,
      { ...tools, uvCacheDir: join(root, 'private-cache') },
      { offline: false },
    );
    expect(authorizedRequests).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((path) => path === `/wheels/${filename}`)).toBe(true);
    expect(installed(selected).slice(0, 2)).toEqual(['original', '1.0.0']);
  });

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
  it('honors inherited offline mode on a cold native index cache', async () => {
    vi.stubEnv('UV_OFFLINE', 'true');
    const result = await prepareIndexedToolchainEnvironment(
      join(root, 'cold'),
      requirements,
      tools,
      {
        offline: false,
      },
    ).catch((error) => error);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ code: 'PROCESS_FAILED' });
    await expect(readFile(join(root, 'cold'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
