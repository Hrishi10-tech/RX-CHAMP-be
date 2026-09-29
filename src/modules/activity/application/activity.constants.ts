/** Longest span a single sample may represent (caps sleep / missed-heartbeat gaps). */
export const MAX_GAP_SEC = 150;

/** A user with no sample newer than this is treated as offline (not tracking). */
export const LIVE_GRACE_SEC = 150;

/**
 * How long the agent waits without input before flagging a sample idle — must match
 * the agent's `IdleThresholdSeconds` (appsettings.json). The flag only turns on
 * *after* this much inactivity has already passed, so the stretch leading up to it
 * was inactive too; the daily rollup reclassifies it rather than crediting it as work.
 */
export const IDLE_THRESHOLD_SEC = 300;

/** Default working basis — a 9-hour day. Overtime is anything worked beyond it. */
export const DEFAULT_WORKING_BASIS_SEC = 9 * 60 * 60;

/**
 * How many entries the top-apps / top-websites lists return.
 *
 * Sized to be a safety valve, not a Top 10: the lists are meant to show everything
 * a person touched, and the UI scrolls. A busy day here is ~14 apps and ~16 sites
 * against an average of 6, so 50 leaves generous headroom while still bounding the
 * payload — these lists ride along with every live activity push, so "unlimited"
 * would put one unusual day's worth of entries on every update, every minute.
 */
export const TOP_N = 50;

/**
 * Foreground process name of the Windows lock screen.
 *
 * The agent has its own {@link LockWatcher} and sends `locked` explicitly, but that
 * flag has never arrived in practice — 108 of 60,127 samples carry it, from a single
 * machine — while the lock screen itself shows up 17,012 times. Until a fixed agent
 * is everywhere, this app name is the only reliable evidence that a workstation was
 * locked, so it is treated as equivalent to the flag.
 */
export const LOCK_SCREEN_APP = 'LockApp.exe';

/**
 * Longest unreported stretch that may be credited as idle on the strength of a
 * locked workstation either side of it.
 *
 * A locked PC sleeps a few minutes later and a sleeping PC cannot report, so an
 * ordinary break arrives as a hole in the samples rather than as idle time. Filling
 * it needs a bound: past this, "locked and asleep at her desk" and "locked it and
 * went home" stop being distinguishable, and the honest answer is to leave the time
 * unaccounted.
 *
 * Sized at 90 minutes to begin with, on the strength of lunch running to about an
 * hour. That was too tight to survive contact with an actual working day: on one
 * Tuesday four people came back from the same lunch after 91, 92, 92 and 96
 * minutes, and each of them was credited nothing at all — a minute over the line
 * cost an hour and a half.
 *
 * Four hours is what an office event actually costs (one ran past three), and it is
 * the longest a break can plausibly run while still being a break. Half a day off
 * does not need the cap to catch it: someone leaving for the afternoon ends their
 * day, which freezes the totals outright — so the cap is only ever asked to tell an
 * event from an absence, and four hours draws that line where the office does.
 */
export const LOCK_GAP_FILL_CAP_SEC = 4 * 60 * 60;
