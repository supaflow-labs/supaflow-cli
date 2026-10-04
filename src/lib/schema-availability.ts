import type { MetadataSkipReason } from '../types/backendTypes.js';
import type { SchemaMapping } from './schema-file.js';

type JsonObject = Record<string, unknown>;

const PERMANENT_SKIP_REASONS = new Set<MetadataSkipReason>([
  // Keep aligned with supaflow-app/src/utils/errorDetection.ts.
  'UNSUPPORTED_TYPE',
  'DELETED_FROM_SOURCE',
  'CHANGE_TRACKING_NOT_ENABLED',
]);

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function catalogRowAvailabilityMetadata(row: JsonObject): JsonObject {
  return (
    asObject(row.merged_metadata) ??
    asObject(row.selected_source_metadata) ??
    asObject(row.source_metadata) ??
    {}
  );
}

/** Match the frontend rule for objects that users cannot select. */
export function isSchemaObjectUnavailable(object: JsonObject): boolean {
  const reason = object.skipped_reason;
  return (
    object.deleted === true ||
    (typeof reason === 'string' && PERMANENT_SKIP_REASONS.has(reason as MetadataSkipReason))
  );
}

/**
 * Flatten only the availability fields needed by generated selection files.
 * This keeps MCP selection behavior identical with or without --with-fields.
 */
export function schemaObjectAvailabilityFields(row: JsonObject): JsonObject {
  const metadata = catalogRowAvailabilityMetadata(row);
  const result: JsonObject = { deleted: metadata.deleted === true };
  if (typeof metadata.skipped_reason === 'string') {
    result.skipped_reason = metadata.skipped_reason;
  }
  if (typeof metadata.skipped_reason_detail === 'string') {
    result.skipped_reason_detail = metadata.skipped_reason_detail;
  }
  return result;
}

export function schemaMappingFromCatalogRow(row: JsonObject): SchemaMapping {
  const metadata = catalogRowAvailabilityMetadata(row);
  return {
    fully_qualified_name: String(row.fully_qualified_source_object_name),
    selected: !isSchemaObjectUnavailable(metadata),
    fields: null,
  };
}

export function selectionFileObjectFromCatalogRow(row: JsonObject): JsonObject {
  return {
    ...schemaMappingFromCatalogRow(row),
    ...schemaObjectAvailabilityFields(row),
  };
}
