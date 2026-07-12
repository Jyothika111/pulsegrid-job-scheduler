import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/', label: 'Overview', icon: '◆' },
  { to: '/queues', label: 'Queues', icon: '▤' },
  { to: '/jobs', label: 'Job explorer', icon: '▣' },
  { to: '/workers', label: 'Workers', icon: '◍' },
  { to: '/dead-letter', label: 'Dead letters', icon: '✕' },
];

export default function Layout() {
  const { user, projects, currentProject, setCurrentProject, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-signal-running)] text-sm font-bold text-[#05221d] font-data">
            ▲
          </div>
          <div>
            <div className="font-data text-sm font-semibold leading-none">Pulsegrid</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">
              job scheduler
            </div>
          </div>
        </div>

        <div className="px-4 py-4">
          <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">
            Project
          </label>
          <select
            value={currentProject?.id || ''}
            onChange={(e) => setCurrentProject(projects.find((p) => p.id === e.target.value))}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-signal-running)]"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                    : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
                }`
              }
            >
              <span className="w-4 text-center text-[var(--color-signal-running)]">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] px-4 py-4">
          <div className="mb-2 truncate text-xs text-[var(--color-muted)]">{user?.email}</div>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-signal-danger)]/50 hover:text-[var(--color-signal-danger)]"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
