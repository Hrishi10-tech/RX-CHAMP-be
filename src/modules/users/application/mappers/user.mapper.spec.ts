import { Role } from '@shared/rbac/roles.enum';
import { LIVE_GRACE_SEC } from '@modules/activity/application/activity.constants';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { UserMapper } from './user.mapper';

/**
 * The Status column exists because the account's own status could not answer "is
 * this person actually being tracked?". These pin the three answers, and in
 * particular that a one-off activation stamp never gets mistaken for one.
 */
function user(over: { agentActivatedAt?: Date | null } = {}): User {
  return User.fromPersistence({
    id: UserId.create('u-1'),
    email: Email.create('u@acme.test'),
    passwordHash: 'h',
    firstName: 'Uma',
    lastName: 'C',
    designation: null,
    role: Role.USER,
    department: null,
    managerId: null,
    companyId: null,
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status: 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: over.agentActivatedAt === undefined ? new Date() : over.agentActivatedAt,
    createdAt: new Date(),
  });
}

describe('UserMapper.agentStatusOf', () => {
  const now = new Date('2026-09-03T10:00:00.000Z');
  const secondsAgo = (n: number) => new Date(now.getTime() - n * 1000);

  /** Signed in, day not ended — the ordinary case. */
  const at = (seen?: Date) => ({ lastSeenAt: seen, dayEndedToday: false, signedOut: false });

  it('is NOT_ACTIVATED when the agent has never enrolled', () => {
    expect(UserMapper.agentStatusOf(user({ agentActivatedAt: null }), at(), now)).toBe(
      'NOT_ACTIVATED',
    );
  });

  it('stays NOT_ACTIVATED whatever else is true', () => {
    // Never enrolled outranks everything; nothing else is worth saying.
    expect(
      UserMapper.agentStatusOf(
        user({ agentActivatedAt: null }),
        { lastSeenAt: secondsAgo(5), dayEndedToday: true, signedOut: true },
        now,
      ),
    ).toBe('NOT_ACTIVATED');
  });

  it('is LIVE while reporting inside the grace window', () => {
    expect(UserMapper.agentStatusOf(user(), at(secondsAgo(30)), now)).toBe('LIVE');
    expect(UserMapper.agentStatusOf(user(), at(secondsAgo(LIVE_GRACE_SEC)), now)).toBe('LIVE');
  });

  it('is LIVE even after End Day, if reports are still arriving', () => {
    // Something is plainly running, whatever was pressed earlier — say so rather
    // than repeating a stale button press back at the reader.
    expect(
      UserMapper.agentStatusOf(
        user(),
        { lastSeenAt: secondsAgo(20), dayEndedToday: true, signedOut: false },
        now,
      ),
    ).toBe('LIVE');
  });

  it('is DAY_ENDED when they finished their day and went quiet', () => {
    // The silence is explained, so it must not read as a fault — otherwise every
    // properly finished day looks broken by evening.
    expect(
      UserMapper.agentStatusOf(
        user(),
        { lastSeenAt: secondsAgo(3 * 3600), dayEndedToday: true, signedOut: false },
        now,
      ),
    ).toBe('DAY_ENDED');
  });

  it('prefers DAY_ENDED over being signed out', () => {
    expect(
      UserMapper.agentStatusOf(
        user(),
        { lastSeenAt: secondsAgo(3 * 3600), dayEndedToday: true, signedOut: true },
        now,
      ),
    ).toBe('DAY_ENDED');
  });

  it('is NOT_SIGNED_IN when no usable session is left', () => {
    // Signed out or session broken — same remedy, and a different job from
    // "go and look at the machine".
    expect(
      UserMapper.agentStatusOf(
        user(),
        { lastSeenAt: secondsAgo(5 * 86400), dayEndedToday: false, signedOut: true },
        now,
      ),
    ).toBe('NOT_SIGNED_IN');
  });

  it('is OFFLINE once the grace window has passed', () => {
    expect(UserMapper.agentStatusOf(user(), at(secondsAgo(LIVE_GRACE_SEC + 1)), now)).toBe(
      'OFFLINE',
    );
  });

  it('is OFFLINE for an enrolled agent that has never reported', () => {
    expect(UserMapper.agentStatusOf(user(), at(undefined), now)).toBe('OFFLINE');
  });

  it('is OFFLINE after days of silence — the case the column exists for', () => {
    expect(UserMapper.agentStatusOf(user(), at(secondsAgo(5 * 86400)), now)).toBe('OFFLINE');
  });

  it('is OFFLINE when nothing at all is known about the agent', () => {
    expect(UserMapper.agentStatusOf(user(), undefined, now)).toBe('OFFLINE');
  });

  it('carries the last-seen time onto the row', () => {
    const seen = secondsAgo(90);
    const row = UserMapper.toListItem(user(), at(seen), now);
    expect(row.agentStatus).toBe('LIVE');
    expect(row.agentLastSeenAt).toBe(seen.toISOString());
  });

  it('reports no last-seen time when there is none', () => {
    expect(UserMapper.toListItem(user(), at(undefined), now).agentLastSeenAt).toBeNull();
  });
});
