export interface PaginationQuery {
  page?: number | string;
  limit?: number | string;
  sort?: string;
  search?: string;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginationSlice {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export interface PageFilter {
  skip?: number;
  take?: number;
}

export interface SearchPageFilter extends PageFilter {
  search?: string;
}

export type PaginatedResult<K extends string, T> = Record<K, T[]> & {
  total: number;
  page: number;
  limit: number;
};
