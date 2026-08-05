# Productivity Hub — Backend (what shipped)

Response to the frontend handover. Everything below is **live and tested** against
the running API unless marked. All responses enveloped `{ success, data }`; auth =
httpOnly cookies; dates are ISO-8601 UTC. Base `http://localhost:4000/api/v1`.

## 1. Confirmed
- Screenshot base path: `/api/v1/screenshots`. ✅
- `from`/`to` accept ISO-8601 UTC (`2026-07-15T00:00:00.000Z`). ✅ No change needed.

## 2. New endpoints (real data now)

### Productivity score
`GET /productivity/:userId?date=YYYY-MM-DD` → self / manager-of / admin.
```jsonc
{ "date": "2026-07-15", "score": 10, "focusSec": 6844, "meetingSec": 0, "idleSec": 0, "onlineSec": 6844 }
```
Heuristic (no per-app tracking): `focusSec = online − meeting`; `idleSec = active-window
span − online − break − lunch − meeting`; `score/10 = (focus+meeting)/(focus+meeting+idle)`.
`onlineSec` is included as a bonus. Defaults to today when `date` omitted.

### Activity timeline
`GET /presence/team/:userId/timeline?date=YYYY-MM-DD` → manager-scoped (report only).
```jsonc
{ "date": "2026-07-15",
  "buckets": [ { "start": "12:00", "workSec": 2629, "breakSec": 419, "lunchSec": 968, "meetingSec": 0 }, ... ] }
```
24 **hourly** buckets (00:00–23:00, local). `workSec` = active online time in the hour;
break/lunch/meeting from presence sessions. Built from existing data — no agent change.

## 3. History upgrades (real data now)
`GET /presence/team/:userId/history?days=N` — each day now also carries:
```jsonc
{ "date": "2026-07-15", "totals": { ...,"onlineSec":6844 }, "focusSec": 6844, "teamAvgOnlineSec": 1141 }
```
`focusSec = online − meeting` (drop your `online − meeting` proxy). `teamAvgOnlineSec` =
average online across the manager's whole team that day (real team baseline for the dashed line).

## 4. Screenshot repository
- **kind filter + pagination:** `GET /screenshots?userId=&limit=&offset=&kind=AUTO|MANUAL&from=&to=&includeArchived=`.
  Returns `{ userId, total, items[] }`; `total` respects the filter. ✅ tested.
- **Archive:** `POST /screenshots/archive { userId, ids: string[] }` → `{ archived }`. Archived
  shots are hidden unless `includeArchived=true`. ✅ tested.
- **Export:** `GET /screenshots/export?userId=&from=&to=&kind=` → **CSV download**
  (`id,takenAt,kind,url`, presigned URLs valid 24 h; includes archived). ✅ tested.
- **OCR search (`q`)** — wired via **AWS Textract on upload**, stored in `ocr_text`, searched
  case-insensitively. **⚠️ Currently non-functional: the IAM user for the provided AWS key is
  not authorized for `textract:DetectDocumentText`** (S3 works, Textract is denied), so
  `ocr_text` stays null and `q` returns nothing. Grant that action to the IAM user and OCR +
  search work with no code change. (Upload/list/etc. are unaffected — OCR is best-effort.)

## Agent instrumentation note
Per the decision: productivity/focus/idle are **heuristics from presence + online data** — no
new agent tracking. True per-app focus would require agent instrumentation (deferred).

## Action items for you (infra)
1. **Grant Textract** to the IAM user (`textract:DetectDocumentText`) to enable OCR search.
2. **Rotate the AWS key** — it was shared in plaintext.
