/**
 * Gold/Silver/FX provider using Sina Finance (hq.sinajs.cn + stock2.finance).
 * Yahoo Finance is geo-blocked (429) on this network; Sina works globally
 * and provides spot metals, precious metals futures, FX, and kline history.
 */

import type { Candle } from "./yahoo.js";

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  time: number | null;
  source: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const HEADERS = { "User-Agent": UA, Referer: "https://finance.sina.com.cn" } as const;

// ---- helpers ----

const n = (v: unknown): number | null => {
  // Sina pads absent fields with "" (and occasionally "_"/"-"); those must be
  // "unknown", not the all-too-easy-to-misread 0 that Number("") yields.
  if (typeof v === "string" && v.trim() === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
};

export { n };

/** Parse Beijing-time stamp to UTC epoch seconds. */
export function beijingTs(ts: string): number {
  const d = new Date(ts.replace(" ", "T") + "+08:00");
  return Math.floor(d.getTime() / 1000);
}

/** YYYY-MM-DD → UTC midnight epoch seconds. */
export function dayTs(date: string): number {
  return Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
}

// ---- raw Sina endpoints ----

async function hqRaw(symbols: string[]): Promise<string[]> {
  const url = "https://hq.sinajs.cn/list=" + symbols.join(",");
  const viaCurl = await (async () => {
    try {
      const { execFile } = await import("node:child_process");
      const out = await new Promise<string>((resolve, reject) => {
        execFile("curl", ["-sS", "-m", "8", "-L", "-A", "Mozilla/5.0", "-H", "Referer: https://finance.sina.com.cn", url], { windowsHide: true, timeout: 12_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      return out;
    } catch {
      return null;
    }
  })();
  if (viaCurl !== null) {
    return symbols.map((_, i) => {
      const m = viaCurl.match(new RegExp(`hq_str_${symbols[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)";`));
      return m?.[1] ?? "";
    });
  }
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("sina hq " + res.status);
  const text = await res.text();
  return symbols.map((_, i) => {
    const m = text.match(new RegExp(`hq_str_${symbols[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)";`));
    return m?.[1] ?? "";
  });
}

export function parseHf(fields: string[]) {
  // Live-verified hf_XAU/XAG/GC/SI layout:
  //   [0] price · [1] prevClose · [2] bid · [3] ask · [4] dayHigh · [5] dayLow
  //   [6] time (Beijing HH:MM:SS) · [7] prevClose echo · [8] dayOpen
  //   [9..11] zeros · [12] date · [13] name
  const date = fields[12] ?? "";
  const tm = fields[6] ?? "";
  const time = date && tm ? beijingTs(`${date} ${tm}`) : null;
  return {
    price: n(fields[0]),
    previousClose: n(fields[1]),
    open: n(fields[8]),
    dayHigh: n(fields[4]),
    dayLow: n(fields[5]),
    time,
    bid: n(fields[2]),
    ask: n(fields[3]),
  };
}

export function parseFx(fields: string[]) {
  // fx_seurusd format: time, bid, ask, last, volume, hi1, lo1
  const bid = n(fields[1]);
  const ask = n(fields[2]);
  const hi = n(fields[5]);
  const lo = n(fields[6]);
  return {
    time: fields[0] ?? null,
    bid,
    ask,
    price: n(fields[3]) ?? bid,
    previousClose: null,
    open: null,
    dayHigh: hi !== null && lo !== null ? Math.max(hi, lo) : hi,
    dayLow: hi !== null && lo !== null ? Math.min(hi, lo) : lo,
  };
}

// Heavy endpoints are TTL-cached here so a 1-second refresh cycle (quotes) or
// parallel widgets never hammer Sina. The daily kline is ~5k bars and the
// minute line is the full current session (~23h of 1-minute points).
interface DailyBar {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface MinRow {
  time: string;
  price: number;
  ts: string;
}

const DAILY_TTL = 5 * 60_000;
const MINUTE_TTL = 10_000;
const klineCache = new Map<string, { at: number; bars: DailyBar[] }>();
const minuteCache = new Map<string, { at: number; rows: MinRow[] }>();

async function dailyKline(symbol: string): Promise<DailyBar[]> {
  const hit = klineCache.get(symbol);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.bars;
  const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  let text = await res.text();
  text = text.replace(/^\/\*<script>.*?<\/script>\*\/\s*/, "");
  const json = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
  const arr: DailyBar[] = JSON.parse(json);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`sina daily: no data for ${symbol}`);
  klineCache.set(symbol, { at: Date.now(), bars: arr });
  return arr;
}

interface MinRow {
  time: string;
  price: number;
  ts: string;
}

async function minuteLine(symbol: string): Promise<MinRow[]> {
  const hit = minuteCache.get(symbol);
  if (hit && Date.now() - hit.at < MINUTE_TTL) return hit.rows;
  const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  let text = await res.text();
  text = text.replace(/^\/\*<script>.*?<\/script>\*\/\s*/, "");
  const json = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
  const parsed = JSON.parse(json);
  const rows: any[] = parsed.minLine_1d ?? [];
  if (rows.length === 0) throw new Error("sina minLine: no data");

  const result: MinRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length >= 9) {
      // header row: [date, prevClose, exchange, "", time, price, ?, ?, avg, fullTs]
      result.push({
        time: row[4],
        price: n(row[5]) ?? 0,
        ts: row[9] ?? "",
      });
    } else if (row.length >= 6) {
      // data row: [time, price, ?, ?, avg, fullTs]
      result.push({
        time: row[0],
        price: n(row[1]) ?? 0,
        ts: row[5] ?? "",
      });
    }
  }
  minuteCache.set(symbol, { at: Date.now(), rows: result });
  return result;
}

// ---- public API ----

/** Fetch a live quote for any Sina-supported symbol. */
export async function quote(
  sinaSymbol: string,
  displayName: string,
  displaySymbol: string,
  opts: { fx?: boolean } = {}
): Promise<Quote> {
  const isFx = opts.fx ?? false;
  const vals = await hqRaw([sinaSymbol]);
  const raw = vals[0];
  if (!raw) throw new Error(`sina: no data for ${sinaSymbol}`);

  const fields = raw.split(",");
  const p = isFx ? parseFx(fields) : parseHf(fields);

  // For change, use prevClose from hf format or compute from daily kline
  const price = p.price;
  // An empty prevClose field parses as 0 — treat it as unknown so the caller
  // can enrich it (futures/spot daily delta, ECB, …) instead of computing a
  // bogus "price - 0" change.
  const previousClose = p.previousClose !== null && p.previousClose > 0 ? p.previousClose : null;
  const change = price !== null && previousClose !== null && previousClose !== 0 ? price - previousClose : null;
  const changePercent =
    change !== null && previousClose !== null && previousClose !== 0 ? (change / previousClose) * 100 : null;

  return {
    symbol: displaySymbol,
    name: displayName,
    price,
    change,
    changePercent,
    open: p.open ?? price,
    high: p.dayHigh ?? price,
    low: p.dayLow ?? price,
    previousClose,
    bid: p.bid,
    ask: p.ask,
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
    exchange: "Sina",
    marketState: null,
    time: isFx ? null : (p as ReturnType<typeof parseHf>).time,
    source: "sina",
  };
}

export async function dailyHistory(symbol: string): Promise<Candle[]> {
  const bars = await dailyKline(symbol);
  return bars.map((b) => ({
    time: dayTs(b.date),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume) || 0,
  }));
}

/** Build intraday candles (1m granularity) from the current session's minute line. */
export async function minuteHistory(symbol: string): Promise<Candle[]> {
  const rows = await minuteLine(symbol);
  return rows.map((r) => ({
    time: beijingTs(r.ts),
    open: r.price,
    high: r.price,
    low: r.price,
    close: r.price,
    volume: 0,
  }));
}

/** Aggregate flat 1m candles into larger OHLC bars. */
export function aggregateCandles(candles: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
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
