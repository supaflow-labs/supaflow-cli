import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSchemaMappingFile, assertMappingSaveSuccess } from '../../src/lib/schema-file.js';

describe('readSchemaMappingFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-file-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('accepts a valid raw array with fully_qualified_name', () => {
    const filePath = writeFile('valid.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', selected: true, fields: null },
      { fully_qualified_name: 'schema.table_b', selected: false, fields: null },
    ]));

    const result = readSchemaMappingFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].fully_qualified_name).toBe('schema.table_a');
    expect(result[0].selected).toBe(true);
    expect(result[1].selected).toBe(false);
  });

  it('rejects wrapped list JSON ({ data: [...] })', () => {
    const filePath = writeFile('wrapped.json', JSON.stringify({
      data: [
        { fully_qualified_name: 'schema.table_a', selected: true, fields: null },
      ],
      total: 1,
      limit: 25,
      offset: 0,
    }));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/wrapped list JSON/);
    try {
      readSchemaMappingFile(filePath);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rejects items missing fully_qualified_name', () => {
    const filePath = writeFile('missing-fqn.json', JSON.stringify([
      { object: 'schema.table_a', selected: true, fields: null },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/fully_qualified_name/);
    try {
      readSchemaMappingFile(filePath);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rejects non-array JSON (plain object)', () => {
    const filePath = writeFile('object.json', JSON.stringify({ fully_qualified_name: 'x' }));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/JSON array/);
    try {
      readSchemaMappingFile(filePath);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rejects invalid JSON', () => {
    const filePath = writeFile('bad.json', '{ not valid json !!!');

    expect(() => readSchemaMappingFile(filePath)).toThrow(/Failed to parse/);
    try {
      readSchemaMappingFile(filePath);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rejects items with empty fully_qualified_name', () => {
    const filePath = writeFile('empty-fqn.json', JSON.stringify([
      { fully_qualified_name: '', selected: true, fields: null },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/fully_qualified_name/);
  });

  it('rejects missing selected field', () => {
    const filePath = writeFile('no-selected.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', fields: null },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/"selected" must be a boolean/);
    try {
      readSchemaMappingFile(filePath);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rejects non-boolean selected', () => {
    const filePath = writeFile('string-selected.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', selected: 'yes', fields: null },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/"selected" must be a boolean/);
  });

  it('rejects fields as a non-array non-null value', () => {
    const filePath = writeFile('bad-fields.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', selected: true, fields: 'all' },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/"fields" must be null or an array/);
  });

  it('rejects fields array with non-object entries', () => {
    const filePath = writeFile('bad-field-entry.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', selected: true, fields: ['name'] },
    ]));

    expect(() => readSchemaMappingFile(filePath)).toThrow(/fields\[0\] is not an object/);
  });

  it('accepts valid fields array with objects', () => {
    const filePath = writeFile('valid-fields.json', JSON.stringify([
      { fully_qualified_name: 'schema.table_a', selected: true, fields: [{ name: 'col1', selected: true }] },
    ]));

    const result = readSchemaMappingFile(filePath);
    expect(result).toHaveLength(1);
  });

  it('throws NOT_FOUND for missing file', () => {
    expect(() => readSchemaMappingFile('/nonexistent/path.json')).toThrow(/not found/);
    try {
      readSchemaMappingFile('/nonexistent/path.json');
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('NOT_FOUND');
    }
  });
});

describe('assertMappingSaveSuccess', () => {
  it('returns result on full success', () => {
    const result = assertMappingSaveSuccess([{
      processed_count: 3,
      inserted_count: 3,
      updated_count: 0,
      snapshotted_count: 3,
      error_count: 0,
      error_messages: [],
    }]);

    expect(result.processed_count).toBe(3);
    expect(result.inserted_count).toBe(3);
    expect(result.error_count).toBe(0);
  });

  it('throws on partial failure (error_count > 0)', () => {
    const rpcResult = [{
      processed_count: 3,
      inserted_count: 2,
      updated_count: 0,
      snapshotted_count: 2,
      error_count: 1,
      error_messages: [
        { fully_qualified_name: 'schema.missing_table', message: 'No catalog entry found' },
      ],
    }];

    expect(() => assertMappingSaveSuccess(rpcResult)).toThrow(/1 of 3 object\(s\) failed/);
    expect(() => assertMappingSaveSuccess(rpcResult)).toThrow(/schema\.missing_table/);
    try {
      assertMappingSaveSuccess(rpcResult);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('API_ERROR');
    }
  });

  it('throws on null/empty result', () => {
    expect(() => assertMappingSaveSuccess(null)).toThrow(/No result/);
    expect(() => assertMappingSaveSuccess([])).toThrow(/No result/);
  });

  it('includes multiple error details in message', () => {
    const rpcResult = [{
      processed_count: 5,
      inserted_count: 3,
      updated_count: 0,
      snapshotted_count: 3,
      error_count: 2,
      error_messages: [
        { fully_qualified_name: 'table_a', message: 'No catalog entry found' },
        { fully_qualified_name: 'table_b', message: 'Some other error' },
      ],
    }];

    try {
      assertMappingSaveSuccess(rpcResult);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain('2 of 5');
      expect(msg).toContain('table_a');
      expect(msg).toContain('table_b');
    }
  });
});
