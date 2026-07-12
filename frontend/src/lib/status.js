export const STATUS_COLOR = {
  QUEUED: 'var(--color-signal-pending)',
  SCHEDULED: 'var(--color-signal-pending)',
  WAITING_DEPENDENCY: 'var(--color-signal-idle)',
  CLAIMED: 'var(--color-signal-running)',
  RUNNING: 'var(--color-signal-running)',
  COMPLETED: 'var(--color-signal-success)',
  FAILED: 'var(--color-signal-warning)',
  DEAD: 'var(--color-signal-danger)',
  CANCELLED: 'var(--color-signal-idle)',
  ONLINE: 'var(--color-signal-success)',
  DRAINING: 'var(--color-signal-warning)',
  OFFLINE: 'var(--color-signal-idle)',
  ACTIVE: 'var(--color-signal-success)',
  PAUSED: 'var(--color-signal-idle)',
};

export const EVENT_COLOR = {
  'job.created': 'var(--color-signal-pending)',
  'job.claimed': 'var(--color-signal-running)',
  'job.started': 'var(--color-signal-running)',
  'job.completed': 'var(--color-signal-success)',
  'job.retrying': 'var(--color-signal-warning)',
  'job.dead': 'var(--color-signal-danger)',
  'job.cancelled': 'var(--color-signal-idle)',
  'worker.registered': 'var(--color-signal-success)',
  'worker.offline': 'var(--color-signal-idle)',
};

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
