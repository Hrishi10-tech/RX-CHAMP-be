/**
 * The agent names the foreground app from its executable's `FileDescription`, and
 * falls back to the raw process name when there isn't one. That fallback is what
 * reaches us for the agent's own window: `TimeChampAgent`, the old product name.
 *
 * Mapped on the way out rather than fixed only in the agent, because the stored
 * samples already carry the old name — a build with corrected metadata would leave
 * every historical row reading `TimeChampAgent`, and machines running an older agent
 * would keep sending it. Applied where names are served, so one entry covers the
 * live "currently using" panel, the top-apps list and the analytics export at once.
 *
 * Aggregation happens after the rename, so old and new names collapse into a single
 * row instead of appearing twice.
 */
const DISPLAY_NAMES: Record<string, string> = {
  timechampagent: 'RX Vision Agent',
};

/** The name to show for a stored app name. Unknown names pass through untouched. */
export function appDisplayName(app: string | null): string | null {
  if (!app) return app;
  return DISPLAY_NAMES[app.trim().toLowerCase()] ?? app;
}
