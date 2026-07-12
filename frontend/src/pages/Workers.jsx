import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { timeAgo } from '../lib/status';

export default function Workers() {
  const { currentProject } = useAuth();
  const [workers, setWorkers] = useState([]);

  const load = useCallback(async () => {
    if (!currentProject) return;
    const res = await api.get(`/api/workers?projectId=${currentProject.id}`);
    setWorkers(res);
  }, [currentProject]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (!currentProject) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Workers</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Processes polling this project's queues. Offline workers' in-flight jobs are automatically requeued.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((w) => (
          <div key={w.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-data text-xs">{w.id.slice(0, 20)}</span>
              <StatusBadge status={w.status} />
            </div>
            <div className="text-sm text-[var(--color-muted)]">{w.hostname} · pid {w.pid || '—'}</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-[var(--color-muted-2)]">In flight</div>
                <div className="font-data text-base">{w.active_jobs} / {w.concurrency}</div>
              </div>
              <div>
                <div className="text-[var(--color-muted-2)]">Last seen</div>
                <div className="font-data text-base">{timeAgo(w.last_seen_at)}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {(w.queue_names || []).map((q) => (
                <span key={q} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-muted)]">
                  {q}
                </span>
              ))}
            </div>
          </div>
        ))}
        {workers.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center text-sm text-[var(--color-muted-2)]">
            No workers have registered yet. Start one with <code className="font-data">npm run worker</code>.
          </div>
        )}
      </div>
    </div>
  );
}
