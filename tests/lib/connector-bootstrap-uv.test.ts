import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bootstrapConnectorToolchain,
  type ConnectorToolchainBundle,
} from '../../src/lib/connector-bootstrap.js';
import { runConnectorToolchain } from '../../src/lib/connector-toolchain.js';

const requirementsPath = process.env.SUPAFLOW_TEST_BOOTSTRAP_REQUIREMENTS;
const wheelDir = process.env.SUPAFLOW_TEST_BOOTSTRAP_WHEELHOUSE;
const uv = process.env.SUPAFLOW_TEST_UV;

describe.skipIf(!requirementsPath)('native public toolchain bootstrap', () => {
  let root: string;
  let server: Server;
  let requests: string[];
  let requirements: Buffer;
  let bundle: ConnectorToolchainBundle;
  let options: {
    cacheDir: string;
    configurationDir: string;
    offline: boolean;
    uvExecutable: string;
  };

  beforeAll(async () => {
    expect(wheelDir && uv).toBeTruthy();
    root = await mkdtemp(join(tmpdir(), 'supaflow bootstrap uv ; '));
    requirements = await readFile(requirementsPath!);
    bundle = {
      schemaVersion: 1,
      requiresPython: '>=3.14,<3.15',
      toolchainVersion: '0.1.0',
      sdkVersion: '1.0.73.dev0',
      runtimeVersion: null,
      testkitVersion: '0.1.0',
      uvVersion: '0.11.5',
      requirementsSha256: createHash('sha256').update(requirements).digest('hex'),
    };
    const files = new Map<string, Buffer>();
    const packages = new Map<string, string[]>();
    for (const filename of (await readdir(wheelDir!)).filter((name) => name.endsWith('.whl'))) {
      const data = await readFile(join(wheelDir!, filename));
      const name = filename.split('-')[0].replaceAll('_', '-').toLowerCase();
      files.set('/wheels/' + filename, data);
      const links = packages.get(name) ?? [];
      links.push(
        `<a href="/wheels/${filename}#sha256=${createHash('sha256').update(data).digest('hex')}">${filename}</a>`,
      );
      packages.set(name, links);
    }
    for (const [name, links] of packages)
      files.set(`/simple/${name}/`, Buffer.from(links.join('\n')));
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url!);
      const raw = files.get(request.url!);
      response.statusCode = raw ? 200 : 404;
      response.setHeader(
        'content-type',
        request.url?.startsWith('/simple/') ? 'text/html' : 'application/octet-stream',
      );
      response.end(raw);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local index address');
    await mkdir(join(root, 'project'));
    await writeFile(
      join(root, 'project', 'uv.toml'),
      `[[index]]\nurl = "http://127.0.0.1:${address.port}/simple/"\ndefault = true\n`,
    );
    for (const key of Object.keys(process.env).filter((key) => key.startsWith('UV_')))
      vi.stubEnv(key, undefined);
    vi.stubEnv('UV_CONFIG_FILE', join(root, 'project', 'uv.toml'));
    options = {
      cacheDir: join(root, 'cache'),
      configurationDir: join(root, 'project'),
      offline: false,
      uvExecutable: uv!,
    };
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('uses the configured mirror and exact public wheels, then reuses the ready environment offline', async () => {
    // Native registry configuration comes from this fixture's root uv.toml.
    const tools = await bootstrapConnectorToolchain(bundle, requirements, options);
    expect(requests.some((path) => path.endsWith('.whl'))).toBe(true);
    expect(
      await runConnectorToolchain(tools.pythonExecutable, {
        protocolVersion: 1,
        operation: 'info',
      }),
    ).toMatchObject({ ok: true });
    const native = await import('node:child_process');
    const absent = native.execFileSync(
      tools.pythonExecutable,
      [
        '-I',
        '-c',
        "import importlib.util; assert importlib.util.find_spec('dlt') is None; assert importlib.util.find_spec('supaflow_python_runtime') is None",
      ],
      { encoding: 'utf8' },
    );
    expect(absent).toBe('');
    requests.length = 0;
    expect(
      await bootstrapConnectorToolchain(bundle, requirements, { ...options, offline: true }),
    ).toEqual(tools);
    expect(requests).toEqual([]);
  }, 60_000);

  it('rejects a cold offline miss without network access or a ready environment', async () => {
    requests.length = 0;
    const cold = { ...options, offline: true, cacheDir: join(root, 'cold') };
    await expect(bootstrapConnectorToolchain(bundle, requirements, cold)).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
    });
    expect(requests).toEqual([]);
    expect(await readdir(join(root, 'cold', 'environments'))).toEqual([]);
  }, 60_000);
});
