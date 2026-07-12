const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, withTransaction } = require('../../db');
const { ConflictError, UnauthorizedError, NotFoundError } = require('../utils/errors');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') +
    '-' +
    Math.random().toString(36).slice(2, 7)
  );
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Registers a new user AND a new organization owned by them as ADMIN.
 * Wrapped in a transaction: we never want a user row without a home org.
 */
async function register({ email, password, name, orgName }) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) throw new ConflictError('An account with this email already exists');

  const passwordHash = await bcrypt.hash(password, 12);

  return withTransaction(async (client) => {
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email, passwordHash, name]
    );
    const user = userRes.rows[0];

    const orgRes = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug`,
      [orgName || `${name}'s Org`, slugify(orgName || name)]
    );
    const org = orgRes.rows[0];

    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'ADMIN')`,
      [org.id, user.id]
    );

    const token = signToken(user);
    return { user, organization: org, token };
  });
}

async function login({ email, password }) {
  const res = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = res.rows[0];
  if (!user) throw new UnauthorizedError('Invalid email or password');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  const token = signToken(user);
  delete user.password_hash;
  return { user, token };
}

async function getUserById(id) {
  const res = await query('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
  if (!res.rows[0]) throw new NotFoundError('User');
  const orgs = await query(
    `SELECT o.id, o.name, o.slug, om.role
       FROM organizations o JOIN organization_members om ON om.organization_id = o.id
      WHERE om.user_id = $1 ORDER BY om.created_at ASC`,
    [id]
  );
  return { ...res.rows[0], organizations: orgs.rows };
}

/** Returns the caller's role within an organization, or null if not a member. */
async function getMembership(userId, organizationId) {
  const res = await query(
    'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
    [userId, organizationId]
  );
  return res.rows[0]?.role || null;
}

/** Resolves a project's organization id + caller's role for RBAC checks. */
async function getRoleForProject(userId, projectId) {
  const res = await query(
    `SELECT om.role
       FROM projects p
       JOIN organization_members om ON om.organization_id = p.organization_id
      WHERE p.id = $1 AND om.user_id = $2`,
    [projectId, userId]
  );
  return res.rows[0]?.role || null;
}

module.exports = { register, login, getUserById, getMembership, getRoleForProject, verifyToken: (t) => jwt.verify(t, JWT_SECRET) };
