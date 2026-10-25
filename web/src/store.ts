import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, getToken } from './api';
import type { FloorState } from './types';

/**
 * Keeps the floor state fresh: loads it, listens on the WebSocket for changes
 * (reconnecting with backoff), and refetches every 30 s as a safety net.
 * Also tracks the difference between the host clock and this device's clock
 * so timers are correct even if the counter PC's clock is off.
 */
export function useFloor(enabled: boolean) {
  const [state, setState] = useState<FloorState | null>(null);
  const [online, setOnline] = useState(true);
  const [authLost, setAuthLost] = useState(false);
  const offset = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    inflight.current = (async () => {
      try {
        do {
          again.current = false;
          const sent = Date.now();
          const s = await api.get<FloorState>('/api/state');
          const rtt = Date.now() - sent;
          offset.current = s.now + rtt / 2 - Date.now();
          setState(s);
          setOnline(true);
        } while (again.current);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setAuthLost(true);
        else setOnline(false);
      } finally {
        inflight.current = null;
      }
    })();
    return inflight.current;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken() ?? '')}`);
      ws.onopen = () => {
        backoff = 500;
        setOnline(true);
        void refresh();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type: string };
          if (msg.type === 'changed') void refresh();
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4401) {
          setAuthLost(true);
          return;
        }
        setOnline(false);
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      };
    };
    connect();
    const poll = setInterval(() => void refresh(), 30_000);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      ws?.close();
    };
  }, [enabled, refresh]);

  return { state, online, authLost, refresh, serverNow: () => Date.now() + offset.current };
}

/** A clock that ticks every second, for live timers. */
const tickListeners = new Set<() => void>();
let tickValue = Date.now();
setInterval(() => {
  tickValue = Date.now();
  tickListeners.forEach((l) => l());
}, 1000);

export function useTick(): number {
  return useSyncExternalStore(
    (cb) => {
      tickListeners.add(cb);
      return () => tickListeners.delete(cb);
    },
    () => tickValue,
  );
}
