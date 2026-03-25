import { describe, it, expect } from 'vitest';
import { validateProperty } from '../../src/lib/visibility.js';

function prop(overrides: Record<string, unknown> = {}) {
  return {
    name: 'testProp',
    type: 'STRING',
    required: false,
    sensitive: false,
    hidden: false,
    defaultValue: null,
    enumValues: null,
    minValue: null,
    maxValue: null,
    minLength: null,
    maxLength: null,
    relatedPropertyNameAndValue: null,
    ...overrides,
  };
}

describe('validateProperty BOOLEAN strictness', () => {
  it('accepts "true" (case insensitive)', () => {
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'true')).toHaveLength(0);
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'True')).toHaveLength(0);
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'TRUE')).toHaveLength(0);
  });

  it('accepts "false" (case insensitive)', () => {
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'false')).toHaveLength(0);
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'False')).toHaveLength(0);
  });

  it('rejects invalid boolean values', () => {
    const errors = validateProperty(prop({ type: 'BOOLEAN' }), 'maybe');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"true" or "false"');
  });

  it('rejects "yes" as boolean', () => {
    expect(validateProperty(prop({ type: 'BOOLEAN' }), 'yes')).toHaveLength(1);
  });

  it('rejects "1" as boolean', () => {
    expect(validateProperty(prop({ type: 'BOOLEAN' }), '1')).toHaveLength(1);
  });
});

describe('validateProperty type coercion regression', () => {
  it('validates numeric range for INTEGER', () => {
    const p = prop({ type: 'INTEGER', minValue: 1, maxValue: 65535 });
    expect(validateProperty(p, '5432')).toHaveLength(0);
    expect(validateProperty(p, '0')).toHaveLength(1);
    expect(validateProperty(p, '99999')).toHaveLength(1);
  });

  it('rejects non-numeric value for INTEGER', () => {
    const p = prop({ type: 'INTEGER' });
    expect(validateProperty(p, 'abc')).toHaveLength(1);
  });

  it('validates enum membership', () => {
    const p = prop({ enumValues: ['disable', 'require'] });
    expect(validateProperty(p, 'disable')).toHaveLength(0);
    expect(validateProperty(p, 'invalid')).toHaveLength(1);
  });
});
