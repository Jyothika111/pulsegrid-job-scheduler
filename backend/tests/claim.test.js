/**
 * Integration tests against a real Postgres instance (DATABASE_URL from
 * .env / .env.test). These exercise the exact concurrency-critical path of
 * the system: SELECT ... FOR UPDATE SKIP LOCKED job claiming.
 */
require('dotenv').config();
const { query, pool } = require('../db');
const workerService = require('../src/services/workerService');
const schedulerService = require('../src/services/schedulerService');

let projectId, queueId;

beforeAll(async () => {
  const org = await query(`INSERT INTO organizations (name, slug) VALUES ('t','t-${Date.now()}') RETURNING id`);
  const user = await query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','t') RETURNING id`,
    [`t${Date.now()}@test.com`]
  );
  const proj = await query(
    `INSERT INTO projects (organization_id, owner_id, name) VALUES ($1,$2,'t') RETURNING id`,
    [org.rows[0].id, user.rows[0].id]
  );
  projectId = proj.rows[0].id;
  const q = await query(
    `INSERT INTO queues (project_id, name, concurrency_limit, max_retries) VALUES ($1,'claimtest',2,1) RETURNING id`,
    [projectId]
  );
  queueId = q.rows[0].id;
  await query('INSERT INTO queue_stats (queue_id) VALUES ($1)', [queueId]);
});

afterAll(async () => {
  await pool.end();
});

async function insertJobs(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await query(
      `INSERT INTO jobs (queue_id, type, status, payload, max_retries) VALUES ($1,'IMMEDIATE','QUEUED','{}',1) RETURNING id`,
      [queueId]
    );
    ids.push(res.rows[0].id);
  }
  return ids;
}

test('two workers claiming concurrently never claim the same job', async () => {
  await insertJobs(10);

  const [batchA, batchB] = await Promise.all([
    workerService.claimJobs({ workerId: 'worker-A', queueIds: [queueId], shardIds: [0], limit: 5 }),
    workerService.claimJobs({ workerId: 'worker-B', queueIds: [queueId], shardIds: [0], limit: 5 }),
  ]);

  const idsA = new Set(batchA.map((j) => j.id));
  const idsB = new Set(batchB.map((j) => j.id));
  const overlap = [...idsA].filter((id) => idsB.has(id));

  expect(overlap.length).toBe(0);
  // concurrency_limit = 2, so across BOTH workers at most 2 should have
  // been claimed as CLAIMED in this same tick (rest stay QUEUED).
  expect(batchA.length + batchB.length).toBeLessThanOrEqual(2);
});

test('per-queue concurrency limit is enforced even with many available jobs', async () => {
  await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
  await insertJobs(20);

  const claimed = await workerService.claimJobs({ workerId: 'worker-C', queueIds: [queueId], shardIds: [0], limit: 20 });
  expect(claimed.length).toBe(2); // concurrency_limit set to 2 in beforeAll
});

test('completing a job frees up concurrency headroom for the next claim', async () => {
  await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
  const ids = await insertJobs(5);

  const first = await workerService.claimJobs({ workerId: 'worker-D', queueIds: [queueId], shardIds: [0], limit: 10 });
  expect(first.length).toBe(2);

  await workerService.completeJob(first[0].id, { ok: true });

  const second = await workerService.claimJobs({ workerId: 'worker-D', queueIds: [queueId], shardIds: [0], limit: 10 });
  expect(second.length).toBe(1); // only 1 slot freed up
});

test('expired lease is reclaimed by the maintenance reaper', async () => {
  await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
  const [id] = await insertJobs(1);

  await workerService.claimJobs({ workerId: 'worker-E', queueIds: [queueId], shardIds: [0], limit: 1, leaseMs: 1 });
  // force lease into the past to simulate a crashed worker
  await query(`UPDATE jobs SET visible_at = now() - interval '1 second' WHERE id = $1`, [id]);

  const reclaimed = await schedulerService.reapExpiredLeases();
  expect(reclaimed).toBeGreaterThanOrEqual(1);

  const row = await query('SELECT status, claimed_by FROM jobs WHERE id = $1', [id]);
  expect(row.rows[0].status).toBe('QUEUED');
  expect(row.rows[0].claimed_by).toBeNull();
});

test('stress: many concurrent claimers never exceed the queue concurrency limit', async () => {
  await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
  await insertJobs(30);

  const claimers = Array.from({ length: 8 }, (_, i) =>
    workerService.claimJobs({ workerId: `stress-${i}`, queueIds: [queueId], shardIds: [0], limit: 5 })
  );
  const results = await Promise.all(claimers);
  const totalClaimed = results.reduce((sum, r) => sum + r.length, 0);

  expect(totalClaimed).toBeLessThanOrEqual(2); // concurrency_limit = 2

  const running = await query(
    `SELECT count(*) FROM jobs WHERE queue_id = $1 AND status IN ('CLAIMED','RUNNING')`,
    [queueId]
  );
  expect(parseInt(running.rows[0].count, 10)).toBeLessThanOrEqual(2);
});

test('a job that exhausts max_retries lands in the dead letter queue', async () => {
  await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
  const [id] = await insertJobs(1);

  await workerService.claimJobs({ workerId: 'worker-F', queueIds: [queueId], shardIds: [0], limit: 1 });
  await workerService.failJob(id, 'boom 1'); // attempt 1 of 1 max_retries -> exhausted immediately (queue max_retries=1)

  const row = await query('SELECT status FROM jobs WHERE id = $1', [id]);
  expect(row.rows[0].status).toBe('DEAD');

  const dlq = await query('SELECT * FROM dead_letter_jobs WHERE job_id = $1', [id]);
  expect(dlq.rows.length).toBe(1);
});
