"use client";

import { useQuery } from "@tanstack/react-query";
import { fmt, getSessionStats } from "../../lib/api";

export default function SessionStatsWidget() {
  const { data } = useQuery({
    queryKey: ["session-stats"],
    queryFn: () => getSessionStats(),
    refetchInterval: 15_000,
  });
  const rows = data ?? [];

  return (
    <div className="p-2 text-[11px]">
      <div className="dim text-[10px] mb-1.5">
        Last {rows.length} daily sessions from the 15m tape (◀ = still forming)
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="dim text-[10px] uppercase tracking-wide">
            <th className="text-left pb-1">Day</th>
            <th className="text-right pb-1">Open</th>
            <th className="text-right pb-1">High</th>
            <th className="text-right pb-1">Low</th>
            <th className="text-right pb-1">Close</th>
            <th className="text-right pb-1">Move</th>
            <th className="text-right pb-1">Range</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.date} className="border-t border-[#161616]">
              <td className={`py-0.5 pr-2 ${s.isCurrent ? "up font-bold" : ""}`}>
                {s.date.slice(5)}
                {s.isCurrent ? " ◀" : ""}
              </td>
              <td className="py-0.5 px-2 text-right tabular-nums">{fmt(s.open)}</td>
              <td className="py-0.5 px-2 text-right tabular-nums">{fmt(s.high)}</td>
              <td className="py-0.5 px-2 text-right tabular-nums">{fmt(s.low)}</td>
              <td className={`py-0.5 px-2 text-right tabular-nums ${s.isCurrent ? "text-[var(--text)]" : ""}`}>
                {fmt(s.close)}
              </td>
              <td className={`py-0.5 px-2 text-right tabular-nums ${s.movePct >= 0 ? "up" : "down"}`}>
                {s.movePct >= 0 ? "+" : ""}{fmt(s.movePct)}%
              </td>
              <td className="py-0.5 text-right tabular-nums dim">{fmt(s.rangePct)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="dim">No session data yet.</div>}
    </div>
  );
}