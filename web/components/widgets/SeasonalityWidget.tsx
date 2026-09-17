"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getSeasonality } from "../../lib/api";

export default function SeasonalityWidget() {
  const { data } = useQuery({
    queryKey: ["seasonality"],
    queryFn: () => getSeasonality(),
    refetchInterval: 60_000,
  });
  const rows = data ?? [];
  const nowMonth = new Date().getUTCMonth() + 1;

  const hasStats = rows.some((r) => r.count > 0);
  const best = hasStats ? rows.reduce((b, r) => (r.count > 0 && r.avgPct > b.avgPct ? r : b), rows[0]) : null;
  const maxAbs = hasStats ? Math.max(...rows.filter((r) => r.count > 0).map((r) => Math.abs(r.avgPct)), 0.001) : 1;

  return (
    <div className="p-2 text-[11px]">
      <div className="dim text-[10px] mb-1.5">
        Average month-over-month % return of XAUUSD, by calendar month (◀ = current month)
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="dim text-[10px] uppercase tracking-wide">
            <th className="text-left pb-1">Month</th>
            <th className="text-right pb-1">Avg %</th>
            <th className="text-right pb-1">Win</th>
            <th className="text-right pb-1">Median</th>
            <th className="text-right pb-1">|Move|</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-t border-[#161616]">
              <td className={`py-0.5 pr-2 ${r.month === nowMonth ? "up font-bold" : ""}`}>
                {r.label}
                {r.month === nowMonth ? " ◀" : ""}
              </td>
              <td className="py-0.5 px-2">
                <div className="flex items-center justify-end gap-1.5">
                  <span className={`w-9 text-right tabular-nums ${r.count > 0 ? (r.avgPct > 0 ? "up" : r.avgPct < 0 ? "down" : "dim") : "dim"}`}>
                    {r.count > 0 ? `${r.avgPct > 0 ? "+" : ""}${fmt(r.avgPct)}%` : "—"}
                  </span>
                  <span className="w-10 h-1 bg-[#161616] relative overflow-hidden">
                    {r.count > 0 && (
                      <span
                        className={`absolute top-0 bottom-0 ${r.avgPct >= 0 ? "bg-[var(--amber)]" : "bg-[#555]"} ${r.avgPct >= 0 ? "left-1/2" : "right-1/2"}`}
                        style={{ width: `${Math.min(50, (Math.abs(r.avgPct) / maxAbs) * 50)}%` }}
                      />
                    )}
                  </span>
                </div>
              </td>
              <td className={`py-0.5 px-2 text-right tabular-nums ${r.count > 0 ? (r.winRate >= 0.5 ? "up" : "down") : "dim"}`}>
                {r.count > 0 ? `${Math.round(r.winRate * 100)}%` : "—"}
              </td>
              <td className={`py-0.5 px-2 text-right tabular-nums ${r.count > 0 ? (r.medianPct > 0 ? "up" : r.medianPct < 0 ? "down" : "dim") : "dim"}`}>
                {r.count > 0 ? `${r.medianPct > 0 ? "+" : ""}${fmt(r.medianPct)}%` : "—"}
              </td>
              <td className="py-0.5 text-right tabular-nums dim">
                {r.count > 0 ? `${fmt(r.avgMovePct)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {best && hasStats && (
        <div className="dim mt-1.5 text-[10px]">
          Best calendar month historically:{" "}
          <span className={best.avgPct >= 0 ? "up" : "down"}>
            {best.label} ({best.avgPct >= 0 ? "+" : ""}{fmt(best.avgPct)}% avg, {Math.round(best.winRate * 100)}% of years)
          </span>
        </div>
      )}
    </div>
  );
}