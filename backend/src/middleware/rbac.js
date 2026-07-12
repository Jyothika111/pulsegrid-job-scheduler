const { ForbiddenError } = require('../utils/errors');
const authService = require('../services/authService');

// Role hierarchy: each role includes the permissions of roles below it.
const RANK = { VIEWER: 0, DEVELOPER: 1, MAINTAINER: 2, ADMIN: 3 };

/**
 * Express middleware factory: requireRole('MAINTAINER') lets ADMIN and
 * MAINTAINER through, blocks DEVELOPER/VIEWER. Resolves the caller's role
 * from the project referenced by :projectId (route param) or the project
 * body/query, falling back to the queue's project if only queueId is known.
 */
function requireRole(minRole, resolveProjectId) {
  return async (req, res, next) => {
    try {
      // Project API-key callers (workers/services) act with MAINTAINER-
      // equivalent trust for their own project - they authenticated with a
      // project secret, not a user identity.
      if (req.project) return next();

      const projectId = resolveProjectId
        ? await resolveProjectId(req)
        : req.params.projectId || req.body.projectId || req.query.projectId;
      if (!projectId) return next(new ForbiddenError('Project context required for this action'));

      const role = await authService.getRoleForProject(req.user.id, projectId);
      if (!role) return next(new ForbiddenError('You are not a member of this project'));
      if (RANK[role] < RANK[minRole]) {
        return next(new ForbiddenError(`Requires ${minRole} role or higher (you have ${role})`));
      }
      req.role = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireRole, RANK };
