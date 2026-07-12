export default function StatCard({ label, value, accent, sub }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">{label}</div>
      <div className="mt-2 font-data text-2xl font-semibold" style={{ color: accent || 'var(--color-text)' }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}
