const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../../db');

router.use(requireAuth);

// High-level system health summary for the dashboard landing page.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'projectId required' } });

    const [queues, jobsByStatus, workers, dlq] = await Promise.all([
      query(
        `SELECT count(*)::int as total,
                count(*) FILTER (WHERE status = 'ACTIVE')::int as active,
                count(*) FILTER (WHERE status = 'PAUSED')::int as paused
           FROM queues WHERE project_id = $1`,
        [projectId]
      ),
      query(
        `SELECT j.status, count(*)::int as count
           FROM jobs j JOIN queues q ON q.id = j.queue_id
          WHERE q.project_id = $1
          GROUP BY j.status`,
        [projectId]
      ),
      query(
        `SELECT count(*)::int as total, count(*) FILTER (WHERE status = 'ONLINE')::int as online
           FROM workers w
          WHERE EXISTS (SELECT 1 FROM queues q WHERE q.project_id = $1 AND q.name = ANY(w.queue_names))`,
        [projectId]
      ),
      query(
        `SELECT count(*)::int as total FROM dead_letter_jobs d
           JOIN queues q ON q.id = d.queue_id WHERE q.project_id = $1 AND d.reprocessed = false`,
        [projectId]
      ),
    ]);

    res.json({
      queues: queues.rows[0],
      jobsByStatus: Object.fromEntries(jobsByStatus.rows.map((r) => [r.status, r.count])),
      workers: workers.rows[0],
      deadLetterCount: dlq.rows[0].total,
    });
  })
);

module.exports = router;
