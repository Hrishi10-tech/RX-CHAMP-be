// A minimal socket.io (Engine.IO 4) client for the live checks, over Node's own
// WebSocket, so the suites need no client package. It signs in with the
// client's access token (socket.io `auth.token`), joins one namespace and
// records every event it receives.
import { BASE } from './lib.mjs';

const TIMEOUT_MS = 5000;

/** Opens `namespace` (e.g. '/activity') as `client`; resolves once connected. `auth` adds handshake fields (e.g. orgId). */
export async function openSocket(client, namespace, auth = {}) {
  const token = decodeURIComponent(client.cookies.get('accessToken') ?? '');
  const { host, protocol } = new URL(BASE);
  const ws = new WebSocket(
    `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/socket.io/?EIO=4&transport=websocket`,
  );
  const events = [];
  const prefix = `${namespace},`;
  let done;
  const connected = new Promise((resolve, reject) => {
    done = { resolve, reject };
    const timer = setTimeout(
      () => reject(new Error(`no socket connection to ${namespace}`)),
      TIMEOUT_MS,
    );
    timer.unref();
  });
  ws.addEventListener('message', (m) => {
    const s = String(m.data);
    if (s === '2') return ws.send('3'); // ping, pong
    if (s.startsWith('0')) return ws.send(`40${prefix}${JSON.stringify({ ...auth, token })}`);
    if (s.startsWith(`40${prefix}`)) return done.resolve();
    if (s.startsWith(`44${prefix}`)) return done.reject(new Error(s));
    if (s.startsWith(`42${prefix}`)) {
      const [name, payload] = JSON.parse(s.slice(2 + prefix.length).replace(/^\d+/, ''));
      events.push({ name, payload });
    }
  });
  ws.addEventListener('error', (e) => done.reject(e.error ?? new Error('socket error')));
  await connected;
  return {
    events,
    /** Payloads received so far for one event name. */
    received: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    close: () => ws.close(),
  };
}
