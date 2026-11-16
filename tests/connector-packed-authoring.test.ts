import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
    const featureFile = join(build, 'src/commands/connectors.ts');
    const source = readFileSync(featureFile, 'utf8');
    expect(source).toContain('const CONNECTOR_AUTHORING_ENABLED = false;');
    // This non-production build enables the same reviewed entrypoint with test-index assets.
    writeFileSync(
      featureFile,
      source.replace(
        'const CONNECTOR_AUTHORING_ENABLED = false;',
        'const CONNECTOR_AUTHORING_ENABLED = true;',
      ),
    );
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
    mkdirSync(assets, { recursive: true });
    const input = join(root, 'bootstrap.in'),
      requirementsFile = join(assets, 'requirements.txt');
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
    const requirements = readFileSync(requirementsFile);
    writeFileSync(
      join(assets, 'toolchain.json'),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: VERSION,
        requiresPython: '>=3.14,<3.15',
        sdkVersion: versions[0],
        runtimeVersion: versions[1],
        testkitVersion: versions[2],
        toolchainVersion: versions[3],
        uvVersion: versions[4],
        requirementsSha256: createHash('sha256').update(requirements).digest('hex'),
        projectRequiresPython: '>=3.11,<3.15',
        requiredHostProtocol: 2,
        agentExecutionPython: '>=3.14,<3.15',
        templateVersions: { 'custom-source': 1, 'api-source': 1, 'sql-source': 1 },
        // Local fixture inventory only; this does not certify Linux execution.
        agentTargets: [inventory.target],
      }),
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
    (template, group) => {
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
            group === 'io.supaflow' ? 'ACME' : 'CUSTOM__COM_ACME__ACME',
            template,
          ],
          { cwd: root, env: environment, stdio: 'pipe', timeout: 30_000 },
        );
    },
    180_000,
  );
});
