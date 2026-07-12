# API Documentation

Base URL: `http://localhost:4000`

## Authentication

Two schemes, depending on caller:

- **`Authorization: Bearer <jwt>`** — human users via the dashboard. Obtained
  from `POST /api/auth/login` or `/register`.
- **`X-Api-Key: <project api_key>`** — services/workers acting on behalf of
  one project. Obtained from the project object (`POST /api/projects`
  response, or the project detail view). Callers using an API key are
  trusted at MAINTAINER-equivalent level for that project's resources only.

Most routes accept **either** scheme (`requireAuthOrApiKey`); a few
(project management, dashboard summary) require a human JWT.

All error responses share this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
```

Common codes: `VALIDATION_ERROR` (422), `UNAUTHORIZED` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429).

---

## Auth

### `POST /api/auth/register`
Creates a user **and** a new organization owned by them as `ADMIN`.

```json
// request
{ "email": "a@b.com", "password": "min8chars", "name": "Ada", "orgName": "Acme" }
// response 201
{ "user": {...}, "organization": {...}, "token": "eyJ..." }
```

### `POST /api/auth/login`
```json
{ "email": "a@b.com", "password": "..." }
// -> { "user": {...}, "token": "eyJ..." }
```

### `GET /api/auth/me` (JWT)
Returns the current user, including `organizations: [{id, name, slug, role}]`.

---

## Projects (JWT only)

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List projects the caller is a member of |
| POST | `/api/projects` | Create a project (`{organizationId, name, description?}`) |
| GET | `/api/projects/:id` | Project detail |
| GET | `/api/projects/whoami` | (API key) resolves the calling project |
| POST | `/api/projects/:id/rotate-key` | Rotate the project's API key (ADMIN only) |

---

## Queues

| Method | Path | Description |
|---|---|---|
| GET | `/api/queues?projectId=&page=&pageSize=` | List queues with live pending/running counts |
| POST | `/api/queues` | Create a queue (MAINTAINER+) |
| GET | `/api/queues/:id` | Queue detail + stats |
| PATCH | `/api/queues/:id` | Update config (MAINTAINER+) |
| POST | `/api/queues/:id/pause` | Pause (stops new claims; in-flight jobs finish) |
| POST | `/api/queues/:id/resume` | Resume |
| GET | `/api/queues/:id/throughput?minutes=60` | Per-minute completed/failed series |

**Create body:**
```json
{
  "projectId": "uuid", "name": "emails",
  "priority": 0, "concurrencyLimit": 5, "shardCount": 1,
  "retryStrategy": "EXPONENTIAL", "maxRetries": 3,
  "baseRetryDelayMs": 2000, "maxRetryDelayMs": 300000,
  "rateLimitMax": null, "rateLimitWindowMs": 1000,
  "defaultTimeoutMs": 30000
}
```

---

## Jobs

| Method | Path | Description |
|---|---|---|
| GET | `/api/jobs?queueId=\|projectId=&status=&type=&page=&pageSize=` | List/filter jobs |
| POST | `/api/jobs` | Create a job (DEVELOPER+) |
| POST | `/api/jobs/batch` | Create many jobs sharing one `batchId` |
| GET | `/api/jobs/:id` | Full detail: executions, logs, dependency status |
| POST | `/api/jobs/:id/retry` | Manually retry a DEAD/FAILED/CANCELLED job |
| POST | `/api/jobs/:id/cancel` | Cancel a pending job |
| GET | `/api/jobs/dlq/:queueId?page=&pageSize=` | Dead letter queue for a queue |

**Create body** (`type` drives which other fields apply):
```jsonc
{
  "queueId": "uuid",
  "type": "IMMEDIATE | DELAYED | SCHEDULED | RECURRING | BATCH",
  "payload": { "handler": "send_email", "to": "a@b.com" },
  "priority": 0,
  "runAt": "2026-01-01T00:00:00Z",   // required for SCHEDULED
  "delayMs": 5000,                   // DELAYED: alternative to runAt
  "cronExpr": "*/5 * * * *",         // required for RECURRING
  "cronTimezone": "UTC",
  "maxRetries": 3, "retryStrategy": "EXPONENTIAL", "timeoutMs": 30000,
  "idempotencyKey": "order-123-confirmation",
  "dependsOn": ["upstream-job-uuid"]  // workflow dependency (bonus feature)
}
```

---

## Workers

Worker-facing endpoints are called by the worker process itself (see
`src/worker.js`), authenticated with the project's API key.

| Method | Path | Description |
|---|---|---|
| POST | `/api/workers/register` | `{hostname, pid, queueNames, shardIds, concurrency}` -> `{workerId}` |
| POST | `/api/workers/:id/heartbeat` | `{jobsInFlight, memoryMb?, cpuPercent?}` |
| POST | `/api/workers/:id/deregister` | Graceful shutdown; requeues in-flight jobs |
| POST | `/api/workers/:id/claim` | `{queueIds, shardIds, limit, leaseMs}` -> claimed job array |
| POST | `/api/workers/jobs/:jobId/start` | Marks RUNNING |
| POST | `/api/workers/jobs/:jobId/log` | Append a log line |
| POST | `/api/workers/jobs/:jobId/extend-lease` | Renew the in-flight lease |
| POST | `/api/workers/jobs/:jobId/complete` | `{result}` |
| POST | `/api/workers/jobs/:jobId/fail` | `{error}` — triggers retry or DLQ |
| GET | `/api/workers?projectId=` | Dashboard: list workers + liveness |

---

## Dashboard

### `GET /api/dashboard/summary?projectId=` (JWT)
```json
{
  "queues": { "total": 3, "active": 2, "paused": 1 },
  "jobsByStatus": { "QUEUED": 4, "COMPLETED": 120, "DEAD": 2 },
  "workers": { "total": 2, "online": 2 },
  "deadLetterCount": 2
}
```

---

## Pagination & filtering

List endpoints accept `page` (default 1) and `pageSize` (default 20, max
100) and return:
```json
{ "items": [...], "total": 137, "page": 1, "pageSize": 20 }
```

## Rate limiting

The control-plane API itself is rate-limited to 600 requests/minute per
client (separate from per-queue job-start rate limiting, which is a queue
config value enforced during claiming).
