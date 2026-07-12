import { useSocket } from '../context/SocketContext';
import { EVENT_COLOR } from '../lib/status';

const LABELS = {
  'job.created': 'created',
  'job.claimed': 'claimed',
  'job.started': 'started',
  'job.completed': 'completed',
  'job.retrying': 'retrying',
  'job.dead': 'dead-lettered',
  'job.cancelled': 'cancelled',
  'worker.registered': 'worker online',
  'worker.offline': 'worker offline',
};

/**
 * The dashboard's signature element: a live seismograph-style strip of
 * every job/worker state transition as it happens, fed directly by the
 * WebSocket event bus. Each tick is colored by event type, so a healthy
 * system reads as a steady cyan/lime pulse and trouble reads as amber/red
 * spikes - at a glance, before you've read a single number.
 */
export default function PulseStrip() {
  const { pulse, connected } = useSocket() || { pulse: [], connected: false };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Live pulse
        </h3>
        <span className="flex items-center gap-1.5 text-[11px] font-data text-[var(--color-muted)]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? 'var(--color-signal-success)' : 'var(--color-signal-danger)' }}
          />
          {connected ? 'connected' : 'disconnected'}
        </span>
      </div>

      {pulse.length === 0 ? (
        <div className="flex h-16 items-center justify-center text-sm text-[var(--color-muted-2)]">
          Waiting for activity…
        </div>
      ) : (
        <div className="flex h-16 items-end gap-[3px] overflow-hidden">
          {pulse
            .slice()
            .reverse()
            .map((e) => (
              <div
                key={e.key}
                title={`${LABELS[e.type] || e.type} · ${e.payload?.jobId || e.payload?.workerId || ''}`}
                className="w-1.5 shrink-0 rounded-t-sm transition-all"
                style={{
                  height: `${18 + Math.min(46, (e.type.includes('dead') ? 46 : e.type.includes('completed') ? 30 : 20))}px`,
                  background: EVENT_COLOR[e.type] || 'var(--color-muted)',
                  opacity: 0.85,
                }}
              />
            ))}
        </div>
      )}

      <div className="mt-3 max-h-40 space-y-1 overflow-y-auto font-data text-[11px] text-[var(--color-muted)]">
        {pulse.slice(0, 8).map((e) => (
          <div key={e.key} className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: EVENT_COLOR[e.type] }} />
            <span style={{ color: EVENT_COLOR[e.type] }}>{LABELS[e.type] || e.type}</span>
            <span className="truncate text-[var(--color-muted-2)]">
              {(e.payload?.jobId || e.payload?.workerId || '').slice(0, 8)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
