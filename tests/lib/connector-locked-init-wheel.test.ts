import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.SUPAFLOW_TEST_TOOLCHAIN_PYTHON;
const uv = process.env.SUPAFLOW_TEST_UV;
const sdk = process.env.SUPAFLOW_TEST_SDK_WHEEL;
const runtime = process.env.SUPAFLOW_TEST_RUNTIME_WHEEL;
const testkit = process.env.SUPAFLOW_TEST_TESTKIT_WHEEL;
const wheelhouse = process.env.SUPAFLOW_TEST_RUNTIME_WHEELHOUSE;

// The caller-owned public-toolchain fixture includes SQL authoring dependencies.
// This gate installs nothing; environment provisioning is separate bootstrap work.
describe.skipIf(!python)('locked initialization with installed public packages', () => {
  let root: string;
  let versions: string[];

  beforeAll(() => {
    expect(python && uv && sdk && runtime && testkit && wheelhouse).toBeTruthy();
    root = mkdtempSync(join(tmpdir(), 'supaflow locked public init ; '));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(root, 'wheels'));
    for (const wheel of [sdk!, runtime!])
      copyFileSync(wheel, join(root, 'wheels', basename(wheel)));
    versions = JSON.parse(
      execFileSync(
        python!,
        [
          '-I',
          '-c',
          `import email.parser,hashlib,json,pathlib,re,sys,zipfile
groups={}
for wheel in pathlib.Path(sys.argv[1]).glob('*.whl'):
    with zipfile.ZipFile(wheel) as archive:
        entry,=[name for name in archive.namelist() if name.count('/')==1 and name.endswith('.dist-info/METADATA')]
        metadata=email.parser.BytesParser().parsebytes(archive.read(entry))
    name=re.sub(r'[-_.]+','-',metadata['Name']).lower()
    assert re.fullmatch('[a-z0-9-]+',name)
    groups.setdefault(name,[]).append(f'<a href="{wheel.as_uri()}#sha256={hashlib.sha256(wheel.read_bytes()).hexdigest()}">{wheel.name}</a>')
for name,links in groups.items():
    target=pathlib.Path(sys.argv[2])/name;target.mkdir(parents=True)
    (target/'index.html').write_text('\\n'.join(links))
versions=[]
for filename in sys.argv[3:]:
    with zipfile.ZipFile(filename) as archive:
        entry,=[name for name in archive.namelist() if name.count('/')==1 and name.endswith('.dist-info/METADATA')]
        versions.append(email.parser.BytesParser().parsebytes(archive.read(entry))['Version'])
major,minor=sys.version_info[:2]
print(json.dumps([*versions,f'>={major}.{minor},<{major}.{minor+1}']))
`,
          wheelhouse!,
          join(root, 'simple'),
          sdk!,
          runtime!,
          testkit!,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      ),
    );
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
      '--rootDir',
      'src',
      '--outDir',
      join(root, 'compiled'),
      'src/lib/connector-init.ts',
      'src/lib/connector-templates.ts',
    ]);
  }, 60_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(['custom-source', 'api-source', 'sql-source'])(
    'publishes and independently checks %s outside the checkout',
    (templateId) => {
      const target = join(root, templateId);
      const options = {
        toolchainVersion: '0.1.0',
        pythonExecutable: python!,
        uvExecutable: uv!,
        nodeExecutable: process.execPath,
        runtimeWheelDir: join(root, 'wheels'),
        runtimeWheels: [join(root, 'wheels', basename(sdk!))],
        requiredHostProtocol: 2,
        agentExecutionPython: versions[3],
        offline: true,
      };
      if (templateId !== 'custom-source')
        options.runtimeWheels.push(join(root, 'wheels', basename(runtime!)));
      const metadata = {
        connectorName: 'ACME',
        displayName: 'Acme',
        groupId: 'com.acme',
        version: '1.2.3.dev1',
        requiresPython: '>=3.11,<3.15',
        sdkVersion: versions[0],
        runtimeVersion: versions[1],
        testkitVersion: versions[2],
      };
      const initModule = pathToFileURL(join(root, 'compiled/lib/connector-init.js')).href;
      const templatesModule = pathToFileURL(join(root, 'compiled/lib/connector-templates.js')).href;
      const transportModule = pathToFileURL(join(root, 'compiled/lib/connector-toolchain.js')).href;
      const program = `import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {initializeLockedConnectorProject} from ${JSON.stringify(initModule)};
import * as templates from ${JSON.stringify(templatesModule)};
import {runConnectorToolchain} from ${JSON.stringify(transportModule)};
const tools=${JSON.stringify(options)},target=${JSON.stringify(target)},id=${JSON.stringify(templateId)};
const render=id==='custom-source'?templates.renderCustomSourceTemplate:id==='api-source'?templates.renderApiSourceTemplate:templates.renderSqlSourceTemplate;
const template=render(${JSON.stringify(metadata)});
await initializeLockedConnectorProject(target,template,tools);
for(const [path,raw] of Object.entries(template.files))assert.equal(readFileSync(join(target,path),'utf8'),raw);
const before=readFileSync(join(target,'runtime.lock'));
const result=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'check',projectDir:target,options:{uvExecutable:tools.uvExecutable,nodeExecutable:tools.nodeExecutable,runtimeWheelDir:tools.runtimeWheelDir}});
assert.deepEqual(result,{protocolVersion:1,ok:true,result:{checked:true}});
assert.deepEqual(readFileSync(join(target,'runtime.lock')),before);
assert.equal(JSON.parse(before).wheels.length,id==='custom-source'?1:2);
assert.equal(JSON.parse(readFileSync(join(target,'.supaflow/template.json'),'utf8')).templateId,id);
assert.equal(existsSync(join(target,'.venv')),false);
console.log(JSON.stringify({template:id,checked:true,sourceUnchanged:true,runtimeUnchanged:true}));`;
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          UV_OFFLINE: 'true',
          UV_NO_INDEX: 'false',
          UV_DEFAULT_INDEX: pathToFileURL(join(root, 'simple')).href,
          UV_FIND_LINKS: '',
          UV_CACHE_DIR: join(root, 'cache'),
          DLT_TELEMETRY: '0',
          RUNTIME__DLTHUB_TELEMETRY: 'false',
        },
      });
      expect(JSON.parse(result)).toEqual({
        template: templateId,
        checked: true,
        sourceUnchanged: true,
        runtimeUnchanged: true,
      });
    },
    150_000,
  );
});
