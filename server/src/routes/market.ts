import { Router } from "express";
import { cached, cacheGet, cacheStore, staleGet } from "../cache.js";
import { tracked, withFallback } from "../providers/registry.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";
import * as nasdaq from "../providers/nasdaq.js";
import * as fred from "../providers/fred.js";
import * as news from "../providers/news.js";
import * as econcalendar from "../providers/econcalendar.js";
import * as sina from "../providers/sina.js";
import * as cnbc from "../providers/cnbc.js";
import * as cot from "../providers/cot.js";
import {
  computeStats,
  computeCorrelations,
  computeFuturesCurve,
  computeOptionsSummary,
  computeRateProbs,
  computeEtfFlowProxy,
  computeCotSummary,
  computeBias,
  nextContracts,
} from "../analytics.js";
import { getTape } from "../tape.js";
import { attachStream } from "../stream.js";

export const marketRouter = Router();

const QUOTE_TTL = 1_000;
const HISTORY_TTL = 5_000;
const HISTORY_TTL_LONG = 60_000;
const NEWS_TTL = 60_000;
const FRED_TTL = 300_000;

// ---- XAUUSD: gold spot / US dollar (OANDA / TradingView style) ----

/** A symbol is "gold" if it's the spot pair or its near-equivalent futures. */
export function isGoldSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s === "XAUUSD" || s === "XAUUSD=X" || s === "GC=F";
}

/** Instruments Nasdaq's equities API doesn't serve: spot metals, FX pairs,
 *  index/commodity futures. Routed to Yahoo (primary) then Stooq (fallback). */
const META_SYMBOLS = new Set([
  "XAUUSD",
  "XAUUSD=X",
  "GC=F",
  "XAGUSD",
  "XAGUSD=X",
  "SI=F",
  "PL=F",
  "PA=F",
  "DX-Y.NYB",
  "^TNX",
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
  "CL=F",
  "HG=F",
  "BTC-USD",
  "ZQ=F",
]);

function isMeta(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (META_SYMBOLS.has(s)) return true;
  // COMEX gold month codes (GCH27, GCZ27, ...) are futures, not equities.
  return /^GC[H-UZ]\d{2}$/.test(s);
}

/** Resolve display symbols to what Yahoo actually accepts. */
const YAHOO_ALIAS: Record<string, string> = {
  XAUUSD: "XAUUSD=X",
  XAGUSD: "XAGUSD=X",
};

function yahooSymbol(symbol: string): string {
  return YAHOO_ALIAS[symbol.toUpperCase()] ?? symbol;
}

export { yahooSymbol };

// If Yahoo ever stops serving the spot pair (delisted/404), the near-equivalent
// futures are an identical chart substitute: spot ≈ GC=F within a few dollars.
const SPOT_FALLBACK: Record<string, string> = {
  XAUUSD: "GC=F",
  "XAUUSD=X": "GC=F",
  "GC=F": "GC=F",
  XAGUSD: "SI=F",
  "XAGUSD=X": "SI=F",
  "SI=F": "SI=F",
};

export function spotFallback(symbol: string): string | null {
  return SPOT_FALLBACK[symbol.toUpperCase()] ?? null;
}

// ---- Alternative primary providers (Yahoo is geo-blocked on some networks) ----
// Sina Finance (hq.sinajs.cn) covers spot metals, precious-metals futures and FX
// pairs; CNBC covers the US Dollar Index and US equities. These come BEFORE
// Yahoo in the chain so the gold terminal works even with Yahoo unreachable.

/** Map a display symbol to a Sina hq symbol (with a friendly label). */
const SINA_QUOTE_TARGET: Record<string, { code: string; name: string; fx?: boolean }> = {
  XAUUSD: { code: "hf_XAU", name: "Gold Spot / US Dollar" },
  "XAUUSD=X": { code: "hf_XAU", name: "Gold Spot / US Dollar" },
  "GC=F": { code: "hf_GC", name: "Gold Futures (COMEX)" },
  XAGUSD: { code: "hf_XAG", name: "Silver Spot / US Dollar" },
  "XAGUSD=X": { code: "hf_XAG", name: "Silver Spot / US Dollar" },
  "SI=F": { code: "hf_SI", name: "Silver Futures (COMEX)" },
  "EURUSD=X": { code: "fx_seurusd", name: "EUR/USD", fx: true },
  "GBPUSD=X": { code: "fx_sgbpusd", name: "GBP/USD", fx: true },
  "USDJPY=X": { code: "fx_susdjpy", name: "USD/JPY", fx: true },
  "EURGBP=X": { code: "fx_seurgbp", name: "EUR/GBP", fx: true },
};

/** Map a display symbol to its Sina global-futures kline symbol (XAU gold, XAG silver). */
const SINA_KLINE: Record<string, string> = {
  XAUUSD: "XAU",
  "XAUUSD=X": "XAU",
  XAGUSD: "XAG",
  "XAGUSD=X": "XAG",
};

/** Symbols Sina quotes (with recent-session high/low via its daily kline). */
const SINA_BEST = new Set(["XAUUSD", "XAUUSD=X"]);

/** Map display symbol → CNBC quote symbol. */
const CNBC_SYMBOL: Record<string, string> = {
  "DX-Y.NYB": ".DXY",
  "^VIX": ".VIX",
  "^TNX": "US10Y",
};

function fail(req: any, res: any, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[market]", req.path, detail);
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly.", detail });
}

/** Upper bound for a cold analytics fetch: never let a slow provider chain
 *  hold a desk route hostage. The underlying promise keeps running and seeds
 *  the cache, so the next request gets the full result. */
function withBudget<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback()), ms))]);
}

// ---- VIX: served from FRED (daily close) since it's an index, not a tradable
// equity — Nasdaq's stock API doesn't carry it.

function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

async function vixQuote(): Promise<yahoo.Quote> {
  // CNBC serves the CBOE Volatility Index in real time (delayed a few seconds).
  try {
    const live = await tracked("cnbc", () => cnbc.quote(".VIX", "CBOE Volatility Index", "^VIX"));
    if (live.price !== null) return { ...live, symbol: "^VIX", source: "cnbc" };
    throw new Error("cnbc: empty VIX price");
  } catch {
    // FRED's daily close as fallback.
  }
  const points = await tracked("fred", () => fred.series("VIXCLS", 5));
  if (points.length === 0) throw new Error("fred: no VIX data");
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const price = last.value;
  const previousClose = prev?.value ?? null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return {
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    price,
    change,
    changePercent,
    open: null,
    high: null,
    low: null,
    previousClose,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "CBOE",
    marketState: null,
    time: null,
    source: "fred",
  };
}

const VIX_RANGE_N: Record<string, number> = {
  "1D": 5,
  "5D": 5,
  "1M": 22,
  "6M": 130,
  YTD: 200,
  "1Y": 252,
  "5Y": 1260,
  MAX: 20_000,
};

async function vixHistory(rangeKey: string): Promise<yahoo.Candle[]> {
  const n = VIX_RANGE_N[rangeKey] ?? 130;
  const points = await tracked("fred", () => fred.series("VIXCLS", n));
  return points.map((p) => {
    const time = Math.floor(new Date(p.date + "T00:00:00Z").getTime() / 1000);
    return { time, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0 };
  });
}

/**
 * Rich XAUUSD quote: live spot price from Sina hf_XAU, plus the previous
 * completed session's real daily high/low/close (from Sina's daily kline) so
 * pivot levels and day-range stats in the UI are computed correctly.
 */
async function sinaGoldQuote(): Promise<yahoo.Quote> {
  const live = await sina.quote("hf_XAU", "Gold Spot / US Dollar", "XAUUSD");
  try {
    const daily = await sina.dailyHistory("XAU");
    const sorted = [...daily].sort((a, b) => a.time - b.time);
    const last = sorted[sorted.length - 1];
    const prevClose = lastCompletedClose(sorted) ?? live.previousClose;
    const change = live.price !== null && prevClose !== null ? live.price - prevClose : null;
    return {
      ...live,
      name: "Gold Spot / US Dollar",
      previousClose: prevClose,
      open: last?.open ?? live.open,
      high: last?.high ?? live.high,
      low: last?.low ?? live.low,
      change,
      changePercent: change !== null && prevClose ? (change / prevClose) * 100 : null,
      source: "sina",
    };
  } catch {
    return live;
  }
}

// ---- quote statistic normalization ----

/** Sina kline bar dates are Beijing-time calendar days stored at UTC midnight. */
export function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The last *completed* session's close: if the final bar is today's live bar
 * it's still forming, so use the bar before it; over a weekend the last bar is
 * the last completed one.
 */
export function lastCompletedClose(sorted: yahoo.Candle[]): number | null {
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  const lastDate = new Date(last.time * 1000).toISOString().slice(0, 10);
  const prev = sorted[sorted.length - 2];
  return lastDate === beijingToday() ? (prev?.close ?? last.close) : last.close;
}

/** Prev-day ECB reference closes used to compute FX change/changePercent. */
const FX_PREV: Record<string, { flag: string; base: string }> = {
  "EURUSD=X": { flag: "EUR", base: "USD" },
  "GBPUSD=X": { flag: "GBP", base: "USD" },
  "USDJPY=X": { flag: "JPY", base: "USD" },
};

let fxPrevCache: { at: number; closes: Record<string, number> } | null = null;

async function fxPrevCloses(): Promise<Record<string, number>> {
  if (fxPrevCache && Date.now() - fxPrevCache.at < 12 * 3600_000) return fxPrevCache.closes;
  const dateStr = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
  const url = `https://api.frankfurter.app/${dateStr}?from=USD&to=EUR,GBP,JPY`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("frankfurter " + res.status);
  const json = await res.json();
  const rates: Record<string, number> = json?.rates ?? {};
  const closes: Record<string, number> = {};
  if (typeof rates.EUR === "number" && rates.EUR !== 0) closes["EURUSD=X"] = 1 / rates.EUR;
  if (typeof rates.GBP === "number" && rates.GBP !== 0) closes["GBPUSD=X"] = 1 / rates.GBP;
  if (typeof rates.JPY === "number") closes["USDJPY=X"] = rates.JPY;
  fxPrevCache = { at: Date.now(), closes };
  return closes;
}

// Memoized "spot's daily move" (current spot − last completed spot session):
// the derived futures previousClose is q.price − this delta, and the delta only
// moves intraday, so caching it for 30 seconds lets a burst of enrichQuote
// calls (several widgets polling the same futures) skip the Sina round-trips.
const spotMoveCache = new Map<string, { at: number; delta: number | null }>();
const SPOT_MOVE_TTL = 30_000;

async function futuresSpotMove(symbol: "GC=F" | "SI=F"): Promise<number | null> {
  const hit = spotMoveCache.get(symbol);
  if (hit && Date.now() - hit.at < SPOT_MOVE_TTL) return hit.delta;
  let delta: number | null = null;
  try {
    const code = symbol === "GC=F" ? "XAU" : "XAG";
    const daily = await sina.dailyHistory(code);
    const prevSpot = lastCompletedClose([...daily].sort((a, b) => a.time - b.time));
    const live = await sina.quote(code === "XAU" ? "hf_XAU" : "hf_XAG", "metals", symbol);
    if (prevSpot !== null && live.price !== null) delta = live.price - prevSpot;
  } catch {
    // leave null
  }
  spotMoveCache.set(symbol, { at: Date.now(), delta });
  return delta;
}

/**
 * Make a quote fully self-consistent: fill missing high/low, derive
 * previousClose for FX pairs (ECB) and for gold/silver futures (spot daily
 * delta), then compute change / changePercent whenever the pieces exist so
 * no correlated-market cell ever shows "—" for a live price.
 */
async function enrichQuote(q: yahoo.Quote): Promise<yahoo.Quote> {
  if (q.price === null) return q;

  if (q.previousClose === 0) q.previousClose = null;
  if (q.previousClose === null && q.change !== null) q.previousClose = q.price - q.change;

  if (q.previousClose === null && FX_PREV[q.symbol]) {
    try {
      const closes = await fxPrevCloses();
      if (closes[q.symbol] !== undefined) q.previousClose = closes[q.symbol];
    } catch {
      // leave null; FX quote still shows price
    }
  }

  const prevCloseSource = q.symbol === "GC=F" || q.symbol === "SI=F";
  if (q.previousClose === null && prevCloseSource) {
    const delta = await futuresSpotMove(q.symbol as "GC=F" | "SI=F");
    if (delta !== null) q.previousClose = q.price - delta;
  }

  if (q.change === null && q.previousClose !== null) q.change = q.price - q.previousClose;
  if (q.changePercent === null && q.change !== null && q.previousClose !== null && q.previousClose !== 0) {
    q.changePercent = (q.change / q.previousClose) * 100;
  }
  if (q.high === null || q.high < q.price) q.high = Math.max(q.high ?? q.price, q.price);
  if (q.low === null || q.low > q.price) q.low = Math.min(q.low ?? q.price, q.price);
  return q;
}

// ---- quotes (per-symbol cache, so overlapping widgets share one fetch) ----

/**
 * Resolve quotes for a symbol list. Sina is primary for spot metals and FX,
 * CNBC for the US Dollar Index, Nasdaq for listed equities/ETFs (GLD, GDX,
 * SPY, TLT, UUP…); Yahoo remains a fallback for the rest, Stooq last.
 * A symbol that fails anywhere still falls back to its last-known value
 * instead of failing the whole batch.
 */
export async function getQuotes(symbols: string[]): Promise<yahoo.Quote[]> {
  const fresh = new Map<string, yahoo.Quote>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet<yahoo.Quote>(`quote:${sym}`);
    if (hit) fresh.set(sym, hit);
    else missing.push(sym);
  }
  if (missing.length === 0) return symbols.map((s) => fresh.get(s)!).filter(Boolean);

  const fetched = new Map<string, yahoo.Quote>();
  let remaining = missing;

  const vixSymbols = remaining.filter((s) => isVix(s));
  if (vixSymbols.length > 0) {
    const results = await Promise.allSettled(vixSymbols.map(() => vixQuote()));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(vixSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // Sina: spot metals, precious-metals futures, FX pairs.
  const sinaTargets = remaining.filter((s) => SINA_QUOTE_TARGET[s]);
  if (sinaTargets.length > 0) {
    const results = await Promise.allSettled(
      sinaTargets.map((s) =>
        tracked("sina", () =>
          SINA_BEST.has(s)
            ? sinaGoldQuote()
            : sina.quote(SINA_QUOTE_TARGET[s].code, SINA_QUOTE_TARGET[s].name, s, { fx: SINA_QUOTE_TARGET[s].fx })
        )
      )
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(sinaTargets[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // CNBC: US Dollar Index.
  const cnbcTargets = remaining.filter((s) => CNBC_SYMBOL[s]);
  if (cnbcTargets.length > 0) {
    const results = await Promise.allSettled(
      cnbcTargets.map((s) => tracked("cnbc", () => cnbc.quote(CNBC_SYMBOL[s], "US Dollar Index (DXY)", s)))
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(cnbcTargets[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const equity = remaining.filter((s) => !isMeta(s));
  if (equity.length > 0) {
    const results = await Promise.allSettled(equity.map((s) => tracked("nasdaq", () => nasdaq.quote(s))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(equity[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // CNBC fallback for US equities (Nasdaq sometimes returns null rows).
  if (remaining.length > 0) {
    const results = await Promise.allSettled(remaining.map((s) => cnbc.quote(s, s, s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(remaining[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    try {
      const rows = await tracked("yahoo", () => yahoo.quotes(remaining.map(yahooSymbol)));
      for (const q of rows) {
        const key = Object.keys(YAHOO_ALIAS).find((k) => YAHOO_ALIAS[k] === q.symbol);
        fetched.set(key ?? q.symbol, { ...q, symbol: key ?? q.symbol });
      }
      remaining = remaining.filter((s) => !fetched.has(s));
    } catch {
      // fall through to chart-based per-symbol fetch below
    }
  }

  if (remaining.length > 0) {
    const results = await Promise.allSettled(remaining.map((s) => tracked("yahoo", () => yahoo.quoteFromChart(yahooSymbol(s)))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(remaining[i], { ...r.value, symbol: remaining[i] });
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    const results = await Promise.allSettled(
      remaining.map((s) => tracked("yahoo", () => yahoo.quoteFromChart(spotFallback(s) ?? yahooSymbol(s))))
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const fb = spotFallback(remaining[i]);
        fetched.set(remaining[i], {
          ...r.value,
          symbol: remaining[i],
          source: fb && fb !== yahooSymbol(remaining[i]) ? `${r.value.source} (${fb})` : r.value.source,
        });
      }
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    const results = await Promise.allSettled(remaining.slice(0, 20).map((s) => tracked("stooq", () => stooq.quote(s))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(remaining[i], r.value);
    });
  }

  // Normalize every freshly fetched quote (fill change/pct/high/low/prevClose)
  // before handing it to the UI, then cache it.
  const enriched = await Promise.allSettled([...fetched.values()].map(enrichQuote));
  const enrichedMap = new Map<string, yahoo.Quote>();
  [...fetched.keys()].forEach((sym, i) => {
    const r = enriched[i];
    if (r.status === "fulfilled") enrichedMap.set(sym, r.value);
    else enrichedMap.set(sym, fetched.get(sym)!);
  });
  for (const [sym, q] of enrichedMap) cacheStore(`quote:${sym}`, q, QUOTE_TTL);

  const out: yahoo.Quote[] = [];
  for (const sym of symbols) {
    const q = fresh.get(sym) ?? fetched.get(sym) ?? staleGet<yahoo.Quote>(`quote:${sym}`);
    if (q) out.push(q);
  }
  return out;
}

marketRouter.get("/quotes", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  try {
    const out = await getQuotes(symbols);
    res.json(out);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- history / candles ----
// A "range" here is really a chart timeframe: 1m/5m/15m/30m/1h/4h intraday,
// then 1D/1W/1M. Intraday bars come from Yahoo (spot gold, FX, futures all
// support intraday there); daily bars additionally fall back to Stooq.

type RangeSpec = { range: string; interval: string; agg?: number; intraday?: boolean };

const RANGE_MAP: Record<string, RangeSpec> = {
  "1m": { range: "1d", interval: "1m", intraday: true },
  "5m": { range: "5d", interval: "5m", intraday: true },
  "15m": { range: "1mo", interval: "15m", intraday: true },
  "30m": { range: "1mo", interval: "30m", intraday: true },
  "1h": { range: "3mo", interval: "60m", intraday: true },
  "4h": { range: "3mo", interval: "60m", agg: 4, intraday: true },
  "1D": { range: "2y", interval: "1d" },
  "1W": { range: "5y", interval: "1wk" },
  "1M": { range: "max", interval: "1mo" },
};

export function rangeSpec(rangeKey: string): RangeSpec {
  return RANGE_MAP[rangeKey] ?? RANGE_MAP["1D"];
}

export function aggregate(candles: yahoo.Candle[], n: number): yahoo.Candle[] {
  const out: yahoo.Candle[] = [];
  for (let i = 0; i < candles.length; i += n) {
    const slice = candles.slice(i, i + n);
    if (slice.length === 0) continue;
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

/** Bucket daily candles into weeks (Monday-start weeks). */
export function toWeekly(candles: yahoo.Candle[]): yahoo.Candle[] {
  const out: yahoo.Candle[] = [];
  let bucket: yahoo.Candle[] = [];
  let bucketWeek = -1;
  const weekOf = (time: number) => {
    const u = new Date(time * 1000);
    const day = u.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day; // back to Monday
    return Math.floor((u.getTime() + diff * 86_400_000) / (7 * 86_400_000));
  };
  for (const c of [...candles].sort((a, b) => a.time - b.time)) {
    const week = weekOf(c.time);
    if (bucketWeek !== -1 && week !== bucketWeek) {
      out.push({
        time: bucket[0].time,
        open: bucket[0].open,
        high: Math.max(...bucket.map((x) => x.high)),
        low: Math.min(...bucket.map((x) => x.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((s, x) => s + x.volume, 0),
      });
      bucket = [];
    }
    bucketWeek = week;
    bucket.push(c);
  }
  if (bucket.length > 0) {
    out.push({
      time: bucket[0].time,
      open: bucket[0].open,
      high: Math.max(...bucket.map((x) => x.high)),
      low: Math.min(...bucket.map((x) => x.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}

/** Bucket daily candles into calendar months. */
export function toMonthly(candles: yahoo.Candle[]): yahoo.Candle[] {
  const out: yahoo.Candle[] = [];
  let bucket: yahoo.Candle[] = [];
  let bucketKey: string | null = null;
  for (const c of [...candles].sort((a, b) => a.time - b.time)) {
    const key = new Date(c.time * 1000).toISOString().slice(0, 7);
    if (bucketKey !== null && key !== bucketKey) {
      out.push({
        time: bucket[0].time,
        open: bucket[0].open,
        high: Math.max(...bucket.map((x) => x.high)),
        low: Math.min(...bucket.map((x) => x.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((s, x) => s + x.volume, 0),
      });
      bucket = [];
    }
    bucketKey = key;
    bucket.push(c);
  }
  if (bucket.length > 0) {
    out.push({
      time: bucket[0].time,
      open: bucket[0].open,
      high: Math.max(...bucket.map((x) => x.high)),
      low: Math.min(...bucket.map((x) => x.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}

export type SeasonalityRow = {
  month: number; // 1..12
  label: string;
  avgPct: number; // mean month-over-month return of the close
  medianPct: number;
  winRate: number; // 0..1 fraction of years with a positive month
  avgMovePct: number; // mean absolute move (volatility gauge)
  count: number;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monthly seasonality from daily candles — % move of the close month-over-month,
 *  bucketed by calendar month across all years in the series. */
export function computeSeasonality(daily: yahoo.Candle[]): SeasonalityRow[] {
  const sorted = [...daily].sort((a, b) => a.time - b.time);
  const perMonth: number[][] = Array.from({ length: 12 }, () => []);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.close === 0 || !Number.isFinite(prev.close)) continue;
    const m = new Date(cur.time * 1000).getUTCMonth(); // 0-indexed
    perMonth[m].push((cur.close / prev.close - 1) * 100);
  }
  const pct = (arr: number[], f: (a: number[]) => number): number =>
    arr.length === 0 ? 0 : f(arr);
  const median = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;
  return Array.from({ length: 12 }, (_, idx) => {
    const month = idx + 1;
    const vals = perMonth[idx];
    return {
      month,
      label: MONTH_LABELS[idx],
      avgPct: r4(pct(vals, (a) => a.reduce((s, x) => s + x, 0) / a.length)),
      medianPct: r4(median(vals)),
      winRate: r4(vals.length === 0 ? 0 : vals.filter((v) => v > 0).length / vals.length),
      avgMovePct: r4(pct(vals, (a) => a.reduce((s, x) => s + Math.abs(x), 0) / a.length)),
      count: vals.length,
    };
  });
}

export type SessionStat = {
  date: string; // UTC day the session covers
  open: number;
  high: number;
  low: number;
  close: number;
  move: number; // close − open
  movePct: number;
  rangePct: number; // (high − low) / open
  isCurrent: boolean; // true for the still-forming session that contains "now"
};

/** Bucket intraday bars into per-session OHLC (a session = one UTC day for
 *  spot metals) and fill earlier completed sessions from the daily line when
 *  the intraday tape only covers the live session. Returns the last N sessions,
 *  ascending, with the forming one flagged. */
export function computeSessions(intraday: yahoo.Candle[], daily: yahoo.Candle[], limit = 7, nowMs = Date.now()): SessionStat[] {
  const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const sessions = new Map<string, { open: number; high: number; low: number; close: number; count: number }>();

  for (const b of [...intraday].sort((a, b) => a.time - b.time)) {
    const key = dayKey(b.time);
    const s = sessions.get(key) ?? { open: b.open, high: b.high, low: b.low, close: b.close, count: 0 };
    if (s.count === 0) s.open = b.open; else s.open = Math.min(s.open, b.open);
    s.high = Math.max(s.high, b.high);
    s.low = Math.min(s.low, b.low);
    s.close = b.close;
    s.count++;
    sessions.set(key, s);
  }
  const today = dayKey(nowMs / 1000);
  const intradayDays = new Set(sessions.keys());

  for (const d of [...daily].sort((a, b) => a.time - b.time)) {
    const key = dayKey(d.time);
    if (key === today) continue; // daily's today bar is still forming; intraday covers it
    if (sessions.has(key)) continue;
    sessions.set(key, { open: d.open, high: d.high, low: d.low, close: d.close, count: 1 });
  }

  return [...sessions.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([date, s]) => {
      const move = s.close - s.open;
      const movePct = s.open !== 0 ? (move / s.open) * 100 : 0;
      const rangePct = s.open !== 0 ? ((s.high - s.low) / s.open) * 100 : 0;
      return { date, open: s.open, high: s.high, low: s.low, close: s.close, move, movePct, rangePct, isCurrent: date === today };
    });
}

/** Multi-day intraday from Yahoo, using the closest futures substitute when the
 *  spot pair itself has no Yahoo intraday series (XAUUSD → GC=F, XAGUSD → SI=F).
 *  Used for long timeframes (4h) a single Sina session can't cover. */
async function yahooLongIntraday(symbol: string, range: string, interval: string): Promise<yahoo.Candle[]> {
  const fb = spotFallback(symbol);
  const candidates = fb && fb !== yahooSymbol(symbol) ? [yahooSymbol(symbol), fb] : [yahooSymbol(symbol)];
  let lastErr: unknown = new Error("yahoo intraday: no source");
  for (const cand of candidates) {
    try {
      const candles = await yahoo.history(cand, range, interval);
      if (candles.length === 0) throw new Error("yahoo: empty intraday");
      return candles;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** History for spot metals / FX / futures: Sina intraday + daily first, then
 *  Yahoo with a GC=F/SI=F spot fallback, then Stooq for daily. */
async function metaHistory(symbol: string, spec: RangeSpec): Promise<yahoo.Candle[]> {
  const klineSym = SINA_KLINE[symbol];
  if (klineSym) {
    try {
      if (spec.intraday) {
        // 1h/4h need a multi-day tape: a single Sina session only yields ~5
        // four-hour bars, far short of the ~14 required for structure.
        if (spec.interval === "60m") {
          try {
            const bars = await tracked("yahoo", () => yahooLongIntraday(symbol, "3mo", "60m"));
            if (bars.length >= 14) return spec.agg ? aggregate(bars, spec.agg) : bars;
          } catch {
            // fall through to the current-session minute line below
          }
        }
        // Sub-hour ranges: the live Sina session is the fast path. Outside
        // market hours (weekend / pre-open / a Sina gap) its last bar is hours
        // old, so fall back to Yahoo's multi-day tape — the structure board
        // must never pin a single frozen session.
        const minuteBars = await tracked("sina", () => sina.minuteHistory(klineSym)).catch(
          () => null as yahoo.Candle[] | null
        );
        const baseMult =
          {
            "1m": 1,
            "5m": 5,
            "15m": 15,
            "30m": 30,
            "60m": 60, // 1h and 4h both request 60m bars
          }[spec.interval] ?? 1;
        const mult = baseMult * (spec.agg ?? 1); // 4h = 60m × 4
        const sessionBars = minuteBars && minuteBars.length > 0 ? (mult === 1 ? minuteBars : aggregate(minuteBars, mult)) : null;
        const lastTime = minuteBars && minuteBars.length > 0 ? minuteBars[minuteBars.length - 1].time : 0;
        const fresh = lastTime > 0 && Date.now() - lastTime * 1000 < 2 * 3600_000;
        if (fresh && sessionBars && sessionBars.length > 0) return sessionBars;
        // Stale session — paint the multi-day Yahoo tape instead. Nested cache
        // keeps weekend polling off the upstream (60s dedupe vs the 5s route TTL).
        try {
          const offHours = await cached(`history:offhours:${symbol}:${spec.range}:${spec.interval}`, HISTORY_TTL_LONG, () =>
            tracked("yahoo", () => yahooLongIntraday(symbol, spec.range, spec.interval))
          );
          if (offHours.length >= 14) return spec.agg ? aggregate(offHours, spec.agg) : offHours;
        } catch {
          // fall through to the session bars below rather than failing
        }
        if (sessionBars && sessionBars.length > 0) return sessionBars;
        throw new Error("no intraday data (Sina session closed and Yahoo unavailable)");
      }
      const daily = await tracked("sina", () => sina.dailyHistory(klineSym));
      if (spec.interval === "1wk") return toWeekly(daily);
      if (spec.interval === "1mo") return toMonthly(daily);
      return daily;
    } catch (err) {
      // fall through to the Yahoo/Stooq chain below
      return fallbackMetaHistory(symbol, spec);
    }
  }
  return fallbackMetaHistory(symbol, spec);
}

/** Yahoo (primary) with GC=F/SI=F spot fallback, then Stooq for daily. */
async function fallbackMetaHistory(symbol: string, spec: RangeSpec): Promise<yahoo.Candle[]> {
  const fb = spotFallback(symbol);
  const candidates = fb && fb !== yahooSymbol(symbol) ? [yahooSymbol(symbol), fb] : [yahooSymbol(symbol)];
  let lastErr: unknown;
  for (const cand of candidates) {
    try {
      const candles = await tracked("yahoo", () => yahoo.history(cand, spec.range, spec.interval));
      if (candles.length === 0) throw new Error("yahoo: empty history");
      return spec.agg ? aggregate(candles, spec.agg) : candles;
    } catch (err) {
      lastErr = err;
    }
  }
  // No intraday source besides Yahoo/Stooq for spot metals beyond the current
  // session — surface the failure rather than returning mismatched daily bars.
  if (spec.intraday) throw lastErr;
  const daily = await tracked("stooq", () => stooq.history(symbol));
  if (spec.interval === "1wk") return toWeekly(daily);
  if (spec.interval === "1mo") return toMonthly(daily);
  return daily;
}

marketRouter.get("/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const rangeKey = String(req.query.range ?? "1D");
  try {
    const spec = rangeSpec(rangeKey);
    // 1h/4h are served from Yahoo's multi-day hourly tape; they only move
    // hourly, so a longer TTL keeps the feed gentle on the upstream while
    // staying fresh.
    const ttl = spec.intraday && spec.interval === "60m" ? HISTORY_TTL_LONG : HISTORY_TTL;
    const data = await cached(`history:${symbol}:${rangeKey}`, ttl, () =>
      isVix(symbol)
        ? vixHistory(rangeKey)
        : isMeta(symbol)
          ? metaHistory(symbol, spec)
          : withFallback([
              ["nasdaq", () => nasdaq.history(symbol, rangeKey)],
              ["yahoo", () => yahoo.history(symbol, spec.range, spec.interval)],
              ["stooq", () => stooq.history(symbol)],
            ])
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty history from all providers");
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- news (gold-centric) ----

marketRouter.get("/news/geopolitics", async (req, res) => {
  try {
    const data = await cached("news:geopolitics", NEWS_TTL, () => tracked("news", () => news.geopoliticsNews()));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/news", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  try {
    const data = await cached(`news:${symbol ?? "gold"}`, NEWS_TTL, () => buildGoldNews(symbol));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

async function buildGoldNews(symbol: string | null) {
  const queries = symbol
    ? [
        news.symbolNews(yahooSymbol(symbol)),
        news.topNews(`${symbol === "XAUUSD" ? "gold price" : symbol} market`),
      ]
    : [
        news.topNews("gold price"),
        news.topNews("gold market"),
        news.topNews("federal reserve gold dollar"),
      ];
  const lists = await Promise.allSettled(
    queries.map((q) => tracked("news", () => q))
  );
  const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
  if (ok.length === 0) throw new Error("all news sources failed");
  return news.dedupe(ok)
    .slice(0, 40)
    .map((n) => ({ ...n, impact: news.impactOf(n.title), sentiment: news.sentimentOf(n.title) }));
}

// ---- economic calendar (Fed / ECB / CPI / NFP with forecast + actual) — the
// releases that actually move gold. ----

marketRouter.get("/econ-calendar", async (req, res) => {
  try {
    const data = await cached("econ-calendar", 300_000, () => tracked("forexfactory", () => econcalendar.weeklyEvents()));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- seasonality: average monthly % returns (and win rate) for a symbol,
// computed from its daily line. Gold's seasonality (stronger late-summer and
// Q4 runs) is a real pattern traders track. ----

marketRouter.get("/seasonality", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
  try {
    const data = await cached(`seasonality:${symbol}`, HISTORY_TTL_LONG, () =>
      tracked(`history:${symbol}`, () =>
        (isVix(symbol)
          ? vixHistory("1D")
          : isMeta(symbol)
            ? metaHistory(symbol, rangeSpec("1D"))
            : withFallback([
                ["nasdaq", () => nasdaq.history(symbol, "1D")],
                ["yahoo", () => yahoo.history(symbol, "1d", "1d")],
                ["stooq", () => stooq.history(symbol)],
              ])
        ).then((daily) => computeSeasonality(daily))
      )
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- session stats: the last few completed sessions (one UTC day of spot
// trading each) plus the still-forming one, from the live 15m tape. ----

marketRouter.get("/session-stats", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
  try {
    const data = await cached(`session-stats:${symbol}`, 30_000, async () => {
      const [intraday, daily] = await Promise.all([
        isVix(symbol)
          ? vixHistory("15m")
          : isMeta(symbol)
            ? metaHistory(symbol, rangeSpec("15m"))
            : withFallback([
                ["nasdaq", () => nasdaq.history(symbol, "15m")],
                ["yahoo", () => yahoo.history(symbol, "5d", "15m")],
                ["stooq", () => stooq.history(symbol)],
              ]),
        cached(`history:${symbol}:1D`, HISTORY_TTL, () =>
          isVix(symbol)
            ? vixHistory("1D")
            : isMeta(symbol)
              ? metaHistory(symbol, rangeSpec("1D"))
              : withFallback([
                  ["nasdaq", () => nasdaq.history(symbol, "1D")],
                  ["yahoo", () => yahoo.history(symbol, "1d", "1d")],
                  ["stooq", () => stooq.history(symbol)],
                ])
        ),
      ]);
      if (!Array.isArray(intraday) || intraday.length === 0) throw new Error("no intraday tape");
      if (!Array.isArray(daily) || daily.length === 0) throw new Error("no daily line");
      return computeSessions(intraday, daily);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- gold macro: the drivers that matter for XAUUSD ----
// US yields, the 10Y real (TIPS) yield, breakeven inflation, the fed funds
// rate and VIX all come from FRED; correlated markets are quoted live.

const RATE_SERIES: Array<{ id: string; label: string; pct: boolean }> = [
  { id: "DGS2", label: "US 2Y Yield", pct: true },
  { id: "DGS10", label: "US 10Y Yield", pct: true },
  { id: "DGS30", label: "US 30Y Yield", pct: true },
  { id: "DFII10", label: "US 10Y Real Yield", pct: true },
  { id: "T10YIE", label: "10Y Breakeven", pct: true },
  { id: "FEDFUNDS", label: "Fed Funds Rate", pct: true },
  { id: "VIXCLS", label: "VIX", pct: false },
];

const CORRELATED: Array<{ symbol: string; label: string }> = [
  { symbol: "XAUUSD", label: "Gold Spot (XAUUSD)" },
  { symbol: "GC=F", label: "Gold Futures (COMEX)" },
  { symbol: "XAGUSD=X", label: "Silver Spot (XAGUSD)" },
  { symbol: "GLD", label: "Gold ETF (GLD)" },
  { symbol: "GDX", label: "Gold Miners (GDX)" },
  { symbol: "DX-Y.NYB", label: "US Dollar Index (DXY)" },
  { symbol: "UUP", label: "Dollar ETF (UUP)" },
  { symbol: "EURUSD=X", label: "EUR/USD" },
  { symbol: "SPY", label: "S&P 500 (SPY)" },
  { symbol: "TLT", label: "20Y+ Treasury (TLT)" },
  { symbol: "CL=F", label: "WTI Crude Oil (CL=F)" },
  { symbol: "HG=F", label: "Copper (HG=F)" },
  { symbol: "BTC-USD", label: "Bitcoin (BTC-USD)" },
];

marketRouter.get("/gold-macro", async (req, res) => {
  try {
    const data = await cached("gold-macro", 10_000, () => buildGoldMacro());
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

async function buildGoldMacro() {
  const [rateResults, quotes, liveRates] = await Promise.all([
    Promise.allSettled(RATE_SERIES.map((s) => cached(`fred:${s.id}`, FRED_TTL, () => tracked("fred", () => fred.latest(s.id))))),
    getQuotes(CORRELATED.map((c) => c.symbol)),
    // Real-time overrides for the two series that matter intraday but are
    // served by FRED as daily closes by default.
    getQuotes(["^VIX", "^TNX"]),
  ]);
  const liveMap = new Map(liveRates.map((q) => [q.symbol, q]));
  const rates = RATE_SERIES.map((s, i) => ({
    id: s.id,
    label: s.label,
    pct: s.pct,
    value:
      s.id === "VIXCLS"
        ? liveMap.get("^VIX")?.price ?? (rateResults[i].status === "fulfilled" ? (rateResults[i].value?.value ?? null) : null)
        : s.id === "DGS10"
          ? liveMap.get("^TNX")?.price ?? (rateResults[i].status === "fulfilled" ? (rateResults[i].value?.value ?? null) : null)
          : rateResults[i].status === "fulfilled"
            ? (rateResults[i].value?.value ?? null)
            : null,
  })).filter((r) => r.value !== null);

  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const markets: Array<{ symbol: string; label: string; price: number | null; change: number | null; changePercent: number | null }> = CORRELATED.map((c) => {
    const q = bySymbol.get(c.symbol);
    return {
      symbol: c.symbol,
      label: c.label,
      price: q?.price ?? null,
      change: q?.change ?? null,
      changePercent: q?.changePercent ?? null,
    };
  });
  // Derived cross-compare: the gold/silver ratio — a classic broad-metals
  // demand gauge. Pure price ratio from the two spot quotes we already fetch.
  const xau = bySymbol.get("XAUUSD")?.price;
  const xag = bySymbol.get("XAGUSD=X")?.price;
  if (xau !== undefined && xau !== null && xag !== undefined && xag !== null && xag !== 0) {
    markets.push({ symbol: "XAU/XAG", label: "Gold/Silver Ratio", price: xau / xag, change: null, changePercent: null });
  }

  if (rates.length === 0 && markets.every((m) => m.price === null)) throw new Error("no macro data from any provider");
  return { rates, markets };
}

// ===========================================================================
//  Desk features: tape, volatility stats, futures curve, options, COT, rate
//  probabilities, ETF flow proxy, correlation matrix, and CSV export.
// ===========================================================================

/** History resolve shared by the analytics routes. */
async function historyFor(symbol: string, rangeKey: string): Promise<yahoo.Candle[]> {
  const spec = rangeSpec(rangeKey);
  if (isVix(symbol)) return vixHistory(rangeKey);
  if (isMeta(symbol)) return metaHistory(symbol, spec);
  return withFallback([
    ["nasdaq", () => nasdaq.history(symbol, rangeKey)],
    ["yahoo", () => yahoo.history(symbol, spec.range, spec.interval)],
    ["stooq", () => stooq.history(symbol)],
  ]);
}

// ---- tape: last-sale tick stream (from the quote cache ring) ----

marketRouter.get("/tape", async (req, res) => {
  const symbol = String(req.query.symbol ?? "XAUUSD").toUpperCase();
  try {
    const quote = cacheGet<yahoo.Quote>(`quote:${symbol}`);
    const ticks = getTape(symbol, 250);
    const spread =
      quote && quote.bid !== null && quote.ask !== null && quote.ask > quote.bid ? quote.ask - quote.bid : null;
    res.json({
      symbol,
      quote: quote ?? null,
      ticks,
      spread,
      lastSale: ticks.length > 0 ? ticks[ticks.length - 1] : null,
      n: ticks.length,
    });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- volatility / statistics desk ----

marketRouter.get("/stats", async (req, res) => {
  const symbol = String(req.query.symbol ?? "XAUUSD").toUpperCase();
  try {
    const data = await withBudget(
      cached(`stats:${symbol}`, HISTORY_TTL_LONG, async () => {
        const daily = await historyFor(symbol, "1D");
        if (!Array.isArray(daily) || daily.length === 0) throw new Error("no daily line");
        return computeStats(daily);
      }),
      15_000,
      () => staleGet(`stats:${symbol}`) ?? computeStats([])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- COMEX gold futures term structure ----

marketRouter.get("/futures-curve", async (req, res) => {
  try {
    const data = await withBudget(
      cached("futures-curve", 60_000, async () => {
        const contracts = nextContracts(new Date(), 10);
        const [spotQ, contractQs] = await Promise.all([
          getQuotes(["XAUUSD"]),
          getQuotes(contracts),
        ]);
        const spot = spotQ[0]?.price ?? null;
        const prices = new Map(contractQs.map((q) => [q.symbol, q.price ?? null]));
        return computeFuturesCurve(spot, contracts.map((c) => ({ symbol: c, price: prices.get(c) ?? null })));
      }),
      15_000,
      () => {
        const stale = staleGet<any>("futures-curve");
        if (stale) return stale;
        const contracts = nextContracts(new Date(), 10);
        const spot = cacheGet<yahoo.Quote>("quote:XAUUSD")?.price ?? null;
        return computeFuturesCurve(
          spot,
          contracts.map((c) => ({ symbol: c, price: cacheGet<yahoo.Quote>(`quote:${c}`)?.price ?? null }))
        );
      }
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- GC options: ATM IV, skew, put/call OI (nearest expiry) ----

marketRouter.get("/options", async (req, res) => {
  const symbol = String(req.query.symbol ?? "GC=F").toUpperCase();
  try {
    const data = await cached(`options:${symbol}`, 60_000, async () => {
      const chain = await tracked("yahoo", () => yahoo.options(symbol));
      return computeOptionsSummary(chain);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- COT: gold managed-money positioning (CFTC, released Fridays) ----

marketRouter.get("/cot", async (req, res) => {
  try {
    const data = await cached("cot:gold", 3_600_000, () =>
      tracked("cftc", () => cot.cotGold()).then((rows) => computeCotSummary(rows))
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- FedWatch-style rate probabilities from ZQ=F futures ----

marketRouter.get("/rate-probs", async (req, res) => {
  try {
    const data = await withBudget(
      cached("rate-probs", 60_000, async () => {
        const [funded, zq] = await Promise.all([
          cached(`fred:FEDFUNDS`, FRED_TTL, () => tracked("fred", () => fred.latest("FEDFUNDS"))),
          getQuotes(["ZQ=F"]),
        ]);
        const currentBp = funded?.value !== undefined && funded?.value !== null ? funded.value * 100 : null;
        const zqPrice = zq[0]?.price ?? null;
        const impliedBp = zqPrice !== null ? (100 - zqPrice) * 100 : null;
        return computeRateProbs(currentBp, impliedBp);
      }),
      15_000,
      () => staleGet("rate-probs") ?? computeRateProbs(null, null)
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- ETF flow proxy: directional dollars (Δclose × volume), labeled a proxy ----

const FLOW_ETFS: Record<string, string> = {
  GLD: "SPDR Gold Shares (GLD)",
  SLV: "iShares Silver Trust (SLV)",
  IAU: "iShares Gold Trust (IAU)",
  GDX: "VanEck Gold Miners (GDX)",
};

marketRouter.get("/etf-flows", async (req, res) => {
  const symbol = String(req.query.symbol ?? "GLD").toUpperCase();
  try {
    const data = await withBudget(
      cached(`etf-flow:${symbol}`, HISTORY_TTL_LONG, async () => {
        const daily = await historyFor(symbol, "1D");
        if (!Array.isArray(daily) || daily.length === 0) throw new Error("no daily line");
        return { label: FLOW_ETFS[symbol] ?? symbol, ...computeEtfFlowProxy(symbol, daily) };
      }),
      15_000,
      () => staleGet(`etf-flow:${symbol}`) ?? { label: FLOW_ETFS[symbol] ?? symbol, ...computeEtfFlowProxy(symbol, []) }
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- rolling 90-day correlation matrix across the gold complex ----

const CORR_UNIVERSE = ["XAUUSD", "GC=F", "XAGUSD=X", "DX-Y.NYB", "SPY", "TLT", "GLD", "^VIX", "EURUSD=X"];

marketRouter.get("/correlations", async (req, res) => {
  try {
    const data = await withBudget(
      cached("correlations", 300_000, async () => {
        const settled = await Promise.allSettled(
          CORR_UNIVERSE.map((s) => cached(`history:${s}:1D`, HISTORY_TTL_LONG, () => historyFor(s, "1D")))
        );
        const series: Record<string, yahoo.Candle[]> = {};
        settled.forEach((r, i) => {
          if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length > 90) {
            series[CORR_UNIVERSE[i]] = r.value;
          }
        });
        if (Object.keys(series).length < 2) throw new Error("not enough daily lines for a correlation matrix");
        return computeCorrelations(series, 90);
      }),
      15_000,
      () => staleGet("correlations") ?? computeCorrelations({}, 90)
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- consolidated market bias: every terminal data source weighted by a
// professional layered model (structure / momentum / location / macro /
// positioning / order flow / intermarket / sentiment). Single source of truth
// for the MARKET BIAS widget. ----

const settle = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

marketRouter.get("/market-bias", async (req, res) => {
  try {
    const data = await withBudget(
      cached("market-bias", 5_000, async () => {
        const now = Date.now();
        const symbol = "XAUUSD";

        const [h5, h15, h4h, h1d] = await Promise.all([
          cached(`history:${symbol}:5m`, HISTORY_TTL, () => historyFor(symbol, "5m")),
          cached(`history:${symbol}:15m`, HISTORY_TTL, () => historyFor(symbol, "15m")),
          cached(`history:${symbol}:4h`, HISTORY_TTL, () => historyFor(symbol, "4h")),
          cached(`history:${symbol}:1D`, HISTORY_TTL_LONG, () => historyFor(symbol, "1D")),
        ]);
        if (!Array.isArray(h15) || h15.length === 0) throw new Error("no intraday tape for bias");

        const [macro, stats, events, options, rateProbs, etf, cotSummary, corr, seasonality, sessions, newsList] = await Promise.all([
          settle(cached("gold-macro", 10_000, () => buildGoldMacro())),
          settle(
            cached(`stats:${symbol}`, HISTORY_TTL_LONG, async () => {
              const daily = await historyFor(symbol, "1D");
              if (!Array.isArray(daily) || daily.length === 0) throw new Error("no daily line for stats");
              return computeStats(daily);
            })
          ),
          settle(cached("econ-calendar", 300_000, () => tracked("forexfactory", () => econcalendar.weeklyEvents()))),
          settle(
            cached("options:GC=F", 60_000, async () => {
              const chain = await tracked("yahoo", () => yahoo.options("GC=F"));
              return computeOptionsSummary(chain);
            })
          ),
          settle(
            cached("rate-probs", 60_000, async () => {
              const [funded, zq] = await Promise.all([
                cached(`fred:FEDFUNDS`, FRED_TTL, () => tracked("fred", () => fred.latest("FEDFUNDS"))),
                getQuotes(["ZQ=F"]),
              ]);
              const currentBp = funded?.value !== undefined && funded?.value !== null ? funded.value * 100 : null;
              const zqPrice = zq[0]?.price ?? null;
              return computeRateProbs(currentBp, zqPrice !== null ? (100 - zqPrice) * 100 : null);
            })
          ),
          settle(
            cached(`etf-flow:GLD`, HISTORY_TTL_LONG, async () => {
              const daily = await historyFor("GLD", "1D");
              if (!Array.isArray(daily) || daily.length === 0) throw new Error("no GLD line");
              return computeEtfFlowProxy("GLD", daily);
            })
          ),
          settle(
            cached("cot:gold", 3_600_000, () =>
              tracked("cftc", () => cot.cotGold()).then((rows) => computeCotSummary(rows))
            )
          ),
          settle(
            cached("correlations", 300_000, async () => {
              const settled = await Promise.allSettled(
                CORR_UNIVERSE.map((s) => cached(`history:${s}:1D`, HISTORY_TTL_LONG, () => historyFor(s, "1D")))
              );
              const series: Record<string, yahoo.Candle[]> = {};
              settled.forEach((r, i) => {
                if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length > 90) {
                  series[CORR_UNIVERSE[i]] = r.value;
                }
              });
              return computeCorrelations(series, 90);
            })
          ),
          settle(
            cached(`seasonality:${symbol}`, HISTORY_TTL_LONG, async () => {
              const daily = await historyFor(symbol, "1D");
              return computeSeasonality(daily);
            })
          ),
          settle(
            cached(`session-stats:${symbol}`, 30_000, async () => {
              const [intraday, sdaily] = await Promise.all([
                isMeta(symbol)
                  ? metaHistory(symbol, rangeSpec("15m"))
                  : withFallback([
                      ["nasdaq", () => nasdaq.history(symbol, "15m")],
                      ["yahoo", () => yahoo.history(symbol, "5d", "15m")],
                      ["stooq", () => stooq.history(symbol)],
                    ]),
                cached(`history:${symbol}:1D`, HISTORY_TTL, () => historyFor(symbol, "1D")),
              ]);
              if (!Array.isArray(intraday) || intraday.length === 0) throw new Error("no intraday tape");
              return computeSessions(intraday, sdaily);
            })
          ),
          settle(cached(`news:gold`, NEWS_TTL, () => buildGoldNews(null))),
        ]);

        const live = cacheGet<yahoo.Quote>(`quote:${symbol}`);
        const tape = getTape(symbol, 60).map((t) => ({ t: t.t, price: t.price }));

        return computeBias({
          symbol,
          m5: h5,
          m15: h15,
          h4: h4h,
          daily: h1d,
          price: live?.price ?? null,
          feedT: live?.time !== null && live?.time !== undefined ? live.time * 1000 : null,
          macro: macro ?? null,
          stats: stats ?? null,
          events: events ?? null,
          options: options ?? null,
          rateProbs: rateProbs ?? null,
          etf: etf ?? null,
          cot: cotSummary ?? null,
          correlations: corr ?? null,
          seasonality: seasonality
            ? (seasonality as SeasonalityRow[]).map((r) => ({
                month: r.month,
                label: r.label,
                avgPct: r.avgPct,
                medianPct: r.medianPct,
                winRate: r.winRate,
                count: r.count,
              }))
            : null,
          sessions: sessions
            ? (sessions as SessionStat[]).map((s) => ({ movePct: s.movePct, rangePct: s.rangePct, isCurrent: s.isCurrent }))
            : null,
          news: newsList ? newsList.map((n) => ({ sentiment: n.sentiment ?? "neutral" })) : null,
          tape: tape.length > 0 ? tape : null,
          now,
        });
      }),
      15_000,
      () => staleGet("market-bias") ?? null
    );
    if (!data) {
      res.json({
        ts: Date.now(),
        symbol: "XAUUSD",
        price: null,
        score: 0,
        bias: "NEUTRAL",
        strength: "weak",
        primary: { score: 0, bias: "NEUTRAL", note: "engine unavailable" },
        tactical: { score: 0, bias: "NEUTRAL", note: "engine unavailable" },
        session: { label: "N/A", note: "engine unavailable" },
        pillars: [],
        factors: [],
        levels: [],
        warnings: ["bias engine unavailable"],
        feed: { t: null, fresh: false },
      });
      return;
    }
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- CSV export: raw OHLCV pull for offline analysis ----

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

marketRouter.get("/export.csv", async (req, res) => {
  const symbol = String(req.query.symbol ?? "XAUUSD").toUpperCase();
  const rangeKey = String(req.query.range ?? "1D");
  try {
    const data = await withBudget(
      cached(`export:${symbol}:${rangeKey}`, HISTORY_TTL_LONG, () => historyFor(symbol, rangeKey)),
      25_000,
      () => staleGet(`export:${symbol}:${rangeKey}`) ?? ([] as yahoo.Candle[])
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty history");
    const sorted = [...data].sort((a, b) => a.time - b.time);
    const lines = ["time_utc,open,high,low,close,volume"];
    for (const c of sorted) {
      lines.push(`${new Date(c.time * 1000).toISOString().slice(0, 19).replace("T", " ")},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${csvEscape(symbol)}-${csvEscape(rangeKey)}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    fail(req, res, err);
  }
});

// Server-Sent Events: real-time ticks + alerts to every connected tab.
attachStream(marketRouter);