import express from "express";
import cors from "cors";
import { marketRouter } from "./routes/market.js";
import { aiRouter } from "./routes/ai.js";
import { settingsRouter } from "./routes/settings.js";
import { allStats } from "./providers/registry.js";
import { requireApiKey } from "./auth.js";
import { rateLimit } from "./rateLimit.js";
import { getSettings, hasAnyAiKey } from "./settings.js";
import { flushStaleCache, staleCount } from "./cache.js";
import { startNotifier } from "./notify.js";
import { startStream } from "./stream.js";

const app = express();

const startedAt = Date.now();

// Graceful shutdown: persist the last-known-data cache so a restart with cold
// providers can still serve stale quotes instead of failing everything.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    console.log(`[server] ${sig}, flushing stale cache`);
    flushStaleCache();
    process.exit(0);
  });
}

// Desktop safety net: a stray rejected promise or thrown async error must never
// take the whole terminal down silently. Route handlers already try/catch; this
// is a last-resort guard so the packaged app logs it and stays up.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err instanceof Error ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message ?? err);
});

// Off by default: req.ip then falls back to the immediate socket address
// (the bundled web proxy's own address when called through it), so every
// caller behind that proxy shares one rate-limit bucket — safe, if coarser
// than per-browser. Only set TRUST_PROXY=1 if you know exactly one trusted
// reverse proxy sits in front of this process — otherwise a caller can
// forge X-Forwarded-For to dodge the rate limit.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// Only the configured web origin may call this API from a browser.
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
app.use(cors({ origin: webOrigin }));
app.use(express.json());

// Health/status is always public (liveness probes, release builds). Registered
// before the optional read gate so REQUIRE_READ_KEY can never hide it.
app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    providers: allStats(),
    ai: hasAnyAiKey(),
    staleEntries: staleCount(),
    settings: { refreshMs: getSettings().refreshMs },
  });
});

// Optional read-side auth: set REQUIRE_READ_KEY=1 to also protect the market
// endpoints (quotes/history/calendar/news) behind the shared secret — useful
// when exposing the API beyond localhost. The bundled web proxy attaches the
// key to every request, so the desktop app is unaffected.
if (process.env.REQUIRE_READ_KEY === "1") {
  app.use("/api", requireApiKey);
}

// Market routes are not auth-gated by default (the web UI polls quotes/history
// openly), so they get a generous fixed-window limiter as a backstop against
// runaway tabs or misbehaving scripts hammering upstream providers; a healthy
// desktop session with every widget open stays well under it.
app.use("/api", rateLimit({ windowMs: 60_000, max: 900 }), marketRouter);
// Runtime settings (API keys for AI providers, alert/refresh preferences) are
// protected by the shared secret; the bundled web proxy attaches it.
app.use("/api/settings", requireApiKey, rateLimit({ windowMs: 60_000, max: 60 }), settingsRouter);
// The optional AI assistant requires a shared secret; see auth.ts.
app.use(
  "/api/ai",
  requireApiKey,
  rateLimit({ windowMs: 60_000, max: 60 }),
  aiRouter
);

const PORT = Number(process.env.API_PORT ?? 4000);
// Bind to localhost by default so cloning and running this never exposes an
// unauthenticated-by-default API to the network. Set API_HOST=0.0.0.0 (and
// API_KEY + WEB_ORIGIN) to intentionally expose it beyond this machine.
const HOST = process.env.API_HOST ?? "127.0.0.1";
console.log(
  `[env] PORT=${process.env.API_PORT} API_HOST=${process.env.API_HOST} DATA_DIR=${process.env.DATA_DIR} ` +
    `HTTP_PROXY=${process.env.HTTP_PROXY} HTTPS_PROXY=${process.env.HTTPS_PROXY} ` +
    `http_proxy=${process.env.http_proxy} https_proxy=${process.env.https_proxy} ` +
    `NO_PROXY=${process.env.NO_PROXY} no_proxy=${process.env.no_proxy} ` +
    `NODE_OPTIONS=${process.env.NODE_OPTIONS} NODE_ENV=${process.env.NODE_ENV} ` +
    `PREWARM=${process.env.PREWARM} STALE_MAX=${process.env.STALE_MAX}`
);
const server = app.listen(PORT, HOST, () => {
  console.log(`XAUUSD Terminal API listening on http://${HOST}:${PORT}`);
  startNotifier();
  startStream();
  if (process.env.PREWARM !== "0") {
    // Background pre-warm so the first click after a cold boot isn't slow:
    // hit the core endpoints locally once; failures are fine (providers may
    // be down), the fresh value simply lands in cache on the next poll.
    setTimeout(() => {
      const base = `http://${HOST}:${PORT}`;
      const key = typeof process.env.API_KEY === "string" && process.env.API_KEY ? process.env.API_KEY : null;
      const headers = key ? { "x-api-key": key } : undefined;
      const targets = [
        "/api/quotes?symbols=XAUUSD,GC=F,DX-Y.NYB",
        "/api/history/XAUUSD?range=15m",
        "/api/history/XAUUSD?range=1h",
        "/api/history/XAUUSD?range=1D",
        "/api/gold-macro",
        "/api/news",
        "/api/econ-calendar",
        "/api/seasonality",
        "/api/session-stats",
        "/api/stats",
        "/api/futures-curve",
        "/api/correlations",
      ];
      for (const path of targets) {
        fetch(base + path, { headers })
          .then((r) => r.ok ? undefined : console.error(`[prewarm] ${path} → ${r.status}`))
          .catch((err) => console.error(`[prewarm] ${path} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }, 1_500);
  }
});

// Keep the process open even if the notifier interval alone was the last handle.
server.on("close", () => flushStaleCache());