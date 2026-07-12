/**
 * Computes the delay (ms) before retry attempt `attempt` (1-indexed: this is
 * the Nth retry, i.e. the (N+1)th total execution attempt).
 *
 *  FIXED:       baseDelay
 *  LINEAR:      baseDelay * attempt
 *  EXPONENTIAL: baseDelay * 2^(attempt-1), with +/-20% full jitter to avoid
 *               thundering-herd retries all landing in the same instant
 *  NONE:        no retry (caller should treat this as "go straight to DLQ")
 */
function computeRetryDelayMs(strategy, attempt, baseDelayMs, maxDelayMs) {
  let delay;
  switch (strategy) {
    case 'FIXED':
      delay = baseDelayMs;
      break;
    case 'LINEAR':
      delay = baseDelayMs * attempt;
      break;
    case 'EXPONENTIAL': {
      const raw = baseDelayMs * Math.pow(2, attempt - 1);
      const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8x - 1.2x
      delay = raw * jitterFactor;
      break;
    }
    case 'NONE':
    default:
      return null;
  }
  return Math.min(Math.round(delay), maxDelayMs);
}

module.exports = { computeRetryDelayMs };
