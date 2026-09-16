export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

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
  sector?: string;
  label?: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
  impact?: "High" | "Medium" | "Low";
  sentiment?: "bullish" | "bearish" | "neutral";
};

export type AiProviderKey = "openrouter" | "groq" | "nvidia" | "gemini" | "anthropic";

export type PriceLevelAlert = {
  symbol: string;
  level: number;
  dir: "above" | "below";
  label?: string;
};

export type ApiSettings = {
  refreshMs: { quotes: number; charts: number; markets: number; news: number };
  alerts: {
    enabled: boolean;
    sound: boolean;
    thresholdPct: number;
    highImpact: boolean;
    display: "beep" | "tone";
    volume: number;
    levels: PriceLevelAlert[];
    notifications: boolean;
    countdownMin: number;
    newsKeywords: string[];
    webhook: { enabled: boolean; url: string };
  };
  providerOrder: AiProviderKey[];
  providers: Partial<Record<AiProviderKey, boolean>>;
  aiConfigured: boolean;
};

export type SeasonalityRow = {
  month: number;
  label: string;
  avgPct: number;
  medianPct: number;
  winRate: number;
  avgMovePct: number;
  count: number;
};

export type SessionStat = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  move: number;
  movePct: number;
  rangePct: number;
  isCurrent: boolean;
};

export async function getSeasonality(symbol = "XAUUSD"): Promise<SeasonalityRow[]> {
  return apiGet<SeasonalityRow[]>(`/api/seasonality?symbol=${encodeURIComponent(symbol)}`);
}

export async function getSessionStats(symbol = "XAUUSD"): Promise<SessionStat[]> {
  return apiGet<SessionStat[]>(`/api/session-stats?symbol=${encodeURIComponent(symbol)}`);
}

// ---- desk features (tape, stats, futures curve, options, COT, rate probs,
// ETF flows, correlation matrix) ----

export type TapeTick = { t: number; price: number; changePercent: number | null; volume: number | null; source: string };

export type TapeApi = {
  symbol: string;
  quote: Quote | null;
  ticks: TapeTick[];
  spread: number | null;
  lastSale: TapeTick | null;
  n: number;
};

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

export type CurveRow = { symbol: string; label: string; price: number | null; basis: number | null; basisPct: number | null };
export type FuturesCurve = { rows: CurveRow[]; status: "contango" | "backwardation" | "flat" | "n/a" };

export type OptionsSummary = {
  underlying: number | null;
  expiry: number | null;
  atmStrike: number | null;
  atmIv: number | null;
  skewProxy: number | null;
  putCallOiRatio: number | null;
  maxOiStrike: number | null;
  avgIv: number | null;
  nCalls: number;
  nPuts: number;
};

export type CotSummary = {
  reportDate: string | null;
  netManaged: number | null;
  wwChange: number | null;
  netSwap: number | null;
  netOther: number | null;
  status: "managed_bull" | "managed_bear" | "flat" | "n/a";
};

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

export type EtfFlowSummary = {
  symbol: string;
  label?: string;
  series: Array<{ time: number; flowM: number }>;
  sum1dM: number | null;
  sum5dM: number | null;
  sum20dM: number | null;
  bars: number;
};

export type CorrMatrix = { symbols: string[]; rows: number[][]; n: number };

export const getTape = (symbol = "XAUUSD") => apiGet<TapeApi>(`/api/tape?symbol=${encodeURIComponent(symbol)}`);
export const getStats = (symbol = "XAUUSD") => apiGet<StatsRow>(`/api/stats?symbol=${encodeURIComponent(symbol)}`);
export const getFuturesCurve = () => apiGet<FuturesCurve>("/api/futures-curve");
export const getOptions = (symbol = "GC=F") => apiGet<OptionsSummary>(`/api/options?symbol=${encodeURIComponent(symbol)}`);
export const getCot = () => apiGet<CotSummary>("/api/cot");
export const getRateProbs = () => apiGet<RateProbs>("/api/rate-probs");
export const getEtfFlows = (symbol = "GLD") => apiGet<EtfFlowSummary>(`/api/etf-flows?symbol=${encodeURIComponent(symbol)}`);
export const getCorrelations = () => apiGet<CorrMatrix>("/api/correlations");

export const exportHref = (symbol = "XAUUSD", range = "1D") =>
  `/api/export.csv?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`;

export type AiResult = { text: string; provider: string; model: string };

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pctClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "dim";
  return n >= 0 ? "up" : "down";
}
