/**
 * CNBC quote feed — works for US equities, indices, and the US Dollar Index.
 * Used as the primary source for DXY (.DXY) since Yahoo is geo-blocked.
 */

import type { Quote } from "./yahoo.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const n = (v: unknown): number | null => {
  // CNBC renders some figures presentationally — "4.996%", "1,234.5" — so strip
  // symbols and grouping characters before parsing.
  const cleaned = String(v ?? "").replace(/[%$,#\s]/g, "").replace(/,/g, "");
  if (cleaned === "") return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

interface CnbcRow {
  symbol?: string;
  name?: string;
  last?: string;
  last_timedate?: string;
  last_time?: string;
  changetype?: string;
  change?: string;
  changepct?: string;
  open?: string;
  high?: string;
  low?: string;
  high52?: string;
  low52?: string;
  yrhiprice?: string;
  yrloprice?: string;
  prev_close?: string;
  curmktstatus?: string;
  exchange?: string;
  type?: string;
  code?: number;
}

export async function quote(symbol: string, displayName: string, displaySymbol: string): Promise<Quote> {
  const url =
    "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" +
    encodeURIComponent(symbol) +
    "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=0&output=json";
  const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  if (!res.ok) throw new Error("cnbc " + res.status);
  const data = await res.json();
  const q: CnbcRow = data?.FormattedQuoteResult?.FormattedQuote?.[0];
  if (!q || q.code !== 0) throw new Error("cnbc: no data for " + symbol);

  const price = n(q.last);
  const prev = n(q.prev_close);
  const change = q.changetype === "DOWN" ? -Math.abs(n(q.change) ?? 0) : n(q.change);

  return {
    symbol: displaySymbol,
    name: q.name ?? displayName,
    price,
    change: change ?? (price !== null && prev !== null ? price - prev : null),
    changePercent: n(q.changepct),
    open: n(q.open),
    high: n(q.high) ?? n(q.high52) ?? price,
    low: n(q.low) ?? n(q.low52) ?? price,
    previousClose: prev,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: n(q.yrhiprice) ?? n(q.high52),
    week52Low: n(q.yrloprice) ?? n(q.low52),
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: q.exchange ?? "CNBC",
    marketState: q.curmktstatus ?? null,
    time: q.last_time ? Math.floor(new Date(q.last_time).getTime() / 1000) : null,
    source: "cnbc",
  };
}
