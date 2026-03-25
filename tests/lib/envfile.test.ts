// tests/lib/envfile.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseEnvFile, writeEnvFile, resolveEnvVars, extractHeader } from '../../src/lib/envfile.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), '.supaflow-env-test-' + Date.now());

describe('parseEnvFile', () => {
  it('parses key=value pairs', () => {
    const content = 'host=localhost\nport=5432\n';
    const result = parseEnvFile(content);
    expect(result).toEqual({ host: 'localhost', port: '5432' });
  });

  it('ignores comments and blank lines', () => {
    const content = '# comment\nhost=localhost\n\n# another\nport=5432';
    const result = parseEnvFile(content);
    expect(result).toEqual({ host: 'localhost', port: '5432' });
  });

  it('handles values with = signs', () => {
    const content = 'connectionString=host=db;port=5432';
    const result = parseEnvFile(content);
    expect(result).toEqual({ connectionString: 'host=db;port=5432' });
  });

  it('trims whitespace around values', () => {
    const content = 'host = localhost \nport = 5432 ';
    const result = parseEnvFile(content);
    expect(result).toEqual({ host: 'localhost', port: '5432' });
  });

  it('preserves empty values', () => {
    const content = 'host=\nport=5432';
    const result = parseEnvFile(content);
    expect(result).toEqual({ host: '', port: '5432' });
  });
});

describe('extractHeader', () => {
  it('extracts datasource name and connector type', () => {
    const content = '# Supaflow Datasource: my-db\n# Connector: postgres\nhost=localhost';
    const header = extractHeader(content);
    expect(header.name).toBe('my-db');
    expect(header.connector).toBe('postgres');
  });

  it('returns null for missing header', () => {
    const content = 'host=localhost';
    const header = extractHeader(content);
    expect(header.name).toBeNull();
    expect(header.connector).toBeNull();
  });
});

describe('resolveEnvVars', () => {
  beforeEach(() => {
    vi.stubEnv('TEST_HOST', 'db.example.com');
    vi.stubEnv('TEST_PORT', '5432');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('resolves ${VAR} references', () => {
    const values = { host: '${TEST_HOST}', port: '${TEST_PORT}' };
    const resolved = resolveEnvVars(values);
    expect(resolved).toEqual({ host: 'db.example.com', port: '5432' });
  });

  it('resolves ${VAR:-default} with fallback', () => {
    const values = { host: '${MISSING_VAR:-fallback.com}' };
    const resolved = resolveEnvVars(values);
    expect(resolved).toEqual({ host: 'fallback.com' });
  });

  it('throws on unset ${VAR} without default', () => {
    const values = { host: '${TOTALLY_MISSING}' };
    expect(() => resolveEnvVars(values)).toThrow('TOTALLY_MISSING');
  });

  it('resolves $$ as literal $', () => {
    const values = { price: '$$100' };
    const resolved = resolveEnvVars(values);
    expect(resolved).toEqual({ price: '$100' });
  });

  it('passes through values without variables', () => {
    const values = { host: 'localhost', port: '5432' };
    const resolved = resolveEnvVars(values);
    expect(resolved).toEqual({ host: 'localhost', port: '5432' });
  });
});

describe('writeEnvFile', () => {
  beforeEach(() => { fs.mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { fs.rmSync(TEST_DIR, { recursive: true, force: true }); });

  it('writes header and grouped properties', () => {
    const filePath = path.join(TEST_DIR, 'test.env');
    const groups = [
      {
        name: 'Authentication',
        properties: [
          { name: 'host', label: 'Database Host', required: true, defaultValue: null, enumValues: null, sensitive: false, hidden: false },
          { name: 'port', label: 'Database Port', required: true, defaultValue: '5432', enumValues: null, sensitive: false, hidden: false },
        ],
      },
      {
        name: 'Advanced Settings',
        properties: [
          { name: 'sslMode', label: 'SSL Mode', required: false, defaultValue: 'prefer', enumValues: ['disable', 'allow', 'prefer', 'require'], sensitive: false, hidden: false },
        ],
      },
    ];
    writeEnvFile(filePath, 'my-db', 'postgres', 'PostgreSQL', groups);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Supaflow Datasource: my-db');
    expect(content).toContain('# Connector: postgres');
    expect(content).toContain('# API Name: mydb');
    expect(content).toContain('# Description: PostgreSQL datasource');
    expect(content).toContain('host=');
    expect(content).toContain('port=5432');
    expect(content).toContain('sslMode=prefer');
    expect(content).toContain('(required)');
    expect(content).toContain('(optional');
    expect(content).toContain('values: disable|allow|prefer|require');
  });
});
