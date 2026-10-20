import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  ForbiddenError,
  NotFoundError,
  TooManyAttemptsError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, orgOf, requireOrg } from '@shared/tenancy';
import { isId } from '@shared/validation/is-id';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '@modules/auth/domain/refresh-token.repository';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import { AttemptLimiter } from '../domain/attempt-limiter';
import { AgentSignedOutEvent } from '../domain/agent-signed-out.event';
import {
  KEY_TTL_MS,
  SignOutScopeName,
  generatePhrase,
  hashPhrase,
  isKeyActive,
  keyCovers,
  newSalt,
  phraseMatches,
} from '../domain/signout-key.rules';

/** GET /signout-keys item (docs/4.0/SPEC.md 5.5). */
export interface SignOutKeyView {
  id: string;
  scope: SignOutScopeName;
  users: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  uses: number;
  active: boolean;
}

/** POST /signout-keys: the phrase is shown this once and never stored. */
export interface CreatedSignOutKey {
  id: string;
  scope: SignOutScopeName;
  phrase: string;
  expiresAt: string;
}

export interface CreateKeyInput {
  scope: SignOutScopeName;
  userIds?: string[];
  departmentIds?: string[];
}

type KeyRow = Prisma.SignOutKeyGetPayload<Record<string, never>>;

/** Keys listed: created in the last 30 days, newest first. */
const LIST_DAYS = 30;
const LIST_LIMIT = 200;
const MAX_USERS = 500;
const MAX_DEPARTMENTS = 100;

type KeyPurpose = 'SIGN_OUT' | 'QUIT';

function invalidKey(): ForbiddenError {
  return new ForbiddenError(
    'That key is not valid. Check it with your admin.',
    'SIGNOUT_KEY_INVALID',
  );
}

function nameOf(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

/**
 * Sign-out keys (docs/4.0/SPEC.md 2.8, 5.5, 5.6). The Admin issues a 24-hour key
 * for some people, some departments or the whole organisation; an agent signs out
 * (or an Admin's agent quits) only with a valid key whose scope covers the person.
 * Only a salted SHA-256 of the phrase is stored. Every issue, revoke, use and
 * failure is audited; 5 wrong keys in 10 minutes per person answer 429.
 */
@Injectable()
export class SignOutKeysService {
  private readonly attempts = new AttemptLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  // ---- Admin side ----------------------------------------------------------------

  private adminOrg(me: AuthenticatedUser): string {
    const org = requireOrg(me);
    if (!isAdminLike(me))
      throw new ForbiddenError('Only the organisation admin can manage sign-out keys.');
    return org;
  }

  async list(me: AuthenticatedUser, now: Date = new Date()): Promise<SignOutKeyView[]> {
    const org = this.adminOrg(me);
    const keys = await this.prisma.signOutKey.findMany({
      where: {
        companyId: org,
        createdAt: { gte: new Date(now.getTime() - LIST_DAYS * 86_400_000) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: LIST_LIMIT,
    });
    return this.views(org, keys, now);
  }

  async create(
    me: AuthenticatedUser,
    input: CreateKeyInput,
    now: Date = new Date(),
  ): Promise<CreatedSignOutKey> {
    const org = this.adminOrg(me);
    const userIds = [...new Set(input.userIds ?? [])];
    const departmentIds = [...new Set(input.departmentIds ?? [])];

    switch (input.scope) {
      case 'USERS': {
        if (departmentIds.length) throw this.mixed();
        if (userIds.length === 0 || userIds.length > MAX_USERS) {
          throw new ValidationError(`Choose 1 to ${MAX_USERS} people.`).withDetails({
            field: 'userIds',
          });
        }
        const found = await this.prisma.user.count({
          where: {
            id: { in: userIds.filter(isId) },
            companyId: org,
            deletedAt: null,
            role: { name: { not: 'SUPER_ADMIN' } },
          },
        });
        if (found !== userIds.length) {
          throw new NotFoundError(
            'Some of these people are not in this organisation.',
            'PERSON_NOT_FOUND',
          );
        }
        break;
      }
      case 'DEPARTMENTS': {
        if (userIds.length) throw this.mixed();
        if (departmentIds.length === 0 || departmentIds.length > MAX_DEPARTMENTS) {
          throw new ValidationError(`Choose 1 to ${MAX_DEPARTMENTS} departments.`).withDetails({
            field: 'departmentIds',
          });
        }
        const found = await this.prisma.department.count({
          where: { id: { in: departmentIds.filter(isId) }, companyId: org, deletedAt: null },
        });
        if (found !== departmentIds.length) {
          throw new NotFoundError(
            'That department does not exist in this organisation.',
            'DEPARTMENT_NOT_FOUND',
          );
        }
        break;
      }
      case 'ORG':
        if (userIds.length || departmentIds.length) throw this.mixed();
        break;
      default:
        throw new ValidationError('scope must be USERS, DEPARTMENTS or ORG.').withDetails({
          field: 'scope',
        });
    }

    const phrase = generatePhrase();
    const salt = newSalt();
    const expiresAt = new Date(now.getTime() + KEY_TTL_MS);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.signOutKey.create({
        data: {
          companyId: org,
          phraseHash: hashPhrase(salt, phrase),
          salt,
          scope: input.scope,
          userIds: input.scope === 'USERS' ? userIds : [],
          departmentIds: input.scope === 'DEPARTMENTS' ? departmentIds : [],
          createdById: me.id,
          createdAt: now,
          expiresAt,
        },
      });
      await this.audit.record(
        {
          actorId: me.id,
          action: 'SIGNOUT_KEY_CREATED',
          entity: 'SIGNOUT_KEY',
          entityId: created.id,
          metadata: {
            companyId: org,
            scope: input.scope,
            userIds: created.userIds,
            departmentIds: created.departmentIds,
            expiresAt: expiresAt.toISOString(),
          },
        },
        tx,
      );
      return created;
    });
    return { id: row.id, scope: input.scope, phrase, expiresAt: expiresAt.toISOString() };
  }

  async revoke(me: AuthenticatedUser, id: string, now: Date = new Date()): Promise<SignOutKeyView> {
    const org = this.adminOrg(me);
    const key = isId(id)
      ? await this.prisma.signOutKey.findFirst({ where: { id, companyId: org } })
      : null;
    if (!key) throw new NotFoundError('That key does not exist.', 'SIGNOUT_KEY_NOT_FOUND');
    let row = key;
    if (!key.revokedAt) {
      row = await this.prisma.signOutKey.update({
        where: { id: key.id },
        data: { revokedAt: now },
      });
      await this.audit.record({
        actorId: me.id,
        action: 'SIGNOUT_KEY_REVOKED',
        entity: 'SIGNOUT_KEY',
        entityId: key.id,
        metadata: { companyId: org, uses: key.uses },
      });
    }
    return (await this.views(org, [row], now))[0];
  }

  private mixed(): ValidationError {
    return new ValidationError(
      'Give people for a USERS key, departments for a DEPARTMENTS key, and neither for an ORG key.',
    );
  }

  /** Names for a page of keys: one query for people, one for departments. */
  private async views(org: string, keys: KeyRow[], now: Date): Promise<SignOutKeyView[]> {
    const personIds = [...new Set(keys.flatMap((k) => [...k.userIds, k.createdById]))].filter(isId);
    const deptIds = [...new Set(keys.flatMap((k) => k.departmentIds))].filter(isId);
    const [people, depts] = await Promise.all([
      personIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: personIds } },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
      deptIds.length
        ? this.prisma.department.findMany({
            where: { id: { in: deptIds }, companyId: org },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const personName = new Map(people.map((p) => [p.id, nameOf(p)] as const));
    const deptName = new Map(depts.map((d) => [d.id, d.name] as const));
    return keys.map((k) => ({
      id: k.id,
      scope: k.scope as SignOutScopeName,
      users: k.userIds.map((id) => ({ id, name: personName.get(id) ?? 'Removed person' })),
      departments: k.departmentIds.map((id) => ({
        id,
        name: deptName.get(id) ?? 'Removed department',
      })),
      createdBy: personName.has(k.createdById)
        ? { id: k.createdById, name: personName.get(k.createdById)! }
        : null,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt.toISOString(),
      revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
      uses: k.uses,
      active: isKeyActive(k, now),
    }));
  }

  // ---- Agent side ----------------------------------------------------------------

  /**
   * POST /agent/sign-out: a valid key whose scope covers the caller ends their
   * desktop-agent sessions and moves their enrollVersion on (installers and setup
   * codes issued before stop working). The portal session is left alone.
   */
  async signOut(
    me: AuthenticatedUser,
    phrase: string,
    now: Date = new Date(),
  ): Promise<{ signedOut: true }> {
    const key = await this.useKey(me, phrase, 'SIGN_OUT', now);
    const sessions = await this.refreshTokens.revokeAgentSessions(me.id);
    const enrollVersion = await this.users.bumpEnrollVersion(me.id);
    await this.audit.record({
      actorId: me.id,
      action: 'SIGNOUT_KEY_USED',
      entity: 'SIGNOUT_KEY',
      entityId: key.id,
      metadata: {
        companyId: key.companyId,
        userId: me.id,
        agentSessionsEnded: sessions,
        enrollVersion,
      },
    });
    await this.events.publish(
      AgentSignedOutEvent.eventName,
      new AgentSignedOutEvent(me.id, key.companyId, key.id, now),
    );
    return { signedOut: true };
  }

  /** POST /agent/quit-check: the same key check for an Admin's or Super Admin's agent quitting. */
  async quitCheck(
    me: AuthenticatedUser,
    phrase: string,
    now: Date = new Date(),
  ): Promise<{ allowed: true }> {
    if (!isAdminLike(me)) {
      throw new ForbiddenError(
        'Only admins can quit RX Vision. Use Sign out instead.',
        'QUIT_NOT_ALLOWED',
      );
    }
    const key = await this.useKey(me, phrase, 'QUIT', now);
    await this.audit.record({
      actorId: me.id,
      action: 'QUIT_KEY_USED',
      entity: 'SIGNOUT_KEY',
      entityId: key.id,
      metadata: { companyId: key.companyId, userId: me.id },
    });
    return { allowed: true };
  }

  /**
   * Finds a valid key of the caller's organisation that covers them and matches
   * the phrase, and counts the use. A Super Admin (no organisation of their own)
   * may use an organisation-wide key of any organisation.
   */
  private async useKey(
    me: AuthenticatedUser,
    phrase: string,
    purpose: KeyPurpose,
    now: Date,
  ): Promise<KeyRow> {
    const wait = this.attempts.retryAfterSec(me.id, now.getTime());
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      throw new TooManyAttemptsError(
        `Too many wrong keys. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      ).withDetails({ retryAfterSec: wait });
    }

    const org = orgOf(me);
    const superAdmin = me.role === Role.SUPER_ADMIN;
    const candidates =
      org || superAdmin
        ? await this.prisma.signOutKey.findMany({
            where: {
              revokedAt: null,
              expiresAt: { gt: now },
              ...(superAdmin ? { scope: 'ORG' as const } : { companyId: org! }),
            },
            orderBy: { createdAt: 'desc' },
            take: 500,
          })
        : [];
    const holder = {
      id: me.id,
      role: me.role,
      departmentId: me.departmentId ?? null,
      managedDepartmentIds: me.managedDepartmentIds ?? [],
    };
    const match = candidates.find((k) => keyCovers(k, holder) && phraseMatches(k, phrase));

    // Claimed atomically: a key revoked or expiring meanwhile is not used.
    const claimed = match
      ? await this.prisma.signOutKey.updateMany({
          where: { id: match.id, revokedAt: null, expiresAt: { gt: now } },
          data: { uses: { increment: 1 } },
        })
      : { count: 0 };
    if (!match || claimed.count === 0) {
      this.attempts.recordFailure(me.id, now.getTime());
      await this.audit.record({
        actorId: me.id,
        action: purpose === 'QUIT' ? 'QUIT_KEY_FAILED' : 'SIGNOUT_KEY_FAILED',
        entity: 'SIGNOUT_KEY',
        entityId: null,
        metadata: { companyId: org, userId: me.id },
      });
      throw invalidKey();
    }
    this.attempts.reset(me.id);
    return match;
  }
}
