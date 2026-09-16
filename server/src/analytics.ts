// Pure desk analytics for the terminal — everything here is deterministic math
// over inputs already in cache (daily candles, option chains, COT rows, spot),
// so it can be unit-tested without any provider. No I/O, no state.
import type { Candle } from "./providers/yahoo.js";

export type { Candle };

// ---- numerics ----

const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]): number => (a.length === 0 ? Number.NaN : sum(a) / a.length);
const stdev = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const r4 = (n: number): number | null => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null);

export function pctReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0 && Number.isFinite(closes[i])) out.push(closes[i] / prev - 1);
  }
  return out;
}

// Abramowitz–Stegun 7.1.26 (max error 1.5e-7) — no math lib needed.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}
function erfc(x: number): number {
  return 1 - erf(x);
}

// ---- volatility / stats desk ----

export type StatsRow = {
  last: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  dayPct: number | null;
  ytdPct: number | null;
  ret1yPct: number | null;
  ddFromHighPct: number | null;
  atr14: number | null;
  rv20: number | null;
  rv60: number | null;
  rv250: number | null;
  z200: number | null;
  upDaysPct: number | null;
  bars: number;
};

export function computeStats(daily: Candle[]): StatsRow {
  const sorted = [...daily].sort((a, b) => a.time - b.time);
  const closes = sorted.map((c) => c.close).filter((v) => Number.isFinite(v));
  const hs = sorted.map((c) => c.high).filter((v) => Number.isFinite(v));
  const ls = sorted.map((c) => c.low).filter((v) => Number.isFinite(v));
  if (closes.length === 0) {
    return { last: null, yearHigh: null, yearLow: null, dayPct: null, ytdPct: null, ret1yPct: null, ddFromHighPct: null, atr14: null, rv20: null, rv60: null, rv250: null, z200: null, upDaysPct: null, bars: 0 };
  }
  const last = closes[closes.length - 1];
  const y = new Date(last ? sorted[sorted.length - 1].time * 1000 : Date.now()).getUTCFullYear();

  // annualized realized vol over rolling lookbacks
  const rv = (n: number): number | null => {
    const a = pctReturns(closes.slice(-(n + 1)));
    return a.length >= Math.min(2, n) ? r4(stdev(a) * Math.sqrt(252) * 100) : null;
  };

  // year-high/low over the last 252 bars (~52w)
  const win = Math.min(hs.length, 252);
  const yearHigh = win > 0 ? Math.max(...hs.slice(-win)) : null;
  const yearLow = win > 0 ? Math.min(...ls.slice(-win)) : null;

  // YTD: first completed close this calendar year
  const firstOfYear = sorted.find((c) => new Date(c.time * 1000).getUTCFullYear() === y);
  const ytdBase = firstOfYear?.close ?? null;
  const ytdPct = ytdBase !== null && ytdBase > 0 ? ((last - ytdBase) / ytdBase) * 100 : null;

  const dayPct = closes.length >= 2 && closes[closes.length - 2] !== 0
    ? ((last - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
    : null;

  // classic ATR(14)
  let atr14: number | null = null;
  if (sorted.length >= 15) {
    const trs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const h = sorted[i].high;
      const l = sorted[i].low;
      const pc = sorted[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    atr14 = r4(mean(trs.slice(-14)));
  }

  // price vs 200-SMA, in %
  let z200: number | null = null;
  if (closes.length >= 200) {
    const sma200 = mean(closes.slice(-200));
    if (sma200 > 0) z200 = r4((last / sma200 - 1) * 100);
  }

  const ret1y = closes.length > 252 && closes[closes.length - 253] !== 0
    ? ((last - closes[closes.length - 253]) / closes[closes.length - 253]) * 100
    : null;

  const last90 = closes.slice(-90);
  const ups = last90.filter((c, i) => i > 0 && c > last90[i - 1]).length;
  const upDaysPct = last90.length > 1 ? r4((ups / (last90.length - 1)) * 100) : null;

  return {
    last,
    yearHigh,
    yearLow,
    dayPct: r4Chk(dayPct),
    ytdPct: r4Chk(ytdPct),
    ret1yPct: r4Chk(ret1y),
    ddFromHighPct: yearHigh !== null && yearHigh !== 0 ? r4(((last - yearHigh) / yearHigh) * 100) : null,
    atr14,
    rv20: rv(20),
    rv60: rv(60),
    rv250: rv(250),
    z200,
    upDaysPct,
    bars: sorted.length,
  };
}

function r4Chk(n: number | null): number | null {
  return n === null ? null : r4(n);
}

// ---- rolling correlation matrix (desk gauge over last N daily returns) ----

export type CorrMatrix = { symbols: string[]; rows: number[][]; n: number };

export function computeCorrelations(series: Record<string, Candle[]>, window = 90): CorrMatrix {
  const symbols = Object.keys(series).filter((s) => (series[s]?.length ?? 0) > window);
  const returns: Record<string, number[]> = {};
  for (const s of symbols) {
    returns[s] = pctReturns(series[s].slice(-(window + 1)).map((c) => c.close));
  }
  const rows: number[][] = [];
  for (const a of symbols) {
    const row: number[] = [];
    for (const b of symbols) {
      if (a === b) {
        row.push(1);
        continue;
      }
      const k = Math.min(returns[a].length, returns[b].length);
      if (k < 2) {
        row.push(0);
        continue;
      }
      const ra = returns[a].slice(-k);
      const rb = returns[b].slice(-k);
      const ma = mean(ra);
      const mb = mean(rb);
      let num = 0;
      let dA = 0;
      let dB = 0;
      for (let i = 0; i < k; i++) {
        const x = ra[i] - ma;
        const y = rb[i] - mb;
        num += x * y;
        dA += x * x;
        dB += y * y;
      }
      row.push(r4(num / Math.sqrt(dA * dB)) ?? 0);
    }
    rows.push(row);
  }
  return { symbols, rows, n: window };
}

// ---- COMEX gold futures term structure ----

export const FUT_MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
export const FUT_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function gcContract(monthIdx: number, year: number): string {
  return "GC" + FUT_MONTH_CODES[monthIdx] + String(year).slice(-2);
}

/** The monthly GC strip starting with the current delivery month. */
export function nextContracts(now = new Date(), count = 12): string[] {
  let m = now.getUTCMonth();
  let y = now.getUTCFullYear();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(gcContract(m, y));
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

export function contractMonthLabel(symbol: string): string {
  const code = symbol[2] ?? "";
  const yr = symbol.slice(3);
  const idx = FUT_MONTH_CODES.indexOf(code.toUpperCase());
  const name = idx >= 0 ? FUT_MONTH_NAMES[idx] : symbol;
  return yr ? `${name} '${yr}` : symbol;
}

export type CurveRow = { symbol: string; label: string; price: number | null; basis: number | null; basisPct: number | null };

export function computeFuturesCurve(spot: number | null, contracts: Array<{ symbol: string; price: number | null }>): {
  rows: CurveRow[];
  status: "contango" | "backwardation" | "flat" | "n/a";
} {
  const rows: CurveRow[] = contracts.map((c) => {
    const basis = c.price !== null && spot !== null ? c.price - spot : null;
    return {
      symbol: c.symbol,
      label: contractMonthLabel(c.symbol),
      price: c.price,
      basis,
      basisPct: basis !== null && spot ? r4((basis / spot) * 100) : null,
    };
  });
  const priced = rows.filter((r) => r.price !== null && r.basis !== null);
  let status: "contango" | "backwardation" | "flat" | "n/a" = "n/a";
  if (priced.length > 0) {
    const yes = priced.filter((r) => (r.basis ?? 0) > 0).length;
    const no = priced.filter((r) => (r.basis ?? 0) < 0).length;
    status = yes === 0 && no === 0 ? "flat" : yes > no ? "contango" : "backwardation";
  }
  return { rows, status };
}

// ---- GC options: ATM IV + skew proxy + put/call OI ----

export type OptionChainLike = {
  underlyingPrice: number | null;
  expiry?: number | null;
  expirationDate?: number | null;
  calls: Array<{ strike: number; openInterest: number | null; impliedVolatility: number | null; ask?: number | null; bid?: number | null; lastPrice?: number | null }>;
  puts: Array<{ strike: number; openInterest: number | null; impliedVolatility: number | null; ask?: number | null; bid?: number | null; lastPrice?: number | null }>;
};

export type OptionsSummary = {
  underlying: number | null;
  expiry: number | null;
  atmStrike: number | null;
  atmIv: number | null;
  skewProxy: number | null; // OTM call IV − OTM put IV (25-Δ style)
  putCallOiRatio: number | null;
  maxOiStrike: number | null;
  avgIv: number | null;
  nCalls: number;
  nPuts: number;
};

export function computeOptionsSummary(chain: OptionChainLike): OptionsSummary {
  const underlying = chain.underlyingPrice;
  const expiry = chain.expirationDate ?? chain.expiry ?? null;
  const all = [...chain.calls, ...chain.puts].filter((o) => Number.isFinite(o.strike) && o.strike > 0);
  const ivs = all.map((o) => o.impliedVolatility).filter((v): v is number => Number.isFinite(v as number));
  const avgIv = ivs.length ? r4(mean(ivs)) : null;

  let atmStrike: number | null = null;
  let atmIv: number | null = null;
  if (underlying !== null && all.length > 0) {
    atmStrike = all.reduce((best, o) =>
      Math.abs(o.strike - underlying) < Math.abs(best.strike - underlying) ? o : best, all[0]
    ).strike;
    const atm = all.filter((o) => o.strike === atmStrike);
    const atmIvs = atm.map((o) => o.impliedVolatility).filter((v): v is number => Number.isFinite(v as number));
    if (atmIvs.length > 0) atmIv = r4(mean(atmIvs));
  }

  // Risk-reversal proxy: IV of OTM calls (strike > spot) minus IV of OTM puts
  // (strike < spot), each averaged over the nearest 3 available strikes.
  let skewProxy: number | null = null;
  if (underlying !== null) {
    const otmCalls = chain.calls
      .filter((o) => Number.isFinite(o.impliedVolatility as number) && o.strike > underlying)
      .sort((a, b) => Math.abs(a.strike - underlying) - Math.abs(b.strike - underlying))
      .slice(0, 3);
    const otmPuts = chain.puts
      .filter((o) => Number.isFinite(o.impliedVolatility as number) && o.strike < underlying)
      .sort((a, b) => Math.abs(a.strike - underlying) - Math.abs(b.strike - underlying))
      .slice(0, 3);
    const callIv = mean(otmCalls.map((o) => o.impliedVolatility as number));
    const putIv = mean(otmPuts.map((o) => o.impliedVolatility as number));
    if (otmCalls.length > 0 && otmPuts.length > 0) skewProxy = r4(callIv - putIv);
  }

  const callOi = sum(chain.calls.map((o) => o.openInterest ?? 0));
  const putOi = sum(chain.puts.map((o) => o.openInterest ?? 0));
  const putCallOiRatio = putOi > 0 && callOi > 0 ? r4(putOi / callOi) : null;

  let maxOi = 0;
  let maxOiStrike: number | null = null;
  for (const o of all) {
    const oi = o.openInterest ?? 0;
    if (oi > maxOi) {
      maxOi = oi;
      maxOiStrike = o.strike;
    }
  }

  return {
    underlying,
    expiry,
    atmStrike,
    atmIv,
    skewProxy,
    putCallOiRatio,
    maxOiStrike,
    avgIv,
    nCalls: chain.calls.length,
    nPuts: chain.puts.length,
  };
}

// ---- Fed funds futures implied probabilities (FedWatch-style, 2-outcome) ----

export type RateProbs = {
  currentRateBp: number | null;
  impliedRateBp: number | null;
  expectedChangeBp: number | null;
  nextFomcAt: number;
  nextFomcLabel: string;
  probHike25: number | null;
  probCut25: number | null;
  probHold: number | null;
};

/** FOMC decision days (UTC times are the 19:00 announcement) in 2026. */
export const FOMC_2026: Array<{ m: number; d: number }> = [
  { m: 1, d: 28 },
  { m: 3, d: 18 },
  { m: 4, d: 29 },
  { m: 6, d: 17 },
  { m: 7, d: 29 },
  { m: 9, d: 16 },
  { m: 10, d: 28 },
  { m: 12, d: 9 },
];

export function nextFomc(nowMs = Date.now()): { at: number; label: string } {
  const year = new Date(nowMs).getUTCFullYear();
  const candidate = (y: number): Array<{ m: number; d: number }> =>
    y === 2026 ? FOMC_2026 : [{ m: 1, d: 28 }];
  const list = candidate(year).map((f) => Date.UTC(year, f.m - 1, f.d, 19));
  const firstNextYear = Date.UTC(year + 1, 0, 28, 19);
  const at = list.find((t) => t > nowMs) ?? firstNextYear;
  return { at, label: new Date(at).toISOString().slice(0, 10) };
}

/** Binary-outcome probability with a ~10bp spot vol on the front contract.
 *  returns probs in [0,1] with a +25 / −25 / no-change view. */
export function computeRateProbs(currentPerBp: number | null, impliedRateBp: number | null, nowMs = Date.now()): RateProbs {
  const { at, label } = nextFomc(nowMs);
  let expected: number | null = null;
  let pHike: number | null = null;
  let pCut: number | null = null;
  if (currentPerBp !== null && impliedRateBp !== null) {
    expected = impliedRateBp - currentPerBp;
    const sigma = 10; // bp
    const mid = 12.5; // halfway between no-change (0) and +25
    const z = (mid - expected) / (sigma * Math.SQRT2);
    pHike = r4(0.5 * erfc(z)); // P(expected move lands above +12.5)
    pCut = r4(0.5 * erfc((mid + expected) / (sigma * Math.SQRT2))); // symmetric downside
    pHike = pHike === null ? null : Math.max(0, Math.min(1, pHike));
    pCut = pCut === null ? null : Math.max(0, Math.min(1, pCut));
    if (pHike !== null && pCut !== null) {
      const hold = Math.max(0, 1 - pHike - pCut);
      return { currentRateBp: currentPerBp, impliedRateBp, expectedChangeBp: r4(expected), nextFomcAt: at, nextFomcLabel: label, probHike25: pHike, probCut25: pCut, probHold: r4(hold) };
    }
  }
  return { currentRateBp: currentPerBp, impliedRateBp, expectedChangeBp: expected === null ? null : r4(expected), nextFomcAt: at, nextFomcLabel: label, probHike25: null, probCut25: null, probHold: null };
}

// ---- ETF flow proxy (directional dollars, clearly labeled as a proxy) ----

export type FlowDay = { time: number; flowM: number };
export type EtfFlowSummary = {
  symbol: string;
  series: FlowDay[]; // most recent last, daily
  sum1dM: number | null;
  sum5dM: number | null;
  sum20dM: number | null;
  bars: number;
};

export function computeEtfFlowProxy(symbol: string, daily: Candle[]): EtfFlowSummary {
  const sorted = [...daily].sort((a, b) => a.time - b.time);
  const series: FlowDay[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dC = sorted[i].close - sorted[i - 1].close;
    const flow = dC * sorted[i].volume;
    series.push({ time: sorted[i].time, flowM: r4(flow / 1_000_000) ?? 0 });
  }
  const tail = series.slice(-20);
  const last20 = tail.slice(-20);
  return {
    symbol,
    series: tail,
    sum1dM: tail.length ? r4(tail[tail.length - 1].flowM) : null,
    sum5dM: tail.length >= 5 ? r4(sum(tail.slice(-5).map((f) => f.flowM))) : null,
    sum20dM: last20.length >= 20 ? r4(sum(last20.map((f) => f.flowM))) : null,
    bars: series.length,
  };
}

// ---- COT positioning summary (from CFTC disaggregated rows) ----

export type CotRow = {
  reportDate: string;
  managedLong: number | null;
  managedShort: number | null;
  swapLong: number | null;
  swapShort: number | null;
  otherLong: number | null;
  otherShort: number | null;
  contractUnits: number | null;
};

export type CotSummary = {
  reportDate: string | null;
  netManaged: number | null; // (managed long − short) × units = contracts held by money managers
  wwChange: number | null;
  netSwap: number | null;
  netOther: number | null;
  status: "managed_bull" | "managed_bear" | "flat" | "n/a";
};

export function computeCotSummary(rows: CotRow[]): CotSummary {
  const cur = rows[0];
  const prev = rows[1];
  if (!cur) {
    return { reportDate: null, netManaged: null, wwChange: null, netSwap: null, netOther: null, status: "n/a" };
  }
  const units = cur.contractUnits ?? 1;
  const netManaged = cur.managedLong !== null && cur.managedShort !== null ? (cur.managedLong - cur.managedShort) * units : null;
  const netSwap = cur.swapLong !== null && cur.swapShort !== null ? (cur.swapLong - cur.swapShort) * units : null;
  const netOther = cur.otherLong !== null && cur.otherShort !== null ? (cur.otherLong - cur.otherShort) * units : null;
  let wwChange: number | null = null;
  if (prev && prev.managedLong !== null && prev.managedShort !== null && netManaged !== null) {
    wwChange = netManaged - (prev.managedLong - prev.managedShort) * units;
  }
  const status: CotSummary["status"] =
    netManaged === null ? "n/a" : Math.abs(netManaged) < 1_000 ? "flat" : netManaged > 0 ? "managed_bull" : "managed_bear";
  return { reportDate: cur.reportDate, netManaged, wwChange, netSwap, netOther, status };
}

// ---- indicator toolkit (pure, deterministic) ----

export function smaLast(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function emaLast(values: number[], period: number): number | null {
  if (values.length === 0) return null;
  const e = emaSeries(values, period);
  return e[e.length - 1];
}

export function rsiLast(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    avgGain += Math.max(diff, 0) / period;
    avgLoss += Math.max(-diff, 0) / period;
  }
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function macdLast(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: number; signal: number; histogram: number } | null {
  if (values.length < slow + signal) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const line: number[] = [];
  for (let i = 0; i < values.length; i++) line.push(f[i] - s[i]);
  const sg = emaSeries(line, signal);
  const last = line[line.length - 1];
  const lastSig = sg[sg.length - 1];
  return { macd: last, signal: lastSig, histogram: last - lastSig };
}

export function atrLast(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let atr = 0;
  let prevClose = candles[0].close;
  for (let i = 1; i <= period; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    atr = atr === 0 ? tr : (atr * (period - 1) + tr) / period;
    prevClose = c.close;
  }
  for (let i = period + 1; i < candles.length; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    atr = (atr * (period - 1) + tr) / period;
    prevClose = c.close;
  }
  return atr;
}

/** Wilder ADX(14) — trend-strength gauge used to damp/boost momentum votes. */
export function adxLast(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const n = period;
  const trs: number[] = [];
  const dMPlus: number[] = [];
  const dMMinus: number[] = [];
  let prevH = candles[0].high;
  let prevL = candles[0].low;
  let prevC = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const c = candles[i].close;
    const up = h - prevH;
    const dn = prevL - l;
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    dMPlus.push(up > dn && up > 0 ? up : 0);
    dMMinus.push(dn > up && dn > 0 ? dn : 0);
    prevH = h;
    prevL = l;
    prevC = c;
  }
  const sumWindow = (arr: number[], i0: number, count: number): number => {
    let s = 0;
    for (let i = i0; i < i0 + count; i++) s += arr[i];
    return s;
  };
  let atr = sumWindow(trs, 0, n) / n;
  let p = sumWindow(dMPlus, 0, n) / n;
  let m = sumWindow(dMMinus, 0, n) / n;
  let dx = 0;
  let seeds = 0;
  for (let i = n; i < trs.length; i++) {
    atr = (atr * (n - 1) + trs[i]) / n;
    p = (p * (n - 1) + dMPlus[i]) / n;
    m = (m * (n - 1) + dMMinus[i]) / n;
    if (atr <= 0) continue;
    const pdi = (p / atr) * 100;
    const mdi = (m / atr) * 100;
    const sum = pdi + mdi;
    if (sum <= 0) continue;
    const d = (Math.abs(pdi - mdi) / sum) * 100;
    if (seeds < n) {
      dx = seeds === 0 ? d : (dx * seeds + d) / (seeds + 1);
      seeds++;
    } else {
      dx = (dx * (n - 1) + d) / n;
    }
  }
  return seeds >= n ? dx : null;
}

export function vwapLast(candles: Candle[]): number | null {
  let cumPV = 0;
  let cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

export function classicPivots(h: number, l: number, c: number): { p: number; r1: number; s1: number; r2: number; s2: number } {
  const p = (h + l + c) / 3;
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) };
}

export function fibPivots(h: number, l: number, c: number): { p: number; r1: number; s1: number; r2: number; s2: number } {
  const p = (h + l + c) / 3;
  const range = h - l;
  return { p, r1: p + 0.382 * range, s1: p - 0.382 * range, r2: p + 0.618 * range, s2: p - 0.618 * range };
}

export type Pivots = { p: number; r1: number; s1: number; r2: number; s2: number };

// ---- price context (session / day / swings) ----

export function goldOpen(now: Date): boolean {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0) return mins >= 22 * 60;
  if (day === 6) return false;
  if (day === 5) return mins < 21 * 60;
  return true;
}

export function activeSession(now: Date): { label: string; note: string } {
  if (!goldOpen(now)) return { label: "CLOSED", note: "gold market closed (weekend)" };
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 8 * 60) return { label: "ASIA", note: "low volume · liquidity build" };
  if (mins < 13 * 60) return { label: "LONDON", note: "manipulation phase · sweeps Asia H/L" };
  if (mins < 21 * 60) return { label: "NEW YORK", note: "expansion/reversal · data 13:30/15:00 UTC" };
  return { label: "ROLLOVER", note: "post-NY thin window" };
}

/** Fractal swing highs/lows (k bars each side). */
export function swings(cs: Candle[], k = 2): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = k; i < cs.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (cs[j].high > cs[i].high) isH = false;
      if (cs[j].low < cs[i].low) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

/** Institutional swing structure (HH/HL vs LH/LL) from the last two swing points. */
export function structureVote(cs: Candle[] | undefined): { vote: number; note: string } {
  if (!cs || cs.length < 14) return { vote: 0, note: "insufficient data" };
  const { highs, lows } = swings(cs, 2);
  if (highs.length < 2 || lows.length < 2) return { vote: 0, note: "structure unclear" };
  const h1 = cs[highs[highs.length - 1]].high;
  const h0 = cs[highs[highs.length - 2]].high;
  const l1 = cs[lows[lows.length - 1]].low;
  const l0 = cs[lows[lows.length - 2]].low;
  if (h1 > h0 && l1 > l0) return { vote: 1, note: "HH → HL" };
  if (h1 < h0 && l1 < l0) return { vote: -1, note: "LH → LL" };
  if (h1 > h0 && l1 < l0) return { vote: 0.15, note: "HH + LL" };
  if (h1 < h0 && l1 > l0) return { vote: -0.15, note: "LH + HL" };
  return { vote: 0, note: "ranging" };
}

/** True when the final daily bar belongs to the (Beijing) session currently forming. */
export function dailyIsLive(daily: Candle[]): boolean {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const d = new Date(daily[daily.length - 1].time * 1000).toISOString().slice(0, 10);
  return d === today;
}

/** Previous completed day's H/L + the (live) daily open. */
export function prevDayLevels(daily: Candle[] | undefined) {
  if (!daily || daily.length < 2) return { pdh: null, pdl: null, dOpen: null };
  const ref = dailyIsLive(daily) ? daily.length - 2 : daily.length - 1;
  const b = daily[ref];
  return { pdh: b.high, pdl: b.low, dOpen: daily[daily.length - 1].open };
}

// ---- market bias (professional layered model) ----

export type BiasMacro = {
  rates: Array<{ id: string; label: string; pct: boolean; value: number | null }>;
  markets: Array<{ symbol: string; label: string; price: number | null; change: number | null; changePercent: number | null }>;
};

export type BiasEconEvent = {
  title: string;
  country: string;
  date: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
};

export type BiasSeasonalityRow = { month: number; label: string; avgPct: number; medianPct: number; winRate: number; count: number };
export type BiasSessionRow = { movePct: number | null; rangePct: number | null; isCurrent: boolean };
export type BiasNewsRow = { sentiment: "bullish" | "bearish" | "neutral" };

export type BiasTapeTick = { t: number; price: number };

export type BiasInput = {
  symbol: string;
  m5: Candle[];
  m15: Candle[];
  h4: Candle[];
  daily: Candle[];
  price: number | null;
  feedT: number | null;
  macro: BiasMacro | null;
  events: BiasEconEvent[] | null;
  options: OptionsSummary | null;
  rateProbs: RateProbs | null;
  etf: EtfFlowSummary | null;
  cot: CotSummary | null;
  stats: StatsRow | null;
  correlations: CorrMatrix | null;
  seasonality: BiasSeasonalityRow[] | null;
  sessions: BiasSessionRow[] | null;
  news: BiasNewsRow[] | null;
  tape: BiasTapeTick[] | null;
  now: number;
};

export type BiasFactor = { pillar: string; label: string; vote: number; note: string };
export type BiasPillar = { id: string; label: string; vote: number; max: number; note: string };
export type BiasLevel = { label: string; value: number; kind: "pivot" | "resistance" | "support" | "spot" | "open" | "iva" };
export type BiasStrength = "strong" | "moderate" | "weak";

export type BiasResult = {
  ts: number;
  symbol: string;
  price: number | null;
  score: number;
  bias: "BULL" | "BEAR" | "NEUTRAL";
  strength: BiasStrength;
  primary: { score: number; bias: "BULL" | "BEAR" | "NEUTRAL"; note: string };
  tactical: { score: number; bias: "BULL" | "BEAR" | "NEUTRAL"; note: string };
  session: { label: string; note: string };
  pillars: BiasPillar[];
  factors: BiasFactor[];
  levels: BiasLevel[];
  warnings: string[];
  feed: { t: number | null; fresh: boolean };
};

const biasClamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function biasOf(score: number, threshold: number): "BULL" | "BEAR" | "NEUTRAL" {
  if (score >= threshold) return "BULL";
  if (score <= -threshold) return "BEAR";
  return "NEUTRAL";
}

/** Asian/London/NY session-aware PDH sweep detection on the intraday tape. */
function liquiditySweep(m15: Candle[], pdh: number | null, pdl: number | null, price: number | null) {
  if (pdh === null || pdl === null || price === null) return null;
  const tape = m15.slice(-60);
  const sweptHigh = tape.some((c) => c.high > pdh);
  const sweptLow = tape.some((c) => c.low < pdl);
  if (sweptHigh && price < pdh) return { vote: -8, note: `swept PDH ${price >= pdl ? "· rejected" : ""}` };
  if (sweptLow && price > pdl) return { vote: 8, note: `swept PDL · reversed` };
  if (sweptHigh) return { vote: -3, note: `tagged PDH` };
  if (sweptLow) return { vote: 3, note: `tagged PDL` };
  return null;
}

/** 5m Change of Character: the most recent swing broke the prior swing. */
function choch(m5: Candle[] | undefined) {
  if (!m5 || m5.length < 24) return null;
  const { highs, lows } = swings(m5, 2);
  const lastBar = m5.length - 1;
  if (highs.length >= 2 && Math.abs(highs[highs.length - 1] - lastBar) <= 14) {
    const h1 = m5[highs[highs.length - 1]].high;
    const h0 = m5[highs[highs.length - 2]].high;
    if (h1 > h0) return { vote: 4, note: "bullish ChoCH on 5m" };
  }
  if (lows.length >= 2 && Math.abs(lows[lows.length - 1] - lastBar) <= 14) {
    const l1 = m5[lows[lows.length - 1]].low;
    const l0 = m5[lows[lows.length - 2]].low;
    if (l1 < l0) return { vote: -4, note: "bearish ChoCH on 5m" };
  }
  return null;
}

/** High-impact event window (CPI/NFP/FOMC/GDP/…), ±30m past → next 8h. */
function eventRisk(events: BiasEconEvent[] | null, now: number) {
  if (!events) return null;
  const key = /CPI|PCE|NFP|non.?farm|FOMC|fed funds|GDP|retail|unemployment|jobless|PPI|inflation/i;
  for (const e of events) {
    if (e.impact !== "High" || (e.country !== "US" && e.country !== "EU")) continue;
    if (!key.test(e.title)) continue;
    const t = new Date(e.date).getTime();
    const mins = Math.round((t - now) / 60_000);
    if (mins >= -30 && mins <= 8 * 60) {
      return { note: e.title, when: mins <= 0 ? "NOW" : `${mins}m` };
    }
  }
  return null;
}

const str = (n: number | null, d = 1): string => (n === null ? "n/a" : n.toFixed(d));
const pct = (n: number | null, d = 2): string => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

/**
 * Professional market bias. Layers, in decreasing weight: higher-TF swing
 * structure, momentum (RSI/MACD/ROC gated by ADX trend quality), price location
 * (day open / VWAP / PDH-PDL / pivots), macro (DXY, real yields, rate odds),
 * positioning (COT, ETF flows, options skew), intermarket (silver/GDX/basis),
 * order flow (PDH/PDL sweeps, 5m ChoCH), and sentiment (news tally,
 * seasonality, tick tape). PRIMARY = structure+macro+positioning (thesis),
 * TACTICAL = momentum+location+orderflow+intermarket+sentiment (timing).
 */
export function computeBias(x: BiasInput): BiasResult {
  const now = x.now ?? Date.now();
  const m15 = x.m15;
  const m5 = x.m5;
  const h4 = x.h4;
  const daily = x.daily;
  const px = x.price ?? (m15.length > 0 ? m15[m15.length - 1].close : null);
  const factors: BiasFactor[] = [];
  const warnings: string[] = [];
  const budget: Record<string, number> = {
    structure: 30,
    momentum: 20,
    location: 20,
    macro: 12,
    positioning: 10,
    orderflow: 10,
    intermarket: 8,
    sentiment: 10,
  };
  const tallies: Record<string, number> = Object.fromEntries(Object.keys(budget).map((k) => [k, 0]));
  const tallieNotes: Record<string, string[]> = Object.fromEntries(Object.keys(budget).map((k) => [k, []]));

  const push = (pillar: string, label: string, vote: number, note: string) => {
    const v = Number.isFinite(vote) ? vote : 0;
    tallies[pillar] += v;
    tallieNotes[pillar].push(note);
    if (v !== 0 || note) factors.push({ pillar, label, vote: Math.round(v * 10) / 10, note });
  };

  const rate = (id: string) => x.macro?.rates?.find((r) => r.id === id)?.value ?? null;
  const market = (sym: string) => x.macro?.markets?.find((m) => m.symbol === sym);
  const mktPct = (sym: string) => market(sym)?.changePercent ?? null;

  // ---- structure (the framework) ----
  const d1 = structureVote(daily);
  const h4s = structureVote(h4);
  const s15 = structureVote(m15);
  push("structure", "D1 Structure", d1.vote * 14, d1.note);
  push("structure", "H4 Structure", h4s.vote * 10, h4s.note);
  push("structure", "15m Structure", s15.vote * 6, s15.note);

  const sma200 = smaLast(daily.map((c) => c.close), 200);
  const sma50 = smaLast(daily.map((c) => c.close), 50);
  const sma20 = smaLast(daily.map((c) => c.close), 20);
  if (px !== null && sma200 !== null) push("structure", "D1 SMA200", px >= sma200 ? 4 : -4, px >= sma200 ? "above 200" : "below 200");
  if (px !== null && sma50 !== null) push("structure", "D1 SMA50", px >= sma50 ? 3 : -3, px >= sma50 ? "above 50" : "below 50");

  if (d1.vote !== 0 && h4s.vote !== 0 && Math.sign(d1.vote) === Math.sign(h4s.vote)) {
    push("structure", "TF Align", 2, d1.vote > 0 ? "D1+H4 aligned bullish" : "D1+H4 aligned bearish");
  }

  // ---- momentum & timing (gated by trend quality) ----
  const m15Closes = m15.map((c) => c.close);
  const r = rsiLast(m15Closes, 14);
  if (r !== null) {
    if (r >= 58) push("momentum", "RSI14 15m", 6, `${r.toFixed(0)} hot`);
    else if (r >= 52) push("momentum", "RSI14 15m", 3, `${r.toFixed(0)} bid`);
    else if (r <= 42) push("momentum", "RSI14 15m", -6, `${r.toFixed(0)} weak`);
    else if (r <= 48) push("momentum", "RSI14 15m", -3, `${r.toFixed(0)} offer`);
    else push("momentum", "RSI14 15m", 0, `${r.toFixed(0)}`);
  }
  const mac = macdLast(m15Closes);
  if (mac) {
    const rising = m15Closes.length >= 2 && mac.histogram >= (() => {
      const prev = macdLast(m15Closes.slice(0, -1), 12, 26, 9);
      return prev ? prev.histogram : mac.histogram;
    })();
    const v = (mac.histogram >= 0 ? 4 : -4) + (rising ? 2 : 0);
    push("momentum", "MACD 15m", v, `${mac.histogram >= 0 ? "+" : ""}${mac.histogram.toFixed(2)}`);
  }
  if (m15Closes.length >= 13) {
    const roc = ((m15Closes[m15Closes.length - 1] - m15Closes[m15Closes.length - 13]) / m15Closes[m15Closes.length - 13]) * 100;
    const v = biasClamp(roc * 2, -4, 4);
    push("momentum", "ROC 15m", Math.round(v * 10) / 10, `${roc >= 0 ? "+" : ""}${roc.toFixed(2)}%`);
  }
  const dr = rsiLast(daily.map((c) => c.close), 14);
  if (dr !== null) {
    if (dr >= 70) push("momentum", "RSI14 D", 2, `${dr.toFixed(0)} overbought`);
    else if (dr >= 55) push("momentum", "RSI14 D", 4, `${dr.toFixed(0)} bid`);
    else if (dr <= 30) push("momentum", "RSI14 D", -2, `${dr.toFixed(0)} oversold`);
    else if (dr <= 45) push("momentum", "RSI14 D", -4, `${dr.toFixed(0)} offer`);
    else push("momentum", "RSI14 D", 0, `${dr.toFixed(0)}`);
  }
  const adx = adxLast(m15);
  if (adx !== null && adx >= 18) {
    const quality = adx >= 25 ? 1.25 : 1;
    tallies.momentum = biasClamp(tallies.momentum * quality, -budget.momentum, budget.momentum);
    push("momentum", "ADX", 0, `${adx.toFixed(0)} ${adx >= 25 ? "trending" : "transitioning"}`);
  }

  // ---- price location & levels ----
  const { pdh, pdl, dOpen } = prevDayLevels(daily);
  if (px !== null && dOpen !== null) push("location", "vs Daily Open", px >= dOpen ? 5 : -5, px >= dOpen ? `above ${str(dOpen, 1)}` : `below ${str(dOpen, 1)}`);
  const vw = vwapLast(m15);
  if (px !== null && vw !== null) push("location", "VWAP", px > vw ? 6 : -6, px > vw ? "above session VWAP" : "below session VWAP");
  if (px !== null && pdh !== null && pdl !== null && pdh !== pdl) {
    const pos = (px - pdl) / (pdh - pdl);
    const v = pos >= 0.7 ? 4 : pos <= 0.3 ? -4 : 0;
    push("location", "PDH/PDL pos", v, pos >= 0.7 ? "upper range" : pos <= 0.3 ? "lower range" : "mid range");
  }

  if (daily.length >= 2) {
    const base = daily[daily.length - 2];
    const ppt = classicPivots(base.high, base.low, base.close);
    if (px !== null) {
      push("location", "Daily Pivot", px >= ppt.p ? 4 : -4, px >= ppt.p ? `above P ${str(ppt.p, 1)}` : `below P ${str(ppt.p, 1)}`);
    }
  }

  const win = daily.slice(-7);
  if (win.length >= 2) {
    const h = Math.max(...win.map((c) => c.high));
    const l = Math.min(...win.map((c) => c.low));
    const c = win[win.length - 1].close;
    const wp = fibPivots(h, l, c);
    if (px !== null) push("location", "Weekly Pivot", px >= wp.p ? 3 : -3, px >= wp.p ? `above W1 ${str(wp.p, 1)}` : `below W1 ${str(wp.p, 1)}`);
  }

  // ---- order flow ----
  const sw = liquiditySweep(m15, pdh, pdl, px);
  if (sw) push("orderflow", "Liquidity Sweep", sw.vote, sw.note);
  const ch = choch(m5);
  if (ch) {
    const reinforce = sw && Math.sign(sw.vote) === Math.sign(ch.vote);
    push("orderflow", "ChoCH", reinforce ? ch.vote + 2 : ch.vote, ch.note + (reinforce ? " · confirmed" : ""));
  }

  // ---- macro & rates ----
  const dxy = mktPct("DX-Y.NYB");
  if (dxy !== null) {
    const strong = Math.abs(dxy) >= 0.3;
    const v = dxy < 0 ? (strong ? 8 : 5) : strong ? -8 : -5;
    push("macro", "DXY (inverse)", v, `${pct(dxy)}${strong ? " · strong" : ""}`);
  }
  const ri10 = rate("DFII10");
  if (ri10 !== null) {
    const v = ri10 >= 3 ? -4 : ri10 <= 1.5 ? 4 : 0;
    push("macro", "Real Yld", v, `${ri10.toFixed(2)}%`);
  }
  if (x.rateProbs) {
    const cut = x.rateProbs.probCut25;
    const hike = x.rateProbs.probHike25;
    if (cut !== null && hike !== null) {
      const v = biasClamp(Math.round((cut - hike) * 16), -5, 5);
      push("macro", "Rate Odds", v, `cut ${Math.round(cut * 100)}% / hike ${Math.round(hike * 100)}%`);
    } else if (x.rateProbs.expectedChangeBp !== null) {
      const eb = x.rateProbs.expectedChangeBp;
      const v = biasClamp(Math.round(-eb / 6), -5, 5);
      push("macro", "Rate Odds", v, `expected ${eb >= 0 ? "+" : ""}${eb}bp`);
    }
  }
  const vix = rate("VIXCLS");
  if (vix !== null) {
    const v = vix >= 28 ? 2 : vix <= 14 ? -2 : 0;
    push("macro", "VIX", v, vix >= 28 ? "stress bid" : vix <= 14 ? "calm" : `${vix.toFixed(1)}`);
  }

  // ---- positioning ----
  if (x.cot) {
    const net = x.cot.netManaged;
    const ww = x.cot.wwChange;
    if (net === null || x.cot.status === "n/a") {
      push("positioning", "COT", 0, "no recent report");
    } else if (net > 0 && ww !== null && ww > 0) {
      push("positioning", "COT MM", 5, `longs adding ${(net / 1000).toFixed(0)}k`);
    } else if (net < 0 && ww !== null && ww < 0) {
      push("positioning", "COT MM", -5, `shorts adding ${(net / 1000).toFixed(0)}k`);
    } else if (net > 0 && ww !== null && ww < 0) {
      push("positioning", "COT MM", -4, "longs unwinding");
    } else if (net < 0 && ww !== null && ww > 0) {
      push("positioning", "COT MM", 4, "shorts covering");
    } else if (net >= 30_000) {
      push("positioning", "COT MM", 2, `sticky long ${(net / 1000).toFixed(0)}k`);
    } else if (net <= -30_000) {
      push("positioning", "COT MM", -2, `sticky short ${(net / 1000).toFixed(0)}k`);
    } else {
      push("positioning", "COT MM", 0, `${(net / 1000).toFixed(0)}k net`);
    }
  }
  if (x.etf) {
    const f5 = x.etf.sum5dM;
    const f20 = x.etf.sum20dM;
    let v = 0;
    let note = "flat";
    if (f5 !== null && (f5 >= 5 || f5 <= -5)) {
      v = f5 >= 20 ? 4 : f5 >= 5 ? 2 : f5 <= -20 ? -4 : -2;
      note = `${f5 >= 0 ? "+" : ""}${f5.toFixed(0)}M 5d`;
    } else if (f20 !== null) {
      v = biasClamp(Math.round(f20 / 30), -3, 3);
      note = `${f20 >= 0 ? "+" : ""}${f20.toFixed(0)}M 20d`;
    }
    push("positioning", "GLD Flow", v, note);
  }
  if (x.options) {
    const sk = x.options.skewProxy;
    const pc = x.options.putCallOiRatio;
    if (sk !== null && sk !== 0) {
      const v = sk > 0 ? 3 : -3;
      push("positioning", "Opt Skew", v, `calls${sk > 0 ? " bid" : " offered"} (${sk > 0 ? "+" : ""}${(sk * 100).toFixed(1)} IV%)`);
    }
    if (pc !== null && pc >= 1.5) {
      push("positioning", "P/C Ratio", -1, `${pc.toFixed(2)} heavy puts`);
      warnings.push(`HEDGE DEMAND put/call ${pc.toFixed(2)}`);
    } else if (pc !== null && pc > 0) {
      push("positioning", "P/C Ratio", 0, `${pc.toFixed(2)}`);
    }
    if (x.options.atmIv !== null && x.options.atmIv >= 0.25) {
      warnings.push(`HIGH IV atm ${(x.options.atmIv * 100).toFixed(0)}%`);
    }
  }
  if (x.stats && x.stats.rv20 !== null) {
    if (x.stats.rv20 >= 30) push("positioning", "Vol Regime", 0, `rv20 ${x.stats.rv20.toFixed(0)}% choppy`);
    else if (x.stats.rv20 <= 12) push("positioning", "Vol Regime", 0, `rv20 ${x.stats.rv20.toFixed(0)}% quiet`);
  }

  // ---- intermarket ----
  const ag = mktPct("XAGUSD=X");
  if (ag !== null) push("intermarket", "Silver", biasClamp(ag * 12, -4, 4), pct(ag));
  const gdx = mktPct("GDX");
  if (gdx !== null) push("intermarket", "GDX", biasClamp(gdx * 10, -3, 3), pct(gdx));
  const spot = market("XAUUSD")?.price ?? null;
  const fut = market("GC=F")?.price ?? null;
  if (Number.isFinite(spot) && Number.isFinite(fut) && spot !== null && fut !== null && spot !== 0) {
    const basisPct = ((fut - spot) / spot) * 100;
    const v = basisPct === 0 ? 0 : basisPct > 0 ? 1 : -1;
    push("intermarket", "Futures Basis", v, `GC−spot ${basisPct > 0 ? "+" : ""}${basisPct.toFixed(2)}% ${basisPct > 0 ? "contango" : "backwardation"}`);
  }
  if (x.correlations && x.correlations.symbols.length > 0) {
    const gi = x.correlations.symbols.indexOf("GC=F");
    if (gi >= 0) {
      const pairs = x.correlations.symbols
        .filter((s) => s !== "GC=F")
        .map((s, si) => {
          const rv = x.correlations!.rows[gi]?.[si] ?? null;
          return `${s} ${typeof rv === "number" ? (rv >= 0 ? "+" : "") + rv.toFixed(2) : "n/a"}`;
        })
        .join(" · ");
      push("intermarket", "Corr Matrix", 0, pairs);
    }
  }

  // ---- sentiment & context ----
  if (x.news && x.news.length > 0) {
    let tally = 0;
    for (const n of x.news) {
      if (n.sentiment === "bullish") tally++;
      else if (n.sentiment === "bearish") tally--;
    }
    const v = biasClamp(Math.round((tally / x.news.length) * 4 * 10) / 10, -4, 4);
    push("sentiment", "News Tally", v, `${x.news.length} headlines · ${tally >= 0 ? "+" : ""}${tally}`);
  }
  if (x.seasonality && x.seasonality.length > 0) {
    const month = new Date(now).getUTCMonth() + 1;
    const row = x.seasonality.find((s) => s.month === month);
    if (row && row.count >= 15) {
      const v = biasClamp(Math.round(row.avgPct * row.winRate * 30) / 10, -3, 3);
      push("sentiment", "Seasonality", v, `${row.label} avg ${pct(row.avgPct)}`);
    }
  }
  if (x.tape && x.tape.length >= 5) {
    const t = x.tape.slice(-12);
    const roc = ((t[t.length - 1].price - t[0].price) / t[0].price) * 100;
    const v = biasClamp(roc * 2, -3, 3);
    push("sentiment", "Tick Tape", Math.round(v * 10) / 10, `${pct(roc)} last 12 ticks`);
  }
  const session = activeSession(new Date(now));
  push("sentiment", "Session", 0, `${session.label} · ${session.note}`);
  if (x.sessions) {
    const cur = x.sessions.find((s) => s.isCurrent);
    if (cur && cur.movePct !== null) {
      push("sentiment", "Session Stats", 0, `persistent move ${pct(cur.movePct, 1)}`);
    }
  }

  const ev = eventRisk(x.events, now);
  if (ev) warnings.push(`EVENT RISK ${ev.note} ${ev.when}`);

  const levels: BiasLevel[] = [];
  if (pdh !== null) levels.push({ label: "PDH", value: pdh, kind: "resistance" });
  if (px !== null) levels.push({ label: "P", value: px, kind: "spot" });
  if (dOpen !== null) levels.push({ label: "DO", value: dOpen, kind: "open" });
  if (pdl !== null) levels.push({ label: "PDL", value: pdl, kind: "support" });
  if (vw !== null) levels.push({ label: "VWAP", value: vw, kind: "iva" });
  if (x.options && x.options.maxOiStrike !== null) {
    levels.push({ label: "MOI", value: x.options.maxOiStrike, kind: px !== null && px > x.options.maxOiStrike ? "resistance" : "support" });
  }
  if (px !== null && daily.length >= 2) {
    const ppt = classicPivots(daily[daily.length - 2].high, daily[daily.length - 2].low, daily[daily.length - 2].close);
    levels.push({ label: "Piv", value: ppt.p, kind: "pivot" });
  }

  const primaryScore = biasClamp(
    tallies.structure + tallies.macro + tallies.positioning,
    -(budget.structure + budget.macro + budget.positioning),
    budget.structure + budget.macro + budget.positioning
  );
  const tacticalScore = biasClamp(
    tallies.momentum + tallies.location + tallies.orderflow + tallies.intermarket + tallies.sentiment,
    -(budget.momentum + budget.location + budget.orderflow + budget.intermarket + budget.sentiment),
    budget.momentum + budget.location + budget.orderflow + budget.intermarket + budget.sentiment
  );

  const pillars: BiasPillar[] = [
    { id: "structure", label: "Structure", vote: Math.round(biasClamp(tallies.structure, -budget.structure, budget.structure)), max: budget.structure, note: tallieNotes.structure.slice(-3).join(" · ") },
    { id: "momentum", label: "Momentum", vote: Math.round(biasClamp(tallies.momentum, -budget.momentum, budget.momentum)), max: budget.momentum, note: tallieNotes.momentum.slice(-3).join(" · ") },
    { id: "location", label: "Location", vote: Math.round(biasClamp(tallies.location, -budget.location, budget.location)), max: budget.location, note: tallieNotes.location.slice(-3).join(" · ") },
    { id: "orderflow", label: "Order Flow", vote: Math.round(biasClamp(tallies.orderflow, -budget.orderflow, budget.orderflow)), max: budget.orderflow, note: tallieNotes.orderflow.slice(-3).join(" · ") },
    { id: "macro", label: "Macro", vote: Math.round(biasClamp(tallies.macro, -budget.macro, budget.macro)), max: budget.macro, note: tallieNotes.macro.slice(-3).join(" · ") },
    { id: "positioning", label: "Positioning", vote: Math.round(biasClamp(tallies.positioning, -budget.positioning, budget.positioning)), max: budget.positioning, note: tallieNotes.positioning.slice(-3).join(" · ") },
    { id: "intermarket", label: "Intermarket", vote: Math.round(biasClamp(tallies.intermarket, -budget.intermarket, budget.intermarket)), max: budget.intermarket, note: tallieNotes.intermarket.slice(-3).join(" · ") },
    { id: "sentiment", label: "Sentiment", vote: Math.round(biasClamp(tallies.sentiment, -budget.sentiment, budget.sentiment)), max: budget.sentiment, note: tallieNotes.sentiment.slice(-3).join(" · ") },
  ];
  const capped = pillars.reduce((acc, p) => acc + p.vote, 0);
  const score = biasClamp(capped, -100, 100);
  const strength: BiasStrength = Math.abs(score) >= 55 ? "strong" : Math.abs(score) >= 28 ? "moderate" : "weak";
  const feedT = x.feedT;
  const fresh = feedT !== null && now - feedT <= 15_000;

  return {
    ts: now,
    symbol: x.symbol,
    price: px,
    score,
    bias: biasOf(score, 28),
    strength,
    primary: { score: Math.round(primaryScore), bias: biasOf(primaryScore, 24), note: "structure + macro + positioning" },
    tactical: { score: Math.round(tacticalScore), bias: biasOf(tacticalScore, 22), note: "momentum + location + order flow + intermarket + sentiment" },
    session,
    pillars,
    factors,
    levels,
    warnings,
    feed: { t: feedT, fresh },
  };
}