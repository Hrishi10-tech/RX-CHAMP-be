import 'module-alias/register';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { setupSwagger } from './bootstrap/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  configureApp(app);
  setupSwagger(app);

  const apiPrefix = app.get(ConfigService).get<string>('apiPrefix') ?? 'api/v1';
  const port = app.get(ConfigService).get<number>('port') ?? 4000;
  await app.listen(port);
  console.log(`Time Champ API on http://localhost:${port}/${apiPrefix}  (docs: /docs)`);
}

bootstrap();
