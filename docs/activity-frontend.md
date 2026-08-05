# Activity Tracking — Frontend Integration Guide

What the employee is doing right now, which **apps** and **websites** they use, how
much **active vs idle** time they log, and their progress against a **9-hour**
working day. The desktop agent samples the foreground app/window/website (and idle
state) about **once a minute** and reports it; the backend rolls the samples up per
day. Backend + agent are done — this is the contract for the **web frontend**.

- **Base URL:** `http://localhost:4000/api/v1`
- Auth = httpOnly cookies, responses enveloped `{ success, data }` — same as the
  rest of the API (see `docs/chat-frontend.md` §1 for the auth/CORS rules).

> **Transparency:** this is disclosed monitoring. The agent shows a visible tray
> icon and a one-time notice that apps/websites, idle time, and screenshots are
> recorded. Keep it visible in the product — never present it as hidden surveillance.

---

## 1. Types

```ts
type ActivityStatus = 'ACTIVE' | 'IDLE' | 'OFFLINE';
// ACTIVE  = a fresh sample, machine in use
// IDLE    = a fresh sample, but no keyboard/mouse past the idle threshold (~5 min)
// OFFLINE = no sample in the last ~2.5 min (agent closed / machine off / not tracking)

// "Using now" — one user's live foreground activity
type CurrentActivity = {
  status: ActivityStatus;
  app: string | null;        // e.g. "Google Chrome", "Visual Studio Code"
  title: string | null;      // foreground window title
  url: string | null;        // website HOST only when it's a browser, e.g. "github.com"
  idle: boolean;
  lastSampleAt: string | null; // ISO 8601
  staleSec: number;          // seconds since the last sample (how "live" this is)
};

// A manager's live board row (one per report)
type TeamMemberActivity = {
  userId: string;
  name: string;
  email: string;
  department: string | null;
  status: ActivityStatus;
  app: string | null;
  title: string | null;
  url: string | null;
  lastSampleAt: string | null;
};

// A usage list entry (top apps / top websites)
type UsageEntry = { name: string; seconds: number };

// One hour of the day
type HourBucket = { hour: number; activeSec: number; idleSec: number }; // hour 0–23

// A day rolled up
type DailyActivity = {
  date: string;              // YYYY-MM-DD (local)
  activeSec: number;         // non-idle foreground time
  idleSec: number;           // idle time
  workingBasisSec: number;   // the working-day basis — 32400 (9h)
  extraSec: number;          // active time worked BEYOND the basis (overtime)
  remainingSec: number;      // active time still to work to reach the basis
  clockedOut: boolean;       // true once activeSec >= basis (9h reached) — OVERTIME marker, NOT a stop
  clockInAt: string | null;  // first sample of the day (ISO) — "clock in"
  clockOutAt: string | null; // End Day time if the user ended their day, else last sample (ISO)
  topApps: UsageEntry[];     // most-used apps, desc, up to 15
  topWebsites: UsageEntry[]; // most-visited website hosts, desc, up to 15
  hourly: HourBucket[];      // always 24 buckets, hour 0..23
};
```

All durations are **seconds**. Format client-side (e.g. `4h 12m`).

---

## 2. Endpoints

All under `/api/v1`, all require auth.

| Method | Path | Who | Purpose | `data` |
|---|---|---|---|---|
| `GET` | `/activity/team/live` | manager / admin | What every report is using right now | `TeamMemberActivity[]` |
| `GET` | `/activity/user/:userId/current` | manager of that user / admin / self | One user's live "using now" | `CurrentActivity` |
| `GET` | `/activity/user/:userId/daily?date=YYYY-MM-DD` | same | One user's day rollup (defaults to today) | `DailyActivity` |
| `GET` | `/activity/me/current` | any signed-in user | The caller's own live activity | `CurrentActivity` |
| `GET` | `/activity/me/today?date=` | any signed-in user | The caller's own day rollup | `DailyActivity` |
| `POST` | `/activity/report` | the agent only | Ingest a sample; returns the capture gate (§4a). **Frontend does not call this.** | ack |
| `POST` | `/activity/end-day` | the agent only | User pressed **End Day** — stops capture for the rest of the day. **Frontend does not call this.** | `{ ok, date, endedAt }` |

**Authorization:** a manager may only read their **own reports** (or themselves;
admins/super-admins see anyone). Others get `403`. `:userId` not found → `403`.

`date` is optional and defaults to the server's local today. Only whole local days
are supported (`YYYY-MM-DD`).

There is **no socket** for activity — poll `GET /activity/team/live` (and the
`/current` endpoints) on an interval. **Every ~30 s** is plenty; samples only land
once a minute anyway.

---

## 3. Manager UI to build

### 3a. Team "Live now" board  ← `GET /activity/team/live`
A table/grid, one row per report, polled every ~30 s:
- Name + department.
- **Status pill**: 🟢 Active / 🟡 Idle / ⚪ Offline (from `status`).
- **Using now**: show `app`; if `url` is set, show it as the site (e.g. `github.com`);
  `title` as a secondary/tooltip line. When `OFFLINE`, show "—".
- Optional "last seen" from `lastSampleAt`.
- Row click → the per-user detail (3b).

> This is the "what is now using" view. Pair it with `GET /presence/team/live`
> (break/lunch/meeting status) if you want both on one board — they're complementary:
> presence = away-status, activity = foreground app/site.

### 3b. Per-user activity detail  ← `GET /activity/user/:userId/daily`
For a selected user + date (default today):
- **Header stats**: Active (`activeSec`), Idle (`idleSec`), and a progress bar of
  `activeSec / workingBasisSec` ("6h 20m of 9h"). If `extraSec > 0`, show an
  **overtime** chip (`+45m`). If `clockedOut`, show a "9h reached" badge (the
  basis is met — anything further is overtime; it does **not** mean tracking stopped).
- **Clock in / last seen**: `clockInAt` → `clockOutAt` (localized times).
- **Top applications**: bar list from `topApps` (`name`, `seconds`).
- **Top websites**: bar list from `topWebsites` (`name` = host, `seconds`).
- **Hourly timeline**: stacked bars over `hourly` (active vs idle per hour) —
  a 24-column chart of the working day.
- A **date picker** → refetch with `?date=`.

### 3c. (Optional) live strip on the detail page  ← `/activity/user/:userId/current`
A small "using right now" line at the top of 3b, polled every ~30 s, mirroring a
single row of the live board.

---

## 4. The working day: 9-hour basis, overtime & End Day (context)

- `workingBasisSec` is the working-day basis — **9h (32400s)**. `extraSec` is
  overtime beyond it; `remainingSec` counts down to it. When a user's **active**
  time reaches the basis, `clockedOut` flips to `true`.
- **`clockedOut` is informational only.** It marks that the 9h basis was reached
  (overtime from here on) and drives the overtime figures. It does **not** stop
  tracking or screen captures.
- **Screen capture runs for the whole working day** — including overtime past the
  9h basis and idle stretches — and stops only when:
  1. the user presses **End Day** (agent calls `POST /activity/end-day`), or
  2. the agent is closed (nothing runs to capture).
- Idle time does **not** count toward the basis — only active foreground time does.
- Once the day is ended, `clockOutAt` in the day rollup reflects the **End Day**
  time (not the last sample). A new local day starts fresh: new `clockInAt`,
  `clockedOut` back to `false`, capture on again.

### 4a. Agent report ack — the capture gate

`POST /activity/report` (agent only, ~1/min) returns:

```ts
type ReportAck = {
  ok: true;
  activeSec: number;         // active (non-idle) seconds today
  workingBasisSec: number;   // 32400 (9h)
  remainingSec: number;      // active seconds left to reach the basis
  clockedOut: boolean;       // 9h reached — OVERTIME marker only, NOT a capture stop
  dayEnded: boolean;         // true once the user pressed End Day today
  shouldCapture: boolean;    // the agent takes screenshots ONLY while this is true
};
```

- **`shouldCapture`** is the single source of truth for whether the agent captures
  right now. It is `true` for the entire working day (overtime + idle included) and
  flips to `false` once the day has been ended. The agent must **not** use
  `clockedOut` to decide capture — only `shouldCapture`.
- **`POST /activity/end-day`** is idempotent — pressing End Day twice keeps the
  first `endedAt`. After it, `shouldCapture` returns `false` for the rest of the
  local day; the next local day resets automatically.

---

## 5. How it works (not required reading)

- The agent reads the foreground window (Win32) + reads the browser address bar via
  UI Automation for the **host only** (never full URLs/paths — monitoring stays
  proportionate), plus idle time, and `POST`s a sample to `/activity/report` ~1/min.
- The backend stores raw samples (`activity_samples`) and computes every view above
  on read (top apps/websites, active/idle, hourly, clock in/out) — no extra agent
  tracking is needed for new views; they're all derivable from the samples.
- "Using now" = the latest sample within a ~2.5-min grace window; older than that =
  `OFFLINE`.
