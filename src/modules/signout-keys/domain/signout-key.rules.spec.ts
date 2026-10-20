import { createHash } from 'node:crypto';
import { AttemptLimiter } from './attempt-limiter';
import {
  KEY_TTL_MS,
  PHRASE_PATTERN,
  generatePhrase,
  hashPhrase,
  isKeyActive,
  keyCovers,
  newSalt,
  normalisePhrase,
  phraseMatches,
} from './signout-key.rules';
import { SIGNOUT_WORDS } from './wordlist';

describe('sign-out word list', () => {
  it('has 2048 distinct lowercase common words', () => {
    expect(SIGNOUT_WORDS).toHaveLength(2048);
    expect(new Set(SIGNOUT_WORDS).size).toBe(2048);
    for (const w of SIGNOUT_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/);
  });

  it('leaves out words nobody wants to read to a colleague', () => {
    for (const w of [
      'abuse',
      'bomb',
      'gun',
      'kill',
      'naked',
      'drunk',
      'blood',
      'enemy',
      'sword',
      'toilet',
      'stupid',
    ]) {
      expect(SIGNOUT_WORDS).not.toContain(w);
    }
  });
});

describe('sign-out phrases', () => {
  it('are five list words and a two-digit number', () => {
    for (let i = 0; i < 200; i++) {
      const phrase = generatePhrase();
      expect(phrase).toMatch(PHRASE_PATTERN);
      const parts = phrase.split(' ');
      expect(parts).toHaveLength(6);
      for (const w of parts.slice(0, 5)) expect(SIGNOUT_WORDS).toContain(w);
      expect(Number(parts[5])).toBeGreaterThanOrEqual(10);
      expect(Number(parts[5])).toBeLessThanOrEqual(99);
    }
  });

  it('draw from the random source given (crypto.randomInt by default)', () => {
    const calls: [number, number][] = [];
    const rand = (min: number, max: number) => {
      calls.push([min, max]);
      return min;
    };
    expect(generatePhrase(rand)).toBe(`${Array(5).fill(SIGNOUT_WORDS[0]).join(' ')} 10`);
    expect(calls).toEqual([
      [0, 2048],
      [0, 2048],
      [0, 2048],
      [0, 2048],
      [0, 2048],
      [10, 100],
    ]);
  });

  it('normalise case and spacing', () => {
    expect(normalisePhrase('  Amber   ORBIT cedar\triver  lamp 42 ')).toBe(
      'amber orbit cedar river lamp 42',
    );
  });
});

describe('sign-out key hashing', () => {
  const phrase = 'amber orbit cedar river lamp 42';

  it('stores sha256(salt + normalised phrase) with a 16-byte hex salt', () => {
    const salt = newSalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(newSalt()).not.toBe(salt);
    expect(hashPhrase(salt, ' Amber Orbit  cedar river lamp 42')).toBe(
      createHash('sha256')
        .update(salt + phrase)
        .digest('hex'),
    );
  });

  it('matches the phrase however it is typed, and nothing else', () => {
    const salt = newSalt();
    const key = { salt, phraseHash: hashPhrase(salt, phrase) };
    expect(phraseMatches(key, 'AMBER orbit cedar river lamp   42')).toBe(true);
    expect(phraseMatches(key, 'amber orbit cedar river lamp 43')).toBe(false);
    expect(phraseMatches(key, '')).toBe(false);
    expect(phraseMatches({ salt: newSalt(), phraseHash: key.phraseHash }, phrase)).toBe(false);
  });
});

describe('sign-out key scope', () => {
  const staff = { id: 's1', role: 'USER', departmentId: 'd1', managedDepartmentIds: [] };
  const mgr = { id: 'm1', role: 'MANAGER', departmentId: 'd9', managedDepartmentIds: ['d2', 'd3'] };

  it('USERS covers the people listed only', () => {
    expect(keyCovers({ scope: 'USERS', userIds: ['s1'], departmentIds: [] }, staff)).toBe(true);
    expect(keyCovers({ scope: 'USERS', userIds: ['x'], departmentIds: ['d1'] }, staff)).toBe(false);
  });

  it("DEPARTMENTS covers a person's department, and a Manager's managed ones", () => {
    expect(keyCovers({ scope: 'DEPARTMENTS', userIds: [], departmentIds: ['d1'] }, staff)).toBe(
      true,
    );
    expect(keyCovers({ scope: 'DEPARTMENTS', userIds: ['s1'], departmentIds: ['d2'] }, staff)).toBe(
      false,
    );
    expect(keyCovers({ scope: 'DEPARTMENTS', userIds: [], departmentIds: ['d3'] }, mgr)).toBe(true);
    expect(keyCovers({ scope: 'DEPARTMENTS', userIds: [], departmentIds: ['d9'] }, mgr)).toBe(true);
    expect(keyCovers({ scope: 'DEPARTMENTS', userIds: [], departmentIds: ['d1'] }, mgr)).toBe(
      false,
    );
    // Only a Manager's managed departments count, never a Staff member's "managed" list.
    expect(
      keyCovers(
        { scope: 'DEPARTMENTS', userIds: [], departmentIds: ['d2'] },
        { ...staff, managedDepartmentIds: ['d2'] },
      ),
    ).toBe(false);
  });

  it('ORG covers everyone (the organisation is checked by the query)', () => {
    expect(keyCovers({ scope: 'ORG', userIds: [], departmentIds: [] }, staff)).toBe(true);
    expect(keyCovers({ scope: 'NOPE', userIds: ['s1'], departmentIds: ['d1'] }, staff)).toBe(false);
  });

  it('is active for 24 hours unless revoked', () => {
    const created = new Date('2026-10-19T10:00:00Z');
    const key = { revokedAt: null, expiresAt: new Date(created.getTime() + KEY_TTL_MS) };
    expect(isKeyActive(key, new Date('2026-10-20T09:59:59Z'))).toBe(true);
    expect(isKeyActive(key, new Date('2026-10-20T10:00:00Z'))).toBe(false);
    expect(isKeyActive({ ...key, revokedAt: created }, created)).toBe(false);
  });
});

describe('attempt limiter', () => {
  it('allows 5 failures in 10 minutes, then refuses until the oldest ages out', () => {
    const limiter = new AttemptLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.retryAfterSec('p', t0 + i * 1000)).toBe(0);
      limiter.recordFailure('p', t0 + i * 1000);
    }
    expect(limiter.retryAfterSec('p', t0 + 5000)).toBe(595);
    expect(limiter.retryAfterSec('other', t0 + 5000)).toBe(0);
    expect(limiter.retryAfterSec('p', t0 + 600_000)).toBe(0);
  });

  it('a success clears the count', () => {
    const limiter = new AttemptLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure('p', i);
    limiter.reset('p');
    expect(limiter.retryAfterSec('p', 10)).toBe(0);
  });

  it('stays bounded in memory', () => {
    const limiter = new AttemptLimiter(5, 1000, 3);
    for (let i = 0; i < 10; i++) limiter.recordFailure(`p${i}`, 0);
    expect(limiter.retryAfterSec('p9', 1)).toBe(0);
  });
});
