"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, pctClass, type Quote } from "../../lib/api";
import { GOLD_SYMBOL, useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import Flash from "../Flash";

// One troy ounce = 31.1035 grams — handy for spot gold traders quoting per gram.
const GRAMS_PER_OZ = 31.1034768;

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const isGold = symbol === "XAUUSD" || symbol === "XAUUSD=X";
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${symbol}`))[0],
    refetchInterval: 1_000,
  });

  // Live COMEX gold futures — quoted so the basis (contango/backwardation) shows.
  const { data: gc } = useQuery({
    queryKey: ["quote", "GC=F"],
    enabled: isGold,
    queryFn: async () => (await apiGet<Quote[]>("/api/quotes?symbols=GC=F"))[0],
    refetchInterval: 5_000,
  });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!data) return <div className="p-2 dim">Loading {symbol}…</div>;

  const perGram = data.price !== null ? data.price / GRAMS_PER_OZ : null;
  const spread = data.bid !== null && data.ask !== null ? data.ask - data.bid : null;
  const basis = isGold && gc !== undefined && gc.price !== null && data.price !== null ? data.price - gc.price : null;
  const rangePos =
    data.high !== null && data.low !== null && data.high > data.low && data.price !== null
      ? Math.min(100, Math.max(0, ((data.price - data.low) / (data.high - data.low)) * 100))
      : null;

  const feedAge = data.time !== null ? Math.floor(Date.now() / 1000 - data.time) : null;
  const stale = feedAge !== null && feedAge > 15;

  const rows: Array<[string, string]> = [
    ["Prev Close", data.previousClose !== null ? fmt(data.previousClose) : "—"],
    ["Open", data.open !== null ? fmt(data.open) : "—"],
    ["Day High", data.high !== null ? fmt(data.high) : "—"],
    ["Day Low", data.low !== null ? fmt(data.low) : "—"],
    ["Bid", data.bid !== null ? fmt(data.bid) : "—"],
    ["Ask", data.ask !== null ? fmt(data.ask) : "—"],
    ...(spread !== null ? [["Spread", fmt(spread)] as [string, string]] : []),
    ["Volume", data.volume !== null ? fmt(data.volume, 0) : "—"],
    ["52 Week High", data.week52High !== null ? fmt(data.week52High) : "—"],
    ["52 Week Low", data.week52Low !== null ? fmt(data.week52Low) : "—"],
    ["Per Gram (USD)", perGram !== null ? fmt(perGram, 3) : "—"],
  ];

  return (
    <div className="p-2">
      <div className="flex items-baseline gap-3 mb-1">
        <Flash value={data.price} className="text-xl font-bold">{fmt(data.price)}</Flash>
        <Flash value={data.changePercent} className={`${pctClass(data.changePercent)} text-sm`}>
          {data.change !== null && data.change >= 0 ? "+" : ""}
          {fmt(data.change)} ({fmt(data.changePercent)}%)
        </Flash>
        <span
          className={`ml-auto text-[10px] ${stale ? "amber font-bold" : "dim"}`}
          title={data.time !== null ? `Latest feed tick ${new Date(data.time * 1000).toISOString()}` : "No intraday feed timestamp"}
        >
          {data.source}
          {feedAge !== null ? ` ${feedAge}s${stale ? " · STALE" : ""}` : ""}
        </span>
      </div>
      <div className="dim text-[11px] mb-1 truncate">
        {data.name ?? `${GOLD_SYMBOL} (Gold Spot / USD)`}
      </div>

      {rangePos !== null && (
        <div className="mb-2">
          <div className="flex justify-between text-[10px] dim">
            <span>Day range position</span>
            <span className="text-[var(--text)]">{fmt(data.price)} · {rangePos.toFixed(0)}%</span>
          </div>
          <div className="relative h-1 bg-[#161616] rounded-full overflow-hidden mt-1">
            <div className="absolute left-0 top-0 bottom-0 bg-[var(--amber-dim)] opacity-60" style={{ width: `${rangePos}%` }} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-[var(--amber)] rounded-full" style={{ left: `${rangePos}%` }} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-[#161616] py-0.5">
            <span className="dim">{label}</span>
            <span>{value}</span>
          </div>
        ))}
        {gc !== undefined && (
          <div className="flex justify-between border-b border-[#161616] py-0.5" title="Spot − GC=F; negative = contango (futures above spot)">
            <span className="dim">Basis Spot−GC=F</span>
            <span className={basis !== null && basis === 0 ? "dim" : basis !== null && basis > 0 ? "up" : "down"}>
              {basis !== null ? `${basis > 0 ? "+" : ""}${fmt(basis)}` : "—"}
              {gc.price !== null ? ` · ${fmt(gc.price)}` : ""}
            </span>
          </div>
        )}
      </div>
      {data.marketState && (
        <div className="dim text-[10px] mt-1">Market state: {data.marketState}</div>
      )}
    </div>
  );
}