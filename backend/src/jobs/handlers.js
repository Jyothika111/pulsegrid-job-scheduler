/**
 * Job execution handlers. `job.payload.handler` selects which function runs;
 * unknown/omitted handler names fall back to `default`, which just echoes
 * the payload back (useful for load-testing the scheduler itself without
 * needing real side effects).
 *
 * Add your own by exporting a new key here - each handler receives
 * (payload, ctx) where ctx = { jobId, log(message) } and should return a
 * JSON-serializable result or throw to trigger the retry/DLQ pipeline.
 */

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  async default(payload, ctx) {
    ctx.log(`Running default handler with payload: ${JSON.stringify(payload)}`);
    await sleep(200 + Math.random() * 300);
    return { echoed: payload };
  },

  // Simulates an external HTTP call (e.g. webhook delivery).
  async http_request(payload, ctx) {
    ctx.log(`Fetching ${payload.url}`);
    const res = await fetch(payload.url, { method: payload.method || 'GET' });
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`);
    return { status: res.status };
  },

  // Simulates email sending - randomly fails ~20% of the time to
  // demonstrate the retry/backoff/DLQ pipeline end-to-end.
  async send_email(payload, ctx) {
    ctx.log(`Sending email to ${payload.to}`);
    await sleep(150);
    if (Math.random() < 0.2) throw new Error('SMTP timeout: upstream mail server unreachable');
    return { sent: true, to: payload.to };
  },

  // Deliberately-flaky handler for demoing reliability features in the UI.
  async flaky_demo(payload, ctx) {
    ctx.log('Running flaky_demo handler');
    await sleep(300);
    if (Math.random() < (payload.failRate ?? 0.5)) {
      throw new Error('Simulated transient failure');
    }
    return { ok: true };
  },

  // CPU-light data-processing style job.
  async process_report(payload, ctx) {
    ctx.log(`Processing report for ${payload.reportId || 'unknown'}`);
    await sleep(500);
    return { rows: payload.rows || 0, processedAt: new Date().toISOString() };
  },
};
