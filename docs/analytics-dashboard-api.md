# Analytics Dashboard API (Phase 1)

`GET /api/v1/analytics/:userId?date=YYYY-MM-DD`

Returns a user's full dashboard analytics for one day (defaults to today). Auth:
Bearer JWT. Access is **self / manager-of-that-user / admin** — a manager may only
view their own direct reports (else `403`).

Response is the standard envelope: `{ "data": DashboardAnalytics }`.

## Status of each field

Phase 1 computes everything **derivable from existing data** (`activity_samples`,
`online_sessions`, `presence_sessions`). Fields needing new infrastructure are
returned as **stubs** (empty/zero) until later phases.

| Field | Status | Source |
|---|---|---|
| `kpis.active` | ✅ live | `activity_samples` active seconds |
| `kpis.focus` | ✅ live | online − meeting (productivity formula) |
| `kpis.score` | ✅ live | productivity score 0–10 |
| `kpis.sessions` | ✅ live | count of ≥25-min continuous active stretches |
| `kpis.tasks` | 🔴 stub | Phase 3 (tasks module) — value `0` |
| `workVsBreak` | ✅ live | active vs break+lunch |
| `topApps` | ✅ live | `activity_samples` grouped by app |
| `timeline` | ✅ live | today's hourly active/idle |
| `weeklyScore` | ✅ live | 7-day score |
| `focusTrend` | ✅ live | 7-day focus seconds |
| `dailyFlow` | ✅ live | 7 days × 24 hours heatmap |
| `focusSessions` | ✅ live | today's ≥25-min stretches |
| `distribution` (deep/shallow) | 🔴 stub | Phase 2 — `{ deepSec: 0, shallowSec: 0 }` |
| `categories` | 🔴 stub | Phase 2 — `[]` |
| `taskCompletion` | 🔴 stub | Phase 3 — `[]` |
| `achievements` | 🔴 stub | Phase 4 — `[]` |
| `goals` | 🔴 stub | Phase 4 — `[]` |

## Shape

```ts
interface Kpi { value: number; deltaPct: number | null; spark: number[] } // spark = 7 days, oldest first
interface DayValue { date: string; value: number }
interface UsageEntry { name: string; seconds: number }
interface HeatCell { date: string; hour: number; activeSec: number; idleSec: number }
interface TimelineBucket { hour: number; activeSec: number; idleSec: number }
interface FocusSession { start: string; end: string; durationSec: number } // ISO

interface DashboardAnalytics {
  userId: string;
  date: string;
  generatedAt: string;
  kpis: { active: Kpi; focus: Kpi; score: Kpi; sessions: Kpi; tasks: Kpi };
  workVsBreak: { workSec: number; breakSec: number };
  topApps: UsageEntry[];
  timeline: TimelineBucket[];
  weeklyScore: DayValue[];
  focusTrend: DayValue[];
  dailyFlow: HeatCell[];          // length 168 (7×24)
  focusSessions: FocusSession[];
  distribution: { deepSec: number; shallowSec: number };
  categories: UsageEntry[];
  taskCompletion: DayValue[];
  achievements: unknown[];
  goals: unknown[];
}
```

## Notes for the frontend
- **`deltaPct` is `null`** when there's no prior-day baseline (previous day = 0) — render as "—", not "0%".
- **`spark`** is always 7 numbers, oldest first, matching `weeklyScore`/`focusTrend` dates.
- **Seconds everywhere** for durations (`activeSec`, `focusSec`, `workSec`, …); `score` is 0–10, `sessions`/`tasks` are counts.
- **Field names here are the backend's** — if your `src/features/analytics/types/index.ts` differs, tell me the exact names and I'll rename to match (trivial change).
