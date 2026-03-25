import { describe, it, expect } from 'vitest';
import { createPipelineConfig, PIPELINE_DEFAULTS } from '../../src/lib/pipeline-config.js';

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
});
