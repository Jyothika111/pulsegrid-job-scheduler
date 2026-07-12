const { query } = require('../../db');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

async function createProject({ organizationId, name, description, ownerId }) {
  const res = await query(
    `INSERT INTO projects (organization_id, owner_id, name, description)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [organizationId, ownerId, name, description || null]
  );
  return res.rows[0];
}

async function listProjectsForUser(userId) {
  const res = await query(
    `SELECT p.*, om.role as caller_role
       FROM projects p
       JOIN organization_members om ON om.organization_id = p.organization_id
      WHERE om.user_id = $1
      ORDER BY p.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function getProject(id, userId) {
  const res = await query(
    `SELECT p.*, om.role as caller_role
       FROM projects p
       JOIN organization_members om ON om.organization_id = p.organization_id
      WHERE p.id = $1 AND om.user_id = $2`,
    [id, userId]
  );
  if (!res.rows[0]) throw new NotFoundError('Project');
  return res.rows[0];
}

async function rotateApiKey(id) {
  const res = await query(
    `UPDATE projects SET api_key = encode(gen_random_bytes(24), 'hex'), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!res.rows[0]) throw new NotFoundError('Project');
  return res.rows[0];
}

module.exports = { createProject, listProjectsForUser, getProject, rotateApiKey };
