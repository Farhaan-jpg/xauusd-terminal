"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getFuturesCurve } from "../../lib/api";

const STATUS_CLASS: Record<string, string> = {
  contango: "up",
  backwardation: "down",
  flat: "dim",
  "n/a": "dim",
};

export default function FuturesCurveWidget() {
  const { data } = useQuery({
    queryKey: ["futures-curve"],
    queryFn: () => getFuturesCurve(),
    refetchInterval: 30_000,
  });
  const rows = data?.rows ?? [];
  const priced = rows.filter((r) => r.price !== null).length;

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center gap-3 flex-wrap mb-1.5">
        <span className="dim text-[10px]">
          COMEX gold term structure · {priced}/{rows.length} months pricing
        </span>
        <span className={`border border-[#161616] px-1.5 uppercase tracking-wide ${STATUS_CLASS[data?.status ?? "n/a"] ?? "dim"}`}>
          {data?.status ?? "…"}
        </span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="dim text-[10px] uppercase tracking-wide">
            <th className="text-left pb-1">Contract</th>
            <th className="text-right pb-1">Price</th>
            <th className="text-right pb-1">Basis $</th>
            <th className="text-right pb-1">Basis %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-t border-[#161616]">
              <td className="py-0.5 pr-2">{r.label}</td>
              <td className="py-0.5 px-2 text-right tabular-nums">{r.price !== null ? fmt(r.price) : "—"}</td>
              <td className={`py-0.5 px-2 text-right tabular-nums ${r.basis !== null && r.basis > 0 ? "up" : r.basis !== null && r.basis < 0 ? "down" : "dim"}`}>
                {r.basis !== null ? `${r.basis > 0 ? "+" : ""}${fmt(r.basis)}` : "—"}
              </td>
              <td className={`py-0.5 text-right tabular-nums ${r.basisPct !== null && r.basisPct > 0 ? "up" : r.basisPct !== null && r.basisPct < 0 ? "down" : "dim"}`}>
                {r.basisPct !== null ? `${r.basisPct > 0 ? "+" : ""}${fmt(r.basisPct, 2)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim text-[10px] mt-1.5">
        Basis = contract vs XAUUSD spot. All months contango ⇒ carry positive; inversion suggests tight near supply.
      </div>
    </div>
  );
}