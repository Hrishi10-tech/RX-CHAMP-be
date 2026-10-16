import { ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppException, UnauthorizedError } from '../exceptions/app.exception';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(err: unknown, user: TUser, _info?: unknown, _ctx?: ExecutionContext): TUser {
    // A failure while LOADING the account (database down, timeout) is not the
    // client's fault and must not read as "signed out": agents treat 401 as a
    // lost session and stop tracking. Report it as 503 so they retry instead.
    if (err && !(err instanceof AppException)) {
      throw new ServiceUnavailableException('Service temporarily unavailable, please retry');
    }
    if (err || !user) {
      throw err instanceof AppException ? err : new UnauthorizedError('Not signed in');
    }
    return user;
  }
}
