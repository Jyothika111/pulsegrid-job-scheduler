import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

export default function CreateProjectCard() {
  const { refreshProjects } = useAuth();
  const [name, setName] = useState('My first project');
  const [loading, setLoading] = useState(false);

  async function create() {
    setLoading(true);
    try {
      const me = await api.get('/api/auth/me');
      const orgId = me.organizations?.[0]?.id;
      await api.post('/api/projects', { organizationId: orgId, name });
      await refreshProjects();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-[var(--color-signal-running)] text-[#05221d] font-data font-bold">
          ▲
        </div>
        <h2 className="mb-1 text-lg font-semibold">Create your first project</h2>
        <p className="mb-5 text-sm text-[var(--color-muted)]">
          Projects hold their own queues, API key, and members.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
        />
        <button
          onClick={create}
          disabled={loading}
          className="w-full rounded-md bg-[var(--color-signal-running)] py-2 text-sm font-semibold text-[#05221d] disabled:opacity-50"
        >
          {loading ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </div>
  );
}
