import { describe, it, expect } from 'vitest';
import { buildDbtTestSnapshot, looksEncrypted, type DbtSnapshotInput } from '../../src/lib/dbtSnapshot.js';
import { CliError } from '../../src/lib/errors.js';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ds-123',
    workspace_id: 'ws-456',
    state: 'active',
    connector_version_id: 'cv-1',
    connector_type: 'SNOWFLAKE',
    connector_group_id: 'io.supaflow',
    connector_artifact_id: 'supaflow-connector-snowflake',
    connector_version: '1.2.3',
    connector_java_class: 'io.supaflow.connector.snowflake.SnowflakeConnector',
    connector_capabilities: { supports_incremental: true },
    connector_version_properties: [
      { name: 'account', encrypted: false, sensitive: false, password: false },
      { name: 'password', encrypted: true, sensitive: false, password: true },
    ],
    connector_version_capabilities_config: { max_parallelism: 4 },
    configs: {
      account: 'myaccount',
      password: { v: 1, fp: 'ab12', data: 'ZW5jcnlwdGVkLWRhdGE=' },
    },
    ...overrides,
  };
}

describe('buildDbtTestSnapshot', () => {
  it('produces the exact version-1 snapshot shape on the happy path', () => {
    const row = baseRow();
    const input: DbtSnapshotInput = { row, tenantId: 'tenant-789' };

    const snapshot = buildDbtTestSnapshot(input);

    expect(snapshot).toEqual({
      format_version: 1,
      datasource: {
        id: 'ds-123',
        tenant_id: 'tenant-789',
        workspace_id: 'ws-456',
        state: 'active',
        connector: {
          version_id: 'cv-1',
          type: 'SNOWFLAKE',
          group_id: 'io.supaflow',
          artifact_id: 'supaflow-connector-snowflake',
          version: '1.2.3',
          java_class: 'io.supaflow.connector.snowflake.SnowflakeConnector',
          capabilities: { supports_incremental: true },
          properties: row.connector_version_properties,
          capabilities_config: { max_parallelism: 4 },
        },
        encrypted_configs: row.configs,
      },
    });
  });

  it('rejects a plaintext value on a property flagged encrypted, naming the property but never the value', () => {
    const row = baseRow({
      configs: {
        account: 'myaccount',
        password: 'hunter2',
      },
    });
    const input: DbtSnapshotInput = { row, tenantId: 'tenant-789' };

    let thrown: unknown;
    try {
      buildDbtTestSnapshot(input);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const message = (thrown as CliError).message;
    expect(message).toContain('password');
    expect(message).not.toContain('hunter2');
  });

  it('rejects a plaintext value flagged only via `sensitive`, not just `encrypted`/`password`', () => {
    const row = baseRow({
      connector_version_properties: [
        { name: 'api_token', encrypted: false, sensitive: true, password: false },
      ],
      configs: {
        api_token: 'plaintext-token-value',
      },
    });
    const input: DbtSnapshotInput = { row, tenantId: 'tenant-789' };

    expect(() => buildDbtTestSnapshot(input)).toThrow(CliError);
    try {
      buildDbtTestSnapshot(input);
    } catch (err) {
      expect((err as CliError).message).toContain('api_token');
      expect((err as CliError).message).not.toContain('plaintext-token-value');
    }
  });

  it('rejects an inactive datasource', () => {
    const row = baseRow({ state: 'inactive' });
    const input: DbtSnapshotInput = { row, tenantId: 'tenant-789' };

    expect(() => buildDbtTestSnapshot(input)).toThrow(CliError);
  });

  it('rejects a missing/blank tenant id', () => {
    const row = baseRow();

    expect(() => buildDbtTestSnapshot({ row, tenantId: '' })).toThrow(CliError);
    expect(() => buildDbtTestSnapshot({ row, tenantId: '   ' })).toThrow(CliError);
  });
});

describe('looksEncrypted', () => {
  it('returns true for an envelope object with v + fp + data keys', () => {
    expect(looksEncrypted({ v: 1, fp: 'ab12', data: 'ZW5jcnlwdGVkLWRhdGE=' })).toBe(true);
  });

  it('returns false for an object missing one of v/fp/data', () => {
    expect(looksEncrypted({ fp: 'ab12', data: 'xyz' })).toBe(false);
    expect(looksEncrypted({ v: 1, data: 'xyz' })).toBe(false);
    expect(looksEncrypted({ v: 1, fp: 'ab12' })).toBe(false);
  });

  it('returns true for a string JSON envelope containing "fp" and "data" keys', () => {
    expect(looksEncrypted('{"v":1,"fp":"ab12","data":"ZW5jcnlwdGVkLWRhdGE="}')).toBe(true);
  });

  it('returns false for a JSON-looking string missing "fp" or "data"', () => {
    expect(looksEncrypted('{"v":1,"data":"ZW5jcnlwdGVkLWRhdGE="}')).toBe(false);
    expect(looksEncrypted('{"v":1,"fp":"ab12"}')).toBe(false);
  });

  it('returns true for a legacy hex bytea string (\\x-prefixed)', () => {
    expect(looksEncrypted('\\x0a1b2c3d')).toBe(true);
    expect(looksEncrypted('\\XAB12CD')).toBe(true); // case-insensitive per Java pattern
  });

  it('returns false for a malformed hex bytea string', () => {
    expect(looksEncrypted('\\x0a1')).toBe(false); // odd number of hex digits
    expect(looksEncrypted('\\xzz')).toBe(false); // non-hex chars
  });

  it('returns false for a plain string', () => {
    expect(looksEncrypted('hunter2')).toBe(false);
    expect(looksEncrypted('myaccount')).toBe(false);
  });

  it('returns false for the CLI submission "enc:" prefix -- it is a transport marker, not an at-rest envelope', () => {
    expect(looksEncrypted('enc:eyJ2IjoxLCJmcCI6ImFiMTIiLCJkYXRhIjoieHl6In0=')).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });
});
