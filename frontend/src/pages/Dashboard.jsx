import { useEffect, useState, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import StatCard from '../components/StatCard';
import PulseStrip from '../components/PulseStrip';
import CreateProjectCard from '../components/CreateProjectCard';
import { useSocket } from '../context/SocketContext';

export default function Dashboard() {
  const { currentProject } = useAuth();
  const { pulse } = useSocket() || { pulse: [] };
  const [summary, setSummary] = useState(null);
  const [queues, setQueues] = useState([]);
  const [throughput, setThroughput] = useState([]);

  const load = useCallback(async () => {
    if (!currentProject) return;
    const [s, q] = await Promise.all([
      api.get(`/api/dashboard/summary?projectId=${currentProject.id}`),
      api.get(`/api/queues?projectId=${currentProject.id}&pageSize=100`),
    ]);
    setSummary(s);
    setQueues(q.items);
    if (q.items[0]) {
      const t = await api.get(`/api/queues/${q.items[0].id}/throughput?minutes=60`);
      setThroughput(
        t.map((r) => ({
          time: new Date(r.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          completed: Number(r.completed),
          failed: Number(r.failed),
        }))
      );
    }
  }, [currentProject]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-poll summary whenever a pulse event lands, so counts stay fresh
  // without a fixed interval poll.
  useEffect(() => {
    if (pulse.length) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse.length]);

  if (!currentProject) return <CreateProjectCard />;

  const statuses = summary?.jobsByStatus || {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-[var(--color-muted)]">{currentProject.name}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Active queues" value={summary?.queues?.active ?? '—'} sub={`${summary?.queues?.paused ?? 0} paused`} />
        <StatCard
          label="Running now"
          value={(statuses.RUNNING || 0) + (statuses.CLAIMED || 0)}
          accent="var(--color-signal-running)"
        />
        <StatCard
          label="Workers online"
          value={summary?.workers?.online ?? 0}
          sub={`${summary?.workers?.total ?? 0} registered`}
          accent="var(--color-signal-success)"
        />
        <StatCard
          label="Dead letters"
          value={summary?.deadLetterCount ?? 0}
          accent={summary?.deadLetterCount ? 'var(--color-signal-danger)' : 'var(--color-text)'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            Throughput — {queues[0]?.name || 'primary queue'} (last hour)
          </h3>
          {throughput.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-sm text-[var(--color-muted-2)]">
              No executions yet in the last hour.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <LineChart data={throughput}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="time" stroke="var(--color-muted-2)" fontSize={11} />
                <YAxis stroke="var(--color-muted-2)" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', fontSize: 12 }} />
                <Line type="monotone" dataKey="completed" stroke="var(--color-signal-success)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="failed" stroke="var(--color-signal-danger)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <PulseStrip />
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Jobs by status
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {['QUEUED', 'SCHEDULED', 'WAITING_DEPENDENCY', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD'].map((s) => (
            <div key={s} className="rounded-md border border-[var(--color-border-soft)] p-3 text-center">
              <div className="font-data text-lg font-semibold">{statuses[s] || 0}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-2)]">
                {s.replace('_', ' ')}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
