import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Namespace, Socket } from 'socket.io';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { UserAccessChangedEvent, endsCredentials } from '@shared/events/user-access-changed.event';
import { parseDurationMs } from '@shared/utils/duration';
import {
  activityViewRoom,
  deptRoom,
  LiveSection,
  orgRoom,
  RoomSubject,
  roomsOfSubject,
} from './socket-rooms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_TTL_MS = 60_000;

/** Every socket of one account, across namespaces, joins this room. */
export function accountRoom(userId: string): string {
  return `account:${userId}`;
}

/** Whether an open socket may stay; `unknown` when the account could not be read. */
export type SocketStanding = 'current' | 'ended' | 'unknown';

/**
 * Socket admission and eviction, shared by every gateway:
 *  - a browser handshake must come from an allowed origin (native agents send
 *    no Origin header and are unaffected);
 *  - the account must still be active and not deleted (a valid token alone is
 *    not enough: it outlives a block by up to its TTL), and the token or ticket
 *    must have been minted under the account's current auth epoch, so one from
 *    before a sign-out opens nothing;
 *  - when someone is blocked, deleted or signed out, changes role or manager, or
 *    signs their other devices out themselves, their open sockets are dropped at
 *    once, so live data stops immediately;
 *  - an open socket is asked about again every access-token lifetime and dropped
 *    once the account is off or its epoch has moved, so no socket outlives a
 *    sign-out by more than a token would, even if an event above was missed.
 */
@Injectable()
export class SocketAccessService implements OnModuleInit {
  private readonly logger = new Logger(SocketAccessService.name);
  private readonly namespaces = new Set<Namespace>();
  private readonly allowedOrigins: string[] | null;
  /** One access-token lifetime: how long a socket goes between checks of its account. */
  private readonly recheckMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    config: ConfigService,
  ) {
    const origins = (config.get<string[]>('corsOrigins') ?? []).filter(Boolean);
    this.allowedOrigins = origins.length === 0 || origins.includes('*') ? null : origins;
    this.recheckMs = parseDurationMs(config.get<string>('jwt.accessTtl') ?? '15m');
  }

  onModuleInit(): void {
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.onAccessChanged(e),
    );
    // Their own "sign out other devices": a socket opened from one of those devices
    // (or from a copied session) must stop receiving too. This device's sockets go
    // with them and come back on the session the password change just issued.
    this.events.subscribe<OtherDevicesSignedOutEvent>(OtherDevicesSignedOutEvent.eventName, (e) =>
      this.dropSockets(e.userId),
    );
  }

  track(ns: Namespace): void {
    this.namespaces.add(ns);
  }

  originAllowed(origin: string | undefined): boolean {
    if (!origin || !this.allowedOrigins) return true;
    return this.allowedOrigins.includes(origin);
  }

  /**
   * Admission. Answers the account's role when it is active, not deleted, and
   * `epoch` (what the handshake's token or ticket was minted under) is its current
   * auth epoch; null otherwise, and when the account cannot be read.
   */
  async admit(userId: string, epoch: number): Promise<{ role: string } | null> {
    try {
      const row = await this.account(userId);
      if (!row || row.status !== 'ACTIVE' || row.authEpoch !== epoch) return null;
      return { role: row.role.name };
    } catch (err) {
      this.logger.warn(`socket account check failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * The same question for a socket that is already open. A failed read answers
   * `unknown` rather than `ended`: a database blip must not end every live socket,
   * and the next check asks again.
   */
  async standing(userId: string, epoch: number): Promise<SocketStanding> {
    try {
      const row = await this.account(userId);
      return row && row.status === 'ACTIVE' && row.authEpoch === epoch ? 'current' : 'ended';
    } catch (err) {
      this.logger.warn(`socket account re-check failed: ${(err as Error).message}`);
      return 'unknown';
    }
  }

  /**
   * Bounds how long an admitted socket goes unquestioned. The handshake is the only
   * time its credential is verified, so every access-token lifetime the account is
   * read again and the socket is ended, the way an evicted one is, once the account
   * is off or its epoch has moved since the credential was minted.
   *
   * Re-checked in place rather than closed at that age: a socket whose account
   * still stands is left open.
   */
  watch(client: Socket, userId: string, epoch: number): void {
    let timer: NodeJS.Timeout | null = null;
    const arm = () => {
      timer = setTimeout(() => void check(), this.recheckMs);
      // Never keeps the process alive.
      timer.unref();
    };
    const check = async () => {
      timer = null;
      if (client.disconnected) return;
      if ((await this.standing(userId, epoch)) === 'ended') {
        this.logger.debug(`ended a socket of ${userId}: its credential no longer stands`);
        client.disconnect(true);
        return;
      }
      if (!client.disconnected) arm();
    };
    client.once('disconnect', () => {
      if (timer) clearTimeout(timer);
      timer = null;
    });
    arm();
  }

  private account(userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { status: true, authEpoch: true, role: { select: { name: true } } },
    });
  }

  /**
   * 4.0: the rooms a portal socket joins for live team data in one namespace:
   * an Admin their organisation's room; a Super Admin the room of the organisation
   * named in the handshake (`auth.orgId`, `?orgId=` or `X-Org-Id`); a Manager the
   * rooms of their departments, and only with a grant: presence with any grant,
   * screenshots with that grant, activity with the timeline and activity grants
   * (the department's room) or one of them (its redacted room, activityViewRoom).
   */
  async roomsFor(userId: string, orgHint: string | null, section: LiveSection): Promise<string[]> {
    try {
      const row = await this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null, status: 'ACTIVE' },
        select: {
          companyId: true,
          grantActivity: true,
          grantScreenshots: true,
          grantTimeline: true,
          role: { select: { name: true } },
          managedDepartments: {
            where: { department: { deletedAt: null } },
            select: { departmentId: true },
          },
        },
      });
      if (!row) return [];
      switch (row.role.name) {
        case 'SUPER_ADMIN':
        case 'SUPER_MANAGER': {
          if (!orgHint || !UUID.test(orgHint)) return [];
          const org = await this.prisma.company.findFirst({
            where: { id: orgHint, deletedAt: null },
            select: { id: true },
          });
          return org ? [orgRoom(org.id)] : [];
        }
        case 'ADMIN':
          return row.companyId ? [orgRoom(row.companyId)] : [];
        case 'MANAGER': {
          const depts = row.managedDepartments.map((m) => deptRoom(m.departmentId));
          const { grantTimeline: timeline, grantActivity: activity } = row;
          switch (section) {
            case 'presence':
              return timeline || activity || row.grantScreenshots ? depts : [];
            case 'screenshots':
              return row.grantScreenshots ? depts : [];
            case 'activity':
              if (timeline && activity) return depts;
              if (timeline) return depts.map((r) => activityViewRoom(r, 'timeline'));
              if (activity) return depts.map((r) => activityViewRoom(r, 'activity'));
              return [];
            default:
              return [];
          }
        }
        default:
          return [];
      }
    } catch (err) {
      this.logger.warn(`socket rooms for ${userId} failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** The organisation a person belongs to (null: none), for the members room. */
  async companyOf(userId: string): Promise<string | null> {
    const row = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { companyId: true } })
      .catch(() => null);
    return row?.companyId ?? null;
  }

  /**
   * The organisation whose config pushes this socket hears: the person's own, or
   * for a Super Admin the one picked in the portal (a live organisation), else none.
   */
  async membersOrgOf(userId: string, orgHint: string | null): Promise<string | null> {
    const row = await this.prisma.user
      .findFirst({
        where: { id: userId, deletedAt: null, status: 'ACTIVE' },
        select: { companyId: true, role: { select: { name: true } } },
      })
      .catch(() => null);
    if (!row) return null;
    if (row.role.name !== 'SUPER_ADMIN' && row.role.name !== 'SUPER_MANAGER')
      return row.companyId ?? null;
    if (!orgHint || !UUID.test(orgHint)) return null;
    const org = await this.prisma.company
      .findFirst({ where: { id: orgHint, deletedAt: null }, select: { id: true } })
      .catch(() => null);
    return org?.id ?? null;
  }

  private readonly subjects = new Map<string, { s: RoomSubject | null; at: number }>();

  /** The rooms a live update about this person goes to (cached for a minute). */
  async roomsOfUser(userId: string): Promise<string[]> {
    const now = Date.now();
    let hit = this.subjects.get(userId);
    if (!hit || now - hit.at > SUBJECT_TTL_MS) {
      const row = await this.prisma.user
        .findUnique({
          where: { id: userId },
          select: { companyId: true, departmentId: true, role: { select: { name: true } } },
        })
        .catch(() => null);
      hit = {
        s: row
          ? { companyId: row.companyId, departmentId: row.departmentId, role: row.role.name }
          : null,
        at: now,
      };
      if (this.subjects.size > 5000) this.subjects.clear();
      this.subjects.set(userId, hit);
    }
    return hit.s ? roomsOfSubject(hit.s) : [];
  }

  private onAccessChanged(e: UserAccessChangedEvent): void {
    this.subjects.delete(e.userId);
    // 4.0 evicts on a role change (a socket's rooms were picked for the old role);
    // 3.6 on everything that raises the auth epoch: whatever an open socket was
    // admitted with is no longer a credential.
    if (endsCredentials(e)) this.dropSockets(e.userId);
  }

  private dropSockets(userId: string): void {
    for (const ns of this.namespaces) ns.in(accountRoom(userId)).disconnectSockets(true);
    this.logger.debug(`dropped live sockets of ${userId}`);
  }
}
