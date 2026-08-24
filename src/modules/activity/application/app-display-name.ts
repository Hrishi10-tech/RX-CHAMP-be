
const DISPLAY_NAMES: Record<string, string> = {
  timechampagent: 'RX Vision Agent',
};

export function appDisplayName(app: string | null): string | null {
  if (!app) return app;
  return DISPLAY_NAMES[app.trim().toLowerCase()] ?? app;
}
