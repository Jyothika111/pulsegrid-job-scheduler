const { query } = require('../../db');
const lockService = require('./lockService');
const workerService = require('./workerService');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

const LOCK_KEY = 'scheduler:maintenance-tick';
const OWNER_ID = `scheduler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Reclaims jobs whose worker lease (`visible_at`) has expired without the
 * job reaching a terminal state - i.e. the worker almost certainly crashed
 * or was killed mid-execution. This is the SQS-style "visibility timeout"
 * safety net: it does NOT require the dead-worker heartbeat check to have
 * fired first, so a job can never be stuck forever even if worker
 * deregistration is itself missed.
 */
async function reapExpiredLeases() {
  const res = await query(
    `UPDATE jobs
        SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, lock_token = NULL, visible_at = NULL, updated_at = now()
      WHERE status IN ('CLAIMED', 'RUNNING') AND visible_at IS NOT NULL AND visible_at < now()
      RETURNING id, queue_id`
  );
  for (const row of res.rows) {
    logger.warn('Reclaimed job with expired lease (likely crashed worker)', { jobId: row.id });
    // eslint-disable-next-line no-await-in-loop
    await eventBus.publish('job.retrying', { jobId: row.id, reason: 'lease_expired' });
  }
  return res.rows.length;
}

/**
 * Runs one maintenance tick. Guarded by a distributed lock (bonus feature)
 * so that if the API is horizontally scaled to multiple instances, only
 * one of them actually performs the reap work per tick - duplicate reaping
 * is harmless but wasteful, so this keeps it clean rather than relying on
 * idempotency alone.
 */
async function tick() {
  const acquired = await lockService.acquireLock(LOCK_KEY, OWNER_ID, 15000);
  if (!acquired) return; // another instance is handling this tick
  try {
    const leases = await reapExpiredLeases();
    const deadWorkers = await workerService.reapDeadWorkers(30000);
    if (leases || deadWorkers) {
      logger.info('Maintenance tick', { reclaimedLeases: leases, reapedWorkers: deadWorkers });
    }
  } catch (err) {
    logger.error('Maintenance tick failed', { error: err.message });
  } finally {
    await lockService.releaseLock(LOCK_KEY, OWNER_ID);
  }
}

let intervalHandle = null;
function start(intervalMs = 5000) {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => tick().catch((e) => logger.error(e.message)), intervalMs);
  logger.info('Scheduler maintenance loop started', { intervalMs });
}
function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, tick, reapExpiredLeases };
