const { Pool } = require('pg');
const logger = require('../src/utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle Postgres client', { error: err.message });
});

/**
 * Simple tagged query helper. All app code should go through this (or
 * withTransaction) rather than importing `pool` directly, so we have one
 * place to add query logging / slow-query warnings.
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) {
    logger.warn('Slow query', { ms, text: text.slice(0, 120) });
  }
  return res;
}

/**
 * Runs `fn` inside a single client/transaction. `fn` receives a `client`
 * with the same `.query` signature as the pool. Used everywhere we need
 * atomicity - most importantly the job-claim loop (SELECT ... FOR UPDATE
 * SKIP LOCKED + UPDATE must happen in one transaction).
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
