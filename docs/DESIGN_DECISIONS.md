# Design Decisions

This document explains the major engineering trade-offs made while building
Pulsegrid, and why. It's written for a reviewer who wants to understand the
reasoning, not just the code.

## 1. Atomic job claiming: `SELECT ... FOR UPDATE SKIP LOCKED`, not a separate lock service

**Decision:** Job claiming happens inside a single Postgres transaction
using `FOR UPDATE SKIP LOCKED`, rather than delegating coordination to
Redis (e.g. `SETNX`) or a dedicated broker like RabbitMQ.

**Why:** The job table is already the system of record. `SKIP LOCKED`
means N workers can poll concurrently and each walks away with a disjoint
set of rows — no worker blocks waiting for another's row lock, and there's
no separate service that can itself become a single point of failure or a
consistency gap between "what Redis thinks is claimed" and "what Postgres
thinks is queued." This is the same technique used by production systems
like `pg-boss` and Google's `River` queue. The trade-off is that this
doesn't scale to the extreme throughput of a purpose-built broker — for
this system's target scale (an internal job scheduler, not a
million-messages-per-second event bus) that's the right trade.

## 2. Visibility timeout leases instead of relying solely on worker heartbeats

**Decision:** Every claimed job gets a `visible_at` lease (like SQS's
visibility timeout), independently of whether the owning worker is still
heartbeating.

**Why:** Relying purely on "worker missed 3 heartbeats -> reap its jobs"
has a gap: the reaping logic itself needs to run somewhere, and if the
worker process is merely slow (not dead) you don't want to reap
prematurely. A per-job lease that the worker must actively renew
(`extend-lease`) while executing means a stuck or crashed worker's jobs
become reclaimable independently, with no dependency on worker-table
bookkeeping being correct. Two independent safety nets (lease expiry +
dead-worker detection) are used together because the failure modes they
catch don't fully overlap (a worker can go silent on heartbeats but still
be mid-execution, or a job can hang on an external call while the worker
itself is healthy).

## 3. Raw SQL over an ORM for the job-lifecycle tables

**Decision:** The schema is hand-written SQL (`db/migrations/001_init.sql`)
and queried with parameterized `pg` calls, not an ORM like Prisma or
Sequelize, for the hot-path tables.

**Why:** The claim query is deliberately using a Postgres-specific locking
clause (`FOR UPDATE SKIP LOCKED`) combined with a partial index. Most ORMs
either can't express this cleanly or hide exactly the details (lock scope,
index usage) that matter most for correctness under concurrency. Being
explicit here is a feature, not a limitation — a reviewer can read the
query and verify the concurrency guarantee directly. (This project
originally targeted Prisma; the design intent is preserved in
`docs/er_diagram.png`/this document, but the implementation moved to raw
SQL, which also meant zero external binary dependencies at runtime.)

## 4. Two-process architecture: API server vs. Worker, communicating over REST

**Decision:** The worker is a separate OS process that talks to the API
purely over HTTP with a project API key — it does not import the database
layer directly, even though it's in the same codebase/repo.

**Why:** This is the actual distribution boundary of the system. Workers
need to scale independently of the API (you might run 20 workers against 2
API instances), potentially on different hosts/containers, and in
principle in a different language entirely, since the contract is just
REST. Keeping them in one monorepo is a convenience for this assignment;
keeping them procedurally separate (no shared imports beyond `handlers.js`)
means that convenience never leaks into a hidden coupling.

## 5. Retry backoff: exponential with jitter, capped

**Decision:** `EXPONENTIAL` retry delay = `base * 2^(attempt-1)`, multiplied
by a random factor in `[0.8, 1.2]`, capped at `maxDelayMs`.

**Why:** Without jitter, a burst of jobs that fail together (e.g. a
downstream API blip) all retry at exactly the same moment, creating a
"thundering herd" that can re-trigger the same failure. The 20% jitter
band smooths that out cheaply. The cap prevents unbounded backoff from
effectively abandoning a job for hours after only a handful of failures.

## 6. Dead Letter Queue as a first-class table, not just a status flag

**Decision:** Permanently-failed jobs get a row in `dead_letter_jobs` (with
`reason`, `last_payload`, `attempts`) in addition to `jobs.status = DEAD`.

**Why:** The `jobs` table's job is to represent current/recent state
efficiently (hence the partial index on claimable statuses). A dedicated
DLQ table gives operators a purpose-built, indexed view for triage
("what's failing and why") that doesn't compete with the scheduler's
hot-path query, and it's a natural place to track `reprocessed` without
overloading job status semantics.

## 7. Workflow dependencies as an explicit edge table

**Decision:** `job_dependencies(upstream_job_id, dependent_job_id)` is its
own table rather than a `parent_job_id` column on `jobs`.

**Why:** A single parent column only supports trees; real workflows are
DAGs (a job can depend on multiple upstream jobs — "send report" might
depend on both "fetch sales data" and "fetch inventory data" completing).
The edge table supports arbitrary fan-in/fan-out, and dependency
resolution (`resolveDependents`) is a simple query against it rather than
walking a tree.

## 8. Rate limiting in Redis, failing open

**Decision:** Per-queue rate limiting uses a Redis fixed-window counter.
If Redis is unreachable, the rate limiter **allows** the job start rather
than blocking it.

**Why:** Rate limiting is a protective feature, not a correctness
guarantee the rest of the system depends on. If Redis goes down, the
worse outcome is a temporary burst above the configured rate — the better
outcome, compared to failing closed, is that job processing doesn't grind
to a halt because a non-critical dependency degraded. This is called out
explicitly in the code (`rateLimitService.js`) rather than left implicit.

## 9. Distributed locking via a Postgres table, not Redis

**Decision:** The maintenance loop (lease/dead-worker reaping) is guarded
by a lock row in `distributed_locks`, using `INSERT ... ON CONFLICT DO
UPDATE ... WHERE expires_at < now()` for atomic acquire-or-steal-if-expired
semantics.

**Why:** Postgres is already a hard dependency and already strongly
consistent; adding Redis-based locking (`SET NX PX`) for this one
low-frequency use (a tick every 5s) would mean depending on a second
system's availability for something Postgres already does correctly and
simply, via a unique constraint plus a conditional update.

## 10. RBAC scoped per-organization membership, not per-user global roles

**Decision:** A `role` lives on the `organization_members` join row, not
on `users`.

**Why:** The same person can be an ADMIN of their own org and, in
principle, a VIEWER of a client's shared org. Attaching role to the
membership (not the user) is the normalized, extensible choice and avoids
a future migration if multi-org support is needed (which it already
implicitly is, since `users` <-> `organizations` is modeled many-to-many
from the start).

## 11. AI failure summaries are best-effort and never block the pipeline

**Decision:** `aiService.summarizeFailure` is called *after* a job is
already durably marked `DEAD` and inserted into the DLQ, fire-and-forget,
and swallows its own errors.

**Why:** An external LLM call is the least reliable dependency in the
system by construction (network, third-party latency, rate limits). It
must never be on the critical path of the retry/DLQ transition — if it's
slow or down, jobs still fail correctly and land in the DLQ; the summary
simply appears a moment later (or not at all, degrading gracefully to "no
summary" if `ANTHROPIC_API_KEY` isn't configured).

## 12. Event-driven fan-out via Redis pub/sub, not just in-process EventEmitter

**Decision:** `eventBus.js` publishes domain events (`job.completed`,
`worker.offline`, etc.) to a Redis channel in addition to emitting locally.

**Why:** The API process (which hosts the WebSocket server) and the worker
process(es) that actually observe job outcomes are different OS processes.
An in-process `EventEmitter` alone cannot bridge that gap. Redis pub/sub is
a lightweight way to get the same "any process can react to any event"
model without introducing a heavier message broker, and it fails
gracefully (logged warning, no crash) if Redis is temporarily unavailable.

## 13. Idempotency via a caller-supplied key, not automatic dedup

**Decision:** Idempotent job submission requires the caller to pass
`idempotencyKey`; jobs aren't deduplicated by payload hash automatically.

**Why:** Automatic payload-hash dedup is surprising — two semantically
different jobs can have identical payloads (e.g. "send the same welcome
email" twice is sometimes intentional). Requiring an explicit key puts the
idempotency decision where it belongs: with the caller, who knows whether
resubmission should be a no-op.
