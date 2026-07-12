const { query } = require('../../db');

/**
 * Distributed lock backed by a single Postgres row + a UNIQUE/PRIMARY KEY
 * constraint on `key`. This gives us mutual exclusion across every worker
 * process/host without a separate lock service - Postgres's own MVCC +
 * unique constraint is the source of truth.
 *
 * Usage pattern: acquire -> do bounded work -> release, always with a TTL
 * so a crashed holder doesn't wedge the lock forever (expired locks are
 * simply reusable by the next acquire attempt via ON CONFLICT).
 */

/**
 * Attempts to acquire `key` for `ownerId` for `ttlMs` milliseconds.
 * Returns true if acquired (either the key was free, or its previous lease
 * had expired), false if someone else currently holds a live lease.
 */
async function acquireLock(key, ownerId, ttlMs = 10000) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const res = await query(
    `INSERT INTO distributed_locks (key, owner_id, acquired_at, expires_at)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, acquired_at = now(), expires_at = EXCLUDED.expires_at
       WHERE distributed_locks.expires_at < now()
     RETURNING key`,
    [key, ownerId, expiresAt]
  );
  return res.rows.length > 0;
}

/** Extends the TTL of a lock this owner currently holds. */
async function renewLock(key, ownerId, ttlMs = 10000) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const res = await query(
    `UPDATE distributed_locks SET expires_at = $3
      WHERE key = $1 AND owner_id = $2 RETURNING key`,
    [key, ownerId, expiresAt]
  );
  return res.rows.length > 0;
}

/** Releases a lock, but only if still owned by `ownerId` (safe under races). */
async function releaseLock(key, ownerId) {
  await query('DELETE FROM distributed_locks WHERE key = $1 AND owner_id = $2', [key, ownerId]);
}

module.exports = { acquireLock, renewLock, releaseLock };
