// CME delayed gold futures options (COMEX Gold, productId 192). CME's public
// JSON API serves the full strike chain — every listed strike with the call/put
// last, prior settle and volume — plus the underlying GC future quote, ~10 min
// delayed. Yahoo no longer carries futures options at all, so this is the only
// free source of a real GC option chain. IV is not in the payload, so it is
// imputed from the traded price with Black-76 (the futures-option model).
import type { OptionChainLike } from "../analytics.js";

const BASE = "https://www.cmegroup.com";
const GOLD_OPTION_PRODUCT = 192;

const UA = "Mozilla/5.0 (Windows NT 10.0; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Fetch JSON from CME directly, retrying once, then via the Jina reader proxy
 *  (runs from cloud IPs CME serves — how the rest of the terminal keeps working
 *  on Render). The proxy wraps JSON responses in a short markdown preamble. */
async function cmeJson<T>(path: string, timeout = 20_000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_500 * attempt));
    try {
      const res = await fetch(BASE + path, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`cme ${res.status} for ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    const res = await fetch(`https://r.jina.ai/${BASE}${path}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(timeout + 10_000),
    });
    if (!res.ok) throw new Error(`cme-via-proxy ${res.status} for ${path}`);
    const text = await res.text();
    const marker = "Markdown Content:";
    const start = text.indexOf(marker);
    const body = start >= 0 ? text.slice(start + marker.length).trim() : text.trim();
    return JSON.parse(body) as T;
  } catch (err) {
    throw lastErr ?? err;
  }
}

type ExpirationsResponse = Array<{
  contractExpirations: Array<{
    label: string;
    expirationMonth: number;
    expirationYear: number;
    displayExpirationMonth: string;
    displayExpirationYear: string;
    lastTradeDate: string; // 2026-09-24T00:00:00
    underlyingFutureContract: string;
    underlyingFutureExpirationCode: string;
  }>;
}>;

type QuoteResponse = {
  quotes: Array<{
    last: string;
    priorSettle: string;
    quoteCode: string;
  }>;
};

type Leg = {
  last: string;
  priorSettle: string;
  volume: string;
};

type ChainResponse = {
  strikePrices: Array<{
    strikePrice: string;
    put: Leg;
    call: Leg;
    underlyingFutureContract: string;
  }>;
};

function toNum(s: string): number | null {
  if (typeof s !== "string") return null;
  // CME occasionally formats values presentationally ("4,362.5"); parseFloat
  // would stop at the comma and silently return 4.
  const v = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

// ---- Black-76: fair value and implied vol for a futures option ----
const normErf = (() => {
  // erf via Abramowitz–Stegun 7.1.26 — enough precision for IV bisection.
  function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
    return sign * y;
  }
  return (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
})();

function black76Price(F: number, K: number, t: number, v: number, isCall: boolean): number {
  if (t <= 0 || v <= 0) return NaN;
  const d1 = (Math.log(F / K) + (v * v * t) / 2) / (v * Math.sqrt(t));
  const d2 = d1 - v * Math.sqrt(t);
  return isCall ? F * normErf(d1) - K * normErf(d2) : K * normErf(-d2) - F * normErf(-d1);
}

/** Implied vol (Black-76) for a listed price on a futures option. */
function impliedVol(F: number, K: number, t: number, price: number, isCall: boolean, rf = 0): number | null {
  if (!Number.isFinite(F) || F <= 0 || K <= 0 || t <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const df = Math.exp(-rf * t);
  const intrinsic = isCall ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (price <= df * intrinsic) return null;
  let lo = 1e-4;
  let hi = 5;
  const fitP = (v: number) => black76Price(F * df, K * df, t, v, isCall) / df - price / df;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fitP(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const DAY_MS = 86_400_000;

/** Full GC=F option chain (nearest listed option expiry) from CME, ~10 min
 *  delayed. Strikes priced with a last or prior settle; IV imputed Black-76
 *  from the underlying GC future (last/prior settle). Open interest is not
 *  published on this feed, so OI-backed fields stay null upstream. */
export async function goldOptionsChain(): Promise<OptionChainLike> {
  const expirations = await cmeJson<ExpirationsResponse>("/CmeWS/mvc/atm/expirations/192");
  const group = expirations[0];
  const expiry = group?.contractExpirations?.[0];
  if (!expiry) throw new Error("cme: no option expirations for gold");

  const [, yyyy, mm, dd] = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry.lastTradeDate) ?? [];
  if (!yyyy || !mm || !dd) throw new Error("cme: bad lastTradeDate " + expiry.lastTradeDate);
  const lastTrade = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));

  // The strike chain is keyed by the calendar month of last trade (e.g. the Oct
  // 2026 option's last trade day is in 2026-09), not by the contract month.
  const chain = await cmeJson<ChainResponse>(`/CmeWS/mvc/atm/strike-prices/192/${yyyy}/${mm}/ALL`);
  const underlyingCode = chain.strikePrices?.[0]?.underlyingFutureContract ?? expiry.underlyingFutureContract;

  // Underlying GC future price: the live quote when available, else the option
  // month's own implied level is meaningless — fall back to the same feed.
  let underlyingPrice: number | null = null;
  try {
    const quote = await cmeJson<QuoteResponse>(`/CmeWS/mvc/quotes/v2/192/${underlyingCode}`);
    const q = quote.quotes?.[0];
    underlyingPrice = toNum(q?.last) ?? toNum(q?.priorSettle);
  } catch {
    underlyingPrice = null;
  }

  const t = Math.max(lastTrade.getTime() - Date.now(), 0) / (365 * DAY_MS);
  const spot = underlyingPrice;

  const calls: OptionChainLike["calls"] = [];
  const puts: OptionChainLike["puts"] = [];

  // Far-OTM strikes quote at the 0.10 minimum, which back-solves to junk IVs
  // (hundreds of percent) and swamps the summary. Keep the near-money surface —
  // within ±10% of the underlying — like a normal chain screen.
  const bandLo = spot !== null ? spot * 0.9 : 0;
  const bandHi = spot !== null ? spot * 1.1 : Infinity;

  for (const row of chain.strikePrices ?? []) {
    const K = toNum(row.strikePrice);
    if (K === null || K < bandLo || K > bandHi) continue;
    const mk = (leg: Leg, isCall: boolean) => {
      const last = toNum(leg.last);
      const prior = toNum(leg.priorSettle);
      const lastPrice = last ?? prior;
      if (lastPrice === null) return null;
      const iv = spot !== null ? impliedVol(spot, K, t, lastPrice, isCall) : null;
      return {
        strike: K,
        lastPrice,
        openInterest: null,
        // Sane IV range; values outside are unrealistic quote artifacts.
        impliedVolatility: iv !== null && iv >= 0.02 && iv <= 3 ? iv : null,
        bid: null,
        ask: null,
      };
    };
    const c = mk(row.call, true);
    const p = mk(row.put, false);
    if (c) calls.push(c);
    if (p) puts.push(p);
  }

  return {
    underlyingPrice: spot,
    expirationDate: Math.floor(lastTrade.getTime() / 1000),
    calls,
    puts,
  };
}