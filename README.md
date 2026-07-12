# Pulsegrid — Distributed Job Scheduler Platform

A production-shaped distributed job scheduling platform for reliably
running background jobs across multiple worker processes — architecturally
in the same family as Sidekiq, BullMQ, or a simplified Temporal.

Built for an internship evaluation. See [`docs/`](./docs) for the
architecture diagram, ER diagram, API reference, and a design-decisions
document explaining the major trade-offs.

## Stack

- **Backend API**: Node.js + Express, raw SQL over `pg` (no ORM — see
  `docs/DESIGN_DECISIONS.md` §3 for why), JWT + API-key auth, Joi
  validation, Winston logging.
- **Worker**: independent Node.js process, communicates with the API over
  plain REST — a real distribution boundary, not just code organization.
- **Database**: PostgreSQL 16 (`db/migrations/001_init.sql` is the full,
  hand-written, indexed schema).
- **Cache/coordination**: Redis (rate limiting, cross-process event
  pub/sub).
- **Frontend**: React 19 + Vite + Tailwind v4, Socket.IO client, Recharts.
- **Realtime**: Socket.IO, fed by a Redis-backed event bus so events from
  worker processes reach dashboard clients live.

## Features

**Core**
- Auth, organizations, projects (each project owns its queues + has its
  own API key for service-to-service auth)
- Queue configuration: priority, concurrency limits, retry policy,
  pause/resume, live stats
- Job types: immediate, delayed, scheduled, recurring (cron), batch
- Full lifecycle: `QUEUED → (SCHEDULED) → CLAIMED → RUNNING → COMPLETED`,
  with `FAILED → retry → QUEUED` loops and a `DEAD` terminal state feeding
  the Dead Letter Queue
- Configurable retry strategies: fixed, linear, exponential (w/ jitter),
  or none
- Execution logs, full per-attempt retry history, worker assignment,
  timestamps, durations
- Dashboard: queue health, worker status, job explorer with filters,
  execution logs, DLQ triage with one-click reprocess, throughput charts

**Bonus features (all 8 implemented)**
| Feature | Where |
|---|---|
| Workflow dependencies (DAG) | `job_dependencies` table, `resolveDependents()` in `workerService.js` |
| Rate limiting | `rateLimitService.js` — Redis token-bucket per queue |
| Distributed locking | `lockService.js` — Postgres-backed, used by the maintenance loop |
| Queue sharding | `shard_key` / `shardIds` in claim query + queue `shard_count` |
| Event-driven execution | `eventBus.js` — Redis pub/sub bridges worker ↔ API processes |
| WebSocket live updates | `websocket/index.js` + dashboard `PulseStrip` |
| Role-based access control | `organization_members.role` + `rbac.js` middleware |
| AI-generated failure summaries | `aiService.js` — calls the Anthropic API on terminal failure |

## Reliability & concurrency guarantees

- **No duplicate execution**: job claiming uses `SELECT ... FOR UPDATE
  SKIP LOCKED` inside one transaction — verified in `tests/claim.test.js`
  with concurrent claim calls.
- **No stuck jobs**: every claim sets a `visible_at` lease (SQS-style
  visibility timeout); a background maintenance loop reclaims jobs whose
  lease expired without the worker finishing, independent of whether the
  worker's heartbeat also failed.
- **No lost jobs on worker crash**: graceful shutdown requeues in-flight
  jobs immediately; ungraceful crashes are caught by lease expiry + the
  dead-worker reaper.
- **Idempotency**: optional caller-supplied `idempotencyKey` makes job
  submission safe to retry from the client side.

## Quick start (Docker)

```bash
cp backend/.env.example backend/.env   # optional: add ANTHROPIC_API_KEY here
docker compose up --build postgres redis migrate api frontend
```

Open **http://localhost:5173**, register an account (this creates your
org), then create a project. Copy its **API key** from the project screen,
then start a worker against it:

```bash
PROJECT_API_KEY=<paste-it-here> WORKER_QUEUES=default docker compose up --build worker
# or scale to several:
PROJECT_API_KEY=<key> docker compose up --build --scale worker=4 worker
```

## Quick start (without Docker)

Requires Node 20+, PostgreSQL 16, Redis 7.

```bash
# 1. Database
createdb jobscheduler
cd backend
cp .env.example .env        # edit DATABASE_URL/REDIS_URL if needed
npm install
node db/migrate.js          # applies db/migrations/*.sql

# 2. API server
npm run dev                 # http://localhost:4000

# 3. Frontend (new terminal)
cd ../frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

Register in the dashboard, create a project, copy its API key, then in a
third terminal:

```bash
cd backend
PROJECT_API_KEY=<key> WORKER_QUEUES=default npm run worker
# run this command again in more terminals to see concurrent workers
```

Create a queue and jobs directly from the dashboard ("Queues" → New queue,
"Job explorer" → New job — try the `flaky_demo` handler with a payload like
`{"failRate": 0.5}` to watch the retry/backoff/DLQ pipeline live in the
pulse strip), or via the API directly — see `docs/API.md`.

## Tests

```bash
cd backend
npm test
```

Covers: retry backoff math (unit), and — against a real Postgres instance
— concurrent atomic claiming with no duplicate claims, per-queue
concurrency enforcement, lease-expiry reclaiming, and dead-letter
transitions on retry exhaustion. 10/10 passing.

## Project layout

```
backend/
  db/               connection pool, migration runner, migrations/*.sql
  src/
    routes/         Express routers (thin — validation + service calls)
    services/       business logic (job lifecycle, retries, locks, rate limits, AI, events)
    middleware/      auth, RBAC, validation, error handling
    jobs/handlers.js pluggable job execution handlers
    worker.js        standalone worker process
    index.js         API server entrypoint
  tests/
frontend/
  src/
    pages/           Dashboard, Queues, Jobs, Workers, DeadLetter, auth
    components/      Layout, PulseStrip (live event feed), StatusBadge, etc.
    context/         Auth + Socket providers
docs/
  architecture.png, er_diagram.png, API.md, DESIGN_DECISIONS.md
docker-compose.yml
```

## Evaluation criteria mapping

| Criteria | Where to look |
|---|---|
| System Architecture | `docs/architecture.png`, two-process API/worker split (§4 of design decisions) |
| Database Design | `db/migrations/001_init.sql`, `docs/er_diagram.png` |
| Backend Engineering | `src/services/*`, `src/routes/*`, structured errors/validation/logging throughout |
| Reliability & Concurrency | `workerService.js` claim/lease logic, `schedulerService.js`, `tests/claim.test.js` |
| Frontend & UX | `frontend/src/pages/*`, live WebSocket pulse, DLQ reprocess flow |
| API Design | `docs/API.md`, consistent pagination/error shape |
| Documentation | this file + `docs/` |
| Testing | `backend/tests/*` |
