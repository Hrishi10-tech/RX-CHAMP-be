import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { FcmHttpProvider } from './fcm-http.provider';

const TOKEN = 'device-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const payload = {
  title: 'A leave request is waiting for you',
  body: 'Open RX Vision to review it.',
  data: { type: 'APPROVAL_REQUEST', what: 'LEAVE', id: 'l1' },
};
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** A local stand-in for Google's token endpoint and FCM. */
class FakeFcm {
  server!: Server;
  signIns: string[] = [];
  sends: { auth?: string; body: { message: Record<string, unknown> }; url: string }[] = [];
  /** The next answers to messages:send, status then body; 200 once they run out. */
  answers: { status: number; body?: unknown }[] = [];
  signInStatus = 200;
  issued = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/token') {
      this.signIns.push(new URLSearchParams(text).get('assertion') ?? '');
      if (this.signInStatus !== 200) return send(this.signInStatus, { error: 'invalid_grant' });
      this.issued += 1;
      return send(200, { access_token: `access-${this.issued}`, expires_in: 3600 });
    }
    this.sends.push({
      auth: req.headers.authorization,
      url: req.url ?? '',
      body: JSON.parse(text) as { message: Record<string, unknown> },
    });
    const answer = this.answers.shift() ?? { status: 200, body: { name: 'projects/x/messages/1' } };
    send(answer.status, answer.body ?? {});
  }
}

describe('FcmHttpProvider (3.6)', () => {
  const fake = new FakeFcm();
  let warn: jest.SpyInstance;

  const provider = () =>
    new FcmHttpProvider({
      projectId: 'rx-test',
      clientEmail: 'push@rx-test.example',
      privateKey: privateKey.replace(/\n/g, '\\n'),
      tokenUrl: `${fake.url}/token`,
      apiUrl: fake.url,
    });

  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fake.signIns = [];
    fake.sends = [];
    fake.answers = [];
    fake.signInStatus = 200;
    fake.issued = 0;
  });
  afterEach(() => warn.mockRestore());

  it('is configured only with all three credentials', () => {
    const full = {
      projectId: 'p',
      clientEmail: 'e',
      privateKey: 'k',
    };
    expect(new FcmHttpProvider(full).configured).toBe(true);
    for (const missing of Object.keys(full)) {
      expect(new FcmHttpProvider({ ...full, [missing]: '' }).configured).toBe(false);
      expect(new FcmHttpProvider({ ...full, [missing]: undefined }).configured).toBe(false);
    }
    expect(new FcmHttpProvider({}).configured).toBe(false);
  });

  it('signs in as the service account with an RS256 assertion', async () => {
    await provider().deliver(TOKEN, payload);
    const [head, claims, signature] = fake.signIns[0].split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(c.iss).toBe('push@rx-test.example');
    expect(c.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(c.aud).toBe(`${fake.url}/token`);
    expect(c.exp - c.iat).toBe(3600);
    const verified = createVerify('RSA-SHA256')
      .update(`${head}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
  });

  it('sends the message through HTTP v1 with the access token', async () => {
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({ ok: true });
    expect(fake.sends).toHaveLength(1);
    const sent = fake.sends[0];
    expect(sent.url).toBe('/v1/projects/rx-test/messages:send');
    expect(sent.auth).toBe('Bearer access-1');
    expect(sent.body.message).toEqual({
      token: TOKEN,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: 'HIGH' },
    });
  });

  it('signs in once and reuses the access token', async () => {
    const fcm = provider();
    await fcm.deliver(TOKEN, payload);
    await fcm.deliver(TOKEN, payload);
    expect(fake.signIns).toHaveLength(1);
    expect(fake.sends).toHaveLength(2);
  });

  it('signs in again when the access token is refused', async () => {
    const fcm = provider();
    fake.answers = [{ status: 401 }];
    await expect(fcm.deliver(TOKEN, payload)).resolves.toEqual({ ok: true });
    expect(fake.signIns).toHaveLength(2);
    expect(fake.sends[1].auth).toBe('Bearer access-2');
  });

  it('gives up after a second refusal', async () => {
    fake.answers = [{ status: 401 }, { status: 401 }];
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
    expect(fake.sends).toHaveLength(2);
  });

  describe("a 401 for the phone's own platform: the APNs certificate or web push key", () => {
    const refused = {
      status: 401,
      body: {
        error: {
          code: 401,
          message: 'Auth error from APNS or Web Push Service',
          status: 'UNAUTHENTICATED',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'THIRD_PARTY_AUTH_ERROR',
            },
          ],
        },
      },
    };

    it('is a refused message, not an expired sign-in: the good access token is kept', async () => {
      const fcm = provider();
      await fcm.deliver(TOKEN, payload);
      fake.answers = [refused];
      await expect(fcm.deliver(TOKEN, payload)).resolves.toEqual({
        ok: false,
        code: 'REJECTED',
      });
      expect(fake.sends).toHaveLength(2);
      expect(fake.signIns).toHaveLength(1);
      // It says what happened, so the missing key can be found.
      expect(warn).toHaveBeenCalledWith('FCM refused a message (HTTP 401)');
      await fcm.deliver(TOKEN, payload);
      expect(fake.sends[2].auth).toBe('Bearer access-1');
    });
  });

  it('a 404 means the token is dead', async () => {
    fake.answers = [{ status: 404, body: { error: { status: 'NOT_FOUND' } } }];
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNREGISTERED',
    });
  });

  it('a 400 naming the token means the token is dead', async () => {
    fake.answers = [
      {
        status: 400,
        body: {
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ fieldViolations: [{ field: 'message.token' }] }],
          },
        },
      },
    ];
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNREGISTERED',
    });
  });

  it('any other 400 is a refused message, and the token stays', async () => {
    fake.answers = [{ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }];
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'REJECTED',
    });
  });

  it.each([429, 500, 503])('a %d is unavailable', async (status) => {
    fake.answers = [{ status }];
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
  });

  it('a refused sign-in is unavailable, and nothing is sent', async () => {
    fake.signInStatus = 400;
    await expect(provider().deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
    expect(fake.sends).toHaveLength(0);
  });

  it('an unreadable key or a dead server is unavailable, and never throws', async () => {
    const badKey = new FcmHttpProvider({
      projectId: 'p',
      clientEmail: 'e',
      privateKey: 'not a key',
      tokenUrl: `${fake.url}/token`,
      apiUrl: fake.url,
    });
    await expect(badKey.deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
    const deadServer = new FcmHttpProvider({
      projectId: 'p',
      clientEmail: 'e',
      privateKey: privateKey,
      tokenUrl: 'http://127.0.0.1:9/token',
      apiUrl: 'http://127.0.0.1:9',
    });
    await expect(deadServer.deliver(TOKEN, payload)).resolves.toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
  });

  it('never logs the token, the key or the access token', async () => {
    fake.answers = [{ status: 500, body: { error: { message: `bad ${TOKEN}` } } }];
    await provider().deliver(TOKEN, payload);
    await new FcmHttpProvider({
      projectId: 'p',
      clientEmail: 'e',
      privateKey: 'not a key',
      tokenUrl: `${fake.url}/token`,
      apiUrl: fake.url,
    }).deliver(TOKEN, payload);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('PRIVATE KEY');
    expect(logged).not.toContain('not a key');
    expect(logged).not.toContain('access-');
  });
});
