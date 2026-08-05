
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';

describe('Auth + Users (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));

    configureApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health -> { success, data:{ status:"up" } }', async () => {
    const res = await request(server).get('/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('up');
  });

  it('POST /api/v1/auth/login with bad creds -> 401 INVALID_CREDENTIALS', async () => {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@timechamp.test', password: 'wrong' })
      .expect(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
    });
  });

  it('full flow: login -> me -> list users', async () => {
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@timechamp.test', password: 'admin123' })
      .expect(200);

    expect(login.body.success).toBe(true);
    expect(login.body.data.token).toEqual(expect.any(String));
    expect(login.body.data.user).not.toHaveProperty('password');
    const token = login.body.data.token as string;

    const me = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.data.email).toBe('admin@timechamp.test');

    const users = await request(server)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(users.body.success).toBe(true);
    expect(Array.isArray(users.body.data)).toBe(true);
    expect(users.body.meta.total).toEqual(expect.any(Number));
  });

  it('GET /api/v1/users without a token -> 401 UNAUTHORIZED', async () => {
    const res = await request(server).get('/api/v1/users').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
