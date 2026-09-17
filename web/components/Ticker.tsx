"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, pctClass } from "../lib/api";
import { useTerminal } from "../store/terminal";

type Market = {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
};

function MarketItem({ m }: { m: Market }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="dim">{m.label.split("(")[0].trim()}</span>
      <span className="text-[var(--text)]">{fmt(m.price, 2)}</span>
      <span className={pctClass(m.changePercent)}>
        {m.changePercent !== null ? `${m.changePercent >= 0 ? "+" : ""}${fmt(m.changePercent)}%` : ""}
      </span>
    </span>
  );
}

export default function Ticker() {
  const pollMs = useTerminal((s) => s.settings?.refreshMs?.markets ?? 6_000);

  const { data: markets } = useQuery({
    queryKey: ["ticker-macro"],
    queryFn: async () => (await apiGet<{ markets: Market[] }>("/api/gold-macro")).markets,
    refetchInterval: pollMs,
  });

  if (!markets || markets.length === 0) return null;

  return (
    <div className="term-ticker border-b border-[var(--border)] bg-[var(--panel-2)] px-2 text-[10px] leading-5 h-5 shrink-0 select-none">
      <div className="term-ticker-track">
        <span className="term-ticker-copy">
          {markets.map((m) => <MarketItem key={m.symbol} m={m} />)}
        </span>
        <span className="term-ticker-copy" aria-hidden>
          {markets.map((m) => <MarketItem key={`dup-${m.symbol}`} m={m} />)}
        </span>
      </div>
    </div>
  );
}