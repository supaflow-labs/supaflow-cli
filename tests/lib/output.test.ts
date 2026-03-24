import { describe, it, expect } from 'vitest';
import { formatTable, formatListJson, formatGetJson, truncateUuid, relativeTime } from '../../src/lib/output.js';

describe('truncateUuid', () => {
  it('truncates UUID to 8 chars', () => {
    expect(truncateUuid('8a3f1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c')).toBe('8a3f1b2c');
  });

  it('returns non-UUID strings as-is', () => {
    expect(truncateUuid('short')).toBe('short');
  });
});

describe('relativeTime', () => {
  it('returns relative time string', () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(twoHoursAgo)).toBe('2 hours ago');
  });

  it('returns dash for null', () => {
    expect(relativeTime(null)).toBe('-');
  });
});

describe('formatTable', () => {
  it('formats rows with aligned columns', () => {
    const headers = ['ID', 'NAME', 'STATUS'];
    const rows = [
      ['abc', 'test-pipeline', 'active'],
      ['def', 'other', 'paused'],
    ];
    const output = formatTable(headers, rows);
    expect(output).toContain('ID');
    expect(output).toContain('test-pipeline');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3);
  });
});

describe('formatListJson', () => {
  it('wraps data in list envelope', () => {
    const data = [{ id: '1' }];
    const output = formatListJson(data, 1, 25, 0);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ data: [{ id: '1' }], total: 1, limit: 25, offset: 0 });
  });
});

describe('formatGetJson', () => {
  it('outputs raw object without wrapping', () => {
    const obj = { id: '1', name: 'test' };
    const output = formatGetJson(obj);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ id: '1', name: 'test' });
  });
});
