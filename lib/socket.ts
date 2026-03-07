import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';

let socket: Socket | null = null;

/** A stable ID that persists across socket reconnections within the same browser session. */
export function getPersistentId(): string {
  if (typeof window === 'undefined') return '';
  const key = 'cuppong_pid';
  let pid = sessionStorage.getItem(key);
  if (!pid) {
    pid = uuidv4();
    sessionStorage.setItem(key, pid);
  }
  return pid;
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
