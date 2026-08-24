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
