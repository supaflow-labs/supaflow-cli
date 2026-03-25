// tests/lib/visibility.test.ts
import { describe, it, expect } from 'vitest';
import { shouldShowProperty, filterVisibleFormValues, validateProperty } from '../../src/lib/visibility.js';

// Minimal ConnectorProperty shape for testing
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

describe('shouldShowProperty', () => {
  it('returns true when relatedPropertyNameAndValue is null', () => {
    const p = prop();
    expect(shouldShowProperty(p, {}, [])).toBe(true);
  });

  it('returns true when parent value matches', () => {
    const p = prop({ relatedPropertyNameAndValue: ['authType', 'basic'] });
    expect(shouldShowProperty(p, { authType: 'basic' }, [prop({ name: 'authType' })])).toBe(true);
  });

  it('returns false when parent value does not match', () => {
    const p = prop({ relatedPropertyNameAndValue: ['authType', 'oauth'] });
    expect(shouldShowProperty(p, { authType: 'basic' }, [prop({ name: 'authType' })])).toBe(false);
  });

  it('supports multiple allowed values', () => {
    const p = prop({ relatedPropertyNameAndValue: ['authType', 'basic', 'key_pair'] });
    expect(shouldShowProperty(p, { authType: 'key_pair' }, [prop({ name: 'authType' })])).toBe(true);
    expect(shouldShowProperty(p, { authType: 'oauth' }, [prop({ name: 'authType' })])).toBe(false);
  });

  it('handles chained dependencies', () => {
    const parent = prop({ name: 'authType', relatedPropertyNameAndValue: null });
    const child = prop({ name: 'username', relatedPropertyNameAndValue: ['authType', 'basic'] });
    const grandchild = prop({ name: 'schema', relatedPropertyNameAndValue: ['username', 'admin'] });
    const allProps = [parent, child, grandchild];

    // authType=basic -> username visible -> schema depends on username=admin
    expect(shouldShowProperty(grandchild, { authType: 'basic', username: 'admin' }, allProps)).toBe(true);
    expect(shouldShowProperty(grandchild, { authType: 'basic', username: 'other' }, allProps)).toBe(false);
    // authType=oauth -> username not visible -> schema not visible
    expect(shouldShowProperty(grandchild, { authType: 'oauth', username: 'admin' }, allProps)).toBe(false);
  });
});

describe('filterVisibleFormValues', () => {
  it('includes visible property values', () => {
    const props = [prop({ name: 'host', required: true })];
    const result = filterVisibleFormValues(props, { host: 'localhost' });
    expect(result).toEqual({ host: 'localhost' });
  });

  it('excludes non-visible property values', () => {
    const props = [
      prop({ name: 'authType' }),
      prop({ name: 'password', sensitive: true, relatedPropertyNameAndValue: ['authType', 'basic'] }),
    ];
    const result = filterVisibleFormValues(props, { authType: 'oauth', password: 'secret' });
    expect(result.password).toBeNull();
  });

  it('nulls sensitive non-visible fields', () => {
    const props = [
      prop({ name: 'mode' }),
      prop({ name: 'secret', sensitive: true, relatedPropertyNameAndValue: ['mode', 'advanced'] }),
    ];
    const result = filterVisibleFormValues(props, { mode: 'simple', secret: 'old-value' });
    expect(result.secret).toBeNull();
  });
});

describe('validateProperty', () => {
  it('fails on empty required field', () => {
    const errors = validateProperty(prop({ name: 'host', required: true }), '');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('required');
  });

  it('passes on empty optional field', () => {
    const errors = validateProperty(prop({ name: 'desc', required: false }), '');
    expect(errors).toHaveLength(0);
  });

  it('validates enum membership', () => {
    const p = prop({ name: 'ssl', enumValues: ['disable', 'require'] });
    expect(validateProperty(p, 'require')).toHaveLength(0);
    expect(validateProperty(p, 'invalid')).toHaveLength(1);
  });

  it('validates numeric range', () => {
    const p = prop({ name: 'port', type: 'INTEGER', minValue: 1, maxValue: 65535 });
    expect(validateProperty(p, '5432')).toHaveLength(0);
    expect(validateProperty(p, '0')).toHaveLength(1);
    expect(validateProperty(p, '99999')).toHaveLength(1);
  });

  it('validates string length', () => {
    const p = prop({ name: 'name', minLength: 1, maxLength: 5 });
    expect(validateProperty(p, 'ok')).toHaveLength(0);
    expect(validateProperty(p, '')).toHaveLength(0); // empty is not a length error, only required check
    expect(validateProperty(p, 'toolong')).toHaveLength(1);
  });
});
