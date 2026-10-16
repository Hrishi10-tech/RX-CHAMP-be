export class AppException extends Error {
  /** Extra machine-readable context for clients (e.g. a required minimum length). */
  public details?: Record<string, unknown>;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** Attaches client-readable details; returns `this` so it can be thrown inline. */
  withDetails(details: Record<string, unknown>): this {
    this.details = details;
    return this;
  }
}

export class ValidationError extends AppException {
  constructor(message = 'Validation failed', code = 'VALIDATION_ERROR') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppException {
  constructor(message = 'Not signed in', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class InvalidCredentialsError extends AppException {
  constructor(message = 'Invalid email or password') {
    super(401, 'INVALID_CREDENTIALS', message);
  }
}

export class ForbiddenError extends AppException {
  constructor(message = 'Not allowed', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class AccountDisabledError extends AppException {
  constructor(message = 'Tracking turned off by your manager') {
    super(403, 'ACCOUNT_DISABLED', message);
  }
}

export class NotFoundError extends AppException {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppException {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class TooManyAttemptsError extends AppException {
  constructor(message = 'Too many attempts. Try again later.', code = 'TOO_MANY_ATTEMPTS') {
    super(429, code, message);
  }
}

export class UnprocessableError extends AppException {
  constructor(message = 'Cannot process this request', code = 'UNPROCESSABLE') {
    super(422, code, message);
  }
}
