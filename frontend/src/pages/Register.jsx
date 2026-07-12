import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(form);
      navigate('/');
    } catch (err) {
      setError(err.details ? err.details.map((d) => d.message).join(', ') : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-signal-running)] text-sm font-bold text-[#05221d] font-data">
            ▲
          </div>
          <div className="font-data text-lg font-semibold">Pulsegrid</div>
        </div>

        <h1 className="mb-1 text-xl font-semibold">Create your account</h1>
        <p className="mb-6 text-sm text-[var(--color-muted)]">
          This sets up a new organization with you as admin.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Organization name</label>
            <input
              value={form.orgName}
              onChange={(e) => set('orgName', e.target.value)}
              placeholder="Optional"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
            />
          </div>
          {error && <div className="rounded-md border border-[var(--color-signal-danger)]/40 bg-[var(--color-signal-danger)]/10 px-3 py-2 text-xs text-[var(--color-signal-danger)]">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-[var(--color-signal-running)] py-2 text-sm font-semibold text-[#05221d] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-muted)]">
          Already have an account?{' '}
          <Link to="/login" className="text-[var(--color-signal-running)]">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
