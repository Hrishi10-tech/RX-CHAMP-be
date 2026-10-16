import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Namespace } from 'socket.io';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';

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

  private onAccessChanged(e: UserAccessChangedEvent): void {
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
