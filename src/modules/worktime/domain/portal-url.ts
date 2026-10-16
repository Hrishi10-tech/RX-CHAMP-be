/**
 * The portal address the 3.1 agent opens for "Open approvals" (SPEC 3.1):
 * PORTAL_PUBLIC_URL, else the first CORS_ORIGINS entry, else null. Only an
 * http(s) origin is ever returned (never "*"), without a trailing slash.
 */
export function portalUrlFrom(
  explicit: string | undefined,
  corsOrigins: string[] | undefined,
): string | null {
  for (const candidate of [explicit, corsOrigins?.[0]]) {
    const value = (candidate ?? '').trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      return value.replace(/\/+$/, '');
    } catch {
      continue;
    }
  }
  return null;
}
