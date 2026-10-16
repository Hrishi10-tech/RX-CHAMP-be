/**
 * CORS for the socket.io namespaces, from the same CORS_ORIGINS list as HTTP.
 * Read at import time because gateway options are decorator arguments; dotenv
 * is loaded by bootstrap/timezone before any module is imported.
 * An unset list or '*' keeps the old behaviour (reflect the caller's origin).
 */
export function socketCors(): { origin: boolean | string[]; credentials: boolean } {
  const list = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { origin: list.length === 0 || list.includes('*') ? true : list, credentials: true };
}
