import { execFileSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.SUPAFLOW_TEST_TOOLCHAIN_PYTHON;
const uv = process.env.SUPAFLOW_TEST_UV;
const sdk = process.env.SUPAFLOW_TEST_SDK_WHEEL;
const runtime = process.env.SUPAFLOW_TEST_RUNTIME_WHEEL;
const testkit = process.env.SUPAFLOW_TEST_TESTKIT_WHEEL;
const toolchain = process.env.SUPAFLOW_TEST_TOOLCHAIN_WHEEL;
const uvWheel = process.env.SUPAFLOW_TEST_UV_WHEEL;
const bundleRequirements = process.env.SUPAFLOW_TEST_BOOTSTRAP_REQUIREMENTS;
const wheelhouse = process.env.SUPAFLOW_TEST_RUNTIME_WHEELHOUSE;
const buildWheelhouse = process.env.SUPAFLOW_TEST_BUILD_WHEELHOUSE;

// The seed handles initial proposals. Each case prepares its own locked authoring
// graph and separately installs the exported production graph without tools.
describe.skipIf(!python)('locked initialization with installed public packages', () => {
  let root: string;
  let versions: string[];
  let agentTarget: { name: string; environment: Record<string, string>; wheelTags: string[] };

  beforeAll(() => {
    expect(
      python &&
        uv &&
        sdk &&
        runtime &&
        testkit &&
        toolchain &&
        uvWheel &&
        bundleRequirements &&
        wheelhouse &&
        buildWheelhouse,
    ).toBeTruthy();
    root = mkdtempSync(join(tmpdir(), 'supaflow locked public init ; '));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    // Match an installed CLI prefix without importing its source checkout.
    mkdirSync(join(root, 'node_modules'));
    cpSync(join(process.cwd(), 'node_modules/commander'), join(root, 'node_modules/commander'), {
      recursive: true,
    });
    mkdirSync(join(root, 'install-wheels'));
    mkdirSync(join(root, 'index-wheels'));
    for (const directory of [wheelhouse!, buildWheelhouse!]) {
      for (const wheel of readdirSync(directory).filter((name) => name.endsWith('.whl'))) {
        copyFileSync(join(directory, wheel), join(root, 'install-wheels', wheel));
        copyFileSync(join(directory, wheel), join(root, 'index-wheels', wheel));
      }
    }
    for (const wheel of [sdk!, runtime!, testkit!, toolchain!, uvWheel!]) {
      copyFileSync(wheel, join(root, 'install-wheels', basename(wheel)));
      copyFileSync(wheel, join(root, 'index-wheels', basename(wheel)));
    }
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
          join(root, 'index-wheels'),
          join(root, 'simple'),
          sdk!,
          runtime!,
          testkit!,
          toolchain!,
          uvWheel!,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      ),
    );
    writeFileSync(join(root, 'bundle-requirements.txt'), readFileSync(bundleRequirements!));
    // An explicitly local-agent test inventory, not Linux deployment evidence.
    agentTarget = JSON.parse(
      execFileSync(
        python!,
        [
          '-I',
          '-c',
          'import json; from packaging.markers import default_environment; from packaging.tags import sys_tags; print(json.dumps({"name":"fixture-local-agent","environment":default_environment(),"wheelTags":[str(tag) for tag in sys_tags()]}))',
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
      'src/lib/connector-environment.ts',
      'src/commands/connector-authoring.ts',
      'src/commands/connector-init.ts',
      'src/commands/connector-lock.ts',
    ]);
  }, 60_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['custom-source', 'com.acme'],
    ['api-source', 'com.acme'],
    ['sql-source', 'com.acme'],
    ['custom-source', 'io.supaflow'],
  ])(
    'initializes and builds %s (%s) outside the checkout',
    (templateId, groupId) => {
      const target = join(root, templateId + (groupId === 'io.supaflow' ? '-first-party' : ''));
      const options = {
        toolchainVersion: versions[3],
        pythonExecutable: python!,
        uvExecutable: uv!,
        nodeExecutable: process.execPath,
        sdkVersion: versions[0],
        runtimeVersion: templateId === 'custom-source' ? null : versions[1],
        requiredHostProtocol: 2,
        agentExecutionPython: versions[5],
        offline: true,
      };
      const metadata = {
        connectorName: 'ACME',
        displayName: 'Acme',
        groupId,
        version: '1.2.3.dev1',
        requiresPython: '>=3.11,<3.15',
        sdkVersion: versions[0],
        runtimeVersion: versions[1],
        testkitVersion: versions[2],
      };
      const initModule = pathToFileURL(join(root, 'compiled/commands/connector-init.js')).href;
      const templatesModule = pathToFileURL(join(root, 'compiled/lib/connector-templates.js')).href;
      const transportModule = pathToFileURL(join(root, 'compiled/lib/connector-toolchain.js')).href;
      const environmentModule = pathToFileURL(
        join(root, 'compiled/lib/connector-environment.js'),
      ).href;
      const commandsModule = pathToFileURL(
        join(root, 'compiled/commands/connector-authoring.js'),
      ).href;
      const lockModule = pathToFileURL(join(root, 'compiled/commands/connector-lock.js')).href;
      const commanderModule = pathToFileURL(join(root, 'node_modules/commander/index.js')).href;
      const program = `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,readFileSync,readdirSync,existsSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {registerConnectorInitCommand} from ${JSON.stringify(initModule)};
import {registerConnectorLockCommand} from ${JSON.stringify(lockModule)};
import {refreshConnectorDependencyLocks,upgradeConnectorRuntimeLocks} from ${JSON.stringify(pathToFileURL(join(root, 'compiled/lib/connector-lock.js')).href)};
import * as templates from ${JSON.stringify(templatesModule)};
import {runConnectorToolchain} from ${JSON.stringify(transportModule)};
import {prepareOfflineConnectorEnvironment,prepareConnectorProjectEnvironment} from ${JSON.stringify(environmentModule)};
import {registerConnectorAuthoringCommands} from ${JSON.stringify(commandsModule)};
import commander from ${JSON.stringify(commanderModule)};
const tools=${JSON.stringify(options)},target=${JSON.stringify(target)},id=${JSON.stringify(templateId)};
const projectEnvironment={bundleRequirements:readFileSync(${JSON.stringify(join(root, 'bundle-requirements.txt'))}),uvCacheDir:${JSON.stringify(join(root, 'authoring-cache'))},agentTargets:${JSON.stringify([agentTarget])}};
tools.agentTargets=projectEnvironment.agentTargets;
const render=id==='custom-source'?templates.renderCustomSourceTemplate:id==='api-source'?templates.renderApiSourceTemplate:templates.renderSqlSourceTemplate;
const template=render(${JSON.stringify(metadata)});
if(id==='custom-source') {
 const failedTarget=target+'-uncovered-init';
 const failedProgram=new commander.Command().version('0.0.0').exitOverride().option('--json');
 registerConnectorInitCommand(failedProgram.command('connectors'),async()=>({...tools,projectEnvironment:{...projectEnvironment,agentTargets:[{...projectEnvironment.agentTargets[0],name:'fixture-uncovered-agent',wheelTags:['cp399-cp399-linux_x86_64']}]},testkitVersion:${JSON.stringify(versions[2])},projectRequiresPython:'>=3.11,<3.15'}),{timeoutMs:60_000});
 const lines=[],original=console.log;
 try {
  console.log=value=>lines.push(value);
  await failedProgram.parseAsync(['--json','connectors','init',failedTarget,'--template',id,'--name','ACME','--group',${JSON.stringify(groupId)},'--offline'],{from:'user'});
 } finally { console.log=original; }
 assert.equal(process.exitCode,1);process.exitCode=undefined;
 assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).error.code,'LOCK_FAILED');
 assert.equal(existsSync(failedTarget),false);
 assert.equal(readdirSync(${JSON.stringify(root)}).some(name=>name.startsWith('.supaflow-init-')),false);
}
const initProgram = new commander.Command().version('0.0.0').exitOverride().option('--json');
registerConnectorInitCommand(initProgram.command('connectors'), async(project,options)=>{
 assert.equal(project,target);assert.equal(options.offline,true);assert(options.signal instanceof AbortSignal);
 return {...tools,projectEnvironment,testkitVersion:${JSON.stringify(versions[2])},projectRequiresPython:'>=3.11,<3.15'};
},{timeoutMs:60_000});
const initLines=[],initLog=console.log;
try {
 console.log=(value)=>initLines.push(value);
 await initProgram.parseAsync(['--json','connectors','init',target,'--template',id,'--name','ACME','--display-name','Acme','--group',${JSON.stringify(groupId)},'--connector-version','1.2.3.dev1','--offline'],{from:'user'});
} finally {console.log=initLog;}
assert.equal(process.exitCode,undefined);assert.deepEqual(initLines.map(value=>JSON.parse(value)),[{projectDir:target}]);
tools.pythonExecutable=join(target,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
assert(existsSync(tools.pythonExecutable));
const manifestType=execFileSync(tools.pythonExecutable,['-I','-c',"import pathlib,sys,yaml; print(yaml.safe_load(pathlib.Path(sys.argv[1]).read_bytes())['connector']['type'])",join(target,'connector.yaml')],{encoding:'utf8'}).trim();
assert.equal(manifestType,${JSON.stringify(groupId === 'io.supaflow' ? 'ACME' : 'COM_ACME__ACME')});
for(const [path,raw] of Object.entries(template.files))assert.equal(readFileSync(join(target,path),'utf8'),raw);
const before=readFileSync(join(target,'runtime.lock'));
const inspection=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'runtime.inspect',projectDir:target,options:{}});
assert.deepEqual(inspection,{protocolVersion:1,ok:true,result:{runtime:JSON.parse(before),runtimeSha256:createHash('sha256').update(before).digest('hex')}});
if(id==='custom-source') {
 const missing=target+'-missing';
 const absent=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'runtime.inspect',projectDir:missing,options:{}});
 assert.equal(absent.ok,false);assert.equal(absent.error.code,'MISSING_RUNTIME_LOCK');assert.equal(existsSync(missing),false);
 const invalid=target+'-invalid';mkdirSync(invalid);
 const tooLarge=JSON.parse(before);tooLarge.connectorApiVersion=Number.MAX_SAFE_INTEGER+1;
 for(const raw of ['{"schemaVersion":2}','{"schemaVersion":',JSON.stringify(tooLarge)]) {
  writeFileSync(join(invalid,'runtime.lock'),raw);
  const malformed=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'runtime.inspect',projectDir:invalid,options:{}});
  assert.equal(malformed.ok,false);assert.equal(malformed.error.code,'CHECK_FAILED');
  assert.equal(readFileSync(join(invalid,'runtime.lock'),'utf8'),raw);
 }
}
const result=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'check',projectDir:target,options:{uvExecutable:tools.uvExecutable,nodeExecutable:tools.nodeExecutable,offline:true}});
assert.deepEqual(result,{protocolVersion:1,ok:true,result:{checked:true}});
assert.deepEqual(readFileSync(join(target,'runtime.lock')),before);
assert.equal(JSON.parse(before).wheels.length,id==='custom-source'?1:2);
assert.equal(JSON.parse(readFileSync(join(target,'.supaflow/template.json'),'utf8')).templateId,id);
assert.equal(existsSync(join(target,'.venv')),true);
function projectFiles(directory,prefix='') {
 const result={};
 for(const entry of readdirSync(directory,{withFileTypes:true})) {
  if(prefix===''&&entry.name==='.venv')continue;
  const relative=prefix+entry.name,path=join(directory,entry.name);
  if(entry.isDirectory())Object.assign(result,projectFiles(path,relative+'/'));
  else {assert(entry.isFile());result[relative]=readFileSync(path);}
 }
 return result;
}
const beforeExport=projectFiles(target);
const upgradeProject=target+'-runtime-upgrade';cpSync(target,upgradeProject,{recursive:true,filter:path=>path!==join(target,'.venv')});
const proposal={sdkVersion:${JSON.stringify(versions[0])},runtimeVersion:id==='custom-source'?null:${JSON.stringify(versions[1])},requiredHostProtocol:3,agentExecutionPython:tools.agentExecutionPython};
// A local proposal can raise its protocol requirement; this is not deployment approval.
const change=await upgradeConnectorRuntimeLocks(upgradeProject,tools,proposal,{offline:true});
assert.deepEqual(change.before,before);assert.equal(JSON.parse(change.after).requiredHostProtocol,3);
assert.deepEqual(readFileSync(join(upgradeProject,'runtime.lock')),change.after);
assert.equal(existsSync(join(upgradeProject,'.venv')),false);
assert.deepEqual(await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'dependencies.check',projectDir:upgradeProject,options:{uvExecutable:tools.uvExecutable,offline:true,agentTargets:tools.agentTargets}}),{protocolVersion:1,ok:true,result:{checked:true}});
const upgradedFiles=projectFiles(upgradeProject);
await assert.rejects(upgradeConnectorRuntimeLocks(upgradeProject,{...tools,agentTargets:[{...tools.agentTargets[0],name:'fixture-uncovered-agent',wheelTags:['cp399-cp399-linux_x86_64']}]},{...proposal,requiredHostProtocol:4},{offline:true}),error=>error.code==='LOCK_FAILED');
assert.deepEqual(projectFiles(upgradeProject),upgradedFiles);assert.deepEqual(projectFiles(target),beforeExport);
const lockProject=target+'-lock-update';cpSync(target,lockProject,{recursive:true,filter:path=>path!==join(target,'.venv')});
const lockRuntime=readFileSync(join(lockProject,'runtime.lock'));
const lockRootPath=join(lockProject,'pyproject.toml');
const editedRoot=readFileSync(lockRootPath,'utf8').replace('dependencies = [','dependencies = ["packaging>=24",');
writeFileSync(lockRootPath,editedRoot);writeFileSync(join(lockProject,'deps/uv.toml'),'# author-owned configuration\\n');
const lockProgram=new commander.Command().version('0.0.0').exitOverride().option('--json');
registerConnectorLockCommand(lockProgram.command('connectors'),async(project,options)=>{
 assert.equal(project,lockProject);assert.equal(options.offline,true);assert(options.signal instanceof AbortSignal);return tools;
},{timeoutMs:60_000});
const lockLines=[],lockLog=console.log;
try {
 console.log=(value)=>lockLines.push(value);
 await lockProgram.parseAsync(['--json','connectors','lock','--project',lockProject,'--offline'],{from:'user'});
} finally {console.log=lockLog;}
assert.equal(process.exitCode,undefined);assert.deepEqual(lockLines.map(value=>JSON.parse(value)),[{locked:true}]);
assert.deepEqual(readFileSync(join(lockProject,'runtime.lock')),lockRuntime);
assert.equal(readFileSync(lockRootPath,'utf8'),editedRoot);
assert.equal(readFileSync(join(lockProject,'deps/uv.toml'),'utf8'),'# author-owned configuration\\n');
assert(Buffer.isBuffer(beforeExport['deps/pyproject.toml']));
assert.notDeepEqual(readFileSync(join(lockProject,'deps/pyproject.toml')),beforeExport['deps/pyproject.toml']);
assert.notDeepEqual(readFileSync(join(lockProject,'deps/uv.lock')),beforeExport['deps/uv.lock']);
assert.deepEqual(await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'dependencies.check',projectDir:lockProject,options:{uvExecutable:tools.uvExecutable,offline:true}}),{protocolVersion:1,ok:true,result:{checked:true}});
async function checkLock() {
 const checkProgram=new commander.Command().version('0.0.0').exitOverride().option('--json');
 registerConnectorLockCommand(checkProgram.command('connectors'),async(project,options)=>{
  assert.equal(project,lockProject);assert.equal(options.offline,true);assert(options.signal instanceof AbortSignal);return tools;
 },{timeoutMs:60_000});
 const lines=[],original=console.log;
 try {
  console.log=(value)=>lines.push(value);
  await checkProgram.parseAsync(['--json','connectors','lock','--check','--project',lockProject,'--offline'],{from:'user'});
 } finally {console.log=original;}
 assert.equal(lines.length,1);return JSON.parse(lines[0]);
}
const beforeLockCheck=projectFiles(lockProject);
assert.deepEqual(await checkLock(),{checked:true});
assert.equal(process.exitCode,undefined);assert.deepEqual(projectFiles(lockProject),beforeLockCheck);
const coveredTargets=tools.agentTargets;
tools.agentTargets=[{...coveredTargets[0],name:'fixture-uncovered-agent',wheelTags:['cp399-cp399-linux_x86_64']}];
assert.equal((await checkLock()).error.code,'LOCK_FAILED');assert.equal(process.exitCode,1);process.exitCode=undefined;
assert.deepEqual(projectFiles(lockProject),beforeLockCheck);
await assert.rejects(refreshConnectorDependencyLocks(lockProject,tools,{offline:true}),error=>error.code==='LOCK_FAILED');
assert.deepEqual(projectFiles(lockProject),beforeLockCheck);tools.agentTargets=coveredTargets;
writeFileSync(lockRootPath,editedRoot.replace('packaging>=24','packaging>=900'));
const staleLockInputs=projectFiles(lockProject);
assert.equal((await checkLock()).error.code,'LOCK_FAILED');assert.equal(process.exitCode,1);process.exitCode=undefined;
assert.deepEqual(projectFiles(lockProject),staleLockInputs);writeFileSync(lockRootPath,editedRoot);
assert.deepEqual(projectFiles(target),beforeExport);

assert.deepEqual(await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'dependencies.check',projectDir:target,options:{uvExecutable:tools.uvExecutable,offline:true}}),{protocolVersion:1,ok:true,result:{checked:true}});
assert.deepEqual(projectFiles(target),beforeExport);
const requirementsDir=target+'-requirements';
const exported=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'dependencies.export',projectDir:target,options:{uvExecutable:tools.uvExecutable,outputDir:requirementsDir,agentTargets:tools.agentTargets}});
assert.deepEqual(exported,{protocolVersion:1,ok:true,result:{requirementsDir}});
const python=await prepareOfflineConnectorEnvironment(target+'-runtime',readFileSync(join(requirementsDir,'requirements.txt')),{
 uvExecutable:tools.uvExecutable,pythonExecutable:tools.pythonExecutable,
 wheelDir:${JSON.stringify(join(root, 'install-wheels'))},uvCacheDir:${JSON.stringify(join(root, 'install-cache'))},
});
const runtimeProbe=${JSON.stringify(`import importlib.metadata as m,importlib.util as u,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'src'))
import supaflow_python_sdk as sdk
from supaflow_connector_acme.connector import Connector
assert Connector.get_definition().${groupId === 'io.supaflow' ? 'connector_type' : 'connector_name'} == 'ACME'
assert pathlib.Path(sdk.__file__).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve())
absent=['supaflow-connector-toolchain','supaflow-connector-testkit']
if sys.argv[2]=='custom-source': absent.append('supaflow-connector-runtime')
for name in absent:
    try: m.distribution(name)
    except m.PackageNotFoundError: pass
    else: raise AssertionError(name+' leaked into the runtime environment')
runtime=None if sys.argv[2]=='custom-source' else m.version('supaflow-connector-runtime')
if runtime is not None:
    import supaflow_connector
    assert pathlib.Path(supaflow_connector.__file__).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve())
assert (u.find_spec('dlt') is None) == (sys.argv[2]=='custom-source')
print(json.dumps([m.version('supaflow-python-sdk'),runtime]))
`)};
assert.deepEqual(JSON.parse(execFileSync(python,['-I','-B','-c',runtimeProbe,target,id],{encoding:'utf8'})),[${JSON.stringify(versions[0])},id==='custom-source'?null:${JSON.stringify(versions[1])}]);
assert.deepEqual(projectFiles(target),beforeExport);
assert.equal(existsSync(join(target,'.venv')),true);
assert.equal(existsSync(join(target,'deps/.venv')),false);
for(const [path,raw] of Object.entries(template.files))assert.equal(readFileSync(join(target,path),'utf8'),raw);
const authoringDir=target+'-scratch/deep/authoring-inputs';
const agentTargets=${JSON.stringify([agentTarget])};
if(id==='custom-source') {
 const failedOutput=target+'-uncovered-target';
 const uncovered=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'authoring.prepare',projectDir:target,options:{uvExecutable:tools.uvExecutable,outputDir:failedOutput,bundleRequirementsFile:${JSON.stringify(join(root, 'bundle-requirements.txt'))},offline:true,agentTargets:[{...agentTargets[0],name:'fixture-uncovered-agent',wheelTags:['cp399-cp399-linux_x86_64']}]}});
 assert.equal(uncovered.ok,false);assert.equal(uncovered.error.code,'LOCK_FAILED');
 assert.match(uncovered.error.message,/no compatible wheel for agent target/);assert.equal(existsSync(failedOutput),false);
 assert.deepEqual(projectFiles(target),beforeExport);
}
const prepared=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'authoring.prepare',projectDir:target,options:{uvExecutable:tools.uvExecutable,outputDir:authoringDir,bundleRequirementsFile:${JSON.stringify(join(root, 'bundle-requirements.txt'))},offline:true,agentTargets}});
assert.deepEqual(prepared,{protocolVersion:1,ok:true,result:{requirementsDir:authoringDir}});
const environmentInode=statSync(join(target,'.venv')).ino;
tools.pythonExecutable=await prepareConnectorProjectEnvironment(target,{...tools,...projectEnvironment},{offline:true});
assert.equal(statSync(join(target,'.venv')).ino,environmentInode);
const authoringProbe=${JSON.stringify(`import importlib.metadata as m,importlib.util as u,sys
assert m.version('supaflow-python-sdk') == sys.argv[1]
assert m.version('supaflow-connector-toolchain') == sys.argv[4]
assert m.version('supaflow-connector-testkit') == sys.argv[2]
assert (None if sys.argv[3]=='custom-source' else m.version('supaflow-connector-runtime')) == (None if sys.argv[3]=='custom-source' else sys.argv[5])
if sys.argv[3]=='custom-source':
    try: m.distribution('uv')
    except m.PackageNotFoundError: pass
    else: raise AssertionError('the CLI uv runner leaked into the project environment')
assert (u.find_spec('dlt') is None) == (sys.argv[3]=='custom-source')
assert u.find_spec('supaflow_python_runtime') is None
`)};
execFileSync(tools.pythonExecutable,['-I','-B','-c',authoringProbe,${JSON.stringify(versions[0])},${JSON.stringify(versions[2])},id,${JSON.stringify(versions[3])},${JSON.stringify(versions[1])}]);
assert.deepEqual(projectFiles(target),beforeExport);
const bootstrapCalls=[];
let buildUv=tools.uvExecutable;
async function command(args,json=true,expectedExit=undefined) {
 const cli=new commander.Command().version('0.0.0').exitOverride().option('--json');
 registerConnectorAuthoringCommands(cli.command('connectors'),async(project,options)=>{
  assert.equal(project,target);assert.equal(options.offline,true);
  assert(options.signal instanceof AbortSignal);bootstrapCalls.push(options.operation);
  return options.operation==='artifact.build'?{...tools,uvExecutable:buildUv}:tools;
 },{timeoutMs:60_000});
 const lines=[],original=console.log;
 try {
  console.log=(value)=>lines.push(value);
  await cli.parseAsync([...(json?['--json']:[]),'connectors',...args,'--project',target,'--offline'],{from:'user'});
 } finally {console.log=original;}
 assert.equal(process.exitCode,expectedExit,JSON.stringify(lines));process.exitCode=undefined;assert.equal(lines.length,1);
 return json?JSON.parse(lines[0]):lines[0];
}
assert.deepEqual(await command(['check']),{checked:true});
assert.deepEqual(await command(['test']),{tested:true});
const diagnostic=await command(['doctor']);
assert.equal(diagnostic.diagnostics.selected.sdkDistributionVersion,${JSON.stringify(versions[0])});
assert.equal(diagnostic.diagnostics.selected.runtimeDistributionVersion,id==='custom-source'?null:${JSON.stringify(versions[1])});
assert.match(await command(['doctor'],false),/Execution ranges are local declarations/);
assert.deepEqual(await command(['manifest','check']),{manifest:'connector.yaml'});
assert.deepEqual(await command(['manifest','generate']),{manifest:'connector.yaml'});
const beforeBuild=projectFiles(target),artifactDir=target+'-artifact';
const uvObservations=target+'-uv-offline.jsonl';
if(id==='custom-source'&&process.platform!=='win32') {
 buildUv=target+'-recording-uv';
 const wrapper=${JSON.stringify(`import json,os,pathlib,shlex,sys
target=pathlib.Path(sys.argv[1]);uv=sys.argv[2];log=sys.argv[3]
program=('import json,os,sys\\n'
    +'with open('+repr(log)+',"a") as output: output.write(json.dumps({"phase":"build" if sys.argv[1:2]==["build"] else "other","offline":os.environ.get("UV_OFFLINE")})+"\\\\n")\\n'
    +'os.execv('+repr(uv)+',['+repr(uv)+',*sys.argv[1:]])\\n')
target.write_text('#!/bin/sh\\nexec '+shlex.quote(sys.executable)+' -I -c '+shlex.quote(program)+' "$@"\\n')
target.chmod(0o755)
`)};
 execFileSync(tools.pythonExecutable,['-I','-B','-c',wrapper,buildUv,tools.uvExecutable,uvObservations]);
}
process.env.UV_OFFLINE='false';
assert.deepEqual(await command(['build','--output',artifactDir]),{artifactDir});
assert.equal(process.env.UV_OFFLINE,'false');process.env.UV_OFFLINE='true';
if(buildUv!==tools.uvExecutable) {
 const observations=readFileSync(uvObservations,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
 assert(observations.some(value=>value.phase==='build'));assert(observations.every(value=>value.offline==='true'));
}
const artifactFiles=projectFiles(artifactDir);
const artifactCheck=${JSON.stringify(`import pathlib,sys,zipfile
from supaflow_connector_toolchain.connector_lock import parse_connector_lock,verify_connector_payloads
root=pathlib.Path(sys.argv[1])
files={path.relative_to(root).as_posix():path.read_bytes() for path in root.rglob('*') if path.is_file()}
lock=parse_connector_lock(files['connector.lock'])
verify_connector_payloads(lock.raw_bytes,files)
assert set(files)=={'connector.lock','connector.yaml','runtime.lock','deps/pyproject.toml','deps/uv.lock',lock.connector_wheel.path}
with zipfile.ZipFile(root/lock.connector_wheel.path) as wheel:
    roots={name.split('/',1)[0] for name in wheel.namelist()}
    assert 'supaflow_connector_acme' in roots
    assert roots.isdisjoint({'supaflow_python_sdk','supaflow_python_runtime','supaflow_connector','supaflow_dlt_runtime','supaflow_python_testkit','supaflow_connector_toolchain','supaflow_connector_cli'})
`)};
execFileSync(tools.pythonExecutable,['-I','-B','-c',artifactCheck,artifactDir]);
const versionedRoot=target+'-versioned-artifact';
const versioned=await runConnectorToolchain(tools.pythonExecutable,{protocolVersion:1,operation:'artifact.build',projectDir:target,options:{uvExecutable:tools.uvExecutable,nodeExecutable:tools.nodeExecutable,offline:true,outputDir:versionedRoot,versionedOutput:true}});
assert.equal(versioned.ok,true);
const versionedParts=relative(versionedRoot,versioned.result.artifactDir).split(sep);
assert.equal(versionedParts.length,2);assert.equal(versionedParts[1],'1.2.3.dev1');
execFileSync(tools.pythonExecutable,['-I','-B','-c',artifactCheck,versioned.result.artifactDir]);
assert.deepEqual(await command(['build','--output',artifactDir],true,1),{error:{code:'BUILD_FAILED',message:'Artifact output already exists; supply a fresh staging destination'}});
assert.deepEqual(projectFiles(artifactDir),artifactFiles);
assert.deepEqual(projectFiles(target),beforeBuild);
const defaultOutput=join(target,'dist',...versionedParts);
assert.deepEqual(await command(['build']),{artifactDir:defaultOutput});
execFileSync(tools.pythonExecutable,['-I','-B','-c',artifactCheck,defaultOutput]);
assert.deepEqual(await command(['build']),{artifactDir:defaultOutput});
execFileSync(tools.pythonExecutable,['-I','-B','-c',artifactCheck,defaultOutput]);
assert.deepEqual(await command(['check']),{checked:true});
assert.deepEqual(await command(['test']),{tested:true});
assert.deepEqual(await command(['manifest','generate']),{manifest:'connector.yaml'});
const afterDefault=projectFiles(target);
for(const path of Object.keys(afterDefault))if(path.startsWith('dist/'))delete afterDefault[path];
assert.deepEqual(afterDefault,beforeBuild);
assert.deepEqual(bootstrapCalls,['check','test','doctor','doctor','manifest.check','manifest.generate','artifact.build','artifact.build','artifact.build','artifact.build','check','test','manifest.generate']);
for(const [path,raw] of Object.entries(template.files))assert.equal(readFileSync(join(target,path),'utf8'),raw);
assert.deepEqual(readFileSync(join(target,'runtime.lock')),before);
console.log(JSON.stringify({template:id,checked:true,sourceUnchanged:true,runtimeUnchanged:true,runtimeEnvironment:true,commands:true}));`;
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: root,
        encoding: 'utf8',
        timeout: 240_000,
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
        runtimeEnvironment: true,
        commands: true,
      });
    },
    270_000,
  );
});
