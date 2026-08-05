import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
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
