import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { addDaysToKey, appTimezone, dateKeyInZone, startOfDayInZone } from '@shared/utils/timezone';
import { localDateString } from '@modules/activity/application/activity-date.util';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { DayPlanService } from '@modules/worktime/application/day-plan.service';
import { WorkdayState } from '@modules/worktime/application/worktime.types';
import {
  WORK_SESSION_REPOSITORY,
  WorkSessionRecord,
  WorkSessionRepository,
} from '@modules/worktime/domain/work-session.repository';
import {
  AGENT_CONTACT_REPOSITORY,
  AgentContactRecord,
  AgentContactRepository,
} from '../domain/agent-contact.repository';
import {
  AGENT_HEALTH_READER,
  AgentHealthPerson,
  AgentHealthReader,
} from '../domain/agent-health.reader';
import { agentVersionLabel, healthFlags, liveStatus } from '../domain/agent-health.rules';
import {
  agentHealthOrg,
  agentHealthPeopleWhere,
  AgentHealthScopeQuery,
  assertCanSeeAgentHealth,
} from './agent-health.scope';
import { AgentHealthRow, AgentHealthSummary, AgentHealthView } from './agent-health.types';

export interface AgentHealthQuery extends AgentHealthScopeQuery {
  /** Only people with at least one flag. */
  problemsOnly?: boolean;
}

/**
 * GET /agent-health (3.3, on 4.0): see agent-health.types.ts. Scope follows the
 * 4.0 tenancy rules (agent-health.scope.ts); the working day comes from the
 * organisation calendar and the person's shift (DayPlanService), the day state
 * from work sessions.
 */
@Injectable()
export class AgentHealthService {
  constructor(
    private readonly days: BreakDayService,
    private readonly plans: DayPlanService,
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(AGENT_HEALTH_READER) private readonly reader: AgentHealthReader,
    @Inject(AGENT_CONTACT_REPOSITORY) private readonly contacts: AgentContactRepository,
  ) {}

  async list(me: AuthenticatedUser, q: AgentHealthQuery, now: Date): Promise<AgentHealthView> {
    assertCanSeeAgentHealth(me);
    const organisationId = agentHealthOrg(me, q);
    const people = await this.reader.people(agentHealthPeopleWhere(me, q));

    const tz = appTimezone();
    const today = dateKeyInZone(now, tz);
    const dayStart = startOfDayInZone(today, tz);
    const ids = people.map((p) => p.id);
    const [samples, shots, signIns, enabled, contacts, sessions, plan] = await Promise.all([
      this.reader.sampleStats(ids, localDateString(now)),
      this.reader.screenshotStats(ids, dayStart),
      this.reader.signIns(ids, now),
      this.reader.screenshotsEnabled(ids),
      this.contacts.forUsers(ids),
      this.sessions.listForUsersBetween(ids, addDaysToKey(today, -1), today),
      this.plans.context(people.map(asPlanPerson)),
    ]);
    const byUser = new Map<string, WorkSessionRecord[]>();
    for (const s of sessions) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);

    const rows: AgentHealthRow[] = [];
    for (const p of people) {
      const day = dayOf(byUser.get(p.id) ?? [], today);
      // The shift-day of now (a night shift's early hours belong to the evening
      // before), then that day's plan: the organisation calendar and the shift.
      const shiftDay = this.days.dayWith(plan.shifts, asPlanPerson(p), now).dateKey;
      const dayPlan = plan.plan(asPlanPerson(p), shiftDay);
      const shiftStart = dayPlan.shift ? shiftBounds(dayPlan.shift, shiftDay, tz).start : null;
      const sample = samples.get(p.id);
      const shot = shots.get(p.id);
      const signIn = signIns.get(p.id) ?? { signedIn: false, agentUserAgent: null };
      const contact = contacts.get(p.id) ?? null;
      const version = versionOf(contact, signIn.agentUserAgent);
      const facts = {
        now,
        lastContactAt: contact?.lastContactAt ?? null,
        lastSampleAt: sample?.lastAt ?? null,
        lastSampleIdle: sample?.lastIdle ?? false,
        signedIn: signIn.signedIn,
        agentVersion: version,
        dayState: day.state,
        dayStartedAt: day.startedAt,
        workday: dayPlan.isWorkingDay,
        shiftStart,
        screenshotsEnabled: enabled.get(p.id) ?? true,
        lastShotAt: shot?.lastAt ?? null,
        shotsToday: shot?.today ?? 0,
        lastRefusalAt: contact?.lastRefusal?.at ?? null,
        dayStart,
      };
      rows.push({
        userId: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        email: p.email,
        role: p.role,
        department: p.department,
        departmentId: p.departmentId,
        companyId: p.companyId,
        companyName: p.companyName,
        agent: {
          version,
          signedIn: signIn.signedIn,
          lastContactAt: iso(contact?.lastContactAt ?? null),
          lastSampleAt: iso(sample?.lastAt ?? null),
          lastActiveAt: iso(sample?.lastActiveAt ?? null),
          samplesToday: sample?.today ?? 0,
          status: liveStatus(facts),
        },
        day: {
          state: day.state,
          startedAt: iso(day.startedAt),
          endedAt: iso(day.endedAt),
          workday: dayPlan.isWorkingDay,
          shiftStart: iso(shiftStart),
        },
        screenshots: {
          enabled: facts.screenshotsEnabled,
          lastAt: iso(shot?.lastAt ?? null),
          today: shot?.today ?? 0,
          lastRefusal: contact?.lastRefusal
            ? { ...contact.lastRefusal, at: contact.lastRefusal.at.toISOString() }
            : null,
        },
        flags: healthFlags(facts),
      });
    }
    // Problems first, then by name; the portal keeps this order.
    rows.sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));
    const shown = q.problemsOnly ? rows.filter((r) => r.flags.length) : rows;
    return {
      date: today,
      organisationId,
      timezone: tz,
      asOf: now.toISOString(),
      summary: summarize(rows),
      rows: shown,
    };
  }
}

function asPlanPerson(p: AgentHealthPerson) {
  return { id: p.id, companyId: p.companyId, department: p.department };
}

/** Today's day state from the sessions dated yesterday and today (night shifts). */
export function dayOf(
  list: WorkSessionRecord[],
  today: string,
): { state: WorkdayState; startedAt: Date | null; endedAt: Date | null } {
  const open = list.find((s) => s.endedAt === null);
  if (open) {
    const first = list.filter((s) => s.date === open.date).sort(byStart)[0] ?? open;
    return { state: 'OPEN', startedAt: first.startedAt, endedAt: null };
  }
  const todays = list.filter((s) => s.date === today).sort(byStart);
  if (todays.length) {
    const last = todays[todays.length - 1];
    return { state: 'ENDED', startedAt: todays[0].startedAt, endedAt: last.endedAt };
  }
  return { state: 'NOT_STARTED', startedAt: null, endedAt: null };
}

const byStart = (a: WorkSessionRecord, b: WorkSessionRecord) =>
  a.startedAt.getTime() - b.startedAt.getTime();

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The agent version: the last contact's User-Agent, else the sign-in's; "legacy" when it called without one. */
function versionOf(contact: AgentContactRecord | null, signInUa: string | null): string | null {
  const fromContact = agentVersionLabel(contact?.userAgent);
  if (fromContact) return fromContact;
  const fromSignIn = agentVersionLabel(signInUa);
  if (fromSignIn) return fromSignIn;
  return contact ? 'legacy' : null;
}

function summarize(rows: AgentHealthRow[]): AgentHealthSummary {
  const has = (flag: AgentHealthRow['flags'][number]) =>
    rows.filter((r) => r.flags.includes(flag)).length;
  return {
    people: rows.length,
    tracking: rows.filter((r) => r.day.state === 'OPEN' && r.agent.status !== 'OFFLINE').length,
    offline: has('AGENT_OFFLINE'),
    notStarted: rows.filter((r) => r.day.state === 'NOT_STARTED').length,
    ended: rows.filter((r) => r.day.state === 'ENDED').length,
    screenshotsOff: has('SCREENSHOTS_OFF'),
    noScreenshots: has('NO_SCREENSHOTS_TODAY') + has('SCREENSHOTS_STALE'),
    refused: has('UPLOAD_REFUSED'),
  };
}
