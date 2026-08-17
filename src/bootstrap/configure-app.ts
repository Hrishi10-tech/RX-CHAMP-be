import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // In production the app sits behind nginx, so every request arrives from the
  // proxy. Without this, req.ip is the proxy's address for all traffic and the
  // global ThrottlerGuard buckets the entire user base into one rate limit —
  // which only shows up in production, never in local dev.
  //
  // The hop count is 1 (nginx), not `true`: trusting the whole X-Forwarded-For
  // chain would let a client prepend a forged address and evade the limit.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string[]>('corsOrigins'),
    credentials: true,
  });

  app.setGlobalPrefix(config.get<string>('apiPrefix') ?? 'api/v1', {
    exclude: ['health', 'metrics'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
}
