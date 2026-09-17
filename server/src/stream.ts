// Real-time push: a 1s engine reads the per-symbol quote cache (the same 1s
// cache the polling routes write), records tape ticks, and broadcasts to every
// connected /api/stream (Server-Sent Events) client. Alerts from notify.ts's
// rule engine are also pushed instantly to the browser instead of only hitting
// the webhook. No provider calls happen here — it is a cache reader.
import { cacheGet } from "./cache.js";
import { cached } from "./cache.js";
import { getSettings } from "./settings.js";
import { evaluateRules, type NotifyEvent } from "./notify.js";
import { recordTapeTick } from "./tape.js";
import { tracked } from "./providers/registry.js";
import { weeklyEvents } from "./providers/econcalendar.js";
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
  // Only tick frames are replayed to newly-connected clients; alerts are live
  // events and must not replay on every reconnect/refresh.
  if (msg.type === "tick") lastTick = msg;
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      // never let a broken listener break the loop
    }
  }
}

// ---- alert push (single evaluator: rules + move detection → SSE + webhook) ----

let prevSpot: { price: number; at: number } | null = null;
let lastMoveAt = 0;

function postWebhook(url: string, ev: NotifyEvent): void {
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: ev.type, text: ev.text, tone: ev.tone, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => {
      if (!r.ok) console.error(`[stream] webhook ${r.status}`);
    })
    .catch((err) => {
      console.error(`[stream] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

function deliver(ev: NotifyEvent): void {
  broadcast({ type: "alert", ts: Date.now(), alert: ev });
  const { alerts } = getSettings();
  const url = alerts.webhook?.url?.trim();
  if (alerts.enabled && alerts.webhook?.enabled && url) postWebhook(url, ev);
}

async function evaluateAndPushAlerts(): Promise<void> {
  const { alerts } = getSettings();
  if (!alerts.enabled) return;
  const prices = new Map<string, number | null>();
  for (const sym of WATCH) {
    const q = cacheGet<Quote>(`quote:${sym}`);
    prices.set(sym, q?.price ?? null);
  }

  // Spot-move detection between consecutive evaluations (server-side so the
  // webhook and the browser get the exact same move event, once).
  const now = Date.now();
  const spot = prices.get("XAUUSD");
  if (spot !== undefined && spot !== null && Number.isFinite(spot) && prevSpot) {
    const pct = Math.abs((spot / prevSpot.price - 1) * 100);
    const threshold = Number.isFinite(alerts.thresholdPct) ? alerts.thresholdPct : 0.5;
    if (pct >= threshold && now - lastMoveAt > 10 * 60_000) {
      lastMoveAt = now;
      const dir = spot > prevSpot.price ? "up" : "down";
      deliver({
        type: "move",
        tone: dir === "up" ? "up" : "down",
        text: `Gold ${dir} ${pct.toFixed(2)}% in the last ${Math.round((now - prevSpot.at) / 1000)}s → ${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        key: `mv:${Math.floor(now / 600_000)}`,
      });
    }
  }
  if (spot !== undefined && spot !== null && Number.isFinite(spot)) {
    prevSpot = { price: spot, at: now };
  }

  const events = (await cachedEvents()).filter((e) => e && /\S/.test(e.date));
  const headlines = cachedHeadlines();
  const fired = evaluateRules({ now, alerts, prices, events, headlines });
  for (const alert of fired) deliver(alert);
}

/** Same cache key + loader as GET /api/econ-calendar, so the stream's 5s
 *  cadence shares the route's fetch (single-flight) and never self-HTTPs the
 *  API — which broke under REQUIRE_READ_KEY and misread API_PORT. */
async function cachedEvents(): Promise<EconEvent[]> {
  try {
    const list = await cached("econ-calendar", 300_000, () => tracked("forexfactory", () => weeklyEvents()));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function cachedHeadlines(): string[] {
  const list = cacheGet<NewsItem[]>("news:gold");
  if (!Array.isArray(list)) return [];
  return list.map((n) => n.title).filter((t): t is string => typeof t === "string");
}

// ---- engine ----

let engineTimer: NodeJS.Timeout | null = null;
let tickCount = 0;
// Last known tick per symbol. The quote cache has a 1s TTL, so a poll landing
// right on the boundary would otherwise flap a known price to null and blank
// the live strip; hold the previous value until a fresh quote arrives.
const lastTicks: TickMap = {};

function engineTick(): void {
  const ts = Date.now();
  const ticks: TickMap = {};
  for (const sym of WATCH) {
    const q = cacheGet<Quote>(`quote:${sym}`);
    if (q) {
      const t = { price: q.price, changePercent: q.changePercent, t: q.time ?? null };
      ticks[sym] = t;
      lastTicks[sym] = t;
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
      ticks[sym] = lastTicks[sym] ?? { price: null, changePercent: null, t: null };
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

    // Guarded write: once the socket is torn down (client navigated away, proxy
    // dropped it) a raw res.write() can throw or emit an unhandled 'error' and
    // take the whole process down. Swallow writes to a dead socket instead.
    const send = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(chunk);
      } catch {
        // socket died mid-write; cleanup runs via the close/error handlers below
      }
    };

    send("retry: 3000\n\n");
    if (lastTick) send(`data: ${JSON.stringify(lastTick)}\n\n`);

    const unsub = subscribe((msg) => {
      send(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const hb = setInterval(() => send(`: hb ${Date.now()}\n\n`), 20_000);
    hb.unref?.();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub();
    };
    // 'close' on either side + an explicit res error handler: a vanished client
    // must never leak the heartbeat interval or leave an unhandled socket error.
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });
}

export type { StreamMessage, Listener };