# Chat — Frontend Integration Guide

Manager ↔ member 1:1 messaging. The backend (REST + socket.io) and the desktop
agent are done; this document is the contract for building the **web frontend**.

- **Base URL:** `http://localhost:4000/api/v1` (prod: your `AGENT_PUBLIC_API_BASE_URL` host).
- **Socket URL:** the server **origin + `/chat`**, e.g. `http://localhost:4000/chat`
  (socket.io is mounted at the root, **not** under `/api/v1`).

---

## 1. Ground rules

### Auth = httpOnly cookies
`POST /auth/login` sets `accessToken` (2 min) and `refreshToken` (1 day) cookies.
Send **every** request with credentials:

```ts
// axios
axios.defaults.withCredentials = true;
// fetch
fetch(url, { credentials: 'include' });
```

On `401`, call `POST /auth/refresh` (cookie-based) and retry — a standard
interceptor. The token is httpOnly, so JS can't read it; you never handle it
manually in the browser.

### Every REST response is enveloped
```jsonc
{ "success": true, "data": <payload> }   // success
{ "success": false, ... }                // error
```
Always read `res.data.data`.

### CORS
The API runs with `credentials: true`, so **`CORS_ORIGINS` cannot be `*`** for a
browser. Set it to your frontend origin in the backend `.env`, e.g.:
```
CORS_ORIGINS=http://localhost:5173
```

---

## 2. Types

```ts
type ChatContact = {
  userId: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'USER';
  department: string | null;
};

type ChatMessage = {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  mine: boolean;      // true if sent by the logged-in user → align right
  read: boolean;
  createdAt: string;  // ISO 8601
};

type ChatThread = ChatContact & {
  lastMessage: ChatMessage | null;
  unreadCount: number;
};
```

`mine` is computed server-side per caller — don't compare ids yourself.

---

## 3. REST endpoints

All under `/api/v1`, all require auth (cookie).

| Method | Path | Purpose | `data` |
|---|---|---|---|
| `GET` | `/chat/contacts` | People you can message (your manager + the users you created) | `ChatContact[]` |
| `GET` | `/chat/threads` | **Conversation list**: each contact + `lastMessage` preview + `unreadCount`, sorted newest-activity first | `ChatThread[]` |
| `GET` | `/chat/unread` | Total unread messages addressed to you (for a global badge) | `{ count: number }` |
| `GET` | `/chat/messages?withUserId=<uuid>&limit=50` | One conversation, oldest→newest. **Side effect: marks the other side's messages read.** | `ChatMessage[]` |
| `POST` | `/chat/messages` — body `{ toUserId, body }` | Send a message (persists). `201`. | `ChatMessage` |

Notes:
- `limit` is 1–200 (default 50).
- Opening a conversation (`GET /chat/messages`) clears its unread count — refetch
  `/chat/unread` / `/chat/threads` afterwards to update badges.
- `body` is 1–2000 chars.

---

## 4. WebSocket (socket.io)

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000/chat', { withCredentials: true });

socket.on('connect', () => {/* ready */});
socket.on('chat:message', (m: ChatMessage) => {
  // If m is for the open thread → append (de-dupe by m.id).
  // Otherwise → bump that contact's unread badge / toast.
});
socket.on('', () => {
  // Handshake token expired → refresh the session, then socket.connect() again.
});
```

**Delivery model:** on every send the server emits `chat:message` to **both** the
recipient and the sender (all their tabs). So:

1. `POST /chat/messages` → get the saved message back.
2. Also receive the same message via `chat:message`.
3. **De-dupe by `m.id`** so it renders once.

The simplest robust approach: render optimistically from the POST response, then
ignore any `chat:message` whose id you've already shown.

**Reconnect caveat:** the socket only checks auth at the *handshake*, so an open
socket survives access-token expiry. But a reconnect resends a possibly-expired
cookie and can fail with `unauthorized` — refresh the session before reconnecting.

The gateway also accepts `auth: { token }` or an `Authorization: Bearer` header
(that's how the desktop agent connects); browsers should just use the cookie via
`withCredentials: true`.

---

## 5. UI to build

### Member view (simple)
One conversation, with the manager.
1. `GET /chat/contacts` → pick `role === 'MANAGER'` (or use `GET /chat/threads[0]`).
2. `GET /chat/messages?withUserId=<managerId>` → render bubbles (mine=right).
3. Connect socket; append incoming `chat:message`.
4. Composer → `POST /chat/messages { toUserId: managerId, body }`.

### Manager view (two-pane messenger)
1. Left list ← `GET /chat/threads` (name, last-message preview, `unreadCount` badge).
2. Selecting a thread ← `GET /chat/messages?withUserId=<id>` (this marks read;
   refresh the badge).
3. Right pane composer → `POST /chat/messages { toUserId: <id>, body }`.
4. Global `chat:message`: if it belongs to the open thread → append; else bump
   that thread's badge and re-sort the list to top.
5. Global unread badge (navbar) ← `GET /chat/unread`, kept in sync on each
   incoming message and after opening a thread.

---

## 6. Suggested wiring order

1. Axios/fetch client with `withCredentials` + 401→refresh interceptor.
2. Envelope unwrapper (`res.data.data`).
3. Chat API module (the 5 endpoints above).
4. Socket singleton created after login; tear down on logout.
5. Member conversation screen (smallest slice) → verify send/receive live.
6. Manager thread list + unread badges.

---

## 7. Behaviour reference

- **Who can talk to whom:** your manager (who created you) and your direct reports
  (the users you created). Enforced server-side by `/chat/contacts`.
- **Read receipts:** a message is `read` once the recipient opens the conversation
  (`GET /chat/messages`). There's a `read` flag per message if you want ticks.
- **Ordering:** `/chat/messages` returns oldest→newest (append at bottom);
  `/chat/threads` returns newest-activity first.
