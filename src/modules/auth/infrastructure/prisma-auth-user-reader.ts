import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrganisationChangedEvent } from '@shared/events/organisation-changed.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Permission } from '@shared/rbac/permissions.enum';
import { Role } from '@shared/rbac/roles.enum';
import { AuthUserReader } from '../domain/auth-user-reader.port';

const ORG_TTL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PrismaAuthUserReader implements AuthUserReader, OnModuleInit {
  /** Organisation id -> exists, for the Super Admin's X-Org-Id (read on every request). */
  private readonly orgs = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(EVENT_BUS) private readonly events?: EventBus,
  ) {}

  /** A created, renamed or deleted organisation is re-read on the next request. */
  onModuleInit(): void {
    this.events?.subscribe<OrganisationChangedEvent>(OrganisationChangedEvent.eventName, (e) =>
      this.forgetOrg(e.companyId),
    );
  }

  async loadById(id: string, orgHeader?: string | null): Promise<AuthenticatedUser | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        role: true,
        company: { select: { deletedAt: true } },
        managedDepartments: {
          where: { department: { deletedAt: null } },
          select: { departmentId: true },
        },
      },
    });
    if (!row) return null;

    const role = row.role.name as Role;
    // 4.0: someone left in an organisation that was deleted acts in none (404).
    const orgDeleted = role !== Role.SUPER_ADMIN && !!row.companyId && !!row.company?.deletedAt;
    const user: AuthenticatedUser = {
      id: row.id,
      email: row.email,
      role,
      permissions: row.role.permissions as Permission[],
      department: row.department,
      companyId: row.companyId,
      status: row.status,
      orgId: role === Role.SUPER_ADMIN || orgDeleted ? null : row.companyId,
      ...(orgDeleted ? { orgDeleted: true } : {}),
      departmentId: row.departmentId,
      managedDepartmentIds:
        role === Role.MANAGER ? row.managedDepartments.map((m) => m.departmentId) : [],
      grants:
        role === Role.MANAGER
          ? {
              screenshots: row.grantScreenshots,
              timeline: row.grantTimeline,
              activity: row.grantActivity,
            }
          : undefined,
    };

    if (role === Role.SUPER_ADMIN) {
      const header = orgHeader?.trim();
      if (header && header !== 'all') {
        if (UUID.test(header) && (await this.orgExists(header))) user.orgId = header;
        else user.orgHeaderInvalid = true;
      }
    }
    return user;
  }

  private async orgExists(id: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.orgs.get(id);
    if (hit && now - hit.at < ORG_TTL_MS) return hit.ok;
    const generation = this.generation;
    const found = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (this.orgs.size > 1000) this.orgs.clear();
    // A read that began before an organisation changed is not kept: it may have
    // seen the organisation just before it was deleted.
    if (generation === this.generation) this.orgs.set(id, { ok: !!found, at: now });
    return !!found;
  }

  /** Bumped whenever an organisation changes (see orgExists). */
  private generation = 0;

  /** Forget a cached organisation (created, renamed or deleted). */
  forgetOrg(id: string): void {
    this.generation += 1;
    this.orgs.delete(id);
  }
}
