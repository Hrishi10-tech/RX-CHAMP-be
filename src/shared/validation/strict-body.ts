import { createParamDecorator, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Request } from 'express';

const rawBody = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request>().body as unknown,
);

/**
 * The request body validated against the parameter's class, with any other field refused
 * (400) rather than dropped. The global pipe only strips unknown fields and would hide them
 * from a stricter pipe, so this reads the body as it came (it skips custom decorators).
 */
export const StrictBody = (): ParameterDecorator =>
  rawBody(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validateCustomDecorators: true,
    }),
  );
