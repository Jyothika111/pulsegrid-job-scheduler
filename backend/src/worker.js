/**
 * Distributed worker process. Intentionally talks to the API over plain
 * HTTP (not a direct DB import) so that:
 *   (a) workers can be deployed on different hosts/containers than the API
 *   (b) a worker could be reimplemented in any language against the same
 *       REST contract - this is the actual distribution boundary of the
 *       system, not just a code-organization convenience.
 *
 * Run multiple instances of this process (see docker-compose.yml, scaled
 * via `docker compose up --scale worker=4`) to see concurrent, non-
 * duplicate job execution across independent processes.
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const logger = require('./utils/logger');
const handlers = require('./jobs/handlers');

const API_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.PROJECT_API_KEY; // identifies which project's queues this worker serves
const QUEUE_NAMES = (process.env.WORKER_QUEUES || 'default').split(',').map((s) => s.trim());
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '1000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '5000', 10);
const LEASE_MS = parseInt(process.env.WORKER_LEASE_MS || '60000', 10);

if (!API_KEY) {
  logger.error('PROJECT_API_KEY is required to run a worker. Set it to a project\'s api_key.');
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${path} -> ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

class Worker {
  constructor() {
    this.id = null;
    this.inFlight = new Map(); // jobId -> Promise
    this.draining = false;
    this.queueIds = [];
  }

  async start() {
    const { workerId } = await api('/api/workers/register', {
      method: 'POST',
      body: JSON.stringify({
        hostname: os.hostname(),
        pid: process.pid,
        queueNames: QUEUE_NAMES,
        shardIds: [0],
        concurrency: CONCURRENCY,
      }),
    });
    this.id = workerId;
    logger.info('Worker registered', { id: this.id, queues: QUEUE_NAMES, concurrency: CONCURRENCY });

    // Resolve queue names -> ids once at startup (queues rarely change identity).
    const queues = await api(`/api/queues?projectId=${await this.projectId()}&pageSize=100`);
    this.queueIds = queues.items.filter((q) => QUEUE_NAMES.includes(q.name)).map((q) => q.id);
    if (!this.queueIds.length) {
      logger.warn('No matching queues found for this worker\'s queueNames - polling will find nothing', { QUEUE_NAMES });
    }

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.pollAndClaim(), POLL_INTERVAL_MS);
    this.pollAndClaim();

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async projectId() {
    if (this._projectId) return this._projectId;
    // The dashboard "me" endpoint doesn't resolve project from api key, so
    // instead we ask queues without a filter is not supported; simplest
    // robust approach: decode via a lightweight endpoint isn't exposed, so
    // we fetch queues unfiltered is disallowed too. We piggyback on the
    // fact the API key IS the project's key - the queue list route accepts
    // any projectId query but authorizes via api key at the queue-service
    // layer being project-scoped implicitly isn't enforced server-side for
    // API-key callers by design (trusted service credential). We resolve
    // the true id via a dedicated call:
    const me = await api('/api/projects/whoami').catch(() => null);
    this._projectId = me ? me.id : null;
    return this._projectId;
  }

  async heartbeat() {
    try {
      await api(`/api/workers/${this.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ jobsInFlight: this.inFlight.size }),
      });
    } catch (err) {
      logger.warn('Heartbeat failed', { error: err.message });
    }
  }

  async pollAndClaim() {
    if (this.draining) return;
    const capacity = CONCURRENCY - this.inFlight.size;
    if (capacity <= 0 || !this.queueIds.length) return;

    try {
      const jobs = await api(`/api/workers/${this.id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ queueIds: this.queueIds, shardIds: [0], limit: capacity, leaseMs: LEASE_MS }),
      });
      for (const job of jobs) this.execute(job);
    } catch (err) {
      logger.warn('Claim poll failed', { error: err.message });
    }
  }

  async execute(job) {
    this.inFlight.set(job.id, true);
    const leaseRenewer = setInterval(() => {
      api(`/api/jobs/${job.id}/extend-lease`, {
        method: 'POST',
        body: JSON.stringify({ lockToken: job.lock_token, leaseMs: LEASE_MS }),
      }).catch(() => {});
    }, Math.floor(LEASE_MS * 0.6));

    try {
      await api(`/api/workers/jobs/${job.id}/start`, { method: 'POST' });
      logger.info('Executing job', { jobId: job.id, queueId: job.queue_id, attempt: job.attempt });

      const handlerName = job.payload?.handler || 'default';
      const handler = handlers[handlerName] || handlers.default;

      const timeoutMs = job.timeout_ms || 30000;
      const result = await Promise.race([
        handler(job.payload, { jobId: job.id, log: (msg) => this.log(job.id, msg) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);

      await api(`/api/workers/jobs/${job.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ result: result ?? null }),
      });
      logger.info('Job completed', { jobId: job.id });
    } catch (err) {
      logger.error('Job failed', { jobId: job.id, error: err.message });
      await api(`/api/workers/jobs/${job.id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: err.message }),
      }).catch((e) => logger.error('Failed to report job failure', { error: e.message }));
    } finally {
      clearInterval(leaseRenewer);
      this.inFlight.delete(job.id);
    }
  }

  async log(jobId, message) {
    await api(`/api/workers/jobs/${jobId}/log`, {
      method: 'POST',
      body: JSON.stringify({ level: 'info', message }),
    }).catch(() => {});
  }

  async shutdown() {
    if (this.draining) return;
    this.draining = true;
    logger.info('Graceful shutdown initiated - draining in-flight jobs', { inFlight: this.inFlight.size });
    clearInterval(this.pollTimer);

    const deadline = Date.now() + 30000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
    }
    clearInterval(this.heartbeatTimer);
    await api(`/api/workers/${this.id}/deregister`, { method: 'POST' }).catch(() => {});
    logger.info('Worker deregistered, exiting', { remainingInFlight: this.inFlight.size });
    process.exit(0);
  }
}

const worker = new Worker();
worker.start().catch((err) => {
  logger.error('Worker failed to start', { error: err.message });
  process.exit(1);
});
