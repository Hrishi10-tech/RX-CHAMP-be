export abstract class DomainException extends Error {
  abstract readonly code: string;
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedAction extends DomainException {
  readonly code = 'FORBIDDEN';
  constructor(message = 'You are not allowed to perform this action') {
    super(message);
  }
}

export class InvalidUserState extends DomainException {
  readonly code = 'VALIDATION_ERROR';
  constructor(message = 'Invalid user state') {
    super(message);
  }
}
