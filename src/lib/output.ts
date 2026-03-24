const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function truncateUuid(value: string): string {
  if (UUID_REGEX.test(value)) {
    return value.substring(0, 8);
  }
  return value;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
    return Math.max(h.length, maxRow);
  });

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('   ');
  const dataLines = rows.map((row) =>
    row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join('   '),
  );

  return [headerLine, ...dataLines].join('\n');
}

export function formatListJson(
  data: unknown[],
  total: number,
  limit: number,
  offset: number,
): string {
  return JSON.stringify({ data, total, limit, offset }, null, 2);
}

export function formatGetJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export function printOutput(content: string): void {
  console.log(content);
}
