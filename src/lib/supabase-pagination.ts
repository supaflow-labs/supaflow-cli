const DEFAULT_PAGE_SIZE = 500;

export interface FetchAllRowsByKeyOptions {
  key?: string;
  pageSize?: number;
}

interface KeysetQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface KeysetQuery {
  gt(column: string, value: string): KeysetQuery;
  order(column: string, options: { ascending: boolean }): KeysetQuery;
  limit(count: number): PromiseLike<KeysetQueryResult>;
}

/**
 * Read a complete Supabase/PostgREST result using an immutable string key.
 * Pagination continues until an empty page, so a server row cap lower than the
 * requested page size cannot be mistaken for exhaustion.
 */
export async function fetchAllRowsByKey<T extends Record<string, unknown>>(
  buildQuery: () => KeysetQuery,
  options: FetchAllRowsByKeyOptions = {},
): Promise<T[]> {
  const key = options.key ?? 'id';
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: T[] = [];
  const seenKeys = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    let query = buildQuery();
    if (cursor !== null) {
      query = query.gt(key, cursor);
    }

    const { data, error } = await query.order(key, { ascending: true }).limit(pageSize);

    if (error) throw new Error(error.message);
    if (data !== null && !Array.isArray(data)) {
      throw new Error('Pagination query returned an unexpected response');
    }

    const page = (data ?? []) as T[];
    if (page.length === 0) return rows;

    for (const row of page) {
      const value = row[key];
      const rowKey = typeof value === 'string' ? value : '';
      if (!rowKey.trim() || seenKeys.has(rowKey)) {
        throw new Error(`Pagination query returned a missing or repeated ${key}`);
      }
      seenKeys.add(rowKey);
      rows.push(row);
    }

    const nextCursorValue = page[page.length - 1]?.[key];
    const nextCursor = typeof nextCursorValue === 'string' ? nextCursorValue : '';
    if (!nextCursor.trim() || nextCursor === cursor) {
      throw new Error(`Pagination query did not advance ${key}`);
    }
    cursor = nextCursor;
  }
}
