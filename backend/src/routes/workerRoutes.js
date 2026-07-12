const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuthOrApiKey } = require('../middleware/auth');
const schemas = require('../validation/schemas');
const workerService = require('../services/workerService');
const { query } = require('../../db');

router.use(requireAuthOrApiKey);

router.post(
  '/register',
  validate({ body: schemas.worker.register }),
  asyncHandler(async (req, res) => {
    const workerId = await workerService.registerWorker(req.body);
    res.status(201).json({ workerId });
  })
);

router.post(
  '/:id/heartbeat',
  validate({ body: schemas.worker.heartbeat }),
  asyncHandler(async (req, res) => {
    await workerService.heartbeat(req.params.id, req.body);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/deregister',
  asyncHandler(async (req, res) => {
    await workerService.deregisterWorker(req.params.id, { graceful: true });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/claim',
  asyncHandler(async (req, res) => {
    const { queueIds, shardIds, limit, leaseMs } = req.body;
    const jobs = await workerService.claimJobs({
      workerId: req.params.id,
      queueIds,
      shardIds,
      limit: limit || 5,
      leaseMs: leaseMs || 60000,
    });
    res.json(jobs);
  })
);

router.post(
  '/jobs/:jobId/start',
  asyncHandler(async (req, res) => {
    await workerService.markRunning(req.params.jobId);
    res.json({ ok: true });
  })
);

router.post(
  '/jobs/:jobId/log',
  asyncHandler(async (req, res) => {
    await workerService.appendLog(req.params.jobId, req.body.level || 'info', req.body.message);
    res.json({ ok: true });
  })
);

router.post(
  '/jobs/:jobId/extend-lease',
  asyncHandler(async (req, res) => {
    await workerService.extendLease(req.params.jobId, req.body.lockToken, req.body.leaseMs || 60000);
    res.json({ ok: true });
  })
);

router.post(
  '/jobs/:jobId/complete',
  asyncHandler(async (req, res) => {
    await workerService.completeJob(req.params.jobId, req.body.result);
    res.json({ ok: true });
  })
);

router.post(
  '/jobs/:jobId/fail',
  asyncHandler(async (req, res) => {
    await workerService.failJob(req.params.jobId, req.body.error);
    res.json({ ok: true });
  })
);

// Dashboard: list workers with liveness status for a project's queues.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { projectId } = req.query;
    const res2 = await query(
      `SELECT w.*,
              (SELECT count(*) FROM jobs j WHERE j.claimed_by = w.id AND j.status IN ('CLAIMED','RUNNING')) as active_jobs
         FROM workers w
        WHERE $1::text IS NULL OR EXISTS (
          SELECT 1 FROM queues q JOIN projects p ON p.id = q.project_id
           WHERE q.name = ANY(w.queue_names) AND p.id = $1
        )
        ORDER BY w.last_seen_at DESC`,
      [projectId || null]
    );
    res.json(res2.rows);
  })
);

module.exports = router;
