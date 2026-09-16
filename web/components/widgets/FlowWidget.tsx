"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmt, getEtfFlows } from "../../lib/api";

const ETFS = [
  { symbol: "GLD", label: "GLD — SPDR Gold Shares" },
  { symbol: "SLV", label: "SLV — iShares Silver Trust" },
  { symbol: "IAU", label: "IAU — iShares Gold Trust" },
  { symbol: "GDX", label: "GDX — VanEck Gold Miners" },
];

export default function FlowWidget() {
  const [sym, setSym] = useState("GLD");
  const { data } = useQuery({
    queryKey: ["etf-flows", sym],
    queryFn: () => getEtfFlows(sym),
    refetchInterval: 60_000,
  });

  const bars = useMemo(() => {
    const s = data?.series ?? [];
    if (s.length === 0) return [];
    const max = Math.max(...s.map((x) => Math.abs(x.flowM)), 1);
    return s.slice(-24).map((x) => ({
      h: Math.max(4, (Math.abs(x.flowM) / max) * 100),
      d: x.flowM >= 0 ? "up" : "down",
    }));
  }, [data]);

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <label className="dim text-[10px] uppercase tracking-wide">Flow (directional $ proxy)</label>
      </div>
      <div className="flex gap-1 mb-2 flex-wrap">
        {ETFS.map((e) => (
          <button
            key={e.symbol}
            onClick={() => setSym(e.symbol)}
            className={`px-1.5 py-0.5 text-[10px] border ${sym === e.symbol ? "border-[var(--amber)] text-[var(--text)]" : "border-[var(--border)] dim"}`}
            title={e.label}
          >
            {e.symbol}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[9px] uppercase">1d</div>
          <div className={`tabular-nums ${data?.sum1dM !== null && data?.sum1dM !== undefined && data.sum1dM > 0 ? "up" : "down"}`}>
            {data?.sum1dM === null || data?.sum1dM === undefined ? "—" : `${fmt(data.sum1dM)}M`}
          </div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[9px] uppercase">5d</div>
          <div className={`tabular-nums ${data?.sum5dM !== null && data?.sum5dM !== undefined && data.sum5dM > 0 ? "up" : "down"}`}>
            {data?.sum5dM === null || data?.sum5dM === undefined ? "—" : `${fmt(data.sum5dM)}M`}
          </div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[9px] uppercase">20d</div>
          <div className={`tabular-nums ${data?.sum20dM !== null && data?.sum20dM !== undefined && data.sum20dM > 0 ? "up" : "down"}`}>
            {data?.sum20dM === null || data?.sum20dM === undefined ? "—" : `${fmt(data.sum20dM)}M`}
          </div>
        </div>
      </div>
      <div className="flex items-end gap-px h-10 mt-1">
        {bars.map((b, i) => (
          <div
            key={i}
            className={`flex-1 ${b.d === "up" ? "bg-[var(--up)]" : "bg-[var(--down)]"}`}
            style={{ height: `${b.h}%` }}
            title={`${data?.series[data.series.length - bars.length + i]?.time ? new Date(data.series[data.series.length - bars.length + i].time * 1000).toISOString().slice(0, 10) : ""} · ${fmt(data?.series[data.series.length - bars.length + i]?.flowM ?? null)}M`}
          />
        ))}
      </div>
      <div className="dim text-[10px] mt-1.5">
        Flow proxy = Δclose × volume in $M (daily). Directional estimate of investor flows — before-tracking data is not publicly free.
      </div>
    </div>
  );
}