import { ValidationError } from '@shared/exceptions/app.exception';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Email {
  private constructor(public readonly value: string) {}

  static create(raw: string): Email {
    const normalized = (raw ?? '').toLowerCase().trim();
    if (!normalized || !EMAIL_RE.test(normalized)) {
      throw new ValidationError(`Invalid email: "${raw}"`);
    }
    return new Email(normalized);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
