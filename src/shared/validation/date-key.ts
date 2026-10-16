import { ValidateBy, ValidationOptions } from 'class-validator';
import { isValidDateKey } from '@shared/utils/timezone';

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_KEY.test(value);
}

/** A real calendar day "YYYY-MM-DD" (2026-02-30 is refused). */
export function IsDateKey(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDateKey',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidDateKey(value),
        defaultMessage: () => '$property must be a real day as YYYY-MM-DD',
      },
    },
    options,
  );
}

/** A month "YYYY-MM". */
export function IsMonthKey(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isMonthKey',
      validator: {
        validate: (value: unknown) => isValidMonthKey(value),
        defaultMessage: () => '$property must be a month as YYYY-MM',
      },
    },
    options,
  );
}

/** "a,b , c" or ["a","b"] -> ["a","b","c"] (query strings carry lists comma-separated). */
export function splitList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((s) => String(s).trim()).filter((s) => s.length > 0);
}
