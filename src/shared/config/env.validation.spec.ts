import 'reflect-metadata';
import { environmentProblems, validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('environment checks', () => {
  it('accepts a sound production config without warnings', () => {
    const r = environmentProblems({
      ...base,
      NODE_ENV: 'production',
      JWT_ENROLL_SECRET: 'c'.repeat(40),
      CORS_ORIGINS: 'https://vision.example.com',
      APP_TIMEZONE: 'Asia/Kolkata',
    });
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it('refuses placeholder secrets and unknown timezones', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me-access' }),
    ).toThrow(/published placeholder/);
    expect(() => validateEnv({ ...base, APP_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA timezone/);
  });

  it('refuses the .env.example placeholders and an enroll secret equal to the access secret', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_REFRESH_SECRET: 'change-me-refresh-secret',
      }),
    ).toThrow(/JWT_REFRESH_SECRET is a published placeholder/);
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_ENROLL_SECRET: base.JWT_ACCESS_SECRET }),
    ).toThrow(/must differ from JWT_ACCESS_SECRET/);
    // Outside production the example file still works for development.
    expect(() =>
      validateEnv({ ...base, JWT_ACCESS_SECRET: 'change-me-access-secret' }),
    ).not.toThrow();
  });

  it('warns, without failing, about soft production risks', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).not.toThrow();
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/CORS_ORIGINS/);
    expect(said).toMatch(/JWT_ENROLL_SECRET is not set/);
    warn.mockRestore();
  });

  it('still requires the database and both JWT secrets', () => {
    expect(() => validateEnv({ DATABASE_URL: 'x' })).toThrow(/JWT_ACCESS_SECRET/);
  });
});
