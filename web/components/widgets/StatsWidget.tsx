"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { exportHref, fmt, getStats } from "../../lib/api";

const RANGES = ["1D", "1W", "1M"] as const;

function Cell({ label, value, suffix = "" }: { label: string; value: number | null; suffix?: string }) {
  const sign = value !== null && value > 0;
  const neg = value !== null && value < 0;
  return (
    <div className="px-2 py-1">
      <div className="dim text-[10px] uppercase tracking-wide">{label}</div>
      <div className={`tabular-nums ${neg ? "down" : sign ? "up" : ""}`}>
        {value === null ? "—" : `${sign ? "+" : ""}${fmt(value)}${suffix}`}
      </div>
    </div>
  );
}

export default function StatsWidget() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("1D");
  const { data } = useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center justify-between mb-1">
        <span className="dim text-[10px]">Realized volatility &amp; drawdown desk · {data?.bars ?? 0} daily bars</span>
        <a className="amber hover:underline text-[10px]" href={exportHref("XAUUSD", range)} download>
          ⤓ CSV
        </a>
      </div>
      <div className="flex gap-1 mb-1.5">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-1.5 py-0.5 text-[10px] border ${range === r ? "border-[var(--amber)] text-[var(--text)]" : "border-[var(--border)] dim"}`}
          >
            {r}
          </button>
        ))}
      </div>
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-x-2">
            <Cell label="Last" value={data.last} />
            <Cell label="Day %" value={data.dayPct} suffix="%" />
            <Cell label="YTD %" value={data.ytdPct} suffix="%" />
            <Cell label="1Y %" value={data.ret1yPct} suffix="%" />
            <Cell label="52w High" value={data.yearHigh} />
            <Cell label="52w Low" value={data.yearLow} />
            <Cell label="Dd. from High %" value={data.ddFromHighPct} suffix="%" />
            <Cell label="vs SMA200 %" value={data.z200} suffix="%" />
          </div>
          <div className="dim text-[10px] mt-2 uppercase tracking-wide">Realized vol (ann.)</div>
          <div className="flex gap-1 mt-1">
            {([
              ["RV20", data.rv20],
              ["RV60", data.rv60],
              ["RV250", data.rv250],
            ] as Array<[string, number | null]>).map(([l, v]) => (
              <div key={l} className="border border-[#161616] px-2 py-1 flex-1 text-center">
                <div className="dim text-[9px] uppercase">{l}</div>
                <div className="tabular-nums">{v === null ? "—" : `${fmt(v, 1)}%`}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-2">
            {data.atr14 !== null && <Cell label="ATR(14)" value={data.atr14} />}
            <Cell label="Up days (90)" value={data.upDaysPct === null ? null : data.upDaysPct} suffix="%" />
          </div>
        </>
      ) : (
        <div className="dim">Loading desk stats…</div>
      )}
    </div>
  );
}