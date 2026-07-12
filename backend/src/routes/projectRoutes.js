const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth, requireApiKey } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const schemas = require('../validation/schemas');
const projectService = require('../services/projectService');

// API-key callers (workers) resolve which project they belong to. Must be
// registered before requireAuth is applied to the rest of this router.
router.get(
  '/whoami',
  requireApiKey,
  asyncHandler(async (req, res) => {
    res.json(req.project);
  })
);

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await projectService.listProjectsForUser(req.user.id));
  })
);

router.post(
  '/',
  validate({ body: schemas.project.create }),
  asyncHandler(async (req, res) => {
    const project = await projectService.createProject({ ...req.body, ownerId: req.user.id });
    res.status(201).json(project);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await projectService.getProject(req.params.id, req.user.id));
  })
);

router.post(
  '/:id/rotate-key',
  (req, res, next) => {
    req.body.projectId = req.params.id;
    next();
  },
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await projectService.rotateApiKey(req.params.id));
  })
);

module.exports = router;
