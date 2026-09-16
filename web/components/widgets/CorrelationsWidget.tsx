"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, pctClass } from "../../lib/api";
import { useTerminal } from "../../store/terminal";
import Flash from "../Flash";

type GoldMacro = {
  rates: Array<{ id: string; label: string; pct: boolean; value: number | null }>;
  markets: Array<{ symbol: string; label: string; price: number | null; change: number | null; changePercent: number | null }>;
};

/** Simple informational read-outs about the current drivers for gold. */
function goldDrivers(m: GoldMacro | undefined): string[] {
  if (!m) return [];
  const notes: string[] = [];
  const dxy = m.markets.find((x) => x.symbol === "DX-Y.NYB");
  const xau = m.markets.find((x) => x.symbol === "XAUUSD");
  const xag = m.markets.find((x) => x.symbol === "XAGUSD=X");
  const vix = m.rates.find((r) => r.id === "VIXCLS");
  const real = m.rates.find((r) => r.id === "DFII10");

  if (dxy?.changePercent !== null && dxy?.changePercent !== undefined) {
    notes.push(dxy.changePercent < 0 ? "USD weakening — tailwind for gold" : "USD strengthening — headwind for gold");
  }
  if (real?.value !== null && real?.value !== undefined) {
    notes.push(real.value >= 2 ? "Real yields high — pressure on gold" : real.value <= 0.5 ? "Real yields low — supportive for gold" : "Real yields neutral for gold");
  }
  if (vix?.value !== null && vix?.value !== undefined) {
    notes.push(vix.value >= 28 ? "Risk-off (VIX high) — flight to gold" : vix.value >= 18 ? "Markets on edge — mild gold support" : "Low volatility backdrop");
  }
  if (xau?.changePercent !== null && xau?.changePercent !== undefined && xag?.changePercent !== null && xag?.changePercent !== undefined) {
    notes.push(xag.changePercent > xau.changePercent ? "Silver outperforming gold — broad metals demand" : "Gold leading silver — defensive bid");
  }
  return notes.slice(0, 4);
}

export default function CorrelationsWidget() {
  const addWidget = useTerminal((s) => s.addWidget);

  const { data, error } = useQuery({
    queryKey: ["gold-macro"],
    queryFn: () => apiGet<GoldMacro>("/api/gold-macro"),
    refetchInterval: 3_000,
  });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!data) return <div className="p-2 dim">Loading correlations…</div>;

  const drivers = goldDrivers(data);

  return (
    <div className="p-2 text-[11px] overflow-auto h-full">
      <div className="amber font-bold mb-1">RATES &amp; SENTIMENT</div>
      <table className="data-table mb-3">
        <thead>
          <tr><th>Indicator</th><th>Value</th></tr>
        </thead>
        <tbody>
          {data.rates.map((r) => (
            <tr key={r.id}>
              <td className="!text-left">{r.label}</td>
              <td>{r.value !== null ? `${fmt(r.value, 2)}${r.pct ? "%" : ""}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="amber font-bold mb-1">CORRELATED MARKETS</div>
      <table className="data-table mb-3">
        <thead>
          <tr><th>Market</th><th>Last</th><th>Chg%</th><th></th></tr>
        </thead>
        <tbody>
          {data.markets.map((m) => (
            <tr key={m.symbol}>
              <td className="!text-left">{m.label}</td>
              <td><Flash value={m.price}>{fmt(m.price)}</Flash></td>
              <td className={pctClass(m.changePercent)}>
                <Flash value={m.changePercent}>{m.changePercent !== null ? fmt(m.changePercent) + "%" : "—"}</Flash>
              </td>
              <td>
                {m.symbol !== "XAUUSD" && m.symbol !== "XAU/XAG" && (
                  <button
                    className="dim hover:text-[var(--amber)]"
                    title={`Open ${m.symbol} chart`}
                    onClick={(e) => {
                      e.stopPropagation();
                      addWidget("chart", m.symbol);
                    }}
                  >
                    ▸
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {drivers.length > 0 && (
        <>
          <div className="amber font-bold mb-1">GOLD DRIVERS</div>
          <ul className="list-none space-y-1">
            {drivers.map((note, i) => (
              <li key={i} className="dim">• {note}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}