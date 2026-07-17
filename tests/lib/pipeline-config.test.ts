import { describe, it, expect } from 'vitest';
import { createPipelineConfig, resolvePipelinePrefix, PIPELINE_DEFAULTS } from '../../src/lib/pipeline-config.js';

describe('createPipelineConfig', () => {
  it('returns defaults when no overrides provided', () => {
    const config = createPipelineConfig();
    expect(config.pipeline_type).toBe('REPLICATION');
    expect(config.ingestion_mode).toBe('HISTORICAL_PLUS_INCREMENTAL');
    expect(config.load_mode).toBe('MERGE');
    expect(config.schema_evolution_mode).toBe('ALLOW_ALL');
  });

  it('merges user overrides with defaults', () => {
    const config = createPipelineConfig({ load_mode: 'APPEND', ingestion_mode: 'HISTORICAL' });
    expect(config.load_mode).toBe('APPEND');
    expect(config.ingestion_mode).toBe('HISTORICAL');
    // Defaults preserved for unset fields
    expect(config.error_handling).toBe('MODERATE');
  });

  it('forces BLOCK_ALL schema evolution for ACTIVATION pipelines', () => {
    const config = createPipelineConfig({
      pipeline_type: 'ACTIVATION',
      schema_evolution_mode: 'ALLOW_ALL', // User tries to override
    });
    expect(config.pipeline_type).toBe('ACTIVATION');
    expect(config.schema_evolution_mode).toBe('BLOCK_ALL'); // Forced
  });

  it('allows ALLOW_ALL for REPLICATION pipelines', () => {
    const config = createPipelineConfig({ pipeline_type: 'REPLICATION' });
    expect(config.schema_evolution_mode).toBe('ALLOW_ALL');
  });

  it('includes all default keys', () => {
    const config = createPipelineConfig();
    for (const key of Object.keys(PIPELINE_DEFAULTS)) {
      expect(config).toHaveProperty(key);
    }
  });

  it('rejects unknown config fields', () => {
    expect(() => createPipelineConfig({ destinationSchemaPrefix: 'test' })).toThrow(
      'Unknown pipeline config field(s): destinationSchemaPrefix',
    );
  });

  it('rejects multiple unknown fields and lists all of them', () => {
    expect(() => createPipelineConfig({ foo: 1, bar: 2 })).toThrow(
      'Unknown pipeline config field(s): foo, bar',
    );
  });

  it('accepts valid override keys', () => {
    expect(() => createPipelineConfig({ pipeline_prefix: 'my_prefix', is_custom_prefix: true })).not.toThrow();
  });
});

describe('resolvePipelinePrefix', () => {
  it('defaults an empty non-custom prefix to the lowercased connector type', () => {
    // The bug: `create` without --config stored '' and persisted a null schema.
    const config = createPipelineConfig(); // pipeline_prefix '', is_custom_prefix false
    expect(resolvePipelinePrefix(config, 'SUCCESSFACTORS')).toBe('successfactors');
  });

  it('keeps an already-set non-custom prefix (e.g. from pipelines init)', () => {
    const config = createPipelineConfig({ pipeline_prefix: 'successfactors' });
    expect(resolvePipelinePrefix(config, 'SUCCESSFACTORS')).toBe('successfactors');
  });

  it('honors an explicit custom prefix verbatim', () => {
    const config = createPipelineConfig({ pipeline_prefix: 'hr_data', is_custom_prefix: true });
    expect(resolvePipelinePrefix(config, 'SUCCESSFACTORS')).toBe('hr_data');
  });

  it('preserves a deliberate empty (mirror) prefix when is_custom_prefix is true', () => {
    const config = createPipelineConfig({ pipeline_prefix: '', is_custom_prefix: true });
    expect(resolvePipelinePrefix(config, 'SUCCESSFACTORS')).toBe('');
  });

  it('lowercases the connector type for the default', () => {
    const config = createPipelineConfig();
    expect(resolvePipelinePrefix(config, 'SQL_SERVER')).toBe('sql_server');
  });
});
