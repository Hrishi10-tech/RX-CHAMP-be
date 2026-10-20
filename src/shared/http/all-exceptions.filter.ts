import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception';
import { DomainException } from '../exceptions/domain.exception';

const STATUS_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/**
 * 4.0 offline replay: a repeated agent event answers exactly what the first one
 * answered (its stored status and body), whatever that was.
 */
export class ReplayedResponse extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super('replayed response');
  }
}

/** The status and JSON body an exception answers with (shared with the replay store). */
export function errorResponse(exception: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  const { status, code, message, details } = normalizeException(exception);
  return {
    status,
    body: {
      success: false,
      message,
      error: details ? { code, message, details } : { code, message },
    },
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof ReplayedResponse) {
      res.status(exception.status).json(exception.body);
      return;
    }

    const { status, code, message, details } = normalizeException(exception);

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status} ${code}: ${message}`,
        (exception as Error)?.stack,
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} -> ${status} ${code}: ${message}`);
    }

    // `message` is duplicated at the top level because clients read it there to
    // show a toast; `error` keeps the code for programmatic handling.
    res.status(status).json({
      success: false,
      message,
      error: details ? { code, message, details } : { code, message },
    });
  }
}

function normalizeException(exception: unknown): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (exception instanceof AppException) {
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      details: exception.details,
    };
  }

  if (exception instanceof DomainException) {
    const status = exception.code === 'FORBIDDEN' ? 403 : 400;
    return { status, code: exception.code, message: exception.message };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const resBody = exception.getResponse();
    let message: string;
    if (typeof resBody === 'string') {
      message = resBody;
    } else {
      const m = (resBody as { message?: string | string[] }).message;
      message = Array.isArray(m) ? m.join(', ') : (m ?? exception.message);
    }
    return { status, code: STATUS_CODE[status] ?? 'ERROR', message };
  }

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') {
      return { status: 409, code: 'CONFLICT', message: 'Resource already exists' };
    }
    if (exception.code === 'P2025') {
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    }
    // A malformed id reached a uuid column: nothing by that id exists.
    if (exception.code === 'P2023') {
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    }
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong',
  };
}
