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
 * Rejects unknown keys to prevent invalid config from reaching the backend.
 * Enforces platform safety rules (e.g., ACTIVATION pipelines must use BLOCK_ALL).
 */
/**
 * Capability ownership: which connector controls each setting.
 */
const CAPABILITY_OWNERSHIP: Record<string, 'source' | 'destination' | 'both'> = {
  ingestion_mode: 'source',
  load_mode: 'destination',
  namespace_rules: 'destination',
  destination_table_handling: 'destination',
  schema_evolution_mode: 'destination',
  load_optimization_mode: 'destination',
  checksum_validation_level: 'both',
  perform_hard_deletes: 'both',
  trigger_auto_re_sync_on_new_table: 'destination',
  trigger_auto_re_sync_on_new_column: 'destination',
  trigger_auto_re_sync_on_schema_change: 'destination',
  propagate_empty_table_schema: 'destination',
};

interface FieldCapability {
  enabled?: boolean;
  default_value?: string;
  supported_values?: string[];
}

interface BooleanCapability {
  supported?: boolean;
  default_value?: boolean;
}

type CapabilitiesConfig = Record<string, FieldCapability | BooleanCapability | unknown>;

/**
 * Generate a capability-aware pipeline config by resolving defaults from
 * source and destination capabilities, following the same ownership rules
 * as the frontend pipeline wizard.
 */
export function generateCapabilityAwareConfig(
  sourceCapabilities: CapabilitiesConfig | null,
  destinationCapabilities: CapabilitiesConfig | null,
  sourceConnectorType: string,
): Record<string, unknown> {
  const config = { ...PIPELINE_DEFAULTS };

  // Set default prefix from lowercased source connector type
  config.pipeline_prefix = sourceConnectorType.toLowerCase();

  for (const [key, ownership] of Object.entries(CAPABILITY_OWNERSHIP)) {
    let caps: CapabilitiesConfig | null = null;
    if (ownership === 'source') caps = sourceCapabilities;
    else if (ownership === 'destination') caps = destinationCapabilities;
    else if (ownership === 'both') caps = destinationCapabilities || sourceCapabilities;

    if (!caps || !(key in caps)) continue;
    const cap = caps[key] as FieldCapability & BooleanCapability;

    // Field capabilities (with supported_values)
    if (cap.supported_values) {
      let validValues = cap.supported_values;

      // For 'both' ownership, intersect supported values from both connectors
      if (ownership === 'both' && sourceCapabilities && destinationCapabilities) {
        const srcCap = sourceCapabilities[key] as FieldCapability | undefined;
        const dstCap = destinationCapabilities[key] as FieldCapability | undefined;
        if (srcCap?.supported_values && dstCap?.supported_values) {
          validValues = srcCap.supported_values.filter(
            (v: string) => dstCap.supported_values!.includes(v),
          );
        }
      }

      if (validValues.length > 0) {
        // Use capability default if it's in valid values, otherwise use first valid value
        if (cap.default_value !== undefined && validValues.includes(cap.default_value)) {
          config[key] = cap.default_value;
        } else if (!validValues.includes(config[key] as string)) {
          // Current default not valid for this connector pair -- use first valid option
          config[key] = validValues[0];
        }
      }
    }

    // Boolean capabilities
    if ('supported' in cap && cap.default_value !== undefined) {
      if (ownership === 'both' && sourceCapabilities && destinationCapabilities) {
        const srcCap = sourceCapabilities[key] as BooleanCapability | undefined;
        const dstCap = destinationCapabilities[key] as BooleanCapability | undefined;
        config[key] = (srcCap?.supported !== false) && (dstCap?.supported !== false) && !!cap.default_value;
      } else {
        config[key] = cap.supported !== false && !!cap.default_value;
      }
    }
  }

  // ACTIVATION pipelines MUST use BLOCK_ALL
  if (config.pipeline_type === 'ACTIVATION') {
    config.schema_evolution_mode = 'BLOCK_ALL';
  }

  return config;
}

/**
 * Generate an annotated JSON config file with comments explaining each field,
 * its default, and valid options from capabilities.
 */
/**
 * User-facing settings to include in the init config file.
 */
const USER_FACING_KEYS = [
  'pipeline_prefix',
  'is_custom_prefix',
  'ingestion_mode',
  'load_mode',
  'schema_evolution_mode',
  'error_handling',
  'namespace_rules',
  'destination_table_handling',
  'perform_hard_deletes',
  'full_sync_frequency',
  'full_resync_frequency',
  'load_optimization_mode',
  'checksum_validation_level',
  'trigger_auto_re_sync_on_new_table',
  'trigger_auto_re_sync_on_new_column',
  'trigger_auto_re_sync_on_schema_change',
  'propagate_empty_table_schema',
];

/**
 * Generate a valid JSON config file (only user-facing settings) that can be
 * passed directly to `pipelines create --config`.
 */
export function generateConfigJson(config: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const key of USER_FACING_KEYS) {
    if (key in config) {
      subset[key] = config[key];
    }
  }
  return JSON.stringify(subset, null, 2);
}

/**
 * Generate a reference comment block describing each field, its ownership,
 * and valid options from capabilities.
 */
export function generateConfigReference(
  config: Record<string, unknown>,
  sourceCapabilities: CapabilitiesConfig | null,
  destinationCapabilities: CapabilitiesConfig | null,
): string {
  const lines: string[] = ['# Pipeline Configuration Reference', '#'];

  for (const key of USER_FACING_KEYS) {
    const value = config[key];
    const ownership = CAPABILITY_OWNERSHIP[key];

    let supportedValues: string[] | null = null;
    let caps: CapabilitiesConfig | null = null;
    if (ownership === 'source') caps = sourceCapabilities;
    else if (ownership === 'destination') caps = destinationCapabilities;
    else if (ownership === 'both') caps = destinationCapabilities || sourceCapabilities;

    if (caps && key in caps) {
      const cap = caps[key] as FieldCapability;
      supportedValues = cap.supported_values || null;
    }

    const parts: string[] = [`${key}: ${JSON.stringify(value)}`];
    if (ownership) parts.push(`  controlled by: ${ownership}`);
    if (supportedValues) parts.push(`  valid options: ${supportedValues.join(', ')}`);
    if (key === 'pipeline_prefix') parts.push('  WARNING: cannot be changed after pipeline creation');

    lines.push(`# ${parts.join('\n#   ')}`);
  }

  return lines.join('\n');
}

export function createPipelineConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // Validate that all override keys exist in PIPELINE_DEFAULTS
  const validKeys = new Set(Object.keys(PIPELINE_DEFAULTS));
  const unknownKeys = Object.keys(overrides).filter((k) => !validKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown pipeline config field(s): ${unknownKeys.join(', ')}. Valid fields: ${[...validKeys].sort().join(', ')}`,
    );
  }

  const config = { ...PIPELINE_DEFAULTS, ...overrides };

  // ACTIVATION pipelines MUST use BLOCK_ALL schema evolution to prevent
  // schema drift from writing bad payloads into external APIs.
  if (config.pipeline_type === 'ACTIVATION') {
    config.schema_evolution_mode = 'BLOCK_ALL';
  }

  return config;
}
