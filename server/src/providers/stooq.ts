import type { Candle, Quote } from "./yahoo.js";

/** Yahoo-style symbol -> Stooq ticker. Kept to the handful of instruments a gold
 *  terminal actually needs: spot gold/silver, gold/silver futures, platinum,
 *  palladium, the dollar index and the majors. Daily bars only. */
const STOOQ_MAP: Record<string, string> = {
  XAUUSD: "xauusd",
  "XAUUSD=X": "xauusd",
  "GC=F": "xauusd",
  "GC=F.": "xauusd",
  XAGUSD: "xagusd",
  "XAGUSD=X": "xagusd",
  "SI=F": "xagusd",
  "SI=F.": "xagusd",
  "PL=F": "xptusd",
  "PA=F": "xpdusd",
  "DX-Y.NYB": "^dxy",
  "EURUSD=X": "eurusd",
  "GBPUSD=X": "gbpusd",
  "USDJPY=X": "usdjpy",
};

function stooqSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  const mapped = STOOQ_MAP[s];
  if (mapped) return mapped;
  if (s.startsWith("^")) return s.toLowerCase(); // indexes share the caret convention
  if (s.includes(".") || s.includes("=") || s.includes("-")) return s.toLowerCase();
  return s.toLowerCase() + ".us";
}

export async function history(symbol: string): Promise<Candle[]> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&i=d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !lines[0].startsWith("Date")) throw new Error("stooq: no data for " + symbol);
  const candles: Candle[] = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(",");
    const t = Date.parse(date + "T00:00:00Z") / 1000;
    const c = +close;
    if (!isFinite(t) || !isFinite(c)) continue;
    // Stooq emits "N/D" for missing intraday fields on some instruments — a NaN
    // open/high/low would poison the chart, so fall back to the close.
    const o = +open;
    const h = +high;
    const l = +low;
    candles.push({
      time: t,
      open: isFinite(o) ? o : c,
      high: isFinite(h) ? h : c,
      low: isFinite(l) ? l : c,
      close: c,
      volume: +volume || 0,
    });
  }
  return candles;
}

export async function quote(symbol: string): Promise<Quote> {
  const sym = stooqSymbol(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const lines = (await res.text()).trim().split("\n");
  if (lines.length < 2) throw new Error("stooq: empty quote");
  const [ticker, , , open, high, low, close, volume] = lines[1].split(",");
  const price = +close;
  if (!isFinite(price)) throw new Error("stooq: no quote for " + sym);
  // "N/D" in any of these must become null, not NaN/0 — and a legitimate 0
  // (e.g. a volume print) must not be coerced away by `|| null`.
  const numOrNull = (s: string | undefined): number | null => {
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  return {
    symbol: symbol.toUpperCase(),
    name: ticker,
    price,
    change: null,
    changePercent: null,
    open: numOrNull(open),
    high: numOrNull(high),
    low: numOrNull(low),
    previousClose: null,
    bid: null,
    ask: null,
    volume: numOrNull(volume),
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: null,
    exchange: "Stooq",
    marketState: null,
    time: null,
    source: "stooq",
  };
}