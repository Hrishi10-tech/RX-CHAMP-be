// End-to-end checks against a real database. Needs DATABASE_URL pointing at a
// migrated and seeded database (npx prisma migrate reset --force), then:
//   npm run test:e2e
import '../src/bootstrap/timezone';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';

describe('RX Vision API (e2e)', () => {
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

  const signIn = async (email: string, password: string) => {
    const agent = request.agent(server);
    const res = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    expect(res.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^accessToken=/)]),
    );
    return { agent, user: res.body.data.user as { id: string; role: string } };
  };

  it('GET /health -> 200 with the database up', async () => {
    const res = await request(server).get('/health').expect(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'up', db: 'up' } });
  });

  it('POST /auth/login with bad credentials -> 401 INVALID_CREDENTIALS', async () => {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@timechamp.test', password: 'wrong' })
      .expect(401);
    expect(res.body).toEqual({
      success: false,
      message: expect.any(String),
      error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
    });
  });

  it('signs in with cookies and lists users (4.0: per organisation)', async () => {
    const { agent, user } = await signIn('admin@timechamp.test', 'admin123');
    expect(user.role).toBe('SUPER_ADMIN');
    expect(user).not.toHaveProperty('passwordHash');

    // A Super Admin chooses an organisation first.
    const none = await agent.get('/api/v1/users').expect(400);
    expect(none.body.error.code).toBe('ORG_REQUIRED');
    const admin = await signIn('orgadmin@timechamp.test', 'orgadmin123');
    const me = await admin.agent.get('/api/v1/me').expect(200);
    const orgId = me.body.data.organisation.id as string;

    const users = await agent.get('/api/v1/users').set('X-Org-Id', orgId).expect(200);
    expect(users.body.success).toBe(true);
    expect(Array.isArray(users.body.data)).toBe(true);
    expect(users.body.meta.total).toEqual(expect.any(Number));
    const own = await admin.agent.get('/api/v1/users').expect(200);
    expect(own.body.meta.total).toBe(users.body.meta.total);
  });

  it('GET /users without a session -> 401 UNAUTHORIZED', async () => {
    const res = await request(server).get('/api/v1/users').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('enforces the Super Admin -> Manager -> Staff hierarchy', async () => {
    const manager = await signIn('manager@timechamp.test', 'manager123');
    const staff = await signIn('user@timechamp.test', 'user123');

    expect(manager.user.role).toBe('MANAGER');
    await manager.agent.post('/api/v1/shifts').send({}).expect(403);
    await staff.agent.get('/api/v1/shifts').expect(403);
    await staff.agent.get('/api/v1/breaks/approvals').expect(403);

    // A manager sees their own staff only.
    const team = await manager.agent.get('/api/v1/shift-assignments/people').expect(200);
    const emails = team.body.data.map((p: { email: string }) => p.email);
    expect(emails).toContain('user@timechamp.test');
    expect(emails).not.toContain('orgadmin@timechamp.test');
    expect(emails).not.toContain('manager@timechamp.test');
  });

  it('keeps activity from staff (SPEC 1.8) and from managers without the grant', async () => {
    const admin = await signIn('orgadmin@timechamp.test', 'orgadmin123');
    const manager = await signIn('manager@timechamp.test', 'manager123');
    const staff = await signIn('user@timechamp.test', 'user123');
    await staff.agent.get(`/api/v1/analytics/${staff.user.id}`).expect(403);
    await admin.agent.get(`/api/v1/analytics/${staff.user.id}`).expect(200);
    await staff.agent.get(`/api/v1/productivity/${staff.user.id}`).expect(403);
    await admin.agent.get(`/api/v1/productivity/${staff.user.id}`).expect(200);
    // 4.0: the seed's manager has no view grants yet.
    const denied = await manager.agent.get(`/api/v1/activity/user/${staff.user.id}/hourly`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('GRANT_REQUIRED');
    const current = await staff.agent.get('/api/v1/activity/me/current').expect(200);
    expect(current.body.data).toMatchObject({ app: null, title: null, url: null });
  });

  it('allows an office behind one address to sign in at once', async () => {
    // The per-address login limit is sized for 100+ people (it was 30 a minute).
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@timechamp.test', password: 'wrong-password' })
      .expect(401);
    expect(Number(res.headers['x-ratelimit-limit'])).toBeGreaterThanOrEqual(300);
  });

  it("serves a staff member's break day", async () => {
    const staff = await signIn('user@timechamp.test', 'user123');
    const res = await staff.agent.get('/api/v1/breaks/me/today').expect(200);
    expect(['SCHEDULED', 'FREE']).toContain(res.body.data.mode);
    expect(res.body.data.timezone).toEqual(expect.any(String));
    expect(res.body.data.shift?.name).toBe('General');
  });

  // Last: it leaves this address over its failed sign-in limit for 10 minutes.
  it('stops password spraying from one address; people who signed in from it before still can', async () => {
    const admin = await signIn('orgadmin@timechamp.test', 'orgadmin123');
    const depts = await admin.agent.get('/api/v1/departments').expect(200);
    const email = `spray-check-${Date.now()}@timechamp.test`;
    await admin.agent
      .post('/api/v1/users')
      .send({
        firstName: 'Spray',
        lastName: 'Check',
        email,
        password: 'Spray-Check-2026',
        role: 'USER',
        departmentId: depts.body.data[0].id,
      })
      .expect(201);
    // One guess per account (the per-account lockout never trips): 401 until this
    // address has 30 wrong passwords in 10 minutes (two came from the tests above).
    let wrong = 0;
    let blocked: request.Response | null = null;
    for (let i = 0; i < 35 && !blocked; i++) {
      const res = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: `nobody-${i}@timechamp.test`, password: 'Winter2026!' });
      if (res.status === 401) wrong += 1;
      else blocked = res;
    }
    expect(wrong).toBeGreaterThanOrEqual(28);
    expect(blocked?.status).toBe(429);
    expect(blocked?.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    // The right password of an account never signed in from here: refused too.
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Spray-Check-2026' })
      .expect(429);
    // Someone who signed in from this address before still gets in.
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'orgadmin@timechamp.test', password: 'orgadmin123' })
      .expect(200);
  }, 120_000);
});
