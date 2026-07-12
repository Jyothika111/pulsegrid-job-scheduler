const { UnauthorizedError } = require('../utils/errors');
const authService = require('../services/authService');
const { query } = require('../../db');

/** Requires a valid `Authorization: Bearer <jwt>` header (human/dashboard users). */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new UnauthorizedError('Missing or malformed Authorization header'));
  }
  try {
    const payload = authService.verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

/**
 * Requires a valid `X-Api-Key` header matching a project's api_key. Used by
 * services/scripts submitting jobs programmatically without a human login.
 * Attaches req.project.
 */
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return next(new UnauthorizedError('Missing X-Api-Key header'));
  try {
    const res2 = await query('SELECT * FROM projects WHERE api_key = $1', [key]);
    if (!res2.rows[0]) return next(new UnauthorizedError('Invalid API key'));
    req.project = res2.rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/** Accepts EITHER a JWT (dashboard user) OR a project API key (service/worker). */
async function requireAuthOrApiKey(req, res, next) {
  if (req.headers['x-api-key']) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

module.exports = { requireAuth, requireApiKey, requireAuthOrApiKey };
