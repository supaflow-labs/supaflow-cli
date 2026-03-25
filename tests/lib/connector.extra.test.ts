import { describe, it, expect } from 'vitest';
import { generateApiName } from '../../src/lib/connector.js';

describe('generateApiName', () => {
  it('matches app logic: lowercase, spaces to underscores, strip invalid chars', () => {
    expect(generateApiName('My Postgres DB')).toBe('my_postgres_db');
  });

  it('removes hyphens (not alphanumeric or underscore)', () => {
    expect(generateApiName('cli-test-postgres')).toBe('clitestpostgres');
  });

  it('handles empty string', () => {
    expect(generateApiName('')).toBe('');
  });

  it('preserves underscores', () => {
    expect(generateApiName('my_pipeline_name')).toBe('my_pipeline_name');
  });

  it('removes special characters', () => {
    expect(generateApiName('test@#$%name')).toBe('testname');
  });

  it('converts spaces to underscores before stripping', () => {
    // "My DB" -> "my_db" (space becomes underscore, then nothing else to strip)
    expect(generateApiName('My DB')).toBe('my_db');
  });
});
