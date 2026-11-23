import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AllExceptionsFilter } from '../http/all-exceptions.filter';
import { throttlerOptions } from './throttler-options';

@Controller('ping')
class PingController {
  @Get()
  ping(): string {
    return 'ok';
  }
}

const SETTINGS: Record<string, unknown> = {
  'jwt.accessSecret': 'only-for-this-spec',
  'security.rateLimitMax': 2,
};

describe('past the limit (C-937): the words people read, with the code and status as ever', () => {
  let app: INestApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          throttlerOptions({ get: (key: string) => SETTINGS[key] } as unknown as ConfigService),
        ),
      ],
      controllers: [PingController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('answers 429 RATE_LIMITED with the next step, never the class name', async () => {
    const server = app.getHttpServer();
    await request(server).get('/ping').expect(200);
    await request(server).get('/ping').expect(200);
    const refused = await request(server).get('/ping').expect(429);
    const message = 'Try again in a minute.';
    expect(refused.body).toEqual({
      success: false,
      message,
      error: { code: 'RATE_LIMITED', message },
    });
    expect(refused.headers['retry-after']).toBeDefined();
  });
});
