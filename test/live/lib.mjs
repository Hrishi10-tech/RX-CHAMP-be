// A small API client and checks for the live suites (cookie auth, like the portal).
// Each suite needs a freshly reset and seeded database: see README.md.
export const BASE = (process.env.API ?? 'http://localhost:4000/api/v1').replace(/\/+$/, '');

// These suites change data (passwords, account status, a day ended). Never production.
const PRODUCTION_HOSTS = ['api.rxvision.shop'];
const host = new URL(BASE).hostname.toLowerCase();
if (PRODUCTION_HOSTS.includes(host)) {
  console.error(`Refusing to run against ${host}: these checks change data. Use a local or staging API.`);
  process.exit(2);
}

let failures = 0;
let passes = 0;

/** The User-Agent a 3.1 desktop agent sends (SPEC 4). */
export const AGENT_31_UA = 'RXVisionAgent/3.1.0 (Windows)';
/** The User-Agent of the 3.0 agent: a legacy caller. */
export const AGENT_30_UA = 'RXVisionAgent/3.0.0 (Windows)';

export class Client {
  /** `ua`: the User-Agent to send (none: Node's default, which the API treats as legacy). */
  constructor(name, ua) {
    this.name = name;
    this.ua = ua;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method, path, body) {
    const headers = { 'content-type': 'application/json', cookie: this.cookieHeader() };
    if (this.ua) headers['user-agent'] = this.ua;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if ((res.headers.get('content-type') ?? '').includes('spreadsheetml')) {
      return {
        status: res.status,
        body: null,
        file: Buffer.from(await res.arrayBuffer()),
        headers: Object.fromEntries(res.headers.entries()),
      };
    }
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()) };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, b = {}) {
    return this.req('POST', p, b);
  }
  put(p, b = {}) {
    return this.req('PUT', p, b);
  }
  patch(p, b = {}) {
    return this.req('PATCH', p, b);
  }
  del(p) {
    return this.req('DELETE', p);
  }
  async login(email, password) {
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) {
      throw new Error(
        `${this.name} could not sign in as ${email} (${r.status}). Reset and seed the database first (README.md). ${JSON.stringify(r.body)}`,
      );
    }
    this.user = r.body.data?.user ?? r.body.user;
    return this;
  }
}

export function check(label, cond, extra) {
  if (cond) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 600) : ''}`);
  }
}

export function expectStatus(label, res, status) {
  check(`${label} [${status}]`, res.status === status, { got: res.status, body: res.body });
  return res;
}

export function summary() {
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

// Must match the API's APP_TIMEZONE: shift times are built around "now" in that zone.
const TZ = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

export function hm(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function todayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60000);
