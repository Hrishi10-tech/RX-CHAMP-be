import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { isAdminLike, orgOf } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { LeavePeopleService } from '@modules/leave/application/leave-people.service';
import { kindLabel, unitsOfMask } from '@modules/leave/domain/leave.types';
import { routeFor } from '@modules/leave/domain/routing';
import { WfhDaysService } from './wfh-days.service';
import { WfhPolicyService } from './wfh-policy.service';
import { WfhRequestsService } from './wfh-requests.service';
import { WfhSchedulesService } from './wfh-schedules.service';
import { MyWfhView } from './wfh.views';

/** "Full day", "Half day (first half)" from a mask of approved quarters. */
export function wfhMaskLabel(mask: number): string {
  if (mask === 0b1111) return 'Full day';
  if (mask === 0b0011) return kindLabel('HALF_DAY', 'FIRST_HALF');
  if (mask === 0b1100) return kindLabel('HALF_DAY', 'SECOND_HALF');
  const q = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
  for (let i = 0; i < 4; i++) if (mask === 1 << i) return kindLabel('QUARTER_DAY', q[i]);
  return `${unitsOfMask(mask)} quarters of the day`;
}

export const WFH_SOURCE_LABEL: Record<string, string> = {
  REQUEST: 'Approved request',
  SCHEDULE: 'Schedule',
  BOTH: 'Schedule and request',
};

/** GET /wfh/me: the person's work from home in one read (3.5). */
@Injectable()
export class WfhOverviewService {
  constructor(
    private readonly requests: WfhRequestsService,
    private readonly schedules: WfhSchedulesService,
    private readonly days: WfhDaysService,
    private readonly policies: WfhPolicyService,
    private readonly people: LeavePeopleService,
  ) {}

  async my(me: AuthenticatedUser, now: Date): Promise<MyWfhView> {
    const today = dateKeyInZone(now, appTimezone());
    const month = today.slice(0, 7);
    const monthEnd = `${month}-31`;
    const person = (await this.people.any([me.id])).get(me.id) ?? null;
    const [requests, schedules, byDay, policy] = await Promise.all([
      this.requests.mine(me, now),
      this.schedules.mine(me, now),
      this.days.byDay([me.id], `${month}-01`, monthEnd),
      this.policies.get(person?.companyId ?? orgOf(me)),
    ]);
    const mine = byDay.get(me.id) ?? new Map();
    const t = mine.get(today);
    let days = 0;
    let waiting = 0;
    for (const d of mine.values()) {
      days += d.units;
      waiting += unitsOfMask(d.pendingMask);
    }
    const route = person
      ? routeFor(policy.approver, person, await this.people.routingPeople(person))
      : null;
    const waitingFor = route?.approverRole
      ? (await this.people.waitingFor([{ approverRole: route.approverRole, userId: me.id }]))[0]
      : null;
    return {
      today,
      attendanceSource: person?.attendanceSource === 'BIOMETRIC' ? 'BIOMETRIC' : 'AGENT',
      todayWfh:
        t && t.mask
          ? {
              days: t.units / 4,
              label: wfhMaskLabel(t.mask),
              source: WFH_SOURCE_LABEL[t.source ?? 'REQUEST'] ?? 'Approved request',
              capSec: t.capSec,
            }
          : null,
      upcoming: requests
        .filter((r) => (r.status === 'PENDING' || r.status === 'APPROVED') && r.endDate >= today)
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
      requests,
      schedules,
      thisMonth: { days: days / 4, waitingDays: waiting / 4, capDays: policy.maxDaysPerMonth },
      waitingFor,
      policy: WfhPolicyService.view(policy, {
        canEdit: isAdminLike(me) && !!orgOf(me),
        canRoute: isAdminLike(me) && !!orgOf(me),
      }),
    };
  }
}
