import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterPushTokenDto, RemovePushTokenDto } from './push.dto';

const TOKEN = 'x'.repeat(163);

function errorsOf<T extends object>(cls: new () => T, value: unknown) {
  return validateSync(plainToInstance(cls, value) as object).map((e) => e.property);
}

describe('push token requests (3.6)', () => {
  it.each(['android', 'ios', 'web', 'ANDROID', ' iOS '])('accepts platform %s', (platform) => {
    expect(errorsOf(RegisterPushTokenDto, { token: TOKEN, platform })).toEqual([]);
    expect(plainToInstance(RegisterPushTokenDto, { token: TOKEN, platform }).platform).toBe(
      platform.trim().toLowerCase(),
    );
  });

  it('refuses an unknown platform', () => {
    expect(errorsOf(RegisterPushTokenDto, { token: TOKEN, platform: 'symbian' })).toEqual([
      'platform',
    ]);
    expect(errorsOf(RegisterPushTokenDto, { token: TOKEN })).toEqual(['platform']);
  });

  it.each([undefined, '', 'short', 'x'.repeat(4097), 42])('refuses token %s', (token) => {
    expect(errorsOf(RegisterPushTokenDto, { token, platform: 'android' })).toEqual(['token']);
  });

  it('a removal may name one token, or none', () => {
    expect(errorsOf(RemovePushTokenDto, {})).toEqual([]);
    expect(errorsOf(RemovePushTokenDto, { token: TOKEN })).toEqual([]);
    expect(errorsOf(RemovePushTokenDto, { token: 'short' })).toEqual(['token']);
  });

  it('a token of null names nothing: it is refused, never read as every phone', () => {
    expect(errorsOf(RemovePushTokenDto, { token: null })).toEqual(['token']);
    expect(errorsOf(RegisterPushTokenDto, { token: null, platform: 'android' })).toEqual(['token']);
  });

  describe.each([
    ['registering', RegisterPushTokenDto],
    ['removing', RemovePushTokenDto],
  ] as const)('%s takes only what a real token can be', (_label, dto) => {
    const body = (token: unknown) => ({ token, platform: 'android' });

    it.each([
      ['an FCM-shaped token', 'dGVzdC10b2tlbg:APA91bH-abc_DEF0123456789'],
      ['the longest allowed', 'x'.repeat(1024)],
    ])('accepts %s', (_name, token) => {
      expect(errorsOf(dto, body(token))).toEqual([]);
    });

    it.each([
      // Longer than the unique index can hold when it does not compress: a 500 before.
      ['one character too long', 'x'.repeat(1025)],
      ['2,800 characters', 'x'.repeat(2800)],
      ['a NUL byte', `${'x'.repeat(30)}\u0000${'x'.repeat(30)}`],
      ['a line break inside', `${'x'.repeat(30)}\n${'x'.repeat(30)}`],
      ['a lone surrogate', `${'x'.repeat(30)}\ud800${'x'.repeat(30)}`],
      ['a space inside', `${'x'.repeat(30)} ${'x'.repeat(30)}`],
    ])('refuses %s', (_name, token) => {
      expect(errorsOf(dto, body(token))).toEqual(['token']);
    });

    it('refuses a JSON number turned into text by the real pipe', () => {
      const converted = plainToInstance(dto, body(123456789012345678901234567890), {
        enableImplicitConversion: true,
      }) as object;
      expect(validateSync(converted).map((e) => e.property)).toEqual(['token']);
    });
  });
});
