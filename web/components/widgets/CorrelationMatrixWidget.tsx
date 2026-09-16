"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getCorrelations } from "../../lib/api";

const cellClass = (v: number | undefined): string => {
  if (v === undefined) return "dim";
  if (v >= 0.5) return "bg-[#00c85333]";
  if (v >= 0.25) return "bg-[#00c85318]";
  if (v <= -0.5) return "bg-[#ff3d3d33]";
  if (v <= -0.25) return "bg-[#ff3d3d18]";
  return "";
};

const SHORT: Record<string, string> = {
  XAUUSD: "GOLD",
  "GC=F": "GC",
  "XAGUSD=X": "SIL",
  "SI=F": "SILF",
  "DX-Y.NYB": "DXY",
  SPY: "SPX",
  TLT: "TLT",
  GLD: "GLD",
  "^VIX": "VIX",
  "EURUSD=X": "EUR",
};

export default function CorrelationMatrixWidget() {
  const { data } = useQuery({
    queryKey: ["correlations"],
    queryFn: () => getCorrelations(),
    refetchInterval: 60_000,
  });
  const symbols = data?.symbols ?? [];

  return (
    <div className="p-2 text-[11px]">
      <div className="dim text-[10px] mb-1.5">
        Rolling {data?.n ?? 90}-day return correlation across the gold complex
      </div>
      <div className="overflow-auto">
        <table className="border-collapse w-full">
          <thead>
            <tr>
              <th className="p-0.5 sticky left-0 bg-[var(--panel)]" />
              {symbols.map((s) => (
                <th key={s} className="p-0.5 text-[9px] font-normal dim tabular-nums" title={s}>
                  {SHORT[s] ?? s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((a, i) => (
              <tr key={a}>
                <td className="p-0.5 text-[9px] dim tabular-nums sticky left-0 bg-[var(--panel)]">{SHORT[a] ?? a}</td>
                {symbols.map((b, j) => {
                  const v = data?.rows?.[i]?.[j];
                  return (
                    <td
                      key={b}
                      className={`p-0.5 text-center tabular-nums ${cellClass(v)}`}
                      title={`${a} vs ${b}`}
                    >
                      {v === undefined ? "·" : fmt(v, 2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {symbols.length === 0 && <div className="dim mt-1">Not enough daily data yet.</div>}
    </div>
  );
}