import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';

/**
 * Audit actions written by 4.0 (docs/4.0/SPEC.md 3.1, AuditLog): credential changes,
 * grants, sign-out keys and their uses, organisation and department changes.
 */
export type AuditAction =
  | 'ORG_CREATED'
  | 'ORG_RENAMED'
  | 'ORG_DELETED'
  | 'ORG_ADMIN_CREATED'
  | 'ORG_PERSON_ASSIGNED'
  | 'DEPARTMENT_CREATED'
  | 'DEPARTMENT_UPDATED'
  | 'DEPARTMENT_DELETED'
  | 'USER_CREATED'
  | 'USER_ROLE_CHANGED'
  | 'USER_DEPARTMENT_CHANGED'
  | 'USER_EMAIL_CHANGED'
  | 'USER_PASSWORD_SET'
  | 'USER_STATUS_CHANGED'
  | 'USER_DELETED'
  | 'USER_GRANTS_CHANGED'
  | 'AGENT_ENROLLMENT_ISSUED'
  | 'SIGNOUT_KEY_CREATED'
  | 'SIGNOUT_KEY_REVOKED'
  | 'SIGNOUT_KEY_USED'
  | 'SIGNOUT_KEY_FAILED'
  | 'QUIT_KEY_USED'
  | 'QUIT_KEY_FAILED';

export interface AuditEntry {
  actorId: string | null;
  action: AuditAction;
  /** USER | ORGANISATION | DEPARTMENT | SIGNOUT_KEY */
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Writes audit_logs rows. Inside a transaction (`tx`) the row is part of the change
 * and a failure rolls it back; on its own it is best-effort and never fails the
 * request that caused it. Never put secrets (passwords, phrases, tokens) in metadata.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: AuditClient): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    };
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (err) {
      this.logger.warn(
        `audit ${entry.action} on ${entry.entity} failed: ${(err as Error).message}`,
      );
    }
  }

  async recordMany(entries: AuditEntry[], tx?: AuditClient): Promise<void> {
    for (const e of entries) await this.record(e, tx);
  }
}
