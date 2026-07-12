import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { timeAgo } from '../lib/status';

const STATUSES = ['', 'QUEUED', 'SCHEDULED', 'WAITING_DEPENDENCY', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED'];
const HANDLERS = ['default', 'flaky_demo', 'send_email', 'process_report', 'http_request'];

export default function Jobs() {
  const { currentProject } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [queueId, setQueueId] = useState('');
  const [queues, setQueues] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ queueId: '', type: 'IMMEDIATE', handler: 'default', payload: '{}', delayMs: 5000, cronExpr: '*/5 * * * *' });
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    if (!currentProject) return;
    const params = new URLSearchParams({ projectId: currentProject.id, page, pageSize: 20 });
    if (status) params.set('status', status);
    if (queueId) params.set('queueId', queueId);
    const res = await api.get(`/api/jobs?${params}`);
    setJobs(res.items);
    setTotal(res.total);
  }, [currentProject, page, status, queueId]);

  useEffect(() => {
    if (currentProject) api.get(`/api/queues?projectId=${currentProject.id}&pageSize=100`).then((r) => {
      setQueues(r.items);
      if (r.items[0]) setForm((f) => ({ ...f, queueId: f.queueId || r.items[0].id }));
    });
  }, [currentProject]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function openJob(id) {
    const detail = await api.get(`/api/jobs/${id}`);
    setSelected(detail);
  }

  async function retry(id) {
    await api.post(`/api/jobs/${id}/retry`);
    load();
    if (selected?.id === id) openJob(id);
  }

  async function cancel(id) {
    await api.post(`/api/jobs/${id}/cancel`);
    load();
    if (selected?.id === id) openJob(id);
  }

  async function createJob(e) {
    e.preventDefault();
    setFormError('');
    let payload;
    try {
      payload = JSON.parse(form.payload || '{}');
    } catch {
      setFormError('Payload must be valid JSON');
      return;
    }
    payload.handler = form.handler;

    const body = { queueId: form.queueId, type: form.type, payload };
    if (form.type === 'DELAYED') body.delayMs = Number(form.delayMs);
    if (form.type === 'SCHEDULED') body.runAt = new Date(Date.now() + Number(form.delayMs)).toISOString();
    if (form.type === 'RECURRING') body.cronExpr = form.cronExpr;

    try {
      await api.post('/api/jobs', body);
      setShowForm(false);
      load();
    } catch (err) {
      setFormError(err.details ? err.details.map((d) => d.message).join(', ') : err.message);
    }
  }

  if (!currentProject) return null;
  const pageCount = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Job explorer</h1>
          <p className="text-sm text-[var(--color-muted)]">{total} jobs matching current filters</p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-[var(--color-signal-running)] px-4 py-2 text-sm font-semibold text-[#05221d]"
        >
          {showForm ? 'Cancel' : '+ New job'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={createJob} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Queue</span>
              <select className="in" value={form.queueId} onChange={(e) => setForm({ ...form, queueId: e.target.value })}>
                {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Type</span>
              <select className="in" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option>IMMEDIATE</option>
                <option>DELAYED</option>
                <option>SCHEDULED</option>
                <option>RECURRING</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Handler</span>
              <select className="in" value={form.handler} onChange={(e) => setForm({ ...form, handler: e.target.value })}>
                {HANDLERS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            {(form.type === 'DELAYED' || form.type === 'SCHEDULED') && (
              <label className="block">
                <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Delay (ms)</span>
                <input type="number" min={0} className="in" value={form.delayMs} onChange={(e) => setForm({ ...form, delayMs: e.target.value })} />
              </label>
            )}
            {form.type === 'RECURRING' && (
              <label className="block">
                <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Cron expression</span>
                <input className="in font-data" value={form.cronExpr} onChange={(e) => setForm({ ...form, cronExpr: e.target.value })} />
              </label>
            )}
          </div>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">Payload (JSON)</span>
            <textarea
              className="in font-data"
              rows={3}
              value={form.payload}
              onChange={(e) => setForm({ ...form, payload: e.target.value })}
              placeholder='{"failRate": 0.3}'
            />
          </label>
          {formError && <div className="mt-3 text-xs text-[var(--color-signal-danger)]">{formError}</div>}
          <button type="submit" className="mt-4 rounded-md bg-[var(--color-signal-running)] px-4 py-2 text-sm font-semibold text-[#05221d]">
            Create job
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-3">
        <select value={queueId} onChange={(e) => { setQueueId(e.target.value); setPage(1); }} className="in max-w-xs">
          <option value="">All queues</option>
          {queues.map((q) => (
            <option key={q.id} value={q.id}>{q.name}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="in max-w-xs">
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface)] text-left text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempt</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr
                key={j.id}
                onClick={() => openJob(j.id)}
                className="cursor-pointer border-b border-[var(--color-border-soft)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
              >
                <td className="px-4 py-3 font-data text-xs">{j.id.slice(0, 8)}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-muted)]">{j.type}</td>
                <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                <td className="px-4 py-3 font-data">{j.attempt}/{j.max_retries}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-muted)]">{timeAgo(j.created_at)}</td>
                <td className="px-4 py-3 text-right">
                  {(j.status === 'DEAD' || j.status === 'FAILED' || j.status === 'CANCELLED') && (
                    <button onClick={(e) => { e.stopPropagation(); retry(j.id); }} className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs hover:border-[var(--color-signal-running)]/50 hover:text-[var(--color-signal-running)]">
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--color-muted-2)]">No jobs match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
        <span>Page {page} of {pageCount}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-[var(--color-border)] px-3 py-1 disabled:opacity-30">Prev</button>
          <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-[var(--color-border)] px-3 py-1 disabled:opacity-30">Next</button>
        </div>
      </div>

      {selected && (
        <JobDrawer job={selected} onClose={() => setSelected(null)} onRetry={retry} onCancel={cancel} />
      )}
    </div>
  );
}

function JobDrawer({ job, onClose, onRetry, onCancel }) {
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-lg overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="font-data text-xs text-[var(--color-muted)]">{job.id}</div>
            <div className="mt-1 flex items-center gap-2">
              <StatusBadge status={job.status} />
              <span className="text-xs text-[var(--color-muted)]">{job.type}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>

        <div className="mb-4 flex gap-2">
          {(job.status === 'DEAD' || job.status === 'FAILED' || job.status === 'CANCELLED') && (
            <button onClick={() => onRetry(job.id)} className="rounded-md bg-[var(--color-signal-running)] px-3 py-1.5 text-xs font-semibold text-[#05221d]">Retry job</button>
          )}
          {['QUEUED', 'SCHEDULED', 'WAITING_DEPENDENCY'].includes(job.status) && (
            <button onClick={() => onCancel(job.id)} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-signal-danger)]/50 hover:text-[var(--color-signal-danger)]">Cancel job</button>
          )}
        </div>

        <Section title="Payload">
          <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-2)] p-3 font-data text-xs text-[var(--color-muted)]">{JSON.stringify(job.payload, null, 2)}</pre>
        </Section>

        {job.result && (
          <Section title="Result">
            <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-2)] p-3 font-data text-xs text-[var(--color-signal-success)]">{JSON.stringify(job.result, null, 2)}</pre>
          </Section>
        )}

        {job.error_msg && (
          <Section title="Last error">
            <div className="rounded-md border border-[var(--color-signal-danger)]/30 bg-[var(--color-signal-danger)]/10 p-3 text-xs text-[var(--color-signal-danger)]">{job.error_msg}</div>
          </Section>
        )}

        {job.ai_failure_summary && (
          <Section title="AI failure summary">
            <div className="rounded-md border border-[var(--color-signal-warning)]/30 bg-[var(--color-signal-warning)]/10 p-3 text-xs text-[var(--color-signal-warning)]">{job.ai_failure_summary}</div>
          </Section>
        )}

        {job.dependsOn?.length > 0 && (
          <Section title="Depends on">
            <div className="space-y-1">
              {job.dependsOn.map((d) => (
                <div key={d.upstream_job_id} className="flex items-center justify-between font-data text-xs">
                  <span className="text-[var(--color-muted)]">{d.upstream_job_id.slice(0, 8)}</span>
                  <StatusBadge status={d.status} />
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title={`Execution history (${job.executions?.length || 0})`}>
          <div className="space-y-2">
            {job.executions?.map((ex) => (
              <div key={ex.id} className="rounded-md border border-[var(--color-border-soft)] p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-data text-xs">attempt {ex.attempt}</span>
                  <StatusBadge status={ex.status} />
                </div>
                <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                  worker {ex.worker_id?.slice(0, 12) || '—'} · {ex.duration_ms ? `${ex.duration_ms}ms` : timeAgo(ex.started_at)}
                </div>
                {ex.error && <div className="mt-1 text-[11px] text-[var(--color-signal-danger)]">{ex.error}</div>}
              </div>
            ))}
          </div>
        </Section>

        <Section title={`Logs (${job.logs?.length || 0})`}>
          <div className="max-h-64 space-y-1 overflow-y-auto font-data text-[11px] text-[var(--color-muted)]">
            {job.logs?.map((l) => (
              <div key={l.id}>
                <span className="text-[var(--color-muted-2)]">{new Date(l.created_at).toLocaleTimeString()}</span> {l.message}
              </div>
            ))}
            {(!job.logs || job.logs.length === 0) && <div className="text-[var(--color-muted-2)]">No logs recorded.</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-5">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted-2)]">{title}</h4>
      {children}
    </div>
  );
}
