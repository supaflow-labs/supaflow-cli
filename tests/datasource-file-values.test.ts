import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
  };
  return { query, supabase: { from: vi.fn(() => query), rpc: vi.fn() } };
});

vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      await handler(
        {
          supabase: mocks.supabase,
          workspaceId: 'workspace-1',
          conn: {
            bearerToken: `test.${Buffer.from('{"sub":"test-user"}').toString('base64url')}.test`,
          },
          outputOptions: { json: true, noColor: true, verbose: false },
        },
        ...args.slice(0, -1),
      );
    },
}));
vi.mock('../src/lib/polling.js', () => ({
  pollJobUntilDone: vi.fn(async () => ({ success: true })),
}));

import { registerDatasourcesCommands } from '../src/commands/datasources.js';
import { registerEncryptCommand } from '../src/commands/encrypt.js';
import { encodeEnvelope } from '../src/lib/encryption.js';
import { mergeEnvWithSchema, type ConnectorProperty } from '../src/lib/connector.js';

const RAW = '{"type":"service_account","private_key":"synthetic-key\\nsecond-line\\n"}';
const BASE64 = Buffer.from(RAW, 'utf8').toString('base64');
const ENVELOPE = { v: 1, fp: 'test-fingerprint', data: 'test-ciphertext' };
const FILE_PROPERTY: ConnectorProperty = {
  name: 'serviceAccountKey',
  type: 'STRING',
  inputType: 'FILE',
  label: 'Service Account Key',
  description: '',
  propertyGroup: 'Authentication',
  displayOrder: 0,
  required: true,
  encrypted: true,
  password: false,
  sensitive: true,
  hidden: false,
  readOnly: false,
  defaultValue: null,
  enumValues: null,
  minValue: null,
  maxValue: null,
  minLength: null,
  maxLength: null,
  multiValue: false,
  relatedPropertyNameAndValue: null,
};
let directory: string;
let file: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supaflow-file-values-'));
  file = path.join(directory, 'datasource.env');
  for (const method of ['select', 'eq', 'insert', 'update'] as const) {
    mocks.query[method].mockReturnValue(mocks.query);
  }
  mocks.query.single.mockResolvedValue({
    data: { id: 'datasource-1', state: 'active' },
    error: null,
  });
  mocks.query.maybeSingle.mockResolvedValue({ data: { id: 'datasource-1' }, error: null });
  mocks.supabase.rpc.mockImplementation((name: string) => {
    if (name === 'get_connectors') {
      let cursor: string | null = null;
      const result = () => ({
        data:
          cursor === null
            ? [
                {
                  id: 'connector-1',
                  type: 'BIGQUERY',
                  name: 'BigQuery',
                  latest_version_id: 'version-1',
                },
              ]
            : [],
        error: null,
      });
      const query = {
        gt: vi.fn((_column: string, value: string) => {
          cursor = value;
          return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn(async () => result()),
        then: (
          resolve: (value: ReturnType<typeof result>) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(result()).then(resolve, reject),
      };
      return query;
    }
    if (name === 'get_connector_version')
      return { data: [{ properties: [FILE_PROPERTY] }], error: null };
    if (name === 'encrypt_with_fingerprint') return { data: ENVELOPE, error: null };
    if (name === 'create_datasource_test_job') return { data: 'job-1', error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function run(action: string, value: string): Promise<void> {
  fs.writeFileSync(
    file,
    `# Supaflow Datasource: test\n# Connector: BIGQUERY\nserviceAccountKey=${value}\n`,
  );
  const program = new Command().exitOverride();
  registerDatasourcesCommands(program);
  registerEncryptCommand(program);
  const args =
    action === 'encrypt'
      ? ['encrypt', '--file', file]
      : action === 'create'
        ? ['datasources', 'create', '--from', file]
        : [
            'datasources',
            'edit',
            'test',
            '--from',
            file,
            ...(action === 'edit-skip-test' ? ['--skip-test'] : []),
          ];
  await program.parseAsync(['node', 'test', ...args]);
}

describe.each(['create', 'edit', 'edit-skip-test', 'encrypt'])('%s FILE contract', (action) => {
  it.each([
    ['raw JSON', RAW],
    ['existing Base64', BASE64],
  ])('encrypts %s as Base64 exactly once', async (_label, input) => {
    await run(action, input);
    expect(mocks.supabase.rpc).toHaveBeenCalledWith(
      'encrypt_with_fingerprint',
      expect.objectContaining({
        p_plaintext: BASE64,
      }),
    );
    expect(fs.readFileSync(file, 'utf8')).toContain(
      `serviceAccountKey=${encodeEnvelope(ENVELOPE)}`,
    );
    if (action === 'create' || action === 'edit') {
      expect(mocks.supabase.rpc).toHaveBeenCalledWith(
        'create_datasource_test_job',
        expect.objectContaining({
          p_configs: { serviceAccountKey: ENVELOPE },
        }),
      );
    }
    if (action !== 'encrypt') {
      expect(action === 'create' ? mocks.query.insert : mocks.query.update).toHaveBeenCalledWith(
        expect.objectContaining({ configs: { serviceAccountKey: ENVELOPE } }),
      );
    }
  });

  it('preserves existing encrypted envelopes', async () => {
    await run(action, encodeEnvelope(ENVELOPE));
    expect(
      mocks.supabase.rpc.mock.calls.filter(([name]) => name === 'encrypt_with_fingerprint'),
    ).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8')).toContain(encodeEnvelope(ENVELOPE));
    if (action !== 'encrypt') {
      expect(action === 'create' ? mocks.query.insert : mocks.query.update).toHaveBeenCalledWith(
        expect.objectContaining({ configs: { serviceAccountKey: ENVELOPE } }),
      );
    }
  });

  it('resolves raw-prefixed environment content before encoding and encryption', async () => {
    vi.stubEnv('TEST_SA_JSON', RAW);
    await run(action, 'raw:${TEST_SA_JSON}');
    expect(mocks.supabase.rpc).toHaveBeenCalledWith(
      'encrypt_with_fingerprint',
      expect.objectContaining({
        p_plaintext: BASE64,
      }),
    );
  });
});

it.each(['create', 'edit', 'edit-skip-test'])(
  '%s encodes environment-supplied FILE content before submission',
  async (action) => {
    vi.stubEnv('TEST_SA_JSON', RAW);
    await run(action, '${TEST_SA_JSON}');
    expect(action === 'create' ? mocks.query.insert : mocks.query.update).toHaveBeenCalledWith(
      expect.objectContaining({ configs: { serviceAccountKey: BASE64 } }),
    );
    expect(fs.readFileSync(file, 'utf8')).toContain('${TEST_SA_JSON}');
  },
);

describe('FILE schema normalization', () => {
  it('encodes PEM content and preserves UTF-8 bytes', () => {
    const content = '-----BEGIN PRIVATE KEY-----\nsynthetic-caf\u00e9\n-----END PRIVATE KEY-----\n';
    const { merged } = mergeEnvWithSchema({ serviceAccountKey: content }, [FILE_PROPERTY]);
    expect(Buffer.from(merged.serviceAccountKey as string, 'base64').toString('utf8')).toBe(
      content,
    );
  });

  it('normalizes FILE defaults', () => {
    expect(
      mergeEnvWithSchema({}, [{ ...FILE_PROPERTY, defaultValue: RAW }]).merged.serviceAccountKey,
    ).toBe(BASE64);
  });

  it('supports an explicit raw prefix for text that itself looks like Base64', () => {
    expect(
      mergeEnvWithSchema({ serviceAccountKey: 'raw:test' }, [FILE_PROPERTY]).merged
        .serviceAccountKey,
    ).toBe(Buffer.from('test').toString('base64'));
  });

  it('leaves non-FILE properties and empty FILE values unchanged', () => {
    expect(
      mergeEnvWithSchema({ serviceAccountKey: RAW }, [{ ...FILE_PROPERTY, inputType: 'TEXTAREA' }])
        .merged.serviceAccountKey,
    ).toBe(RAW);
    expect(
      mergeEnvWithSchema({ serviceAccountKey: '' }, [FILE_PROPERTY]).merged.serviceAccountKey,
    ).toBe('');
  });

  it('does not mistake leniently decodable text for canonical Base64', () => {
    const raw = 'dGVzdA==!';
    expect(
      mergeEnvWithSchema({ serviceAccountKey: raw }, [FILE_PROPERTY]).merged.serviceAccountKey,
    ).toBe(Buffer.from(raw).toString('base64'));
  });
});
