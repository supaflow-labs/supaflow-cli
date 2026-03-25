export const PIPELINE_DEFAULTS: Record<string, unknown> = {
  pipeline_type: 'REPLICATION',
  ingestion_mode: 'HISTORICAL_PLUS_INCREMENTAL',
  error_handling: 'MODERATE',
  load_mode: 'MERGE',
  namespace_rules: 'MIRROR_SOURCE',
  destination_table_handling: 'MERGE',
  perform_hard_deletes: false,
  schema_evolution_mode: 'ALLOW_ALL',
  trigger_auto_re_sync_on_new_table: true,
  trigger_auto_re_sync_on_new_column: false,
  trigger_auto_re_sync_on_schema_change: false,
  trigger_auto_re_sync_on_schema_failure: false,
  load_optimization_mode: null,
  propagate_empty_table_schema: false,
  checksum_validation_level: 'NONE',
  checksum_threshold_percent: 1.0,
  ingestion_parallelism: null,
  staging_parallelism: null,
  loading_parallelism: null,
  chunk_size_mb: null,
  buffer_size_bytes: null,
  force_schema_refresh: false,
  is_custom_prefix: false,
  pipeline_prefix: '',
  full_sync_frequency: 'WEEKLY',
  full_resync_frequency: 'NEVER',
  pipeline_version_config: null,
  source_config: null,
  destination_config: null,
  file_format: null,
};

/**
 * Merge user-provided config overrides with PIPELINE_DEFAULTS.
 * Enforces platform safety rules (e.g., ACTIVATION pipelines must use BLOCK_ALL).
 */
export function createPipelineConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const config = { ...PIPELINE_DEFAULTS, ...overrides };

  // ACTIVATION pipelines MUST use BLOCK_ALL schema evolution to prevent
  // schema drift from writing bad payloads into external APIs.
  if (config.pipeline_type === 'ACTIVATION') {
    config.schema_evolution_mode = 'BLOCK_ALL';
  }

  return config;
}
