import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { SIGNOUT_WORDS } from './wordlist';

/**
 * Sign-out keys (docs/4.0/SPEC.md 2.8). Pure apart from the random source:
 * phrase generation, normalisation, salted hashing and the scope check.
 */

export type SignOutScopeName = 'USERS' | 'DEPARTMENTS' | 'ORG';

/** Valid for 24 hours from creation. */
export const KEY_TTL_MS = 24 * 60 * 60 * 1000;
export const PHRASE_WORDS = 5;

/** "amber orbit cedar river lamp 42": five list words and a two-digit number (10..99). */
export const PHRASE_PATTERN = /^[a-z]{3,8}( [a-z]{3,8}){4} [1-9]\d$/;

export type RandomInt = (min: number, max: number) => number;

/** A new phrase from a cryptographic random source (crypto.randomInt by default). */
export function generatePhrase(rand: RandomInt = randomInt): string {
  const words: string[] = [];
  for (let i = 0; i < PHRASE_WORDS; i++) words.push(SIGNOUT_WORDS[rand(0, SIGNOUT_WORDS.length)]);
  // 10..99, so the number always has two digits and no leading zero to mistype.
  return `${words.join(' ')} ${rand(10, 100)}`;
}

/** What people type, as compared: lowercase, trimmed, single spaces. */
export function normalisePhrase(raw: string): string {
  return (raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** 16 random bytes, hex. */
export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

/** sha256(salt + normalised phrase), hex. Only this is stored. */
export function hashPhrase(salt: string, phrase: string): string {
  return createHash('sha256')
    .update(salt + normalisePhrase(phrase), 'utf8')
    .digest('hex');
}

/** Constant-time comparison of a typed phrase against a stored key. */
export function phraseMatches(key: { salt: string; phraseHash: string }, phrase: string): boolean {
  const a = Buffer.from(hashPhrase(key.salt, phrase), 'hex');
  const b = Buffer.from(key.phraseHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface KeyScope {
  scope: SignOutScopeName | string;
  userIds: string[];
  departmentIds: string[];
}

export interface KeyHolder {
  id: string;
  role: string;
  departmentId: string | null;
  /** A Manager's departments (empty for other roles). */
  managedDepartmentIds: string[];
}

/**
 * Whether a key's scope covers this person (the organisation is checked by the
 * caller): USERS lists them; DEPARTMENTS lists their department, or for a Manager
 * any department they manage; ORG covers everyone.
 */
export function keyCovers(key: KeyScope, who: KeyHolder): boolean {
  switch (key.scope) {
    case 'USERS':
      return key.userIds.includes(who.id);
    case 'DEPARTMENTS': {
      const depts = new Set(key.departmentIds);
      if (who.departmentId && depts.has(who.departmentId)) return true;
      return who.role === 'MANAGER' && who.managedDepartmentIds.some((d) => depts.has(d));
    }
    case 'ORG':
      return true;
    default:
      return false;
  }
}

/** Not revoked and not expired at `now`. */
export function isKeyActive(key: { revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return key.revokedAt === null && key.expiresAt.getTime() > now.getTime();
}
