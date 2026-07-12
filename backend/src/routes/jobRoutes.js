const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const schemas = require('../validation/schemas');
const jobService = require('../services/jobService');
const { query } = require('../../db');

router.use(requireAuthOrApiKey);

async function resolveProjectIdFromQueueBody(req) {
  const qid = req.body.queueId || req.query.queueId;
  if (!qid) return null;
  const res = await query('SELECT project_id FROM queues WHERE id = $1', [qid]);
  return res.rows[0]?.project_id;
}

async function resolveProjectIdFromJob(req) {
  const res = await query(
    `SELECT q.project_id FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1`,
    [req.params.id]
  );
  return res.rows[0]?.project_id;
}

router.get(
  '/',
  validate({ query: schemas.job.list }),
  asyncHandler(async (req, res) => {
    res.json(await jobService.listJobs(req.query));
  })
);

router.post(
  '/',
  validate({ body: schemas.job.create }),
  requireRole('DEVELOPER', resolveProjectIdFromQueueBody),
  asyncHandler(async (req, res) => {
    const job = await jobService.createJob(req.body, req.user?.id);
    res.status(201).json(job);
  })
);

router.post(
  '/batch',
  validate({ body: schemas.job.batchCreate }),
  requireRole('DEVELOPER', resolveProjectIdFromQueueBody),
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobService.createBatch(req.body.queueId, req.body.jobs, req.user?.id));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await jobService.getJobDetail(req.params.id));
  })
);

router.post(
  '/:id/retry',
  requireRole('DEVELOPER', resolveProjectIdFromJob),
  asyncHandler(async (req, res) => {
    res.json(await jobService.retryJob(req.params.id));
  })
);

router.post(
  '/:id/cancel',
  requireRole('DEVELOPER', resolveProjectIdFromJob),
  asyncHandler(async (req, res) => {
    res.json(await jobService.cancelJob(req.params.id));
  })
);

router.get(
  '/dlq/:queueId',
  asyncHandler(async (req, res) => {
    res.json(await jobService.listDeadLetter(req.params.queueId, req.query));
  })
);

module.exports = router;
