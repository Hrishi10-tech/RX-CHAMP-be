import { Role } from '@shared/rbac/roles.enum';
import {
  ActivityAck,
  CurrentActivityView,
  DailyActivityView,
  MyActivityUpdate,
} from './activity.types';

/**
 * Staff never see activity (SPEC 1.8): every view of their own keyboard and mouse
 * activity keeps its shape (200, so older agents keep working) with the figures
 * emptied. Managers and Super Admins see theirs. An unknown role counts as staff.
 */
export function seesOwnActivity(role: string | null | undefined): boolean {
  return role === Role.MANAGER || role === Role.SUPER_ADMIN;
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
