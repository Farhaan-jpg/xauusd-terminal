"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getCot } from "../../lib/api";

const STATUS_LABEL: Record<string, string> = {
  managed_bull: "Money managers net long",
  managed_bear: "Money managers net short",
  flat: "Net flat",
  "n/a": "No data",
};

export default function CotWidget() {
  const { data } = useQuery({
    queryKey: ["cot"],
    queryFn: () => getCot(),
    refetchInterval: 5 * 60_000,
  });

  const m = data?.netManaged ?? null;
  const w = data?.wwChange ?? null;

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span
          className={`font-bold border border-[#161616] px-1.5 ${
            m !== null && m > 0 ? "up" : m !== null && m < 0 ? "down" : "dim"
          }`}
        >
          {STATUS_LABEL[data?.status ?? "n/a"]}
        </span>
        <span className="dim text-[10px]">
          COT report {data?.reportDate ? new Date(data.reportDate).toISOString().slice(0, 10) : "n/a"} · released Fridays
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 my-1.5">
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">Net managed money</div>
          <div className="tabular-nums">{fmt(m, 0)}</div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">W/W change</div>
          <div className={`tabular-nums ${w !== null && w > 0 ? "up" : w !== null && w < 0 ? "down" : ""}`}>
            {w !== null ? `${w > 0 ? "+" : ""}${fmt(w, 0)}` : "—"}
          </div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">Net swap dealers</div>
          <div className="tabular-nums">{fmt(data?.netSwap, 0)}</div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">Net non-reporting</div>
          <div className="tabular-nums">{fmt(data?.netOther, 0)}</div>
        </div>
      </div>
      <div className="dim text-[10px]">
        Positions in contracts (×100 oz). Managed money long/short = commercial paper exposure proxy; swap dealers are the natural short.
      </div>
    </div>
  );
}