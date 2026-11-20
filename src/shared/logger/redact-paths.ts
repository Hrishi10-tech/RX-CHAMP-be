/**
 * What never reaches a log. Cookies carry the access and refresh tokens; the biometric key
 * signs a device's punches, and pino logs every request header.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-biometric-key"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.passwordHash',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
];
