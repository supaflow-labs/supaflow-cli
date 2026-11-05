// tests/lib/connector.test.ts
import { describe, it, expect } from 'vitest';
import {
  mergeEnvWithSchema,
  groupAndSortProperties,
  isOAuthOnly,
} from '../../src/lib/connector.js';

function prop(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    type: 'STRING',
    label: name,
    description: '',
    inputType: 'TEXT',
    propertyGroup: 'Authentication',
    displayOrder: 0,
    required: false,
    encrypted: false,
    password: false,
    sensitive: false,
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
    ...overrides,
  };
}

describe('mergeEnvWithSchema', () => {
  it('uses env value when property exists in both', () => {
    const schema = [prop('host', { required: true })];
    const env = { host: 'db.example.com' };
    const { merged, warnings } = mergeEnvWithSchema(env, schema);
    expect(merged.host).toBe('db.example.com');
    expect(warnings).toHaveLength(0);
  });

  it('coerces INTEGER values to numbers', () => {
    const schema = [prop('port', { type: 'INTEGER' })];
    const env = { port: '5432' };
    const { merged } = mergeEnvWithSchema(env, schema);
    expect(merged.port).toBe(5432);
    expect(typeof merged.port).toBe('number');
  });

  it('coerces BOOLEAN values', () => {
    const schema = [prop('ssl', { type: 'BOOLEAN' })];
    const env = { ssl: 'true' };
    const { merged } = mergeEnvWithSchema(env, schema);
    expect(merged.ssl).toBe(true);
    expect(typeof merged.ssl).toBe('boolean');
  });

  it('uses default for new property with default', () => {
    const schema = [prop('host'), prop('timeout', { defaultValue: 30 })];
    const env = { host: 'db.example.com' };
    const { merged } = mergeEnvWithSchema(env, schema);
    expect(merged.timeout).toBe(30);
  });

  it('reports error for new required property without default', () => {
    const schema = [prop('host'), prop('newRequired', { required: true })];
    const env = { host: 'db.example.com' };
    const { errors } = mergeEnvWithSchema(env, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('newRequired');
  });

  it('warns on unknown env keys', () => {
    const schema = [prop('host')];
    const env = { host: 'localhost', removedProp: 'value' };
    const { warnings } = mergeEnvWithSchema(env, schema);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('removedProp');
  });
});

describe('groupAndSortProperties', () => {
  it('groups by propertyGroup and sorts by displayOrder', () => {
    const props = [
      prop('b', { propertyGroup: 'Auth', displayOrder: 2 }),
      prop('a', { propertyGroup: 'Auth', displayOrder: 1 }),
      prop('c', { propertyGroup: 'Advanced', displayOrder: 1 }),
    ];
    const groups = groupAndSortProperties(props);
    expect(groups[0].name).toBe('Auth');
    expect(groups[0].properties[0].name).toBe('a');
    expect(groups[0].properties[1].name).toBe('b');
    expect(groups[1].name).toBe('Advanced');
  });
});

describe('isOAuthOnly', () => {
  it('returns false when non-OAuth required properties exist', () => {
    const props = [
      prop('host', { required: true }),
      prop('oauth', { type: 'OAUTH_CONFIG', hidden: true }),
    ];
    expect(isOAuthOnly(props)).toBe(false);
  });

  it('returns true when all required properties depend on OAuth', () => {
    const props = [
      prop('oauthConfig', { type: 'OAUTH_CONFIG', hidden: true }),
      prop('accessToken', { required: true, relatedPropertyNameAndValue: ['oauthConfig', 'true'] }),
    ];
    expect(isOAuthOnly(props)).toBe(true);
  });
});

describe('new connection role defaults', () => {
  const schema = [
    prop('enableSourceSchemaDiscovery', {
      type: 'BOOLEAN',
      defaultValue: 'false',
      defaultValueByRole: { SOURCE: 'true' },
    }),
  ];
  it('applies source defaults to scaffold and omitted creation values', () => {
    expect(groupAndSortProperties(schema, 'SOURCE')[0].properties[0].defaultValue).toBe('true');
    expect(mergeEnvWithSchema({}, schema, 'SOURCE').merged.enableSourceSchemaDiscovery).toBe(true);
  });
  it('warns for conflicting file values without overwriting them or leaking values', () => {
    const result = mergeEnvWithSchema({ enableSourceSchemaDiscovery: 'false' }, schema, 'SOURCE');
    expect(result.merged.enableSourceSchemaDiscovery).toBe(false);
    expect(result.warnings).toEqual([expect.stringContaining('overrides its SOURCE role default')]);
    expect(
      mergeEnvWithSchema({ enableSourceSchemaDiscovery: 'true' }, schema, 'SOURCE').warnings,
    ).toEqual([]);
    expect(mergeEnvWithSchema({}, schema, 'SOURCE').warnings).toEqual([]);
    expect(mergeEnvWithSchema({ enableSourceSchemaDiscovery: 'false' }, schema).warnings).toEqual(
      [],
    );
  });
  it('preserves explicit choices, destination defaults, and unscoped/edit defaults', () => {
    expect(
      mergeEnvWithSchema({ enableSourceSchemaDiscovery: 'false' }, schema, 'SOURCE').merged
        .enableSourceSchemaDiscovery,
    ).toBe(false);
    expect(mergeEnvWithSchema({}, schema, 'DESTINATION').merged.enableSourceSchemaDiscovery).toBe(
      'false',
    );
    expect(mergeEnvWithSchema({}, schema).merged.enableSourceSchemaDiscovery).toBe('false');
  });
});
