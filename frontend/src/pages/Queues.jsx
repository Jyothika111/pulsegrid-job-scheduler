import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';

const DEFAULTS = {
  name: '',
  priority: 0,
  concurrencyLimit: 5,
  shardCount: 1,
  retryStrategy: 'EXPONENTIAL',
  maxRetries: 3,
  baseRetryDelayMs: 2000,
  maxRetryDelayMs: 300000,
  rateLimitMax: '',
  rateLimitWindowMs: 1000,
  defaultTimeoutMs: 30000,
};

export default function Queues() {
  const { currentProject } = useAuth();
  const [queues, setQueues] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULTS);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!currentProject) return;
    const res = await api.get(`/api/queues?projectId=${currentProject.id}&pageSize=100`);
    setQueues(res.items);
  }, [currentProject]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function createQueue(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/queues', {
        ...form,
        projectId: currentProject.id,
        rateLimitMax: form.rateLimitMax === '' ? null : Number(form.rateLimitMax),
      });
      setShowForm(false);
      setForm(DEFAULTS);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(q) {
    await api.post(`/api/queues/${q.id}/${q.status === 'ACTIVE' ? 'pause' : 'resume'}`);
    load();
  }

  if (!currentProject) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Queues</h1>
          <p className="text-sm text-[var(--color-muted)]">Configure concurrency, retries, rate limits, and sharding.</p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-[var(--color-signal-running)] px-4 py-2 text-sm font-semibold text-[#05221d]"
        >
          {showForm ? 'Cancel' : '+ New queue'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={createQueue} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Name">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="in" />
            </Field>
            <Field label="Priority">
              <input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: +e.target.value })} className="in" />
            </Field>
            <Field label="Concurrency limit">
              <input type="number" min={1} value={form.concurrencyLimit} onChange={(e) => setForm({ ...form, concurrencyLimit: +e.target.value })} className="in" />
            </Field>
            <Field label="Shard count">
              <input type="number" min={1} value={form.shardCount} onChange={(e) => setForm({ ...form, shardCount: +e.target.value })} className="in" />
            </Field>
            <Field label="Retry strategy">
              <select value={form.retryStrategy} onChange={(e) => setForm({ ...form, retryStrategy: e.target.value })} className="in">
                <option>EXPONENTIAL</option>
                <option>LINEAR</option>
                <option>FIXED</option>
                <option>NONE</option>
              </select>
            </Field>
            <Field label="Max retries">
              <input type="number" min={0} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: +e.target.value })} className="in" />
            </Field>
            <Field label="Base retry delay (ms)">
              <input type="number" min={0} value={form.baseRetryDelayMs} onChange={(e) => setForm({ ...form, baseRetryDelayMs: +e.target.value })} className="in" />
            </Field>
            <Field label="Max retry delay (ms)">
              <input type="number" min={0} value={form.maxRetryDelayMs} onChange={(e) => setForm({ ...form, maxRetryDelayMs: +e.target.value })} className="in" />
            </Field>
            <Field label="Rate limit (jobs/window)">
              <input type="number" min={1} placeholder="unlimited" value={form.rateLimitMax} onChange={(e) => setForm({ ...form, rateLimitMax: e.target.value })} className="in" />
            </Field>
            <Field label="Rate limit window (ms)">
              <input type="number" min={100} value={form.rateLimitWindowMs} onChange={(e) => setForm({ ...form, rateLimitWindowMs: +e.target.value })} className="in" />
            </Field>
            <Field label="Default timeout (ms)">
              <input type="number" min={100} value={form.defaultTimeoutMs} onChange={(e) => setForm({ ...form, defaultTimeoutMs: +e.target.value })} className="in" />
            </Field>
          </div>
          {error && <div className="mt-3 text-xs text-[var(--color-signal-danger)]">{error}</div>}
          <button type="submit" className="mt-4 rounded-md bg-[var(--color-signal-running)] px-4 py-2 text-sm font-semibold text-[#05221d]">
            Create queue
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface)] text-left text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">
              <th className="px-4 py-3">Queue</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Pending</th>
              <th className="px-4 py-3">Running</th>
              <th className="px-4 py-3">Concurrency</th>
              <th className="px-4 py-3">Retry</th>
              <th className="px-4 py-3">Shards</th>
              <th className="px-4 py-3">Completed</th>
              <th className="px-4 py-3">Failed</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.id} className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]">
                <td className="px-4 py-3 font-medium">{q.name}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={q.status} />
                </td>
                <td className="px-4 py-3 font-data">{q.pending_count}</td>
                <td className="px-4 py-3 font-data">{q.running_count}</td>
                <td className="px-4 py-3 font-data">{q.concurrency_limit}</td>
                <td className="px-4 py-3 font-data text-xs text-[var(--color-muted)]">{q.retry_strategy} · {q.max_retries}x</td>
                <td className="px-4 py-3 font-data">{q.shard_count}</td>
                <td className="px-4 py-3 font-data text-[var(--color-signal-success)]">{q.total_completed}</td>
                <td className="px-4 py-3 font-data text-[var(--color-signal-danger)]">{q.total_failed}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => toggle(q)}
                    className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)] hover:border-[var(--color-signal-running)]/50 hover:text-[var(--color-signal-running)]"
                  >
                    {q.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </button>
                </td>
              </tr>
            ))}
            {queues.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-[var(--color-muted-2)]">
                  No queues yet — create one to start scheduling jobs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-[var(--color-muted-2)]">{label}</span>
      {children}
    </label>
  );
}
