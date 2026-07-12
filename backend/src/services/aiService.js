const logger = require('../utils/logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

/**
 * Generates a short, plain-English summary of why a job failed, from its
 * error message + recent log lines. Best-effort: if no API key is
 * configured, or the call fails, we degrade to a canned message rather
 * than blocking the retry/DLQ pipeline on an external API.
 */
async function summarizeFailure({ jobId, queueName, error, logs = [], attempt, maxRetries }) {
  if (!ANTHROPIC_API_KEY) {
    return null; // feature disabled - caller should just skip storing a summary
  }

  const logExcerpt = logs.slice(-10).map((l) => `[${l.level}] ${l.message}`).join('\n');
  const prompt = `A background job failed in a distributed job scheduler. Give a concise (2-3 sentence) plain-English explanation of the likely cause and one suggested next step for the on-call engineer. Do not repeat the raw stack trace verbatim.

Queue: ${queueName}
Job: ${jobId}
Attempt: ${attempt} of ${maxRetries}
Error message: ${error || 'unknown'}
Recent logs:
${logExcerpt || '(none)'}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      logger.warn('AI failure summary request failed', { status: res.status });
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
    return text || null;
  } catch (err) {
    logger.warn('AI failure summary generation error', { error: err.message });
    return null;
  }
}

module.exports = { summarizeFailure };
