import type { SupabaseClient } from '@supabase/supabase-js';

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
  supabase: Pick<SupabaseClient, 'rpc'>,
  options: FetchAllMetadataMappingsOptions,
): Promise<MetadataMappingRow[]> {
  const allMappings: MetadataMappingRow[] = [];

  if (options.includeFields) {
    const pageSize = options.fullFieldsPageSize ?? 50;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.rpc('get_pipeline_metadata_mappings', {
        p_pipeline_id: options.pipelineId,
        p_datasource_id: options.datasourceId,
        p_limit: pageSize,
        p_offset: offset,
        p_include_fields: true,
      });

      if (error) throw new Error(error.message);
      if (data !== null && !Array.isArray(data)) {
        throw new Error('Metadata mappings RPC returned an unexpected response');
      }

      const batch = (data ?? []) as MetadataMappingRow[];
      allMappings.push(...batch);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }

    return allMappings;
  }

  const pageSize = options.objectOnlyPageSize ?? 500;
  let afterFullyQualifiedName: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    const { data, error } = await supabase.rpc('get_pipeline_metadata_mappings_keyset', {
      p_pipeline_id: options.pipelineId,
      p_datasource_id: options.datasourceId,
      p_limit: pageSize,
      p_after_fully_qualified_name: afterFullyQualifiedName,
      p_include_fields: false,
      p_deleted_object_mode: options.deletedObjectMode,
    });

    if (error) throw new Error(error.message);
    if (data !== null && !Array.isArray(data)) {
      throw new Error('Metadata mappings keyset RPC returned an unexpected response');
    }

    const batch = (data ?? []) as MetadataMappingRow[];
    allMappings.push(...batch);
    if (batch.length < pageSize) break;

    const nextCursor = batch[batch.length - 1]?.fully_qualified_source_object_name;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
      throw new Error('Metadata mappings keyset pagination did not return an advancing cursor');
    }

    seenCursors.add(nextCursor);
    afterFullyQualifiedName = nextCursor;
  }

  return allMappings;
}
