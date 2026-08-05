# Presence API (break / lunch / meeting)

Status tracking that replaces the old "start tracking" toggle. An employee is
always in one of four states — **Working** (the default) or on **Break**,
**Lunch**, or in a **Meeting**. Every non-working stretch is recorded as a
*session* with a start and end, so the app can show live status and day-wise
totals, and managers can see how long each report spent where.

All responses use the standard envelope: `{ "success": true, "data": <T>, ... }`.
All endpoints require auth (the `accessToken` cookie or `Authorization: Bearer`).
Timestamps are ISO-8601; durations are whole **seconds**.

`status` is always one of: `WORKING | BREAK | LUNCH | MEETING`.

---

## Employee endpoints (the agent / the signed-in user)

### `POST /presence/start`
Begin a break / lunch / meeting. Automatically closes any status already open.

Request body:
```json
{ "type": "MEETING", "note": "Sprint planning with design" }
```
- `type` — `BREAK | LUNCH | MEETING` (required)
- `note` — optional, ≤500 chars. For `MEETING` it is delivered to the manager
  as a notification (persisted + realtime via the notifications socket).

`data` (the new current status):
```json
{
  "status": "MEETING",
  "sessionId": "9f2c…",
  "note": "Sprint planning with design",
  "since": "2026-07-11T09:15:00.000Z",
  "elapsedSec": 0
}
```

### `POST /presence/end`
End the current status → back to **Working**. Body: none.

`data`:
```json
{ "status": "WORKING", "sessionId": null, "note": null, "since": null, "elapsedSec": 0 }
```

### `GET /presence/me/current`
The signed-in user's current status. `data` is the same shape as above
(`elapsedSec` counts up live while a session is open).

### `GET /presence/me/today`
The user's own day — used by the agent to show "how much break I've taken".

`data`:
```json
{
  "date": "2026-07-11",
  "current": { "status": "BREAK", "sessionId": "…", "note": null, "since": "…", "elapsedSec": 320 },
  "totals": { "breakSec": 900, "lunchSec": 1800, "meetingSec": 2400 },
  "sessions": [
    { "id": "…", "type": "BREAK", "note": null,
      "startedAt": "…", "endedAt": null, "durationSec": 320 }
  ]
}
```
> `totals` **include** the live seconds of any open session. `durationSec` on an
> open session is its live elapsed time; on a closed session it's the final value.

---

## Manager endpoints
Require role `MANAGER`, `ADMIN`, or `SUPER_ADMIN`. Scope = the caller's direct
reports (`users.manager_id = me`).

### `GET /presence/team/live`
Every report and what they're doing **right now**. `data` is an array:
```json
[
  {
    "userId": "…", "name": "Asha Rao", "email": "asha@acme.com", "department": "Support",
    "status": "LUNCH", "note": null,
    "since": "2026-07-11T12:30:00.000Z", "elapsedSec": 640
  }
]
```
Working reports appear with `status: "WORKING"`, `since: null`, `elapsedSec: 0`.

### `GET /presence/team/summary?date=YYYY-MM-DD`
Day-wise rollup per report. `date` is optional (defaults to today).
Response: `{ "success": true, "data": [rows], "meta": { "date": "2026-07-11" } }`

Each row:
```json
{
  "userId": "…", "name": "Asha Rao", "email": "asha@acme.com", "department": "Support",
  "status": "WORKING",
  "totals": { "breakSec": 1200, "lunchSec": 1800, "meetingSec": 3600 },
  "meetingNotes": [
    { "note": "Sprint planning", "startedAt": "…", "durationSec": 3600 }
  ],
  "sessionsCount": 5
}
```

---

## Live updates (WebSocket)

Managers get pushed presence changes without polling.

- **Namespace:** `/presence` (socket.io). Auth via the `accessToken` cookie, an
  `Authorization: Bearer` header, or `auth: { token }` in the handshake — same as
  `/notifications`.
- On connect the socket joins a room keyed by the connected user's id.
- **Event `presence:update`** fires whenever one of your reports starts/ends a
  status. Payload is a single team-live row (same shape as `GET /presence/team/live`
  items). Merge it into the board by `userId`.

Meeting notes additionally arrive on the existing **`/notifications`** socket as a
`notification` event with `type: "MEETING_NOTE"` (and via `GET /notifications`).

---

## Suggested frontend wiring

1. **Manager live board:** load `GET /presence/team/live`, then subscribe to the
   `/presence` socket and upsert rows on `presence:update`. Render a live-counting
   timer from `since`.
2. **Manager day report:** `GET /presence/team/summary?date=…` for the totals table
   + meeting notes; add a date picker.
3. **Employee self view (optional):** `GET /presence/me/today` for personal totals.
