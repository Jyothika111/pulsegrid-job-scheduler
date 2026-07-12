const parser = require('cron-parser');
const { query, withTransaction } = require('../../db');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/errors');
const eventBus = require('./eventBus');

async function getQueueOrThrow(client, queueId) {
  const res = await client.query('SELECT * FROM queues WHERE id = $1', [queueId]);
  if (!res.rows[0]) throw new NotFoundError('Queue');
  return res.rows[0];
}

function computeNextCronRun(cronExpr, tz) {
  try {
    const interval = parser.parseExpression(cronExpr, { tz: tz || 'UTC' });
    return interval.next().toDate();
  } catch (err) {
    throw new ValidationError([{ field: 'cronExpr', message: `Invalid cron expression: ${err.message}` }]);
  }
}

/**
 * Creates a single job. Handles all 5 job types plus:
 *  - idempotency: if idempotencyKey matches an existing non-terminal-failed
 *    job on the same queue, returns that job instead of creating a duplicate
 *  - workflow dependencies (bonus): if dependsOn is given, the job starts
 *    in WAITING_DEPENDENCY and only becomes QUEUED once every upstream job
 *    completes (see resolveDependents in workerService.js)
 */
async function createJob(input, createdById) {
  return withTransaction(async (client) => {
    const queue = await getQueueOrThrow(client, input.queueId);

    if (input.idempotencyKey) {
      const dup = await client.query(
        `SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2
           AND status NOT IN ('DEAD','CANCELLED') ORDER BY created_at DESC LIMIT 1`,
        [input.queueId, input.idempotencyKey]
      );
      if (dup.rows[0]) return dup.rows[0];
    }

    let status = 'QUEUED';
    let runAt = null;
    let nextRunAt = null;
    let cronExpr = null;

    if (input.type === 'DELAYED') {
      runAt = input.runAt ? new Date(input.runAt) : new Date(Date.now() + (input.delayMs || 0));
      status = 'SCHEDULED';
    } else if (input.type === 'SCHEDULED') {
      runAt = new Date(input.runAt);
      status = 'SCHEDULED';
    } else if (input.type === 'RECURRING') {
      cronExpr = input.cronExpr;
      nextRunAt = computeNextCronRun(cronExpr, input.cronTimezone);
      runAt = nextRunAt;
      status = 'SCHEDULED';
    }

    const hasDeps = Array.isArray(input.dependsOn) && input.dependsOn.length > 0;
    if (hasDeps) status = 'WAITING_DEPENDENCY';

    const res = await client.query(
      `INSERT INTO jobs
         (queue_id, created_by_id, type, status, priority, payload, run_at, cron_expr,
          cron_timezone, next_run_at, max_retries, retry_strategy, timeout_ms, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.queueId,
        createdById || null,
        input.type,
        status,
        input.priority ?? 0,
        input.payload || {},
        runAt,
        cronExpr,
        input.cronTimezone || 'UTC',
        nextRunAt,
        input.maxRetries ?? queue.max_retries,
        input.retryStrategy || queue.retry_strategy,
        input.timeoutMs ?? queue.default_timeout_ms,
        input.idempotencyKey || null,
      ]
    );
    const job = res.rows[0];

    if (hasDeps) {
      for (const upstreamId of input.dependsOn) {
        await client.query(
          `INSERT INTO job_dependencies (upstream_job_id, dependent_job_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [upstreamId, job.id]
        );
      }
    }

    await client.query(
      'UPDATE queue_stats SET total_enqueued = total_enqueued + 1, updated_at = now() WHERE queue_id = $1',
      [input.queueId]
    );

    await eventBus.publish('job.created', { jobId: job.id, queueId: job.queue_id, status: job.status });
    return job;
  });
}

/** Bonus: batch job creation - many jobs sharing one batch_id, created in one round trip. */
async function createBatch(queueId, jobs, createdById) {
  return withTransaction(async (client) => {
    const queue = await getQueueOrThrow(client, queueId);
    const batchRes = await client.query('SELECT gen_random_uuid() as id');
    const batchId = batchRes.rows[0].id;

    const created = [];
    for (const j of jobs) {
      const res = await client.query(
        `INSERT INTO jobs (queue_id, created_by_id, batch_id, type, status, priority, payload, max_retries, retry_strategy, timeout_ms)
         VALUES ($1,$2,$3,'BATCH','QUEUED',$4,$5,$6,$7,$8) RETURNING *`,
        [queueId, createdById || null, batchId, j.priority ?? 0, j.payload || {}, queue.max_retries, queue.retry_strategy, queue.default_timeout_ms]
      );
      created.push(res.rows[0]);
    }
    await client.query(
      'UPDATE queue_stats SET total_enqueued = total_enqueued + $2, updated_at = now() WHERE queue_id = $1',
      [queueId, created.length]
    );
    await eventBus.publish('job.batch_created', { queueId, batchId, count: created.length });
    return { batchId, jobs: created };
  });
}

async function getJob(id) {
  const res = await query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!res.rows[0]) throw new NotFoundError('Job');
  return res.rows[0];
}

async function listJobs({ queueId, projectId, status, type, page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize;
  const conditions = [];
  const values = [];
  let i = 1;

  let fromClause = 'jobs j';
  if (projectId && !queueId) {
    fromClause = 'jobs j JOIN queues q ON q.id = j.queue_id';
    conditions.push(`q.project_id = $${i++}`);
    values.push(projectId);
  }
  if (queueId) {
    conditions.push(`j.queue_id = $${i++}`);
    values.push(queueId);
  }
  if (status) {
    conditions.push(`j.status = $${i++}`);
    values.push(status);
  }
  if (type) {
    conditions.push(`j.type = $${i++}`);
    values.push(type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await query(
    `SELECT j.* FROM ${fromClause} ${where} ORDER BY j.created_at DESC LIMIT $${i++} OFFSET $${i}`,
    [...values, pageSize, offset]
  );
  const countRes = await query(`SELECT count(*) FROM ${fromClause} ${where}`, values);
  return { items: res.rows, total: parseInt(countRes.rows[0].count, 10), page, pageSize };
}

async function getJobDetail(id) {
  const job = await getJob(id);
  const executions = await query(
    'SELECT * FROM job_executions WHERE job_id = $1 ORDER BY attempt ASC',
    [id]
  );
  const logs = await query('SELECT * FROM job_logs WHERE job_id = $1 ORDER BY created_at ASC LIMIT 500', [id]);
  const deps = await query(
    `SELECT jd.upstream_job_id, j.status FROM job_dependencies jd
       JOIN jobs j ON j.id = jd.upstream_job_id WHERE jd.dependent_job_id = $1`,
    [id]
  );
  return { ...job, executions: executions.rows, logs: logs.rows, dependsOn: deps.rows };
}

/** Manually retries a DEAD (or FAILED) job by resetting it back to QUEUED. */
async function retryJob(id) {
  const res = await query(
    `UPDATE jobs SET status = 'QUEUED', attempt = 0, claimed_by = NULL, claimed_at = NULL,
            lock_token = NULL, visible_at = NULL, error_msg = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('DEAD', 'FAILED', 'CANCELLED') RETURNING *`,
    [id]
  );
  if (!res.rows[0]) throw new ConflictError('Only DEAD, FAILED, or CANCELLED jobs can be manually retried');
  await query('UPDATE dead_letter_jobs SET reprocessed = true WHERE job_id = $1', [id]);
  await eventBus.publish('job.retrying', { jobId: id, manual: true });
  return res.rows[0];
}

async function cancelJob(id) {
  const res = await query(
    `UPDATE jobs SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND status IN ('QUEUED','SCHEDULED','WAITING_DEPENDENCY') RETURNING *`,
    [id]
  );
  if (!res.rows[0]) throw new ConflictError('Only pending jobs can be cancelled');
  await eventBus.publish('job.cancelled', { jobId: id });
  return res.rows[0];
}

async function listDeadLetter(queueId, { page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const res = await query(
    `SELECT * FROM dead_letter_jobs WHERE queue_id = $1 ORDER BY moved_at DESC LIMIT $2 OFFSET $3`,
    [queueId, pageSize, offset]
  );
  const countRes = await query('SELECT count(*) FROM dead_letter_jobs WHERE queue_id = $1', [queueId]);
  return { items: res.rows, total: parseInt(countRes.rows[0].count, 10), page, pageSize };
}

module.exports = {
  createJob,
  createBatch,
  getJob,
  getJobDetail,
  listJobs,
  retryJob,
  cancelJob,
  listDeadLetter,
  computeNextCronRun,
};
