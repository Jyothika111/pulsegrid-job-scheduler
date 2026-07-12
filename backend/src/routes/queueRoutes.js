const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const schemas = require('../validation/schemas');
const queueService = require('../services/queueService');
const { query } = require('../../db');

router.use(requireAuthOrApiKey);

// Resolves the owning project for a route keyed by /:id (a queue id), so
// RBAC can check the caller's role in that project.
async function resolveProjectIdFromQueue(req) {
  const res = await query('SELECT project_id FROM queues WHERE id = $1', [req.params.id]);
  return res.rows[0]?.project_id;
}

router.get(
  '/',
  validate({ query: schemas.queue.list }),
  asyncHandler(async (req, res) => {
    res.json(await queueService.listQueues(req.query.projectId, req.query));
  })
);

router.post(
  '/',
  validate({ body: schemas.queue.create }),
  requireRole('MAINTAINER'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await queueService.createQueue(req.body));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await queueService.getQueue(req.params.id));
  })
);

router.patch(
  '/:id',
  validate({ body: schemas.queue.update }),
  requireRole('MAINTAINER', resolveProjectIdFromQueue),
  asyncHandler(async (req, res) => {
    res.json(await queueService.updateQueue(req.params.id, req.body));
  })
);

router.post(
  '/:id/pause',
  requireRole('MAINTAINER', resolveProjectIdFromQueue),
  asyncHandler(async (req, res) => {
    res.json(await queueService.pauseQueue(req.params.id));
  })
);

router.post(
  '/:id/resume',
  requireRole('MAINTAINER', resolveProjectIdFromQueue),
  asyncHandler(async (req, res) => {
    res.json(await queueService.resumeQueue(req.params.id));
  })
);

router.get(
  '/:id/throughput',
  asyncHandler(async (req, res) => {
    const minutes = parseInt(req.query.minutes, 10) || 60;
    res.json(await queueService.getThroughput(req.params.id, minutes));
  })
);

module.exports = router;
