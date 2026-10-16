import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** API docs are on by default, off in production unless SWAGGER_ENABLED=true. */
export function swaggerEnabled(): boolean {
  if (process.env.SWAGGER_ENABLED !== undefined) return process.env.SWAGGER_ENABLED === 'true';
  return process.env.NODE_ENV !== 'production';
}

export function setupSwagger(app: INestApplication): void {
  if (!swaggerEnabled()) return;
  const swaggerCfg = new DocumentBuilder()
    .setTitle('Time Champ API')
    .setDescription(
      'Time Champ backend — clean architecture monolith. Preserves the /api/v1 contract.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerCfg));
}
