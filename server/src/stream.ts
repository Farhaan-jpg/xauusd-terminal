// Real-time push: a 1s engine reads the per-symbol quote cache (the same 1s
// cache the polling routes write), records tape ticks, and broadcasts to every
// connected /api/stream (Server-Sent Events) client. Alerts from notify.ts's
// rule engine are also pushed instantly to the browser instead of only hitting
// the webhook. No provider calls happen here — it is a cache reader.
import { cacheGet } from "./cache.js";
import { getSettings } from "./settings.js";
import { evaluateRules, type NotifyEvent } from "./notify.js";
import { recordTapeTick } from "./tape.js";
import type { Quote } from "./providers/yahoo.js";
import type { NewsItem } from "./providers/news.js";
import type { EconEvent } from "./providers/econcalendar.js";

const WATCH = ["XAUUSD", "GC=F", "XAGUSD=X", "DX-Y.NYB"];

export type TickMap = Record<string, { price: number | null; changePercent: number | null; t: number | null }>;

type StreamMessage =
  | { type: "tick"; ts: number; ticks: TickMap }
  | { type: "alert"; ts: number; alert: NotifyEvent }
  | { type: "status"; ts: number; connected: number };

type Listener = (msg: StreamMessage) => void;

const listeners = new Set<Listener>();
let lastTick: StreamMessage | null = null;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function subscriberCount(): number {
  return listeners.size;
}

function broadcast(msg: StreamMessage): void {
  lastTick = msg;
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      // never let a broken listener break the loop
    }
  }
}

// ---- alert push (rule evaluation on a 5s cadence, reusing notify.ts logic) ----

async function evaluateAndPushAlerts(): Promise<void> {
  const { alerts } = getSettings();
  if (!alerts.enabled) return;
  const prices = new Map<string, number | null>();
  for (const sym of WATCH) {
    const q = cacheGet<Quote>(`quote:${sym}`);
    prices.set(sym, q?.price ?? null);
  }
  const events = (await cachedEvents()).filter((e) => e && /\S/.test(e.date));
  const headlines = cachedHeadlines();
  const fired = evaluateRules({ now: Date.now(), alerts, prices, events, headlines });
  for (const alert of fired) broadcast({ type: "alert", ts: Date.now(), alert });
}

let eventsCache: EconEvent[] = [];
let eventsAt = 0;
async function cachedEvents(): Promise<EconEvent[]> {
  if (eventsCache.length === 0 || Date.now() - eventsAt > 300_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 4000}/api/econ-calendar`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as EconEvent[];
        if (Array.isArray(json)) {
          eventsCache = json;
          eventsAt = Date.now();
        }
      }
    } catch {
      // keep last-known events
    }
  }
  return eventsCache;
}

function cachedHeadlines(): string[] {
  const list = cacheGet<NewsItem[]>("news:gold");
  if (!Array.isArray(list)) return [];
  return list.map((n) => n.title).filter((t): t is string => typeof t === "string");
}

// ---- engine ----

let engineTimer: NodeJS.Timeout | null = null;
let tickCount = 0;

function engineTick(): void {
  const ts = Date.now();
  const ticks: TickMap = {};
  for (const sym of WATCH) {
    const q = cacheGet<Quote>(`quote:${sym}`);
    if (q) {
      ticks[sym] = { price: q.price, changePercent: q.changePercent, t: q.time ?? null };
      if (q.price !== null && Number.isFinite(q.price)) {
        recordTapeTick(sym, {
          t: (q.time && Number.isFinite(q.time) ? q.time * 1000 : ts),
          price: q.price,
          changePercent: q.changePercent,
          volume: q.volume,
          source: q.source,
        });
      }
    } else {
      ticks[sym] = { price: null, changePercent: null, t: null };
    }
  }
  broadcast({ type: "tick", ts, ticks });
  tickCount++;
  if (tickCount % 5 === 0) void evaluateAndPushAlerts();
}

/** Start the 1s engine and return a handle to stop it (tests / shutdown). */
export function startStream(): NodeJS.Timeout {
  if (engineTimer) return engineTimer;
  engineTimer = setInterval(engineTick, 1_000);
  engineTimer.unref();
  void engineTick();
  // prime the alert pusher dependent on broadcast wiring
  void evaluateAndPushAlerts().catch(() => undefined);
  return engineTimer;
}

export function stopStream(): void {
  if (engineTimer) {
    clearInterval(engineTimer);
    engineTimer = null;
  }
}

// ---- SSE route ----

import type { Router } from "express";

/** Attach GET /api/stream — a persistent EventSource feed of ticks + alerts. */
export function attachStream(router: Router): void {
  router.get("/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    if (lastTick) res.write(`data: ${JSON.stringify(lastTick)}\n\n`);
    const unsub = subscribe((msg) => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const hb = setInterval(() => {
      res.write(`: hb ${Date.now()}\n\n`);
    }, 20_000);
    hb.unref?.();
    req.on("close", () => {
      clearInterval(hb);
      unsub();
    });
    req.on("error", () => {
      clearInterval(hb);
      unsub();
    });
  });
}

export type { StreamMessage, Listener };