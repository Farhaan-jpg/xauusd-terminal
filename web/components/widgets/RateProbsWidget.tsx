"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getRateProbs } from "../../lib/api";

function Bar({ label, pct, cls }: { label: string; pct: number | null; cls: string }) {
  const v = pct === null ? 0 : Math.round(pct * 1000) / 10;
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 dim text-[10px] uppercase">{label}</span>
      <div className="flex-1 h-2 bg-[#151515] relative">
        <div className={`absolute inset-y-0 left-0 ${cls}`} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
      <span className="w-12 text-right tabular-nums">{pct === null ? "—" : `${v}%`}</span>
    </div>
  );
}

export default function RateProbsWidget() {
  const { data } = useQuery({
    queryKey: ["rate-probs"],
    queryFn: () => getRateProbs(),
    refetchInterval: 60_000,
  });

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center justify-between flex-wrap mb-1.5">
        <span className="dim text-[10px]">FedWatch-style · next FOMC {data?.nextFomcLabel ?? "…"}</span>
        <span className="dim text-[10px]">
          pick-up {data?.expectedChangeBp !== null && data?.expectedChangeBp !== undefined ? `${data.expectedChangeBp >= 0 ? "+" : ""}${fmt(data.expectedChangeBp)}bp` : "—"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">Effective fed funds</div>
          <div className="tabular-nums">
            {data?.currentRateBp !== null && data?.currentRateBp !== undefined ? `${(data.currentRateBp / 100).toFixed(2)}%` : "—"}
          </div>
        </div>
        <div className="border border-[#161616] px-2 py-1">
          <div className="dim text-[10px] uppercase tracking-wide">Implied (ZQ=F)</div>
          <div className="tabular-nums">
            {data?.impliedRateBp !== null && data?.impliedRateBp !== undefined ? `${(data.impliedRateBp / 100).toFixed(2)}%` : "—"}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Bar label="Hike 25" pct={data?.probHike25 ?? null} cls="bg-[var(--up)]" />
        <Bar label="Hold" pct={data?.probHold ?? null} cls="bg-[var(--amber)]" />
        <Bar label="Cut 25" pct={data?.probCut25 ?? null} cls="bg-[var(--down)]" />
      </div>
      <div className="dim text-[10px] mt-1.5">
        Two-outcome model from front 30-day Fed Funds futures vs effective target, ~10bp spot vol.
      </div>
    </div>
  );
}