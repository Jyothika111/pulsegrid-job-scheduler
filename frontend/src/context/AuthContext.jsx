import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshProjects = useCallback(async () => {
    const list = await api.get('/api/projects');
    setProjects(list);
    setCurrentProject((prev) => prev || list[0] || null);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      if (!api.getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.get('/api/auth/me');
        setUser(me);
        await refreshProjects();
      } catch {
        api.clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshProjects]);

  async function login(email, password) {
    const res = await api.post('/api/auth/login', { email, password });
    api.setToken(res.token);
    setUser(res.user);
    await refreshProjects();
  }

  async function register(payload) {
    const res = await api.post('/api/auth/register', payload);
    api.setToken(res.token);
    setUser(res.user);
    await refreshProjects();
  }

  function logout() {
    api.clearToken();
    setUser(null);
    setProjects([]);
    setCurrentProject(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, projects, currentProject, setCurrentProject, loading, login, register, logout, refreshProjects }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
