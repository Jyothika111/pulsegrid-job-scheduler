const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../../db');
const { computeRetryDelayMs } = require('./retryService');
const { allowJobStart } = require('./rateLimitService');
const eventBus = require('./eventBus');
const aiService = require('./aiService');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Worker registration & heartbeats
// ---------------------------------------------------------------------------

async function registerWorker({ id, hostname, pid, queueNames, shardIds, concurrency }) {
  const workerId = id || `${hostname}-${pid || process.pid}-${uuidv4().slice(0, 8)}`;
  await query(
    `INSERT INTO workers (id, hostname, pid, queue_names, shard_ids, concurrency, status, started_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ONLINE', now(), now())
     ON CONFLICT (id) DO UPDATE SET status = 'ONLINE', last_seen_at = now(), stopped_at = NULL`,
    [workerId, hostname, pid || null, queueNames, shardIds, concurrency]
  );
  await eventBus.publish('worker.registered', { workerId, hostname, queueNames });
  return workerId;
}

async function heartbeat(workerId, { jobsInFlight = 0, memoryMb, cpuPercent }) {
  await query('UPDATE workers SET last_seen_at = now() WHERE id = $1', [workerId]);
  await query(
    `INSERT INTO worker_heartbeats (worker_id, jobs_in_flight, memory_mb, cpu_percent) VALUES ($1,$2,$3,$4)`,
    [workerId, jobsInFlight, memoryMb ?? null, cpuPercent ?? null]
  );
  await eventBus.publish('worker.heartbeat', { workerId, jobsInFlight, memoryMb, cpuPercent, at: new Date() });
}

async function deregisterWorker(workerId, { graceful = true } = {}) {
  await query(
    `UPDATE workers SET status = 'OFFLINE', stopped_at = now() WHERE id = $1`,
    [workerId]
  );
  // Any jobs this worker had claimed but not finished go back to QUEUED
  // immediately on graceful shutdown, rather than waiting for the
  // visibility-timeout reaper.
  if (graceful) {
    await query(
      `UPDATE jobs SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, lock_token = NULL, visible_at = NULL
        WHERE claimed_by = $1 AND status IN ('CLAIMED','RUNNING')`,
      [workerId]
    );
  }
  await eventBus.publish('worker.offline', { workerId, graceful });
}

/** Workers that haven't heartbeat within `staleMs` are considered dead; their in-flight jobs are requeued. */
async function reapDeadWorkers(staleMs = 30000) {
  const stale = await query(
    `SELECT id FROM workers WHERE status = 'ONLINE' AND last_seen_at < now() - ($1 || ' milliseconds')::interval`,
    [staleMs]
  );
  for (const row of stale.rows) {
    logger.warn('Reaping dead worker', { workerId: row.id });
    await deregisterWorker(row.id, { graceful: true });
  }
  return stale.rows.length;
}

// ---------------------------------------------------------------------------
// Atomic job claiming
// ---------------------------------------------------------------------------

/**
 * The heart of the scheduler's reliability guarantee: atomically claims up
 * to `limit` claimable jobs for this worker across the given queues/shards,
 * such that no two workers can ever claim the same job.
 *
 * Mechanism: `SELECT ... FOR UPDATE SKIP LOCKED` inside a single
 * transaction. Any row a concurrent transaction already has locked (i.e.
 * another worker's claim in flight) is invisible to this query instead of
 * blocking on it - so N workers polling concurrently each get a disjoint
 * set of jobs with zero contention/deadlock risk, no external
 * lock manager required.
 *
 * A `visible_at` lease (like SQS's visibility timeout) is also set: if a
 * worker crashes mid-job, the row becomes reclaimable again once the lease
 * expires, without needing the worker to explicitly release it.
 */
async function claimJobs({ workerId, queueIds, shardIds, limit, leaseMs = 60000 }) {
  return withTransaction(async (client) => {
    // Lock the queue rows FIRST, before counting running jobs. This is
    // what makes the concurrency-limit check below safe under true
    // concurrency: without it, two transactions claiming from the same
    // queue at the same instant would each run their "how many jobs are
    // currently running" COUNT against the OTHER transaction's
    // not-yet-committed claims (invisible to them), both conclude there's
    // headroom, and both claim - silently exceeding concurrency_limit.
    // Locking the queue row means the second transaction's claim blocks
    // until the first commits, so its COUNT afterwards is accurate.
    // Different queues still claim fully in parallel (different rows).
    await client.query(`SELECT id FROM queues WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [queueIds]);

    const shardFilter = shardIds && shardIds.length ? `AND (j.shard_key IS NULL OR j.shard_key = ANY($3))` : '';
    const params = [queueIds, limit];
    if (shardFilter) params.push(shardIds);

    const candidates = await client.query(
      `SELECT j.id, j.queue_id, q.concurrency_limit, q.rate_limit_max, q.rate_limit_window_ms, q.name as queue_name
         FROM jobs j
         JOIN queues q ON q.id = j.queue_id
        WHERE j.queue_id = ANY($1)
          AND q.status = 'ACTIVE'
          AND j.status IN ('QUEUED', 'SCHEDULED')
          AND (j.run_at IS NULL OR j.run_at <= now())
          AND (j.visible_at IS NULL OR j.visible_at <= now())
          ${shardFilter}
        ORDER BY j.priority DESC, j.created_at ASC
        LIMIT $2
        FOR UPDATE OF j SKIP LOCKED`,
      params
    );

    if (!candidates.rows.length) return [];

    // Enforce per-queue concurrency limit: count jobs already RUNNING/CLAIMED
    // for each queue represented among candidates, and only claim up to the
    // remaining headroom. This runs inside the same transaction as the
    // FOR UPDATE lock above so the count-then-claim is atomic per queue.
    const queueIdsInBatch = [...new Set(candidates.rows.map((r) => r.queue_id))];
    const runningCounts = await client.query(
      `SELECT queue_id, count(*) AS running
         FROM jobs WHERE queue_id = ANY($1) AND status IN ('CLAIMED','RUNNING')
         GROUP BY queue_id`,
      [queueIdsInBatch]
    );
    const runningByQueue = Object.fromEntries(runningCounts.rows.map((r) => [r.queue_id, parseInt(r.running, 10)]));
    const concurrencyByQueue = Object.fromEntries(candidates.rows.map((r) => [r.queue_id, r.concurrency_limit]));

    const claimable = [];
    for (const row of candidates.rows) {
      const used = runningByQueue[row.queue_id] || 0;
      if (used >= concurrencyByQueue[row.queue_id]) continue; // queue at capacity

      // Rate limiting (bonus feature): token-bucket check per queue.
      // eslint-disable-next-line no-await-in-loop
      const allowed = await allowJobStart(row.queue_id, row.rate_limit_max, row.rate_limit_window_ms);
      if (!allowed) continue;

      runningByQueue[row.queue_id] = used + 1;
      claimable.push(row);
    }
    if (!claimable.length) return [];

    const lockToken = uuidv4();
    const ids = claimable.map((r) => r.id);
    const visibleAt = new Date(Date.now() + leaseMs);

    const claimed = await client.query(
      `UPDATE jobs SET status = 'CLAIMED', claimed_by = $1, claimed_at = now(),
              lock_token = $2, visible_at = $3, attempt = attempt + 1, updated_at = now()
        WHERE id = ANY($4)
        RETURNING *`,
      [workerId, lockToken, visibleAt, ids]
    );

    for (const job of claimed.rows) {
      await client.query(
        `INSERT INTO job_executions (job_id, worker_id, attempt, status) VALUES ($1,$2,$3,'CLAIMED')`,
        [job.id, workerId, job.attempt]
      );
    }

    return claimed.rows;
  }).then(async (jobs) => {
    for (const job of jobs) {
      // eslint-disable-next-line no-await-in-loop
      await eventBus.publish('job.claimed', { jobId: job.id, queueId: job.queue_id, workerId });
    }
    return jobs;
  });
}

async function markRunning(jobId) {
  await query(
    `UPDATE jobs SET status = 'RUNNING', started_at = now(), updated_at = now() WHERE id = $1`,
    [jobId]
  );
  await query(
    `UPDATE job_executions SET status = 'RUNNING' WHERE job_id = $1 AND finished_at IS NULL`,
    [jobId]
  );
  await eventBus.publish('job.started', { jobId });
}

async function appendLog(jobId, level, message, executionId = null) {
  await query('INSERT INTO job_logs (job_id, execution_id, level, message) VALUES ($1,$2,$3,$4)', [
    jobId,
    executionId,
    level,
    message,
  ]);
}

/** Renews a worker's lease on an in-flight job so the visibility-timeout reaper doesn't reclaim it mid-execution. */
async function extendLease(jobId, lockToken, leaseMs = 60000) {
  const visibleAt = new Date(Date.now() + leaseMs);
  await query('UPDATE jobs SET visible_at = $1 WHERE id = $2 AND lock_token = $3', [visibleAt, jobId, lockToken]);
}

// ---------------------------------------------------------------------------
// Completion outcomes
// ---------------------------------------------------------------------------

async function completeJob(jobId, result) {
  return withTransaction(async (client) => {
    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const job = jobRes.rows[0];
    if (!job) return null;

    await client.query(
      `UPDATE jobs SET status = 'COMPLETED', result = $2, completed_at = now(), updated_at = now(),
              claimed_by = NULL, lock_token = NULL, visible_at = NULL
        WHERE id = $1`,
      [jobId, result ?? null]
    );
    await client.query(
      `UPDATE job_executions SET status = 'COMPLETED', finished_at = now(),
              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000, result = $2
        WHERE job_id = $1 AND finished_at IS NULL`,
      [jobId, result ?? null]
    );
    await client.query(
      'UPDATE queue_stats SET total_completed = total_completed + 1, updated_at = now() WHERE queue_id = $1',
      [job.queue_id]
    );

    // Recurring job: schedule the next occurrence.
    if (job.type === 'RECURRING' && job.cron_expr) {
      const { computeNextCronRun } = require('./jobService');
      const next = computeNextCronRun(job.cron_expr, job.cron_timezone);
      await client.query(
        `INSERT INTO jobs (queue_id, created_by_id, type, status, priority, payload, run_at,
                            cron_expr, cron_timezone, next_run_at, max_retries, retry_strategy, timeout_ms)
         VALUES ($1,$2,'RECURRING','SCHEDULED',$3,$4,$5,$6,$7,$5,$8,$9,$10)`,
        [
          job.queue_id, job.created_by_id, job.priority, job.payload, next,
          job.cron_expr, job.cron_timezone, job.max_retries, job.retry_strategy, job.timeout_ms,
        ]
      );
    }

    return job;
  }).then(async (job) => {
    if (!job) return null;
    await eventBus.publish('job.completed', { jobId, queueId: job.queue_id });
    await resolveDependents(jobId);
    return job;
  });
}

/**
 * Handles a failed execution attempt: either schedules a retry with
 * backoff, or - once max_retries is exhausted - moves the job to the Dead
 * Letter Queue permanently. Also triggers the (best-effort) AI failure
 * summary on the terminal failure.
 */
async function failJob(jobId, errorMessage) {
  const job = await withTransaction(async (client) => {
    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const job = jobRes.rows[0];
    if (!job) return null;

    await client.query(
      `UPDATE job_executions SET status = 'FAILED', finished_at = now(),
              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000, error = $2
        WHERE job_id = $1 AND finished_at IS NULL`,
      [jobId, errorMessage]
    );

    const exhausted = job.attempt >= job.max_retries;

    if (!exhausted) {
      const delayMs = computeRetryDelayMs(job.retry_strategy, job.attempt, 2000, 300000);
      const nextRunAt = new Date(Date.now() + (delayMs ?? 0));
      await client.query(
        `UPDATE jobs SET status = 'QUEUED', run_at = $2, error_msg = $3,
                claimed_by = NULL, claimed_at = NULL, lock_token = NULL, visible_at = NULL, updated_at = now()
          WHERE id = $1`,
        [jobId, nextRunAt, errorMessage]
      );
      await client.query(
        'UPDATE queue_stats SET total_retried = total_retried + 1, updated_at = now() WHERE queue_id = $1',
        [job.queue_id]
      );
      return { ...job, _outcome: 'retrying', _delayMs: delayMs };
    }

    await client.query(
      `UPDATE jobs SET status = 'DEAD', error_msg = $2, claimed_by = NULL, lock_token = NULL, visible_at = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, errorMessage]
    );
    await client.query(
      `INSERT INTO dead_letter_jobs (job_id, queue_id, reason, last_payload, attempts)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_id) DO UPDATE SET reason = $3, attempts = $5, moved_at = now(), reprocessed = false`,
      [jobId, job.queue_id, errorMessage, job.payload, job.attempt]
    );
    await client.query(
      'UPDATE queue_stats SET total_failed = total_failed + 1, updated_at = now() WHERE queue_id = $1',
      [job.queue_id]
    );
    return { ...job, _outcome: 'dead' };
  });

  if (!job) return null;

  if (job._outcome === 'retrying') {
    await eventBus.publish('job.retrying', { jobId, delayMs: job._delayMs, attempt: job.attempt });
  } else {
    await eventBus.publish('job.dead', { jobId, queueId: job.queue_id });
    // Best-effort AI failure summary - never blocks the DLQ transition.
    summarizeAndStore(jobId).catch((err) => logger.warn('AI summary failed', { error: err.message }));
  }
  return job;
}

async function summarizeAndStore(jobId) {
  const jobRes = await query('SELECT j.*, q.name as queue_name FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1', [jobId]);
  const job = jobRes.rows[0];
  if (!job) return;
  const logsRes = await query('SELECT level, message FROM job_logs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 10', [jobId]);
  const summary = await aiService.summarizeFailure({
    jobId,
    queueName: job.queue_name,
    error: job.error_msg,
    logs: logsRes.rows.reverse(),
    attempt: job.attempt,
    maxRetries: job.max_retries,
  });
  if (summary) {
    await query('UPDATE jobs SET ai_failure_summary = $2 WHERE id = $1', [jobId, summary]);
    await eventBus.publish('job.ai_summary', { jobId, summary });
  }
}

// ---------------------------------------------------------------------------
// Workflow dependency resolution (bonus feature)
// ---------------------------------------------------------------------------

/**
 * Called after a job completes: finds every job that depends on it, and for
 * each one whose OTHER upstream dependencies (if any) have also all
 * completed, transitions it from WAITING_DEPENDENCY to QUEUED so it becomes
 * eligible for claiming.
 */
async function resolveDependents(completedJobId) {
  const dependents = await query(
    `SELECT dependent_job_id FROM job_dependencies WHERE upstream_job_id = $1`,
    [completedJobId]
  );
  for (const row of dependents.rows) {
    const depId = row.dependent_job_id;
    // eslint-disable-next-line no-await-in-loop
    const upstream = await query(
      `SELECT j.status FROM job_dependencies jd JOIN jobs j ON j.id = jd.upstream_job_id
         WHERE jd.dependent_job_id = $1`,
      [depId]
    );
    const allDone = upstream.rows.every((r) => r.status === 'COMPLETED');
    const anyDead = upstream.rows.some((r) => r.status === 'DEAD' || r.status === 'CANCELLED');
    if (anyDead) {
      // eslint-disable-next-line no-await-in-loop
      await query(`UPDATE jobs SET status = 'CANCELLED', error_msg = 'Upstream dependency failed permanently', updated_at = now() WHERE id = $1 AND status = 'WAITING_DEPENDENCY'`, [depId]);
      // eslint-disable-next-line no-await-in-loop
      await eventBus.publish('job.cancelled', { jobId: depId, reason: 'upstream_dead' });
    } else if (allDone) {
      // eslint-disable-next-line no-await-in-loop
      await query(`UPDATE jobs SET status = 'QUEUED', updated_at = now() WHERE id = $1 AND status = 'WAITING_DEPENDENCY'`, [depId]);
      // eslint-disable-next-line no-await-in-loop
      await eventBus.publish('job.created', { jobId: depId, unblocked: true });
    }
  }
}

module.exports = {
  registerWorker,
  heartbeat,
  deregisterWorker,
  reapDeadWorkers,
  claimJobs,
  markRunning,
  appendLog,
  extendLease,
  completeJob,
  failJob,
  resolveDependents,
};
