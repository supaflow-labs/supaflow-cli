import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cli-publish-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  function git(...args) {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  git('init', '--initial-branch=main'); git('init', '--bare', join(root, 'origin.git'));
  mkdirSync(join(repo, 'scripts')); mkdirSync(join(repo, 'src')); mkdirSync(join(root, 'bin'));
  copyFileSync(resolve('scripts/publish.sh'), join(repo, 'scripts/publish.sh'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@getsupaflow/cli', version: '1.2.3' }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  writeFileSync(join(repo, 'src/version.ts'), "export const VERSION = '1.2.3';\n");
  git('add', '.'); git('commit', '-m', 'fixture'); git('remote', 'add', 'origin', join(root, 'origin.git')); git('push', '-u', 'origin', 'main');
  writeFileSync(join(root, 'bin/npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_ROOT/npm-calls"
case "$1" in
  whoami) echo supa-flow ;;
  view)
    if [[ -f "$TEST_ROOT/published" || "$REGISTRY_STATE" == existing ]]; then echo '"1.2.3"'; exit 0; fi
    if [[ "$REGISTRY_STATE" == network ]]; then echo '{"error":{"code":"ENETUNREACH"}}'; exit 1; fi
    echo '{"error":{"code":"E404"}}'; exit 1 ;;
  publish) if [[ "$PUBLISH_FAIL" == 1 ]]; then exit 1; fi; touch "$TEST_ROOT/published" ;;
esac
`, { mode: 0o755 });
  env.PATH = join(root, 'bin') + ':' + process.env.PATH; env.TEST_ROOT = root; env.REGISTRY_STATE = ""; env.PUBLISH_FAIL = "";
  return { root, repo, git, run: (...args) => spawnSync('bash', ['scripts/publish.sh', ...args], { cwd: repo, env, encoding: 'utf8' }), env };
}

test('publishes the reviewed version and pushes only its tag, preserving main', t => {
  const f = fixture(t); const head = f.git('rev-parse', 'HEAD');
  const r = f.run('1.2.3'); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v1.2.3').split(/\s/)[0], head);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.match(readFileSync(join(f.root, 'npm-calls'), 'utf8'), /publish --access public/);
});
for (const state of ['existing', 'network']) test(`blocks publication when registry state is ${state}`, t => {
  const f = fixture(t); f.env.REGISTRY_STATE = state;
  assert.notEqual(f.run('1.2.3').status, 0);
  assert.doesNotMatch(readFileSync(join(f.root, 'npm-calls'), 'utf8'), /publish --access/);
  assert.equal(f.git('tag', '--list'), '');
});
test('rejects the old bump interface without changing version files', t => {
  const f = fixture(t); assert.notEqual(f.run('patch').status, 0);
  assert.equal(f.git('status', '--porcelain'), '');
});
test('blocks an unpublished main commit', t => {
  const f = fixture(t); f.git('commit', '--allow-empty', '-m', 'local only');
  assert.notEqual(f.run('1.2.3').status, 0); assert.equal(f.git('tag', '--list'), '');
});
test('blocks inconsistent version sources', t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'src/version.ts'), "export const VERSION = '1.2.2';\n");
  f.git('add', 'src/version.ts'); f.git('commit', '-m', 'mismatch'); f.git('push', 'origin', 'main');
  assert.notEqual(f.run('1.2.3').status, 0); assert.equal(f.git('tag', '--list'), '');
});

test('does not tag when npm publication fails', t => {
  const f = fixture(t); f.env.PUBLISH_FAIL = '1';
  assert.notEqual(f.run('1.2.3').status, 0);
  assert.equal(f.git('tag', '--list'), '');
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v1.2.3'), '');
});
test('rejects a dirty checkout', t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'unrelated.txt'), 'work');
  assert.notEqual(f.run('1.2.3').status, 0);
  assert.equal(f.git('tag', '--list'), '');
});
