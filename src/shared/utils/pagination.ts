import { PaginationMeta, PaginationQuery, PaginationSlice } from '@shared/types/pagination.types';

export type { PaginationMeta, PaginationQuery, PaginationSlice };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePagination(q: PaginationQuery): PaginationSlice {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const rawLimit = parseInt(String(q.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function parseSort(sort?: string): Record<string, 'asc' | 'desc'> | undefined {
  if (!sort) return undefined;
  const [field, dir] = sort.split(':');
  if (!field) return undefined;
  return { [field]: dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * `page` and `limit` from a query string for lists paged in memory. Anything that
 * is not a whole number of at least 1 (`0`, `-5`, `abc`, `1.5`) falls back to the
 * default, and `limit` is capped at `maxLimit`, so a bad value never fails a request.
 */
export function parsePageParams(
  q: { page?: unknown; limit?: unknown },
  opts: { defaultLimit: number; maxLimit: number },
): { page: number; limit: number } {
  const whole = (v: unknown): number | null => {
    const s = String(v ?? '').trim();
    if (!/^\d{1,9}$/.test(s)) return null;
    const n = Number(s);
    return n >= 1 ? n : null;
  };
  const page = whole(q.page) ?? 1;
  const limit = Math.min(opts.maxLimit, whole(q.limit) ?? opts.defaultLimit);
  return { page, limit };
}

/** The `page` of `rows` (1-based) and its meta; a page past the end is empty. */
export function pageOf<T>(
  rows: T[],
  page: number,
  limit: number,
): { items: T[]; meta: PaginationMeta } {
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    meta: buildMeta(rows.length, page, limit),
  };
}

export function buildMeta(total: number, page: number, limit: number): PaginationMeta {
  return { total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}
