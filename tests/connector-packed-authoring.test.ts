import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const python = process.env.SUPAFLOW_TEST_TOOLCHAIN_PYTHON;
const uv = process.env.SUPAFLOW_TEST_UV;
const wheels = [
  process.env.SUPAFLOW_TEST_SDK_WHEEL,
  process.env.SUPAFLOW_TEST_RUNTIME_WHEEL,
  process.env.SUPAFLOW_TEST_TESTKIT_WHEEL,
  process.env.SUPAFLOW_TEST_TOOLCHAIN_WHEEL,
  process.env.SUPAFLOW_TEST_UV_WHEEL,
];

describe.skipIf(!python)('packed connector authoring from a clean prefix', () => {
  let root: string, executable: string, environment: NodeJS.ProcessEnv, versions: string[];
  beforeAll(() => {
    expect(
      uv &&
        process.env.SUPAFLOW_TEST_BUNDLE_PRODUCER &&
        wheels.every(Boolean) &&
        process.env.SUPAFLOW_TEST_RUNTIME_WHEELHOUSE &&
        process.env.SUPAFLOW_TEST_BUILD_WHEELHOUSE,
    ).toBeTruthy();
    root = mkdtempSync(join(tmpdir(), 'supaflow packed authoring ; '));
    const build = join(root, 'cli-build'),
      wheelhouse = join(root, 'wheels'),
      index = join(root, 'simple');
    mkdirSync(build);
    mkdirSync(wheelhouse);
    for (const entry of ['src', 'bin', 'package.json', 'tsconfig.json', 'tsup.config.ts'])
      cpSync(join(process.cwd(), entry), join(build, entry), { recursive: true });
    // Build tooling may use the checkout; the installed package below cannot.
    symlinkSync(join(process.cwd(), 'node_modules'), join(build, 'node_modules'), 'dir');
    writeFileSync(join(build, '.npmrc'), 'ignore-scripts=true\n');
    const featureFile = join(build, 'src/lib/connector-authoring-feature.ts');
    const source = readFileSync(featureFile, 'utf8');
    // Exercise the release entrypoint without rewriting its activation flag.
    expect(source).toContain('const CONNECTOR_AUTHORING_ENABLED = true;');
    for (const directory of [
      process.env.SUPAFLOW_TEST_RUNTIME_WHEELHOUSE!,
      process.env.SUPAFLOW_TEST_BUILD_WHEELHOUSE!,
    ])
      cpSync(directory, wheelhouse, { recursive: true });
    for (const wheel of wheels) cpSync(wheel!, join(wheelhouse, basename(wheel!)));
    const inventory = JSON.parse(
      execFileSync(
        python!,
        [
          '-I',
          '-c',
          `
from email.parser import BytesParser
import hashlib,json,pathlib,re,sys,zipfile
from packaging.markers import default_environment
from packaging.tags import sys_tags
directory,index=map(pathlib.Path,sys.argv[1:3]); groups={}
for wheel in directory.glob('*.whl'):
    with zipfile.ZipFile(wheel) as archive:
        name,=[name for name in archive.namelist() if name.count('/')==1 and name.endswith('.dist-info/METADATA')]
        metadata=BytesParser().parsebytes(archive.read(name))
    name=re.sub(r'[-_.]+','-',metadata['Name']).lower()
    groups.setdefault(name,[]).append(f'<a href="{wheel.as_uri()}#sha256={hashlib.sha256(wheel.read_bytes()).hexdigest()}">{wheel.name}</a>')
for name,links in groups.items():
    target=index/name;target.mkdir(parents=True)
    (target/'index.html').write_text('\\n'.join(links))
versions=[]
for filename in sys.argv[3:]:
    with zipfile.ZipFile(filename) as archive:
        name,=[name for name in archive.namelist() if name.count('/')==1 and name.endswith('.dist-info/METADATA')]
        versions.append(BytesParser().parsebytes(archive.read(name))['Version'])
print(json.dumps({'versions':versions,'target':{'name':'fixture-local-agent','environment':default_environment(),'wheelTags':[str(tag) for tag in sys_tags()]}}))
`,
          wheelhouse,
          index,
          ...(wheels as string[]),
        ],
        { encoding: 'utf8', timeout: 30_000 },
      ),
    );
    versions = inventory.versions;
    const assets = join(build, 'assets/connectors');
    mkdirSync(join(build, 'assets'), { recursive: true });
    const input = join(root, 'bootstrap.in'),
      requirementsFile = join(root, 'requirements.txt');
    writeFileSync(
      input,
      [
        'supaflow-python-sdk',
        'supaflow-connector-runtime',
        'supaflow-connector-testkit',
        'supaflow-connector-toolchain',
        'uv',
      ]
        .map((name, i) => `${name}==${versions[i]}\n`)
        .join(''),
    );
    const nativeEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('UV_')),
    );
    execFileSync(
      uv!,
      [
        'pip',
        'compile',
        input,
        '--python',
        python!,
        '--offline',
        '--no-config',
        '--no-python-downloads',
        '--only-binary=:all:',
        '--generate-hashes',
        '--no-header',
        '--no-annotate',
        '--default-index',
        pathToFileURL(index).href,
        '--cache-dir',
        join(root, 'resolve-cache'),
        '--output-file',
        requirementsFile,
      ],
      { env: nativeEnvironment, stdio: 'pipe', timeout: 60_000 },
    );
    const selected = join(root, 'public-wheels');
    mkdirSync(selected);
    for (const wheel of wheels.slice(0, 4)) cpSync(wheel!, join(selected, basename(wheel!)));
    const targets = join(root, 'targets.json');
    writeFileSync(targets, JSON.stringify([inventory.target]));
    // Exercise the production producer with local test-index requirements.
    execFileSync(
      python!,
      [
        process.env.SUPAFLOW_TEST_BUNDLE_PRODUCER!,
        '--wheel-dir',
        selected,
        '--requirements',
        requirementsFile,
        '--targets',
        targets,
        '--source-commit',
        'a'.repeat(40),
        '--cli-version',
        VERSION,
        '--uv-version',
        versions[4],
        '--requires-python',
        '>=3.14,<3.15',
        '--project-python',
        '>=3.11,<3.15',
        '--execution-python',
        '>=3.14,<3.15',
        '--host-protocol',
        '2',
        '--output',
        assets,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    execFileSync('npm', ['run', 'build'], { cwd: build, stdio: 'pipe', timeout: 60_000 });
    const packed = JSON.parse(
      execFileSync(
        'npm',
        [
          'pack',
          '--json',
          '--ignore-scripts',
          '--cache',
          join(root, 'npm-cache'),
          '--pack-destination',
          root,
        ],
        {
          cwd: build,
          encoding: 'utf8',
          timeout: 30_000,
        },
      ),
    );
    expect(packed).toHaveLength(1);
    const prefix = join(root, 'installed');
    mkdirSync(prefix);
    const config = join(root, 'empty.npmrc'),
      globalConfig = join(root, 'global.npmrc');
    writeFileSync(config, 'ignore-scripts=true\n');
    writeFileSync(globalConfig, 'ignore-scripts=true\n');
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(root, 'npm-cache'),
        '--registry',
        'https://registry.npmjs.org/',
        '--userconfig',
        config,
        '--globalconfig',
        globalConfig,
        join(root, packed[0].filename),
      ],
      { cwd: root, stdio: 'pipe', timeout: 60_000 },
    );
    executable = join(prefix, 'node_modules/@getsupaflow/cli/bin/supaflow.mjs');
    environment = {
      ...Object.fromEntries(
        Object.entries(nativeEnvironment).filter(([key]) => !key.startsWith('SUPAFLOW_')),
      ),
      PATH: dirname(uv!) + delimiter + process.env.PATH,
      XDG_CACHE_HOME: join(root, 'user-cache'),
      XDG_CONFIG_HOME: join(root, 'user-config'),
      UV_DEFAULT_INDEX: pathToFileURL(index).href,
      UV_CREDENTIALS_DIR: join(root, 'unused-credentials'),
      UV_OFFLINE: 'true',
      SUPAFLOW_APP_URL: 'http://127.0.0.1:1',
    };
  }, 180_000);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['custom-source', 'com.acme'],
    ['api-source', 'com.acme'],
    ['sql-source', 'com.acme'],
    ['custom-source', 'io.supaflow'],
  ])(
    'runs init/lock/check/test/build for %s (%s) without checkout imports or login',
    async (template, group) => {
      const project = join(root, template + (group === 'io.supaflow' ? '-first-party' : ''));
      const invoke = (args: string[]) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [executable, '--json', 'connectors', ...args, '--offline'],
            {
              cwd: root,
              env: environment,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120_000,
            },
          ),
        );
      expect(
        invoke(['init', project, '--template', template, '--name', 'ACME', '--group', group]),
      ).toEqual({ projectDir: project });
      const inputs = ['runtime.lock', 'deps/pyproject.toml', 'deps/uv.lock', 'pyproject.toml'];
      const before = inputs.map((name) => readFileSync(join(project, name)));
      // A hand-authored project's first lock uses the same native selector as init.
      for (const name of inputs.slice(0, 3)) rmSync(join(project, name));
      const missing = spawnSync(
        process.execPath,
        [executable, '--json', 'connectors', 'lock', '--check', '--project', project, '--offline'],
        { cwd: root, env: environment, encoding: 'utf8', timeout: 120_000 },
      );
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stdout).error.code).toBe('MISSING_RUNTIME_LOCK');
      expect(existsSync(join(project, 'runtime.lock'))).toBe(false);
      expect(invoke(['lock', '--project', project])).toEqual({ locked: true });
      inputs.forEach((name, i) => expect(readFileSync(join(project, name))).toEqual(before[i]));
      expect(invoke(['lock', '--check', '--project', project])).toEqual({ checked: true });
      expect(invoke(['lock', '--project', project])).toEqual({ locked: true });
      const unchangedDiff = {
        before: before[0].toString('utf8'),
        after: before[0].toString('utf8'),
      };
      expect(invoke(['lock', '--upgrade-runtime', '--project', project])).toEqual({
        locked: true,
        runtimeLockDiff: unchangedDiff,
      });
      expect(
        invoke([
          'lock',
          '--upgrade-runtime',
          '--to',
          versions[template === 'custom-source' ? 0 : 1],
          '--project',
          project,
        ]),
      ).toEqual({ locked: true, runtimeLockDiff: unchangedDiff });
      const rejected = spawnSync(
        process.execPath,
        [
          executable,
          '--json',
          'connectors',
          'lock',
          '--upgrade-runtime',
          '--to',
          '999.0.0',
          '--project',
          project,
          '--offline',
        ],
        { cwd: root, env: environment, encoding: 'utf8', timeout: 120_000 },
      );
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stdout).error.code).toBe('LOCK_FAILED');
      expect(invoke(['check', '--project', project])).toEqual({ checked: true });
      expect(invoke(['test', '--project', project])).toEqual({ tested: true });
      const artifactDir = join(root, basename(project) + '-artifact');
      expect(invoke(['build', '--project', project, '--output', artifactDir])).toEqual({
        artifactDir,
      });
      const defaultBuild = invoke(['build', '--project', project]);
      const defaultArtifact = defaultBuild.artifactDir;
      expect(defaultArtifact).toBe(
        join(project, 'dist', 'supaflow-connector-acme-python', '0.1.0.dev1'),
      );
      // Rebuild the same coordinate through the actual packed executable.
      expect(invoke(['build', '--project', project])).toEqual(defaultBuild);
      inputs.forEach((name, i) => expect(readFileSync(join(project, name))).toEqual(before[i]));
      const projectPython = join(
        project,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      );
      for (const checkedArtifact of [artifactDir, defaultArtifact])
        execFileSync(
          projectPython,
          [
            '-I',
            '-B',
            '-c',
            `
import importlib.util,pathlib,sys,yaml
from supaflow_connector_toolchain.connector_lock import parse_connector_lock,verify_connector_payloads
artifact=pathlib.Path(sys.argv[1]);files={p.relative_to(artifact).as_posix():p.read_bytes() for p in artifact.rglob('*') if p.is_file()}
lock=parse_connector_lock(files['connector.lock']);verify_connector_payloads(lock.raw_bytes,files)
assert yaml.safe_load(files['connector.yaml'])['connector']['type']==sys.argv[2]
assert importlib.util.find_spec('supaflow_python_runtime') is None
assert (importlib.util.find_spec('dlt') is None)==(sys.argv[3]=='custom-source')
`,
            checkedArtifact,
            group === 'io.supaflow' ? 'ACME' : 'COM_ACME__ACME',
            template,
          ],
          { cwd: root, env: environment, stdio: 'pipe', timeout: 30_000 },
        );
      if (group === 'io.supaflow') {
        const client = new Client({ name: 'packed-authoring-fixture', version: '1' });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [executable, 'mcp'],
          cwd: root,
          env: Object.fromEntries(
            Object.entries(environment).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          stderr: 'pipe',
        });
        try {
          await client.connect(transport);
          const listed = await client.listTools();
          expect(listed.tools).toHaveLength(61);
          const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await client.callTool(
              { name, arguments: { project_dir: project, offline: true, ...args } },
              undefined,
              { timeout: 120_000 },
            );
            expect(result.isError).not.toBe(true);
            const content = result.content as { type: string; text: string }[];
            expect(content).toHaveLength(1);
            expect(content[0].type).toBe('text');
            return JSON.parse(content[0].text);
          };
          expect(await call('connectors_check')).toEqual({ checked: true });
          expect(await call('connectors_test')).toEqual({ tested: true });
          expect((await call('connectors_doctor')).diagnostics).toBeDefined();
          expect(await call('connectors_manifest_check')).toEqual({ manifest: 'connector.yaml' });
          expect(await call('connectors_manifest_generate')).toEqual({
            manifest: 'connector.yaml',
          });
          expect(await call('connectors_lock', { check: true })).toEqual({ checked: true });
          expect(await call('connectors_build')).toEqual(defaultBuild);
          const fresh = join(root, 'mcp-first-party');
          const initialized = await client.callTool(
            {
              name: 'connectors_init',
              arguments: {
                directory: fresh,
                template: 'custom-source',
                name: 'ACME',
                group: 'io.supaflow',
                offline: true,
              },
            },
            undefined,
            { timeout: 120_000 },
          );
          expect(initialized.isError).not.toBe(true);
          expect(JSON.parse((initialized.content as { text: string }[])[0].text)).toEqual({
            projectDir: fresh,
          });
          const rejected = await client.callTool(
            {
              name: 'connectors_build',
              arguments: { project_dir: project, output: artifactDir, offline: true },
            },
            undefined,
            { timeout: 120_000 },
          );
          expect(rejected.isError).toBe(true);
          expect(JSON.parse((rejected.content as { text: string }[])[0].text).error.code).toBe(
            'BUILD_FAILED',
          );
        } finally {
          await client.close();
        }
        inputs.forEach((name, i) => expect(readFileSync(join(project, name))).toEqual(before[i]));
      }
    },
    180_000,
  );
});
