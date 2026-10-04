import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';
import type { MappingSaveResult, SchemaMapping } from './schema-file.js';
import { fetchAllRowsByKey } from './supabase-pagination.js';

export const MAX_MAPPING_SAVE_CHUNK_BYTES = 900 * 1024;
export const MAX_MAPPING_SAVE_CHUNK_OBJECTS = 250;

export interface SavePipelineMetadataMappingsOptions {
  maxChunkBytes?: number;
  maxChunkObjects?: number;
}

export function chunkPipelineMetadataMappings(
  mappings: SchemaMapping[],
  options: SavePipelineMetadataMappingsOptions = {},
): SchemaMapping[][] {
  const maxChunkBytes = options.maxChunkBytes ?? MAX_MAPPING_SAVE_CHUNK_BYTES;
  const maxChunkObjects = options.maxChunkObjects ?? MAX_MAPPING_SAVE_CHUNK_OBJECTS;
  if (maxChunkBytes < 1 || maxChunkObjects < 1) {
    throw new Error('Mapping chunk limits must be positive');
  }

  const chunks: SchemaMapping[][] = [];
  let chunk: SchemaMapping[] = [];
  let chunkSize = 0;

  for (const mapping of mappings) {
    const mappingSize = JSON.stringify(mapping).length;
    if (
      chunk.length > 0 &&
      (chunk.length >= maxChunkObjects || chunkSize + mappingSize > maxChunkBytes)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkSize = 0;
    }
    chunk.push(mapping);
    chunkSize += mappingSize;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export async function savePipelineMetadataMappings(
  supabase: Pick<SupabaseClient, 'rpc'>,
  pipelineId: string,
  datasourceId: string,
  mappings: SchemaMapping[],
  options: SavePipelineMetadataMappingsOptions = {},
): Promise<MappingSaveResult> {
  const totals: MappingSaveResult = {
    processed_count: 0,
    inserted_count: 0,
    updated_count: 0,
    snapshotted_count: 0,
    error_count: 0,
    error_messages: [],
  };

  const batches = chunkPipelineMetadataMappings(mappings, options);
  if (batches.length === 0) batches.push([]);

  for (const batch of batches) {
    const { data, error } = await supabase.rpc('save_pipeline_metadata_mappings', {
      p_pipeline_id: pipelineId,
      p_datasource_id: datasourceId,
      p_mappings: batch,
    });
    if (error) {
      throw new CliError(`Failed to save object selections: ${error.message}`, ErrorCode.API_ERROR);
    }

    const result = Array.isArray(data) ? (data[0] as MappingSaveResult | undefined) : undefined;
    if (!result) {
      throw new CliError(
        'No result returned from save_pipeline_metadata_mappings.',
        ErrorCode.API_ERROR,
      );
    }
    totals.processed_count += result.processed_count;
    totals.inserted_count += result.inserted_count;
    totals.updated_count += result.updated_count;
    totals.snapshotted_count += result.snapshotted_count;
    totals.error_count += result.error_count;
    for (const message of result.error_messages ?? []) {
      if ((totals.error_messages?.length ?? 0) >= 10) break;
      if (
        !(totals.error_messages ?? []).some(
          (existing) =>
            existing.fully_qualified_name === message.fully_qualified_name &&
            existing.message === message.message,
        )
      ) {
        totals.error_messages?.push(message);
      }
    }
  }

  return totals;
}

export interface FetchAllMetadataMappingsOptions {
  pipelineId: string | null;
  datasourceId: string;
  includeFields: boolean;
  deletedObjectMode: 'EXCLUDE' | 'INCLUDE_SELECTED' | 'INCLUDE_ALL';
  fullFieldsPageSize?: number;
  objectOnlyPageSize?: number;
}

type MetadataMappingRow = Record<string, unknown>;

/**
 * Fetch the complete metadata-mapping stream using the pagination strategy
 * appropriate for the requested payload. Full-field responses retain the
 * legacy OFFSET RPC; object-only responses use the keyset RPC.
 */
export async function fetchAllMetadataMappings(
  supabase: Pick<SupabaseClient, 'rpc' | 'from'>,
  options: FetchAllMetadataMappingsOptions,
): Promise<MetadataMappingRow[]> {
  const appendBatch = (
    target: MetadataMappingRow[],
    seenNames: Set<string>,
    batch: MetadataMappingRow[],
  ): string => {
    let lastName = '';
    for (const row of batch) {
      const value = row.fully_qualified_source_object_name;
      const name = typeof value === 'string' ? value : '';
      if (!name.trim() || seenNames.has(name)) {
        throw new Error(
          'Metadata mappings pagination returned a missing or repeated fully qualified name',
        );
      }
      seenNames.add(name);
      target.push(row);
      lastName = name;
    }
    return lastName;
  };

  const fetchObjectKeyset = async (): Promise<MetadataMappingRow[]> => {
    const rows: MetadataMappingRow[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    const pageSize = options.objectOnlyPageSize ?? 500;
    let afterFullyQualifiedName: string | null = null;
    let pageNumber = 1;

    while (true) {
      const { data, error } = await supabase.rpc('get_pipeline_metadata_mappings_keyset', {
        p_pipeline_id: options.pipelineId,
        p_datasource_id: options.datasourceId,
        p_limit: pageSize,
        p_after_fully_qualified_name: afterFullyQualifiedName,
        p_include_fields: false,
        p_deleted_object_mode: options.deletedObjectMode,
      });

      if (error) {
        throw new Error(
          `Metadata mappings keyset validation failed on page ${pageNumber}: ${error.message}`,
        );
      }
      if (data !== null && !Array.isArray(data)) {
        throw new Error('Metadata mappings keyset RPC returned an unexpected response');
      }

      const batch = (data ?? []) as MetadataMappingRow[];
      if (batch.length === 0) return rows;

      const nextCursor = appendBatch(rows, seenNames, batch);
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error('Metadata mappings keyset pagination did not return an advancing cursor');
      }

      seenCursors.add(nextCursor);
      afterFullyQualifiedName = nextCursor;
      pageNumber += 1;
    }
  };

  if (!options.includeFields) return fetchObjectKeyset();

  const fetchMappingRevisions = async (): Promise<MetadataMappingRow[]> => {
    if (!options.pipelineId) return [];

    return fetchAllRowsByKey<MetadataMappingRow>(
      () =>
        supabase
          .from('pipeline_metadata_mappings')
          .select('id, updated_at')
          .eq('pipeline_id', options.pipelineId),
      { key: 'id' },
    );
  };

  const sameMappingRevisions = (
    before: MetadataMappingRow[],
    after: MetadataMappingRow[],
  ): boolean =>
    before.length === after.length &&
    before.every(
      (row, index) =>
        row.id === after[index]?.id &&
        (row.updated_at ?? null) === (after[index]?.updated_at ?? null),
    );

  const fetchFullFieldsOffset = async (): Promise<MetadataMappingRow[]> => {
    const rows: MetadataMappingRow[] = [];
    const seenNames = new Set<string>();
    let pageSize = options.fullFieldsPageSize ?? 50;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.rpc('get_pipeline_metadata_mappings', {
        p_pipeline_id: options.pipelineId,
        p_datasource_id: options.datasourceId,
        p_limit: pageSize,
        p_offset: offset,
        p_include_fields: true,
      });

      if (error) {
        const statementTimedOut =
          error.code === '57014' || error.message.toLowerCase().includes('statement timeout');
        if (statementTimedOut && pageSize > 1) {
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          continue;
        }
        throw new Error(
          `Full-field metadata pagination failed at offset ${offset}: ${error.message}`,
        );
      }
      if (data !== null && !Array.isArray(data)) {
        throw new Error('Metadata mappings RPC returned an unexpected response');
      }

      const batch = (data ?? []) as MetadataMappingRow[];
      if (batch.length === 0) return rows;
      appendBatch(rows, seenNames, batch);
      offset += batch.length;
    }
  };

  const maxMembershipAttempts = 3;
  const identityFields = [
    'source_catalog_id',
    'catalog_version',
    'mapping_id',
    'catalog_updated_at',
    'selected_at',
    'selection_origin',
  ] as const;
  for (let attempt = 1; attempt <= maxMembershipAttempts; attempt += 1) {
    const mappingRevisionsBefore = await fetchMappingRevisions();
    let fullFields: MetadataMappingRow[];
    try {
      fullFields = await fetchFullFieldsOffset();
    } catch (error) {
      const offsetDriftDetected =
        error instanceof Error &&
        error.message.includes('missing or repeated fully qualified name');
      if (offsetDriftDetected && attempt < maxMembershipAttempts) continue;
      throw error;
    }
    const allowedObjects = await fetchObjectKeyset();
    const mappingRevisionsAfter = await fetchMappingRevisions();
    const fullFieldsByName = new Map(
      fullFields.map((row) => [String(row.fully_qualified_source_object_name), row]),
    );
    const membershipChanged = allowedObjects.some((row) => {
      const fullFieldRow = fullFieldsByName.get(String(row.fully_qualified_source_object_name));
      return (
        !fullFieldRow ||
        identityFields.some((field) => (fullFieldRow[field] ?? null) !== (row[field] ?? null))
      );
    });

    if (!membershipChanged && sameMappingRevisions(mappingRevisionsBefore, mappingRevisionsAfter)) {
      return allowedObjects.map(
        (row) => fullFieldsByName.get(String(row.fully_qualified_source_object_name))!,
      );
    }
  }

  throw new Error('Metadata mappings changed during pagination; retry the command');
}
