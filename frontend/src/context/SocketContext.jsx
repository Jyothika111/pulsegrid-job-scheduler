import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

const TRACKED_EVENTS = [
  'job.created',
  'job.claimed',
  'job.started',
  'job.completed',
  'job.retrying',
  'job.dead',
  'job.cancelled',
  'worker.registered',
  'worker.offline',
];

const MAX_PULSE = 60;

export function SocketProvider({ children }) {
  const { currentProject } = useAuth();
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState([]);
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(api.BASE_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    TRACKED_EVENTS.forEach((type) => {
      socket.on(type, (payload) => {
        setPulse((prev) => [{ type, payload, at: Date.now(), key: `${type}-${Date.now()}-${Math.random()}` }, ...prev].slice(0, MAX_PULSE));
      });
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (socketRef.current && currentProject) {
      socketRef.current.emit('subscribe', { projectId: currentProject.id });
    }
  }, [currentProject]);

  return <SocketContext.Provider value={{ connected, pulse }}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}
