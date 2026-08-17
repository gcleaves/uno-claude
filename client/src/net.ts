import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { identify } from './analytics';
import type { Action, ActionResult, ErrorCode, GameView } from '@uno/shared';

const TOKEN_KEY = 'uno.token';
const NAME_KEY = 'uno.name';

export function storedName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function rememberName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

export type ConnState = 'connecting' | 'online' | 'offline';

export interface Net {
  conn: ConnState;
  view: GameView | null;
  code: string | null;
  error: ErrorCode | null;
  clearError: () => void;
  createRoom: (name: string) => Promise<string | null>;
  joinRoom: (code: string, name: string) => Promise<boolean>;
  leaveRoom: () => void;
  send: (action: Action) => Promise<ActionResult>;
}

export function useNet(): Net {
  const socketRef = useRef<Socket | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [view, setView] = useState<GameView | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  // Kept in a ref so the reconnect handler always sees the current room.
  const rejoin = useRef<{ code: string; name: string } | null>(null);

  useEffect(() => {
    const socket = io({
      auth: (cb) =>
        cb({
          token: localStorage.getItem(TOKEN_KEY) ?? undefined,
          name: storedName() || undefined,
        }),
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConn('online');
      // Re-take our seat after a network blip or a phone waking up.
      const target = rejoin.current;
      if (target) {
        socket.emit('room:join', target, (res: { ok: boolean; error?: ErrorCode }) => {
          if (!res.ok) {
            rejoin.current = null;
            setCode(null);
            setView(null);
            setError(res.error ?? 'lostSeat');
          }
        });
      }
    });
    socket.on('disconnect', () => setConn('offline'));
    socket.on('connect_error', () => setConn('offline'));
    socket.on('hello', (payload: { token?: string; analyticsId?: string }) => {
      if (payload.token) localStorage.setItem(TOKEN_KEY, payload.token);
      // Same identity as the server uses, so a player's events form one story.
      if (payload.analyticsId) identify(payload.analyticsId);
    });
    socket.on('state', (next: GameView) => setView(next));

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  const createRoom = useCallback(async (name: string) => {
    const socket = socketRef.current;
    if (!socket) return null;
    rememberName(name);
    const res = await emit<{ ok: boolean; code?: string; error?: ErrorCode }>(socket, 'room:create', {
      name,
    });
    if (!res.ok || !res.code) {
      setError(res.error ?? 'couldNotJoin');
      return null;
    }
    rejoin.current = { code: res.code, name };
    setCode(res.code);
    return res.code;
  }, []);

  const joinRoom = useCallback(async (roomCode: string, name: string) => {
    const socket = socketRef.current;
    if (!socket) return false;
    rememberName(name);
    const res = await emit<{ ok: boolean; code?: string; error?: ErrorCode }>(socket, 'room:join', {
      code: roomCode,
      name,
    });
    if (!res.ok) {
      setError(res.error ?? 'couldNotJoin');
      return false;
    }
    rejoin.current = { code: roomCode.toUpperCase(), name };
    setCode(roomCode.toUpperCase());
    return true;
  }, []);

  const leaveRoom = useCallback(() => {
    rejoin.current = null;
    setCode(null);
    setView(null);
    socketRef.current?.emit('room:leave');
  }, []);

  const send = useCallback(async (action: Action): Promise<ActionResult> => {
    const socket = socketRef.current;
    if (!socket) return { ok: false, error: 'notConnected' };
    const res = await emit<ActionResult>(socket, 'game:action', action);
    if (!res.ok && res.error) setError(res.error);
    return res;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { conn, view, code, error, clearError, createRoom, joinRoom, leaveRoom, send };
}

function emit<T>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => resolve({ ok: false, error: 'noResponse' } as T),
      8000,
    );
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timeout);
      resolve(res);
    });
  });
}
