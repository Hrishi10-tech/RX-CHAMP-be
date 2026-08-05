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

export function buildMeta(total: number, page: number, limit: number): PaginationMeta {
  return { total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}
