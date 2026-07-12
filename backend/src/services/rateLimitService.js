const Redis = require('ioredis');
const logger = require('../utils/logger');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
redis.on('error', (err) => logger.warn('Redis error (rate limiter)', { error: err.message }));

let connected = false;
async function ensureConnected() {
  if (!connected) {
    try {
      await redis.connect();
      connected = true;
    } catch (err) {
      // Fail open: if Redis is down we don't want to block all job
      // execution - queue-level rate limiting degrades gracefully to "off".
      logger.warn('Rate limiter Redis unavailable, failing open', { error: err.message });
    }
  }
}

// Lua script: fixed-window counter, atomic INCR + EXPIRE-if-new-key.
// A sliding/token-bucket algorithm is more accurate but a fixed window
// counter is sufficient here and is a single round trip.
const SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if tonumber(current) == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

/**
 * Returns true if a job start for `queueId` is allowed right now under its
 * configured rate limit, false if the limit for the current window has been
 * hit (caller should leave the job QUEUED and try again next poll).
 */
async function allowJobStart(queueId, max, windowMs) {
  if (!max) return true; // unlimited
  await ensureConnected();
  if (!connected) return true; // fail open

  const key = `ratelimit:queue:${queueId}:${Math.floor(Date.now() / windowMs)}`;
  try {
    const count = await redis.eval(SCRIPT, 1, key, windowMs);
    return count <= max;
  } catch (err) {
    logger.warn('Rate limit check failed, failing open', { error: err.message });
    return true;
  }
}

module.exports = { allowJobStart, redis };
