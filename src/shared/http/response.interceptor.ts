import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { isEnvelope } from './envelope';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    return next.handle().pipe(
      map((value) => {
        if (isEnvelope(value)) {
          return { success: true, data: value.data, ...(value.extra ?? {}) };
        }
        return { success: true, data: value };
      }),
    );
  }
}
