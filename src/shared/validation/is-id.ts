import { Injectable, PipeTransform, BadRequestException } from '@nestjs/common';
import { Matches, ValidationOptions } from 'class-validator';
import { isValidDateKey } from '@shared/utils/timezone';

/**
 * Any 8-4-4-4-12 hex id, the shape Postgres `uuid` accepts. Stricter RFC 4122
 * checks (class-validator's IsUUID on validator >= 13.12) reject ids that exist
 * in this database: the seeded company and shifts use fixed ids like
 * 00000000-0000-0000-0000-0000000000c1, and role ids are md5-derived.
 */
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Validates an id (or each id, with `{ each: true }`). */
export function IsId(options?: ValidationOptions): PropertyDecorator {
  return Matches(ID_PATTERN, { message: '$property must be an id', ...options });
}

/** Route-param pipe: 400 for anything that is not an id. */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isId(value)) throw new BadRequestException('Invalid id');
    return value;
  }
}

/** Optional `YYYY-MM-DD` query value: 400 for anything that is not a real calendar day. */
@Injectable()
export class ParseOptionalDateKeyPipe implements PipeTransform<
  string | undefined,
  string | undefined
> {
  transform(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (!isValidDateKey(value)) throw new BadRequestException('date must be YYYY-MM-DD');
    return value;
  }
}
