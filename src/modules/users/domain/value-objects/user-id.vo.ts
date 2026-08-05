
import { ValidationError } from '@shared/exceptions/app.exception';

export class UserId {
  private constructor(public readonly value: string) {}

  static create(raw: string): UserId {
    if (!raw || typeof raw !== 'string') {
      throw new ValidationError('UserId is required');
    }
    return new UserId(raw);
  }

  equals(other: UserId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
