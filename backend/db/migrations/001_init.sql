-- ============================================================================
-- Distributed Job Scheduler - Initial Schema
-- ============================================================================
-- Design notes (full rationale in docs/DESIGN_DECISIONS.md):
--  - UUIDs (gen_random_uuid) as PKs: safe for concurrent inserts from many
--    worker processes/shards with zero coordination, unlike serial ints.
--  - ON DELETE CASCADE for strictly-owned child data (Project -> Queue ->
--    Job -> JobExecution/JobLog). ON DELETE RESTRICT where deleting the
--    parent would silently orphan meaningful history (User -> Project).
--  - Every index here backs a real query in services/*.js - see comments.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity & Access
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE role AS ENUM ('ADMIN', 'MAINTAINER', 'DEVELOPER', 'VIEWER');

-- RBAC (bonus feature): role is scoped per-organization membership.
CREATE TABLE organization_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            role NOT NULL DEFAULT 'DEVELOPER',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

-- ---------------------------------------------------------------------------
-- Projects & Queues
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  description     TEXT,
  api_key         TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_projects_api_key ON projects(api_key);

CREATE TYPE queue_status AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE retry_strategy AS ENUM ('FIXED', 'LINEAR', 'EXPONENTIAL', 'NONE');

CREATE TABLE queues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  status              queue_status NOT NULL DEFAULT 'ACTIVE',
  priority            INT NOT NULL DEFAULT 0,

  concurrency_limit   INT NOT NULL DEFAULT 5,
  shard_count         INT NOT NULL DEFAULT 1,

  retry_strategy      retry_strategy NOT NULL DEFAULT 'EXPONENTIAL',
  max_retries         INT NOT NULL DEFAULT 3,
  base_retry_delay_ms INT NOT NULL DEFAULT 2000,
  max_retry_delay_ms  INT NOT NULL DEFAULT 300000,

  rate_limit_max        INT,           -- NULL = unlimited
  rate_limit_window_ms   INT NOT NULL DEFAULT 1000,

  default_timeout_ms  INT NOT NULL DEFAULT 30000,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, name)
);
CREATE INDEX idx_queues_project_status ON queues(project_id, status);

CREATE TABLE queue_stats (
  queue_id        UUID PRIMARY KEY REFERENCES queues(id) ON DELETE CASCADE,
  total_enqueued  BIGINT NOT NULL DEFAULT 0,
  total_completed BIGINT NOT NULL DEFAULT 0,
  total_failed    BIGINT NOT NULL DEFAULT 0,
  total_retried   BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE retry_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id      UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  strategy      retry_strategy NOT NULL DEFAULT 'EXPONENTIAL',
  max_retries   INT NOT NULL DEFAULT 3,
  base_delay_ms INT NOT NULL DEFAULT 2000,
  max_delay_ms  INT NOT NULL DEFAULT 300000,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue_id, name)
);

-- ---------------------------------------------------------------------------
-- Jobs & Executions
-- ---------------------------------------------------------------------------

CREATE TYPE job_type AS ENUM ('IMMEDIATE', 'DELAYED', 'SCHEDULED', 'RECURRING', 'BATCH');
CREATE TYPE job_status AS ENUM (
  'QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'COMPLETED',
  'FAILED', 'DEAD', 'CANCELLED', 'WAITING_DEPENDENCY'
);

CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id         UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  created_by_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  batch_id         UUID,               -- groups jobs created via the batch API
  idempotency_key  TEXT,               -- caller-supplied key for safe re-submission

  type     job_type NOT NULL,
  status   job_status NOT NULL DEFAULT 'QUEUED',
  priority INT NOT NULL DEFAULT 0,

  payload            JSONB NOT NULL DEFAULT '{}',
  result             JSONB,
  error_msg          TEXT,
  ai_failure_summary TEXT,             -- bonus: AI-generated plain-english failure summary

  run_at        TIMESTAMPTZ,           -- for DELAYED / SCHEDULED jobs
  cron_expr     TEXT,                  -- for RECURRING jobs
  cron_timezone TEXT DEFAULT 'UTC',
  next_run_at   TIMESTAMPTZ,           -- next occurrence for RECURRING jobs

  retry_policy_id UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
  attempt         INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 3,
  retry_strategy  retry_strategy NOT NULL DEFAULT 'EXPONENTIAL',

  -- atomic claiming / in-flight lease
  shard_key   INT,
  claimed_by  TEXT,                   -- worker id
  claimed_at  TIMESTAMPTZ,
  lock_token  UUID,                   -- proves ownership of the current claim
  visible_at  TIMESTAMPTZ,            -- job invisible to other workers until this time

  timeout_ms INT NOT NULL DEFAULT 30000,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- The scheduler's single hottest query: "find claimable jobs in this queue,
-- ordered by priority then age". A partial index keeps it tiny even when
-- millions of completed jobs accumulate, since only QUEUED/SCHEDULED rows
-- are ever scanned by the claim query.
CREATE INDEX idx_jobs_claimable ON jobs(queue_id, status, priority DESC, run_at)
  WHERE status IN ('QUEUED', 'SCHEDULED');
CREATE INDEX idx_jobs_visible ON jobs(queue_id, status, visible_at);
CREATE INDEX idx_jobs_recurring_tick ON jobs(status, next_run_at) WHERE type = 'RECURRING';
CREATE INDEX idx_jobs_batch ON jobs(batch_id);
CREATE INDEX idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_claimed_by ON jobs(claimed_by);
CREATE INDEX idx_jobs_queue_status ON jobs(queue_id, status);

-- Workflow dependency DAG (bonus feature): explicit edge table so a job can
-- have multiple upstream dependencies; dependent jobs stay WAITING_DEPENDENCY
-- until every edge's upstream job COMPLETES.
CREATE TABLE job_dependencies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upstream_job_id   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dependent_job_id  UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (upstream_job_id, dependent_job_id)
);
CREATE INDEX idx_job_deps_dependent ON job_dependencies(dependent_job_id);
CREATE INDEX idx_job_deps_upstream ON job_dependencies(upstream_job_id);

-- One row per execution ATTEMPT - independent, permanent retry history.
CREATE TABLE job_executions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id   TEXT,
  attempt     INT NOT NULL,
  status      job_status NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  error       TEXT,
  result      JSONB
);
CREATE INDEX idx_executions_job ON job_executions(job_id, attempt);
CREATE INDEX idx_executions_worker ON job_executions(worker_id);

CREATE TABLE job_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id UUID REFERENCES job_executions(id) ON DELETE SET NULL,
  level        TEXT NOT NULL DEFAULT 'info',
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_logs_job ON job_logs(job_id, created_at);

CREATE TABLE dead_letter_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id     UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  last_payload JSONB NOT NULL,
  attempts     INT NOT NULL,
  moved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reprocessed  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_dlq_queue ON dead_letter_jobs(queue_id, moved_at);

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TYPE worker_status AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE');

CREATE TABLE workers (
  id          TEXT PRIMARY KEY,          -- app-generated (hostname-pid-random)
  hostname    TEXT NOT NULL,
  pid         INT,
  status      worker_status NOT NULL DEFAULT 'ONLINE',
  queue_names TEXT[] NOT NULL DEFAULT '{}',
  shard_ids   INT[] NOT NULL DEFAULT '{}',
  concurrency INT NOT NULL DEFAULT 5,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at  TIMESTAMPTZ
);
CREATE INDEX idx_workers_status_seen ON workers(status, last_seen_at);

CREATE TABLE worker_heartbeats (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id      TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  jobs_in_flight INT NOT NULL DEFAULT 0,
  memory_mb      REAL,
  cpu_percent    REAL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_heartbeats_worker_time ON worker_heartbeats(worker_id, created_at);

-- ---------------------------------------------------------------------------
-- Cross-cutting: distributed locking, audit log
-- ---------------------------------------------------------------------------

-- Generic distributed lock (bonus feature) - e.g. only one process may run
-- the recurring-job ticker or a given queue shard's claim loop at a time.
CREATE TABLE distributed_locks (
  key         TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_locks_expires ON distributed_locks(expires_at);

CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
