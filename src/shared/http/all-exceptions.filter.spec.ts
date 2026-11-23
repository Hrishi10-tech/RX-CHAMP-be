import { ArgumentsHost, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException, NotFoundError, UnauthorizedError } from '../exceptions/app.exception';
import { JwtAuthGuard } from '../rbac/jwt-auth.guard';
import { AllExceptionsFilter } from './all-exceptions.filter';

function answered(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'GET', url: '/x' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('database words nobody should read', {
    code,
    clientVersion: 'test',
  });

describe('AllExceptionsFilter: the words people read (COPY_DECK B1), codes and shape as ever', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it.each([
    ['P2002', 409, 'CONFLICT', "That's already saved."],
    ['P2025', 404, 'NOT_FOUND', "We can't find that. Refresh and try again."],
    ['P2023', 404, 'NOT_FOUND', "We can't find that. Refresh and try again."],
  ])('prisma %s', (prisma, status, code, message) => {
    expect(answered(prismaError(prisma))).toEqual({
      status,
      body: { success: false, message, error: { code, message } },
    });
  });

  it('anything else: 500, and the next step', () => {
    const message = 'Try again in a moment.';
    expect(answered(new Error('stack words nobody should read'))).toEqual({
      status: 500,
      body: { success: false, message, error: { code: 'INTERNAL_ERROR', message } },
    });
  });

  it('the defaults of the error classes', () => {
    expect(answered(new UnauthorizedError()).body.error).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Sign in again to carry on.',
    });
    expect(answered(new NotFoundError()).body.error).toEqual({
      code: 'NOT_FOUND',
      message: "We can't find that. Refresh and try again.",
    });
  });

  it('keeps details beside the words', () => {
    const err = new AppException(409, 'SOME_CODE', 'Some words.').withDetails({ month: '2026-09' });
    expect(answered(err)).toEqual({
      status: 409,
      body: {
        success: false,
        message: 'Some words.',
        error: { code: 'SOME_CODE', message: 'Some words.', details: { month: '2026-09' } },
      },
    });
  });
});

describe('JwtAuthGuard: a failure while loading the account is a 503, not a lost session', () => {
  const guard = new JwtAuthGuard();

  it('asks to try again, in the words of C-677', () => {
    let thrown: unknown;
    try {
      guard.handleRequest(new Error('database is down'), null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    const message = "RX Vision isn't available right now. Try again in a moment.";
    expect(answered(thrown)).toEqual({
      status: 503,
      body: { success: false, message, error: { code: 'ERROR', message } },
    });
  });

  it('nobody signed in: sign in again', () => {
    expect(() => guard.handleRequest(null, null)).toThrow('Sign in again to carry on.');
  });
});
