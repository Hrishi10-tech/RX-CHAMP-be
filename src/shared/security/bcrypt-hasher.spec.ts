import { ConfigService } from '@nestjs/config';
import { BcryptHasher } from './bcrypt-hasher';

// bcrypt moved from 5 to 6 (S-1, 19 November 2026: 5 pulled in a vulnerable tar). Every password in
// the database was hashed by 5, so 6 must go on reading them.
describe('BcryptHasher', () => {
  const hasher = new BcryptHasher({
    get: () => ({ bcryptSaltRounds: 4 }),
  } as unknown as ConfigService);

  // Made with bcrypt 5.1.1, rounds 10 and 12.
  const MADE_BY_5 = [
    {
      plain: 'Rx-Vision-36!',
      hash: '$2b$10$MLqkYyBQzzSHN6j84/SlCOufrTxpgj5nv7jD36E5se96ljeb0.OM6',
    },
    { plain: 'admin123', hash: '$2b$12$DzIKtedt03SgvTYv6q6XoOKK7BguE3AyviQnIc84kOp8G/EE.Hv/q' },
  ];

  it.each(MADE_BY_5)('reads a hash made by bcrypt 5 ($plain)', async ({ plain, hash }) => {
    await expect(hasher.compare(plain, hash)).resolves.toBe(true);
    await expect(hasher.compare(`${plain}x`, hash)).resolves.toBe(false);
  });

  it('writes a hash it reads back, in the same $2b$ format', async () => {
    const hash = await hasher.hash('a new password');
    expect(hash.startsWith('$2b$04$')).toBe(true);
    await expect(hasher.compare('a new password', hash)).resolves.toBe(true);
  });
});
