"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getTape } from "../../lib/api";

export default function TapeWidget() {
  const { data } = useQuery({
    queryKey: ["tape"],
    queryFn: () => getTape(),
    refetchInterval: 2_000,
  });
  const quote = data?.quote ?? null;
  const rows = (data?.ticks ?? []).slice(-18).reverse();

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center gap-3 flex-wrap mb-1.5">
        <span className="text-[15px] font-bold tabular-nums">{fmt(quote?.price)}</span>
        <span className={fmt(quote?.changePercent, 2).startsWith("-") ? "down" : "up"}>
          {quote?.changePercent !== null && quote?.changePercent !== undefined
            ? `${quote.changePercent >= 0 ? "+" : ""}${fmt(quote.changePercent, 2)}%`
            : ""}
        </span>
        <span className="dim">
          bid {fmt(quote?.bid)} · ask {fmt(quote?.ask)}
        </span>
        <span className="dim">spread {fmt(data?.spread)}</span>
        <span className="dim">src {quote?.source}</span>
      </div>
      <div className="dim text-[10px] mb-1">
        Last {data?.ticks.length ?? 0} ticks · {data?.symbol}
      </div>
      <div className="flex justify-between dim text-[10px] uppercase tracking-wide border-b border-[#161616] pb-1">
        <span>Time (UTC)</span>
        <span>Price</span>
        <span>Chg%</span>
        <span className="text-right">Vol</span>
      </div>
      {rows.map((t, i) => {
        const prev = rows[i + 1];
        const up = prev ? t.price >= prev.price : t.changePercent !== null && t.changePercent >= 0;
        const chg = t.changePercent;
        return (
          <div key={`${t.t}-${i}`} className="flex justify-between py-0.5 border-b border-[#141414] tabular-nums">
            <span className="dim text-[10px]">{new Date(t.t).toISOString().slice(11, 19)}Z</span>
            <span className={up ? "up" : "down"}>{fmt(t.price)}</span>
            <span className={chg !== null && chg >= 0 ? "up" : chg !== null ? "down" : "dim"}>
              {chg !== null ? `${chg >= 0 ? "+" : ""}${fmt(chg, 2)}%` : "—"}
            </span>
            <span className="text-right dim">{t.volume !== null && t.volume > 0 ? fmt(t.volume, 0) : "—"}</span>
          </div>
        );
      })}
      {rows.length === 0 && <div className="dim mt-1">No ticks yet — waiting on the live quote cache.</div>}
    </div>
  );
}