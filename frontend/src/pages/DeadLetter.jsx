import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { timeAgo } from '../lib/status';

export default function DeadLetter() {
  const { currentProject } = useAuth();
  const [queues, setQueues] = useState([]);
  const [queueId, setQueueId] = useState('');
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (currentProject) {
      api.get(`/api/queues?projectId=${currentProject.id}&pageSize=100`).then((r) => {
        setQueues(r.items);
        if (r.items[0]) setQueueId(r.items[0].id);
      });
    }
  }, [currentProject]);

  const load = useCallback(async () => {
    if (!queueId) return;
    const res = await api.get(`/api/jobs/dlq/${queueId}?pageSize=50`);
    setItems(res.items);
  }, [queueId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function reprocess(jobId) {
    await api.post(`/api/jobs/${jobId}/retry`);
    load();
  }

  if (!currentProject) return null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Dead letter queue</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Jobs that exhausted their retry budget. Inspect the failure, fix the root cause, then reprocess.
        </p>
      </div>

      <select value={queueId} onChange={(e) => setQueueId(e.target.value)} className="in max-w-xs">
        {queues.map((q) => (
          <option key={q.id} value={q.id}>{q.name}</option>
        ))}
      </select>

      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.id} className="rounded-lg border border-[var(--color-signal-danger)]/25 bg-[var(--color-surface)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-data text-xs text-[var(--color-muted)]">{d.job_id.slice(0, 12)}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-[var(--color-muted)]">{d.attempts} attempts · moved {timeAgo(d.moved_at)}</span>
                {!d.reprocessed ? (
                  <button
                    onClick={() => reprocess(d.job_id)}
                    className="rounded-md bg-[var(--color-signal-running)] px-3 py-1 text-xs font-semibold text-[#05221d]"
                  >
                    Reprocess
                  </button>
                ) : (
                  <span className="rounded-md border border-[var(--color-signal-success)]/40 px-2 py-1 text-[11px] text-[var(--color-signal-success)]">
                    reprocessed
                  </span>
                )}
              </div>
            </div>
            <div className="mb-2 rounded-md border border-[var(--color-signal-danger)]/30 bg-[var(--color-signal-danger)]/10 px-3 py-2 text-xs text-[var(--color-signal-danger)]">
              {d.reason}
            </div>
            <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-2)] p-2.5 font-data text-[11px] text-[var(--color-muted)]">
              {JSON.stringify(d.last_payload, null, 2)}
            </pre>
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center text-sm text-[var(--color-muted-2)]">
            No dead letters in this queue. Good sign.
          </div>
        )}
      </div>
    </div>
  );
}
