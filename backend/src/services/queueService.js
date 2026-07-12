const { query } = require('../../db');
const { NotFoundError, ConflictError } = require('../utils/errors');

const COLUMN_MAP = {
  name: 'name',
  priority: 'priority',
  concurrencyLimit: 'concurrency_limit',
  shardCount: 'shard_count',
  retryStrategy: 'retry_strategy',
  maxRetries: 'max_retries',
  baseRetryDelayMs: 'base_retry_delay_ms',
  maxRetryDelayMs: 'max_retry_delay_ms',
  rateLimitMax: 'rate_limit_max',
  rateLimitWindowMs: 'rate_limit_window_ms',
  defaultTimeoutMs: 'default_timeout_ms',
  status: 'status',
};

async function createQueue(input) {
  const existing = await query('SELECT id FROM queues WHERE project_id = $1 AND name = $2', [
    input.projectId,
    input.name,
  ]);
  if (existing.rows[0]) throw new ConflictError(`Queue "${input.name}" already exists in this project`);

  const res = await query(
    `INSERT INTO queues
       (project_id, name, priority, concurrency_limit, shard_count, retry_strategy,
        max_retries, base_retry_delay_ms, max_retry_delay_ms, rate_limit_max,
        rate_limit_window_ms, default_timeout_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.projectId,
      input.name,
      input.priority,
      input.concurrencyLimit,
      input.shardCount,
      input.retryStrategy,
      input.maxRetries,
      input.baseRetryDelayMs,
      input.maxRetryDelayMs,
      input.rateLimitMax,
      input.rateLimitWindowMs,
      input.defaultTimeoutMs,
    ]
  );
  const queue = res.rows[0];
  await query('INSERT INTO queue_stats (queue_id) VALUES ($1)', [queue.id]);
  return queue;
}

async function updateQueue(id, input) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(input)) {
    const col = COLUMN_MAP[key];
    if (!col) continue;
    sets.push(`${col} = $${i++}`);
    values.push(val);
  }
  if (!sets.length) throw new ConflictError('No valid fields to update');
  values.push(id);
  const res = await query(
    `UPDATE queues SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
    values
  );
  if (!res.rows[0]) throw new NotFoundError('Queue');
  return res.rows[0];
}

async function pauseQueue(id) {
  return updateQueue(id, { status: 'PAUSED' });
}

async function resumeQueue(id) {
  return updateQueue(id, { status: 'ACTIVE' });
}

async function getQueue(id) {
  const res = await query(
    `SELECT q.*, s.total_enqueued, s.total_completed, s.total_failed, s.total_retried
       FROM queues q LEFT JOIN queue_stats s ON s.queue_id = q.id
      WHERE q.id = $1`,
    [id]
  );
  if (!res.rows[0]) throw new NotFoundError('Queue');
  return res.rows[0];
}

async function listQueues(projectId, { page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const res = await query(
    `SELECT q.*, s.total_enqueued, s.total_completed, s.total_failed, s.total_retried,
            (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status IN ('QUEUED','SCHEDULED')) AS pending_count,
            (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status = 'RUNNING') AS running_count
       FROM queues q LEFT JOIN queue_stats s ON s.queue_id = q.id
      WHERE q.project_id = $1
      ORDER BY q.priority DESC, q.created_at ASC
      LIMIT $2 OFFSET $3`,
    [projectId, pageSize, offset]
  );
  const countRes = await query('SELECT count(*) FROM queues WHERE project_id = $1', [projectId]);
  return { items: res.rows, total: parseInt(countRes.rows[0].count, 10), page, pageSize };
}

/** Throughput time series for dashboards: completions/failures per minute over the last N minutes. */
async function getThroughput(queueId, minutes = 60) {
  const res = await query(
    `SELECT date_trunc('minute', finished_at) AS bucket,
            count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
            count(*) FILTER (WHERE status = 'FAILED') AS failed
       FROM job_executions je
       JOIN jobs j ON j.id = je.job_id
      WHERE j.queue_id = $1 AND je.finished_at > now() - ($2 || ' minutes')::interval
      GROUP BY bucket ORDER BY bucket ASC`,
    [queueId, minutes]
  );
  return res.rows;
}

module.exports = { createQueue, updateQueue, pauseQueue, resumeQueue, getQueue, listQueues, getThroughput };
