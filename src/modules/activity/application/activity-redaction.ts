import { Role } from '@shared/rbac/roles.enum';
import {
  ActivityAck,
  CurrentActivityView,
  DailyActivityView,
  LiveActivityUpdate,
  MyActivityUpdate,
} from './activity.types';

/**
 * Staff never see activity (SPEC 1.8): every view of their own keyboard and mouse
 * activity keeps its shape (200, so older agents keep working) with the figures
 * emptied. Managers and Super Admins see theirs. An unknown role counts as staff.
 */
export function seesOwnActivity(role: string | null | undefined): boolean {
  return role === Role.MANAGER || role === Role.SUPER_ADMIN || role === Role.ADMIN;
}

/** The day view with active/idle zeroed and no hourly, apps or websites. */
export function redactActivity(daily: DailyActivityView): DailyActivityView {
  return {
    ...daily,
    activeSec: 0,
    idleSec: 0,
    extraSec: 0,
    remainingSec: daily.workingBasisSec,
    clockedOut: false,
    topApps: [],
    topWebsites: [],
    hourly: [],
  };
}

/** What is in the foreground right now, without the app, title or URL. */
export function redactCurrent(current: CurrentActivityView): CurrentActivityView {
  return { ...current, app: null, title: null, url: null };
}

/** The `activity:me` push without the day's activity figures or the current app. */
export function redactMyUpdate(update: MyActivityUpdate): MyActivityUpdate {
  return {
    ...update,
    current: redactCurrent(update.current),
    activeSec: 0,
    idleSec: 0,
    remainingSec: update.workingBasisSec,
    clockedOut: false,
    topApps: [],
  };
}

// ---- 4.0 manager grants (docs/4.0/SPEC.md 1.2): apps, window titles and sites are
// the timeline; keyboard and mouse active and idle time, hourly activity and quiet
// hours are activity. Each view keeps its shape with the other part emptied.

/** A day view without the timeline part: no apps or websites. */
export function withoutTimeline(daily: DailyActivityView): DailyActivityView {
  return { ...daily, topApps: [], topWebsites: [] };
}

/** A day view without the activity part: no active or idle time, no hourly split. */
export function withoutActivity(daily: DailyActivityView): DailyActivityView {
  return {
    ...daily,
    activeSec: 0,
    idleSec: 0,
    extraSec: 0,
    remainingSec: daily.workingBasisSec,
    clockedOut: false,
    hourly: [],
  };
}

/** A day view as a reader with these grants may see it. */
export function dailyFor(
  daily: DailyActivityView,
  grants: { timeline: boolean; activity: boolean },
): DailyActivityView {
  let out = daily;
  if (!grants.timeline) out = withoutTimeline(out);
  if (!grants.activity) out = withoutActivity(out);
  return out;
}

/** The live board push (`activity:update`) as a reader with one of the two grants sees it. */
export function liveUpdateFor(
  update: LiveActivityUpdate,
  view: 'timeline' | 'activity',
): LiveActivityUpdate {
  return view === 'timeline'
    ? { ...update, activeSec: 0, idleSec: 0 }
    : { ...update, app: null, title: null, url: null, topApps: [] };
}

/** The agent's report ack without the active time (dayEnded and the capture switches stay). */
export function redactAck(ack: ActivityAck): ActivityAck {
  return { ...ack, activeSec: 0, remainingSec: ack.workingBasisSec, clockedOut: false };
}

/** The `activity:me` push as its owner may see it. */
export function myUpdateFor(
  role: string | null | undefined,
  update: MyActivityUpdate,
): MyActivityUpdate {
  return seesOwnActivity(role) ? update : redactMyUpdate(update);
}
