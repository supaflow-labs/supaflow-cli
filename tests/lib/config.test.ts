import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readConfig, writeConfig, resolveApiKey, resolveWorkspaceId } from '../../src/lib/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), '.supaflow-test-' + Date.now());
const TEST_CONFIG = path.join(TEST_DIR, 'config.json');

describe('config', () => {
  beforeEach(() => { fs.mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { fs.rmSync(TEST_DIR, { recursive: true, force: true }); });

  it('returns empty config when file does not exist', () => {
    const config = readConfig(TEST_CONFIG);
    expect(config).toEqual({});
  });

  it('writes and reads config', () => {
    writeConfig({ api_key: 'test-key', workspace_id: 'ws-1' }, TEST_CONFIG);
    const config = readConfig(TEST_CONFIG);
    expect(config.api_key).toBe('test-key');
    expect(config.workspace_id).toBe('ws-1');
  });

  it('creates config file with mode 0600', () => {
    writeConfig({ api_key: 'secret' }, TEST_CONFIG);
    const stat = fs.statSync(TEST_CONFIG);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('resolves API key: flag > env > config', () => {
    expect(resolveApiKey('flag-key', undefined, {})).toBe('flag-key');
    expect(resolveApiKey(undefined, 'env-key', {})).toBe('env-key');
    expect(resolveApiKey(undefined, undefined, { api_key: 'config-key' })).toBe('config-key');
    expect(resolveApiKey(undefined, undefined, {})).toBeUndefined();
  });

  it('resolves workspace ID: flag > env > config', () => {
    expect(resolveWorkspaceId('flag-ws', undefined, {})).toBe('flag-ws');
    expect(resolveWorkspaceId(undefined, 'env-ws', {})).toBe('env-ws');
    expect(resolveWorkspaceId(undefined, undefined, { workspace_id: 'config-ws' })).toBe('config-ws');
    expect(resolveWorkspaceId(undefined, undefined, {})).toBeUndefined();
  });
});
