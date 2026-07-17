import fs from 'node:fs';
import { CliError, ErrorCode } from './errors.js';

export interface SchemaMapping {
  fully_qualified_name: string;
  selected: boolean;
  fields: unknown;
  activation_target?: unknown;
  activation_behaviour?: unknown;
  selected_merge_keys?: unknown;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function hasOwn(obj: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function toFieldSelection(fields: unknown): Array<JsonObject> | null {
  if (!Array.isArray(fields) || fields.length === 0) return null;

  const result: JsonObject[] = [];
  for (const field of fields) {
    const source = asObject(field);
    if (!source || typeof source.name !== 'string' || source.name.length === 0) {
      continue;
    }

    const mapped: JsonObject = {
      name: source.name,
      selected: source.selected === true,
      primary_key: source.primary_key === true,
      cursor_field: source.cursor_field === true,
    };

    if (hasOwn(source, 'activation_target_field')) {
      mapped.activation_target_field = source.activation_target_field;
    }
    if (hasOwn(source, 'activation_lookup')) {
      mapped.activation_lookup = source.activation_lookup;
    }

    result.push(mapped);
  }

  return result.length > 0 ? result : null;
}

export interface SchemaMappingExportOptions {
  withFields?: boolean;
}

/**
 * Convert a get_pipeline_metadata_mappings RPC row into the raw JSON array item
 * accepted by save_pipeline_metadata_mappings / pipelines create --objects.
 */
export function schemaMappingFromRpcRow(
  row: JsonObject,
  options: SchemaMappingExportOptions = {},
): SchemaMapping {
  const selectedMetadata = asObject(row.selected_source_metadata);
  const mergedMetadata = asObject(row.merged_metadata);
  const sourceMetadata = asObject(row.source_metadata);
  const metadata = mergedMetadata ?? selectedMetadata ?? sourceMetadata ?? {};

  const fqn = String(
    row.fully_qualified_source_object_name
      ?? row.source_fully_qualified_name
      ?? metadata.fully_qualified_name
      ?? '',
  );

  const hasSavedMapping = row.mapping_id !== null && row.mapping_id !== undefined
    || selectedMetadata !== null;
  const selected = hasSavedMapping
    ? (typeof selectedMetadata?.selected === 'boolean'
        ? selectedMetadata.selected
        : typeof mergedMetadata?.selected === 'boolean'
          ? mergedMetadata.selected
          : true)
    : false;

  const mapping: SchemaMapping = {
    fully_qualified_name: fqn,
    selected,
    fields: options.withFields === true ? toFieldSelection(metadata.fields) : null,
  };

  if (hasOwn(metadata, 'activation_target')) {
    mapping.activation_target = metadata.activation_target;
  }
  if (hasOwn(metadata, 'activation_behaviour')) {
    mapping.activation_behaviour = metadata.activation_behaviour;
  }
  if (hasOwn(metadata, 'selected_merge_keys')) {
    mapping.selected_merge_keys = metadata.selected_merge_keys;
  }

  return mapping;
}

/**
 * Read and validate a schema mapping file.
 * Requires a raw JSON array where every item has `fully_qualified_name`.
 * Rejects wrapped list JSON (`{ data: [...] }`) and malformed entries.
 */
export function readSchemaMappingFile(filePath: string): SchemaMapping[] {
  if (!fs.existsSync(filePath)) {
    throw new CliError(`File "${filePath}" not found.`, ErrorCode.NOT_FOUND);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to parse "${filePath}": ${msg}`, ErrorCode.INVALID_INPUT);
  }

  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>)) {
      throw new CliError(
        `"${filePath}" contains wrapped list JSON ({ "data": [...] }). ` +
        'Expected a raw JSON array. Re-export with: supaflow pipelines schema list <pipeline> --json',
        ErrorCode.INVALID_INPUT,
      );
    }
    throw new CliError(
      `"${filePath}" must contain a JSON array, got ${typeof parsed}.`,
      ErrorCode.INVALID_INPUT,
    );
  }

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object') {
      throw new CliError(
        `Item at index ${i} is not an object.`,
        ErrorCode.INVALID_INPUT,
      );
    }
    if (typeof item.fully_qualified_name !== 'string' || item.fully_qualified_name.length === 0) {
      throw new CliError(
        `Item at index ${i} is missing required field "fully_qualified_name".`,
        ErrorCode.INVALID_INPUT,
      );
    }
    if (typeof item.selected !== 'boolean') {
      throw new CliError(
        `Item at index ${i} ("${item.fully_qualified_name}"): "selected" must be a boolean.`,
        ErrorCode.INVALID_INPUT,
      );
    }
    if (item.fields !== null && item.fields !== undefined) {
      if (!Array.isArray(item.fields)) {
        throw new CliError(
          `Item at index ${i} ("${item.fully_qualified_name}"): "fields" must be null or an array.`,
          ErrorCode.INVALID_INPUT,
        );
      }
      for (let j = 0; j < (item.fields as unknown[]).length; j++) {
        const field = (item.fields as unknown[])[j];
        if (!field || typeof field !== 'object') {
          throw new CliError(
            `Item at index ${i} ("${item.fully_qualified_name}"): fields[${j}] is not an object.`,
            ErrorCode.INVALID_INPUT,
          );
        }
      }
    }
  }

  return parsed as SchemaMapping[];
}

export interface MappingSaveResult {
  processed_count: number;
  inserted_count: number;
  updated_count: number;
  snapshotted_count: number;
  error_count: number;
  error_messages: Array<{ fully_qualified_name: string; message: string }> | null;
}

/**
 * Assert that save_pipeline_metadata_mappings succeeded without partial failures.
 * The RPC returns a single-row result set. Throws CliError if error_count > 0.
 */
export function assertMappingSaveSuccess(
  result: unknown,
): MappingSaveResult {
  const rows = result as MappingSaveResult[] | null;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    throw new CliError(
      'No result returned from save_pipeline_metadata_mappings.',
      ErrorCode.API_ERROR,
    );
  }

  const row = rows[0];

  if (row.error_count > 0) {
    const errors = row.error_messages || [];
    const details = errors
      .map((e) => `  ${e.fully_qualified_name}: ${e.message}`)
      .join('\n');
    const summary = `${row.error_count} of ${row.processed_count} object(s) failed to save.`;
    throw new CliError(
      details ? `${summary}\n${details}` : summary,
      ErrorCode.API_ERROR,
    );
  }

  return row;
}
