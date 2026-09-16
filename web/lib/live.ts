"use client";

// Real-time push over Server-Sent Events. One module-level connection is
// shared by every consumer (widgets/…) so N widgets don't spawn N sockets.
// Loads first through the Next.js proxied path (/api/stream) and falls back to
// the Express origin directly if the proxy buffers the stream.
import { useEffect, useState, useRef } from "react";
import { pushTray } from "./notify";

type LiveTick = {
  price: number | null;
  changePercent: number | null;
  t: number | null;
};

type LiveMsg =
  | { type: "tick"; ts: number; ticks: Record<string, LiveTick> }
  | { type: "alert"; ts: number; alert: { type: string; text: string; tone: "up" | "down" | "amber"; key: string } }
  | { type: "status"; ts: number; connected: number };

const listeners = new Set<(msg: LiveMsg) => void>();
let es: EventSource | null = null;
let state: "idle" | "connecting" | "open" | "dead" = "idle";
let startTimer: ReturnType<typeof setTimeout> | null = null;

function emit(msg: LiveMsg): void {
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      // a broken listener must never break the feed
    }
  }
}

function setState(s: typeof state): void {
  state = s;
  emit({ type: "status", ts: Date.now(), connected: listeners.size });
}

function boot(): void {
  if (es || startTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    connect(false);
  }, 800);
}

function connect(useDirect: boolean): void {
  if (es) {
    es.close();
    es = null;
  }
  const url = useDirect
    ? `${window.location.protocol}//${window.location.hostname}:4000/api/stream`
    : "/api/stream";
  const next = new EventSource(url);
  setState("connecting");
  next.onopen = () => setState("open");
  next.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as LiveMsg;
      if (msg.type === "alert") {
        pushTray(msg.alert.text, msg.alert.tone);
      }
      emit(msg);
    } catch {
      // ignore malformed frames
    }
  };
  next.onerror = () => {
    next.close();
    es = null;
    setState("dead");
    startTimer = setTimeout(() => connect(true), 6_000);
  };
  es = next;
}

export type LiveSnapshot = { connected: boolean; connecting: boolean; dead: boolean };

export function useLiveFeed(cb?: (msg: LiveMsg) => void): LiveSnapshot {
  const [snap, setSnap] = useState<LiveSnapshot>({ connected: false, connecting: false, dead: false });
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    const listener = (msg: LiveMsg) => {
      cbRef.current?.(msg);
      if (msg.type === "status") {
        setSnap({ connected: state === "open", connecting: state === "connecting", dead: state === "dead" });
      }
    };
    listeners.add(listener);
    boot();
    setSnap({ connected: state === "open", connecting: state === "connecting", dead: state === "dead" });
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return snap;
}

export type { LiveMsg, LiveTick };