# Screenshots — Frontend Integration Guide

Periodic + on-demand screen monitoring. The desktop agent captures the screen
**every 5 minutes throughout the working day** (and whenever a manager requests
one) and uploads it; the backend stores the image in **S3** and records it. The
manager UI lists a user's screenshots and can trigger a capture. Backend + agent
are done; this is the contract for the **web frontend** (the manager tab).

> **When auto-capture runs:** the whole working day — overtime past the 9h basis
> and idle stretches included. It stops only when the user presses **End Day** or
> closes the agent, **not** at 9 hours. The agent gates capture on the
> `shouldCapture` flag from `POST /activity/report` — see
> `docs/activity-frontend.md` §4/§4a.

- **Base URL:** `http://localhost:4000/api/v1`
- Auth = httpOnly cookies, responses enveloped `{ success, data }` — same as the
  rest of the API (see `docs/chat-frontend.md` §1 for the auth/CORS rules).

> **Transparency:** this is disclosed monitoring. The agent shows a visible tray
> icon and a one-time notice that screen captures happen. Keep it visible in the
> product — don't present it as hidden surveillance.

---

## 1. Types

```ts
type Screenshot = {
  id: string;
  userId: string | null;
  kind: 'AUTO' | 'MANUAL';   // AUTO = 5-min timer (while shouldCapture), MANUAL = a manager clicked "capture"
  takenAt: string;           // ISO 8601
  url: string;               // presigned S3 GET URL, valid ~1 hour — load directly in <img>
};

type ScreenshotList = {
  userId: string;
  total: number;             // total matching screenshots (for "this many exist")
  items: Screenshot[];       // newest first, capped by `limit`
};
```

`url` is a short-lived presigned link — don't cache it long-term; refetch the list
to get fresh URLs.

---

## 2. Endpoints

All under `/api/v1`, all require auth.

| Method | Path | Who | Purpose | `data` |
|---|---|---|---|---|
| `GET` | `/screenshots?userId=<uuid>&limit=50&from=&to=` | manager of that user / admin / the user | List a user's screenshots (newest first) + `total` | `ScreenshotList` |
| `POST` | `/screenshots/capture` — body `{ userId }` | same | Ask that user's agent to capture **now**. `202`. | `{ requested: boolean }` |
| `POST` | `/screenshots` (multipart `file` + `kind`) | the agent | Upload a capture. **Frontend does not call this** — the agent does. | `Screenshot` |

Query params for the list:
- `limit` 1–200 (default 50).
- `from` / `to` ISO timestamps to window by capture time (optional).

**Authorization:** a manager may only list/capture for their **own reports** (or
themselves; admins see anyone). Others get `403`.

`POST /screenshots/capture` returns `202` immediately — it just signals the agent
over a socket. The new screenshot appears a moment later once the agent captures
and uploads; **re-fetch `GET /screenshots` after ~2–3 s** (or poll briefly) to show it.

---

## 3. Manager tab — UI to build

For a selected user (e.g. from your team list):

1. **"Capture now" button** → `POST /screenshots/capture { userId }`. On `202`,
   show a spinner and re-fetch the list after a couple of seconds.
2. **Screenshot gallery** ← `GET /screenshots?userId=<id>`:
   - Show `total` ("42 screenshots").
   - Grid of thumbnails using `item.url` directly in `<img src>`.
   - Badge each with `kind` (Auto / Manual) and `takenAt` (localized).
   - Click → lightbox with the full image (`item.url`).
3. Optional: date filter → pass `from`/`to`; "load more" → raise `limit` or page
   by `to = last item's takenAt`.

No socket is required in the manager UI — capture is fire-and-forget + refetch.
(Sockets are only used agent-side to receive the capture command.)

---

## 4. How it works (context, not required reading)

- The agent captures the full desktop (all monitors) as PNG and `POST`s it to
  `/screenshots`; the **backend** holds the AWS keys and puts the object in S3
  (bucket `rx-timechamp`, prefix `uploads/screenshots/<userId>/<date>/…`). The
  agent never sees AWS credentials.
- AUTO capture path: the agent's 5-min timer fires and uploads (`kind: 'AUTO'`)
  **only while `shouldCapture` is true** in the `POST /activity/report` ack — i.e.
  for the whole working day until **End Day** (`POST /activity/end-day`) or the
  agent is closed. `clockedOut` (9h reached) does **not** stop it.
- MANUAL capture path: manager `POST /screenshots/capture` → backend emits
  `screenshot:capture` on the `/screenshots` socket to that user's agent → agent
  captures + uploads (`kind: 'MANUAL'`). A manager-requested capture is honored
  regardless of `shouldCapture`.
- Images are stored private; the API returns presigned URLs on read.
