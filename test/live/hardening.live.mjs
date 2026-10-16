// Hardening (23 checks): health, login lockout, password change and reset, socket
// checks, input validation. Changes the demo manager's password and pauses sign-in
// for the demo staff account for 15 minutes, so run it last.
// Needs a freshly reset and seeded database: see README.md.
import { createRequire } from 'node:module';
import { Client, check, expectStatus, summary, BASE } from './lib.mjs';

// The socket client comes from the portal's dependencies (npm ci in web-portal).
let io = null;
try {
  ({ io } = createRequire(new URL('../../../web-portal/package.json', import.meta.url))('socket.io-client'));
} catch {
  io = null;
}
const ORIGIN = BASE.replace(/\/api\/v1$/, '');

console.log('\n# Health');
let res = await fetch(`${ORIGIN}/health`);
check('health 200 with db up', res.status === 200 && (await res.json()).data?.db === 'up');
res = await fetch(`${ORIGIN}/metrics`);
check('metrics available outside production', res.status === 200);

console.log('\n# Login lockout');
const probe = new Client('probe');
let r;
for (let i = 0; i < 10; i++) r = await probe.post('/auth/login', { email: 'user@timechamp.test', password: `wrong-${i}` });
check('10th wrong password still 401', r.status === 401, r.status);
r = await probe.post('/auth/login', { email: 'user@timechamp.test', password: 'user123' });
check('then even the right password is paused (429)', r.status === 429 && /paused/.test(r.body.message), r.body);
r = await probe.post('/auth/login', { email: 'nobody@timechamp.test', password: 'whatever' });
check('unknown email is a plain 401', r.status === 401);

console.log('\n# Change own password');
const mgr = await new Client('manager').login('manager@timechamp.test', 'manager123');
r = await mgr.post('/auth/change-password', { currentPassword: 'nope', newPassword: 'NewPassw0rd!' });
check('wrong current password refused', r.status === 400 && r.body.error?.code === 'WRONG_PASSWORD', r.body);
r = await mgr.post('/auth/change-password', { currentPassword: 'manager123', newPassword: 'short' });
check('short new password refused', r.status === 400, r.body);
r = expectStatus('manager changes password', await mgr.post('/auth/change-password', { currentPassword: 'manager123', newPassword: 'NewPassw0rd!' }), 200);
expectStatus('session still works after change', await mgr.get('/breaks/me/today'), 200);
expectStatus('old password no longer signs in', await new Client('x').post('/auth/login', { email: 'manager@timechamp.test', password: 'manager123' }), 401);
await new Client('m2').login('manager@timechamp.test', 'NewPassw0rd!');
check('new password signs in', true);

console.log('\n# Admin sets a password and signs someone out everywhere');
const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
r = await sa.post(`/users/${mgr.user.id}/password`, { newPassword: 'Reset-Passw0rd', signOutEverywhere: true });
check('SA resets the manager password', r.status === 200 && r.body.data?.signedOut === true, r.body);
await new Promise((s) => setTimeout(s, 300));
r = await mgr.post('/auth/refresh');
check("manager's refresh token was revoked", r.status === 401, r.status);
r = await sa.post(`/users/${sa.user.id}/password`, { newPassword: 'Whatever-123' });
check('cannot reset your own password through the admin route', r.status === 400, r.body);
const mgr2 = await new Client('manager-again').login('manager@timechamp.test', 'Reset-Passw0rd');
r = await mgr2.post(`/users/${sa.user.id}/password`, { newPassword: 'Whatever-123' });
check('a manager cannot reset a super admin', r.status === 404, r.status);

console.log('\n# Sockets');
if (!io) {
  check('socket.io-client found: run npm ci in web-portal, then run this again', false);
} else {
  function connect(client, ns, extraHeaders = {}) {
    return new Promise((resolve) => {
      const s = io(`${ORIGIN}${ns}`, {
        transports: ['websocket'],
        extraHeaders: { cookie: client.cookieHeader(), ...extraHeaders },
        reconnection: false,
        timeout: 4000,
      });
      const done = (state) => resolve({ s, state });
      s.on('connect', () => setTimeout(() => done(s.connected ? 'connected' : 'dropped'), 400));
      s.on('connect_error', () => done('error'));
      s.on('disconnect', () => done('dropped'));
    });
  }
  let c = await connect(mgr2, '/notifications');
  check('active user connects', c.state === 'connected', c.state);
  c.s.close();
  c = await connect(mgr2, '/notifications', { origin: 'https://evil.example' });
  check('a foreign origin connects or is dropped, never errors (dev config, CORS_ORIGINS unset)', ['connected', 'dropped'].includes(c.state));
  c.s.close();

  c = await connect(mgr2, '/presence');
  check('manager presence socket up', c.state === 'connected', c.state);
  const dropped = new Promise((resolve) => c.s.on('disconnect', () => resolve(true)));
  r = await sa.post(`/users/${mgr2.user.id}/status`, { status: 'DISABLED' });
  check('SA blocks the manager', r.status === 200 || r.status === 201, r.status);
  const wasDropped = await Promise.race([dropped, new Promise((s) => setTimeout(() => s(false), 2000))]);
  check("blocked manager's live socket is dropped at once", wasDropped === true);
  c = await connect(mgr2, '/presence');
  check('blocked account cannot reconnect', c.state !== 'connected', c.state);
  c.s.close();
  await sa.post(`/users/${mgr2.user.id}/status`, { status: 'ACTIVE' });
}

console.log('\n# Validation');
r = await sa.get('/analytics/not-an-id');
check('analytics rejects a bad id (400)', r.status === 400, r.status);
r = await sa.get(`/analytics/${sa.user.id}?date=2026-02-30`);
check('analytics rejects an impossible date (400)', r.status === 400, r.status);

summary();
