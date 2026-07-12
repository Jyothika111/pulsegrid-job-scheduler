import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
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

        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-6 text-sm text-[var(--color-muted)]">Monitor and control your job scheduler.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-[var(--color-muted)]">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
              placeholder="••••••••"
            />
          </div>
          {error && <div className="rounded-md border border-[var(--color-signal-danger)]/40 bg-[var(--color-signal-danger)]/10 px-3 py-2 text-xs text-[var(--color-signal-danger)]">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-[var(--color-signal-running)] py-2 text-sm font-semibold text-[#05221d] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-muted)]">
          No account?{' '}
          <Link to="/register" className="text-[var(--color-signal-running)]">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
