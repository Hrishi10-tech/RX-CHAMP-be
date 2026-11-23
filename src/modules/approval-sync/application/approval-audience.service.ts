import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { ApprovalChange, ApprovalWhat } from '@shared/events/approval-changed.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { isDiscardedMeeting } from '@modules/worktime/domain/meetings';

/** Most pending requests announced per table and change (a backlog that large is reviewed in bulk anyway). */
const BATCH = 500;

/** One approval item, as far as its audience needs it. */
export interface AudienceItem {
  userId: string;
  /** MANAGER, ADMIN, SUPER_MANAGER or SUPER_ADMIN; null when nothing waits. */
  approverRole: string | null;
  /** PENDING, APPROVED, ... */
  status: string;
  /** Breaks, meetings and away time past due: they sit in the Admin's queue too. */
  escalated?: boolean;
  /** A live meeting under a minute: it needs no approval, but the lists showed it while it ran. */
  discarded?: boolean;
}

/** The person the item is about, now. */
export interface AudienceSubject {
  id: string;
  role: string;
  companyId: string | null;
  departmentId: string | null;
  /** False when their organisation was deleted: nobody decides or sees their items any more. */
  orgLive: boolean;
}

/** Everyone the 4.0 routing can name for the subject, all active (docs/4.0/SPEC.md 1.3). */
export interface AudiencePeople {
  /** Managers of the subject's department, in the subject's organisation (Staff only). */
  departmentManagerIds: readonly string[];
  /** Admins of the subject's organisation. */
  adminIds: readonly string[];
  superManagerIds: readonly string[];
  superAdminIds: readonly string[];
}

export interface ApprovalAudience {
  /** PENDING, APPROVED, ... */
  status: string;
  /** Whom it waits on: the people the bell tells about a new request. */
  deciders: string[];
  /** Everyone who can see it: the person, the deciders, and those over them. */
  viewers: string[];
}

const others = (ids: readonly string[], subject: AudienceSubject) =>
  ids.filter((id) => id !== subject.id);

/** The first group that has someone in it (a route with nobody falls to the next one up). */
function firstOf(...groups: string[][]): string[] {
  return groups.find((g) => g.length) ?? [];
}

/**
 * Whom an item waits on now, on 4.0's routing (the same people BreakEvents.recipientsFor
 * and leave routing tell): Staff in a department on the Manager route, that department's
 * managers; with none, or on the Admin route, the organisation's Admins; the Super
 * Manager's and Super Admins' routes, those people. A route with nobody in it falls to
 * the next one up, as leave routing does. Breaks, meetings and away time past due also
 * wait on the Admins (their "mine" holds every escalated item). Never the person
 * themselves, and never anyone of another organisation.
 */
export function decidersOf(
  item: AudienceItem,
  subject: AudienceSubject,
  people: AudiencePeople,
): string[] {
  if (!item.approverRole || !subject.orgLive) return [];
  const managers = others(people.departmentManagerIds, subject);
  const admins = subject.companyId ? others(people.adminIds, subject) : [];
  const superManagers = others(people.superManagerIds, subject);
  const superAdmins = others(people.superAdminIds, subject);
  let ids: string[];
  switch (item.approverRole) {
    case 'MANAGER':
      ids =
        subject.role === 'USER' && subject.departmentId
          ? firstOf(managers, admins, superAdmins)
          : firstOf(admins, superAdmins);
      break;
    case 'ADMIN':
      ids = firstOf(admins, superAdmins);
      break;
    case 'SUPER_MANAGER':
      ids = firstOf(superManagers, admins, superAdmins);
      break;
    case 'SUPER_ADMIN':
      ids = superAdmins;
      break;
    default:
      ids = [];
  }
  if (item.escalated) ids = [...ids, ...admins];
  return [...new Set(ids)];
}

/**
 * Everyone who can see the item in a list (scope.ts canSeePerson): the person, the
 * deciders, the organisation's Admins, the managers of a Staff member's department,
 * and the platform roles (a Super Admin and the Super Manager see every organisation;
 * a Super Admin's own items only the Super Admins). An organisation that was deleted
 * leaves only the person.
 */
export function viewersOf(
  subject: AudienceSubject,
  deciders: string[],
  people: AudiencePeople,
): string[] {
  const ids = [subject.id, ...deciders];
  if (subject.orgLive) {
    if (subject.role === 'SUPER_ADMIN') {
      ids.push(...people.superAdminIds);
    } else {
      if (subject.companyId) ids.push(...people.adminIds);
      if (subject.role === 'USER' && subject.departmentId) ids.push(...people.departmentManagerIds);
      ids.push(...people.superAdminIds, ...people.superManagerIds);
    }
  }
  return [...new Set(ids)];
}

/** Breaks and meetings name their state approvalStatus; everything else status. */
const PENDING_ON_MANAGER = { approverRole: 'MANAGER' } as const;

/** Reads who can see one approval item and who decides it, for the live sync. */
@Injectable()
export class ApprovalAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Null for an item that is gone or never needed approval: nobody has anything to refresh. */
  async of(what: ApprovalWhat, id: string): Promise<ApprovalAudience | null> {
    const item = await this.item(what, id);
    if (!item || (item.status === 'NOT_REQUIRED' && !item.discarded)) return null;
    if (item.status === 'UNEXPLAINED') return null;
    const subject = await this.subject(item.userId);
    if (!subject) return null;
    const people = await this.people(subject);
    const deciders = decidersOf(item, subject, people);
    return { status: item.status, deciders, viewers: viewersOf(subject, deciders, people) };
  }

  /**
   * What a change to a person sent to someone else, with nothing else to say so
   * (4.0, by department):
   *  - their own pending items, when their department or role changed: they now wait
   *    on someone new, and the managers of the department they left are told by name.
   *    Breaks and meetings whose route the re-route subscribers rewrite announce
   *    themselves; they are only told to the former managers here.
   *  - a Manager gaining or losing a department (or blocked, back or deleted): the
   *    pending items of that department's Staff on the Manager route. CREATED when the
   *    move is between them and the Admins (nobody else manages it), UPDATED when the
   *    department's other managers keep deciding it.
   */
  async movedBy(e: UserAccessChangedEvent): Promise<ApprovalChange[]> {
    const person = await this.prisma.user.findUnique({
      where: { id: e.userId },
      select: {
        id: true,
        companyId: true,
        departmentId: true,
        status: true,
        deletedAt: true,
        role: { select: { name: true } },
        managedDepartments: {
          where: { department: { deletedAt: null } },
          select: { departmentId: true },
        },
      },
    });
    if (!person?.companyId) return [];
    const org = person.companyId;
    const role = person.role.name as string;
    const active = person.status === 'ACTIVE' && !person.deletedAt;
    const former = e.formerPlacement;
    const out: ApprovalChange[] = [];

    if (former && (former.role !== role || former.departmentId !== person.departmentId)) {
      const formerApprovers =
        former.role === 'USER' && former.departmentId
          ? (await this.departmentManagers(former.departmentId, org)).filter(
              (id) => id !== person.id,
            )
          : [];
      out.push(
        ...(await this.ownPending(
          { id: person.id, role, departmentId: person.departmentId },
          formerApprovers,
        )),
      );
    }

    const managedNow = new Set(
      role === 'MANAGER' ? person.managedDepartments.map((m) => m.departmentId) : [],
    );
    const touched = new Set<string>();
    if (e.changes.includes('STATUS') || e.changes.includes('DELETED')) {
      for (const d of managedNow) touched.add(d);
    }
    if (former) {
      const before = new Set(former.role === 'MANAGER' ? former.managedDepartmentIds : []);
      for (const d of before) if (!managedNow.has(d)) touched.add(d);
      for (const d of managedNow) if (!before.has(d)) touched.add(d);
    }
    for (const departmentId of touched) {
      const decidesNow = active && managedNow.has(departmentId);
      const rest = (await this.departmentManagers(departmentId, org)).filter(
        (id) => id !== person.id,
      );
      out.push(
        ...(await this.departmentPending(departmentId, org, {
          action: rest.length ? 'UPDATED' : 'CREATED',
          formerApprovers: decidesNow ? [] : [person.id],
        })),
      );
    }
    return out;
  }

  /** The person's own pending items, announced to whom they wait on now. */
  private async ownPending(
    person: { id: string; role: string; departmentId: string | null },
    formerApprovers: string[],
  ): Promise<ApprovalChange[]> {
    const mine = { userId: person.id };
    const [breaks, meetings, away, leave, wfh, compOff] = await Promise.all([
      this.prisma.breakRecord.findMany({
        where: { ...mine, approvalStatus: 'PENDING' },
        select: { id: true, approverRole: true },
        take: BATCH,
      }),
      this.prisma.meetingRecord.findMany({
        where: { ...mine, approvalStatus: 'PENDING' },
        select: { id: true, approverRole: true, endedAt: true },
        take: BATCH,
      }),
      this.prisma.awayEvent.findMany({
        where: { ...mine, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.leaveRequest.findMany({
        where: { ...mine, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.wfhRequest.findMany({
        where: { ...mine, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.compOffCredit.findMany({
        where: { ...mine, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
    ]);
    // Where breaks and meetings go now; a row on another route is rewritten (and
    // announced) by the re-route subscribers.
    const routeNow = BreakApprovalPolicy.route({
      role: person.role as never,
      departmentId: person.departmentId,
    }).approverRole;
    const out: ApprovalChange[] = [];
    const tell = (what: ApprovalWhat, id: string, action: ApprovalChange['action']) =>
      out.push({ what, id, action, formerApprovers });
    for (const b of breaks) {
      if (b.approverRole === routeNow) tell('BREAK', b.id, 'CREATED');
      else if (formerApprovers.length) tell('BREAK', b.id, 'UPDATED');
    }
    for (const m of meetings) {
      // A meeting still running cannot be decided yet: nobody is pushed for it.
      if (m.approverRole === routeNow) tell('MEETING', m.id, m.endedAt ? 'CREATED' : 'UPDATED');
      else if (formerApprovers.length) tell('MEETING', m.id, 'UPDATED');
    }
    // Away time is rewritten without a word of its own: announced here either way.
    for (const a of away) tell('AWAY', a.id, 'CREATED');
    for (const r of leave) tell('LEAVE', r.id, 'CREATED');
    for (const r of wfh) tell('WFH', r.id, 'CREATED');
    for (const r of compOff) tell('COMPOFF', r.id, 'CREATED');
    return out;
  }

  /** Pending items of a department's Staff on the Manager route (every kind). */
  private async departmentPending(
    departmentId: string,
    companyId: string,
    how: { action: 'CREATED' | 'UPDATED'; formerApprovers: string[] },
  ): Promise<ApprovalChange[]> {
    const staff = await this.prisma.user.findMany({
      where: { departmentId, companyId, deletedAt: null, role: { name: 'USER' } },
      select: { id: true },
    });
    if (!staff.length) return [];
    const theirs = { userId: { in: staff.map((s) => s.id) }, ...PENDING_ON_MANAGER };
    const [breaks, meetings, away, leave, wfh, compOff] = await Promise.all([
      this.prisma.breakRecord.findMany({
        where: { ...theirs, approvalStatus: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.meetingRecord.findMany({
        where: { ...theirs, approvalStatus: 'PENDING' },
        select: { id: true, endedAt: true },
        take: BATCH,
      }),
      this.prisma.awayEvent.findMany({
        where: { ...theirs, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.leaveRequest.findMany({
        where: { ...theirs, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.wfhRequest.findMany({
        where: { ...theirs, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.compOffCredit.findMany({
        where: { ...theirs, status: 'PENDING' },
        select: { id: true },
        take: BATCH,
      }),
    ]);
    const { action, formerApprovers } = how;
    return [
      ...breaks.map((r) => ({ what: 'BREAK' as const, id: r.id, action, formerApprovers })),
      ...meetings.map((r) => ({
        what: 'MEETING' as const,
        id: r.id,
        action: r.endedAt ? action : ('UPDATED' as const),
        formerApprovers,
      })),
      ...away.map((r) => ({ what: 'AWAY' as const, id: r.id, action, formerApprovers })),
      ...leave.map((r) => ({ what: 'LEAVE' as const, id: r.id, action, formerApprovers })),
      ...wfh.map((r) => ({ what: 'WFH' as const, id: r.id, action, formerApprovers })),
      ...compOff.map((r) => ({ what: 'COMPOFF' as const, id: r.id, action, formerApprovers })),
    ];
  }

  private async subject(userId: string): Promise<AudienceSubject | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        companyId: true,
        departmentId: true,
        role: { select: { name: true } },
        company: { select: { deletedAt: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      role: row.role.name as string,
      companyId: row.companyId,
      departmentId: row.departmentId,
      orgLive: !row.companyId || !row.company?.deletedAt,
    };
  }

  private async people(subject: AudienceSubject): Promise<AudiencePeople> {
    const org = subject.orgLive ? subject.companyId : null;
    const [departmentManagerIds, admins, platform] = await Promise.all([
      org && subject.role === 'USER' && subject.departmentId
        ? this.departmentManagers(subject.departmentId, org)
        : Promise.resolve([] as string[]),
      org
        ? this.prisma.user.findMany({
            where: { companyId: org, deletedAt: null, status: 'ACTIVE', role: { name: 'ADMIN' } },
            select: { id: true },
          })
        : Promise.resolve([] as { id: string }[]),
      this.prisma.user.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          role: { name: { in: ['SUPER_ADMIN', 'SUPER_MANAGER'] } },
        },
        select: { id: true, role: { select: { name: true } } },
      }),
    ]);
    return {
      departmentManagerIds,
      adminIds: admins.map((a) => a.id),
      superAdminIds: platform.filter((p) => p.role.name === 'SUPER_ADMIN').map((p) => p.id),
      superManagerIds: platform.filter((p) => p.role.name === 'SUPER_MANAGER').map((p) => p.id),
    };
  }

  /** Active managers of a department of this organisation (never another organisation's). */
  private async departmentManagers(departmentId: string, companyId: string): Promise<string[]> {
    const rows = await this.prisma.managerDepartment.findMany({
      where: {
        departmentId,
        department: { deletedAt: null, companyId },
        manager: { companyId, deletedAt: null, status: 'ACTIVE', role: { name: 'MANAGER' } },
      },
      select: { managerId: true },
    });
    return [...new Set(rows.map((r) => r.managerId))];
  }

  private async item(what: ApprovalWhat, id: string): Promise<AudienceItem | null> {
    switch (what) {
      case 'BREAK': {
        const row = await this.prisma.breakRecord.findUnique({
          where: { id },
          select: { userId: true, approverRole: true, approvalStatus: true, escalatedAt: true },
        });
        return (
          row && {
            userId: row.userId,
            approverRole: row.approverRole,
            status: row.approvalStatus,
            escalated: !!row.escalatedAt,
          }
        );
      }
      case 'MEETING': {
        const row = await this.prisma.meetingRecord.findUnique({
          where: { id },
          select: {
            userId: true,
            approverRole: true,
            approvalStatus: true,
            escalatedAt: true,
            mode: true,
            endedAt: true,
            durationSec: true,
          },
        });
        return (
          row && {
            userId: row.userId,
            approverRole: row.approverRole,
            status: row.approvalStatus,
            escalated: !!row.escalatedAt,
            discarded: isDiscardedMeeting(row),
          }
        );
      }
      case 'AWAY': {
        const row = await this.prisma.awayEvent.findUnique({
          where: { id },
          select: { userId: true, approverRole: true, status: true, escalatedAt: true },
        });
        return (
          row && {
            userId: row.userId,
            approverRole: row.approverRole,
            status: row.status,
            escalated: !!row.escalatedAt,
          }
        );
      }
      case 'LEAVE':
      case 'WFH':
      case 'COMPOFF': {
        const select = { userId: true, approverRole: true, status: true } as const;
        if (what === 'LEAVE') return this.prisma.leaveRequest.findUnique({ where: { id }, select });
        if (what === 'WFH') return this.prisma.wfhRequest.findUnique({ where: { id }, select });
        return this.prisma.compOffCredit.findUnique({ where: { id }, select });
      }
    }
  }
}
