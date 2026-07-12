import { STATUS_COLOR } from '../lib/status';

export default function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || 'var(--color-muted)';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium font-data tracking-wide"
      style={{ borderColor: color + '55', color, background: color + '14' }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {status.replace('_', ' ')}
    </span>
  );
}
