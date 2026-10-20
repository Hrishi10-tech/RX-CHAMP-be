import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Namespace } from 'socket.io';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
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

/**
 * Socket admission and eviction, shared by every gateway:
 *  - a browser handshake must come from an allowed origin (native agents send
 *    no Origin header and are unaffected);
 *  - the account must still be active and not deleted (a valid token alone is
 *    not enough: it outlives a block by up to its TTL);
 *  - when someone is blocked, deleted, signed out or changes role, their open
 *    sockets are dropped at once, so live data stops immediately.
 */
@Injectable()
export class SocketAccessService implements OnModuleInit {
  private readonly logger = new Logger(SocketAccessService.name);
  private readonly namespaces = new Set<Namespace>();
  private readonly allowedOrigins: string[] | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    config: ConfigService,
  ) {
    const origins = (config.get<string[]>('corsOrigins') ?? []).filter(Boolean);
    this.allowedOrigins = origins.length === 0 || origins.includes('*') ? null : origins;
  }

  onModuleInit(): void {
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.onAccessChanged(e),
    );
  }

  track(ns: Namespace): void {
    this.namespaces.add(ns);
  }

  originAllowed(origin: string | undefined): boolean {
    if (!origin || !this.allowedOrigins) return true;
    return this.allowedOrigins.includes(origin);
  }

  async isActive(userId: string): Promise<boolean> {
    try {
      const row = await this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      return row !== null;
    } catch (err) {
      this.logger.warn(`socket account check failed: ${(err as Error).message}`);
      return false;
    }
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
        case 'SUPER_ADMIN': {
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
    if (row.role.name !== 'SUPER_ADMIN') return row.companyId ?? null;
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
    const evict =
      e.changes.includes('DELETED') ||
      e.changes.includes('SIGN_OUT') ||
      e.changes.includes('ROLE') ||
      (e.changes.includes('STATUS') && e.active === false);
    if (!evict) return;
    for (const ns of this.namespaces) ns.in(accountRoom(e.userId)).disconnectSockets(true);
    this.logger.debug(`dropped live sockets of ${e.userId}`);
  }
}
