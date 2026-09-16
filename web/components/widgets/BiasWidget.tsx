"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt } from "../../lib/api";

type MarketBias = {
  ts: number;
  symbol: string;
  price: number | null;
  score: number;
  bias: "BULL" | "BEAR" | "NEUTRAL";
  strength: "strong" | "moderate" | "weak";
  primary: { score: number; bias: "BULL" | "BEAR" | "NEUTRAL"; note: string };
  tactical: { score: number; bias: "BULL" | "BEAR" | "NEUTRAL"; note: string };
  session: { label: string; note: string };
  pillars: Array<{ id: string; label: string; vote: number; max: number; note: string }>;
  factors: Array<{ pillar: string; label: string; vote: number; note: string }>;
  levels: Array<{ label: string; value: number; kind: string }>;
  warnings: string[];
  feed: { t: number | null; fresh: boolean };
};

const BIAS_CLASS: Record<string, string> = { BULL: "up", BEAR: "down", NEUTRAL: "amber" };
const STRENGTH_CLASS: Record<string, string> = { strong: "up", moderate: "amber", weak: "dim" };

export default function BiasWidget() {
  const { data: result } = useQuery({
    queryKey: ["market-bias"],
    queryFn: () => apiGet<MarketBias>("/api/market-bias"),
    refetchInterval: 4_000,
    staleTime: 2_000,
  });

  if (!result) return <div className="p-2 dim">Computing institutional bias…</div>;

  const markerPct = ((result.score + 100) / 200) * 100;
  const price = result.price ?? null;
  const tick = result.feed?.t ?? null;
  const fresh = result.feed?.fresh ?? false;
  const levelColor = (label: string) => {
    if (label === "P") return "text-[var(--text)]";
    if (price === null) return "dim";
    const lv = result.levels.find((l) => l.label === label);
    if (!lv) return "dim";
    return price >= lv.value ? "up" : "down";
  };

  return (
    <div className="flex flex-col gap-2 p-2 text-[11px]">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`font-bold text-[18px] tracking-wider ${BIAS_CLASS[result.bias]}`}>{result.bias}</span>
        <span className={`text-[10px] uppercase ${STRENGTH_CLASS[result.strength]}`}>{result.strength}</span>
        <span className="dim">score {result.score}</span>
        <span className={`${result.session.label === "NEW YORK" ? "amber" : "dim"} border border-[var(--border)] px-1`}>
          {result.session.label}
        </span>
        {tick !== null && (
          <span
            className={`text-[10px] ${fresh ? "up" : "amber"}`}
            title="Live spot feed · last tick timestamp (UTC)"
          >
            feed {new Date(tick).toISOString().slice(11, 19)}Z {fresh ? "•" : "stale"}
          </span>
        )}
        {result.warnings.length > 0 && (
          <span className="down border border-[#ff3d3d55] px-1">{result.warnings.join(" · ")}</span>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] dim">
        <span>
          PRIMARY <span className={BIAS_CLASS[result.primary.bias]}>{result.primary.bias}</span>{" "}
          <span className={BIAS_CLASS[result.primary.bias]}>({result.primary.score})</span>
        </span>
        <span>·</span>
        <span>
          TACTICAL <span className={BIAS_CLASS[result.tactical.bias]}>{result.tactical.bias}</span>{" "}
          <span className={BIAS_CLASS[result.tactical.bias]}>({result.tactical.score})</span>
        </span>
      </div>

      <div className="relative h-2 bg-[#111] border border-[var(--border)]">
        <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border)]" />
        <div
          className="absolute inset-y-0 w-1.5 -ml-0.5"
          style={{
            left: `${markerPct}%`,
            background: result.bias === "BULL" ? "var(--up)" : result.bias === "BEAR" ? "var(--down)" : "var(--amber)",
          }}
        />
        <span className="absolute -top-1 left-1 dim">-100</span>
        <span className="absolute -top-1 right-1 dim">+100</span>
      </div>

      {result.levels.length > 0 && (
        <div className="flex gap-3 flex-wrap items-center">
          {result.levels.map((l) => (
            <span key={l.label} className="dim" title={`${l.kind}`}>
              {l.label} <span className={levelColor(l.label)}>{fmt(l.value, 1)}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {result.pillars.map((p) => {
          const pos = ((p.vote + p.max) / (2 * p.max)) * 100;
          const color = p.vote > 0 ? "var(--up)" : p.vote < 0 ? "var(--down)" : "var(--amber)";
          return (
            <div key={p.id} className="flex items-center gap-1.5" title={p.note || undefined}>
              <span className="w-[72px] dim text-[10px]">{p.label}</span>
              <div className="relative flex-1 h-1.5 bg-[#111] border border-[var(--border)]">
                <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border)]" />
                <div className="absolute inset-y-0 w-1" style={{ left: `${pos}%`, background: color }} />
              </div>
              <span className="w-8 text-right text-[10px]" style={{ color }}>
                {p.vote > 0 ? "+" : ""}
                {p.vote}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1 mt-1">
        {result.factors.map((f) => (
          <span
            key={`${f.pillar}:${f.label}`}
            className={
              f.vote > 0 ? "up border border-[#00c85355] px-1" : f.vote < 0 ? "down border border-[#ff3d3d55] px-1" : "dim px-1"
            }
            title={`${f.label}: ${f.note}`}
          >
            {f.label} {f.vote > 0 ? "▲" : f.vote < 0 ? "▼" : "•"}
          </span>
        ))}
      </div>

      <div className="dim text-[10px]">
        Model: PRIMARY = D1/H4/15m swing structure + DXY/real-yields/rate-odds + COT/ETF/options positioning. TACTICAL =
        RSI/MACD/ROC (ADX-gated), VWAP/pivots/PDH-PDL location, PDH/PDL sweeps + 5m ChoCH, silver/GDX/basis, news/seasonality/tape.
        PRIMARY is the thesis, TACTICAL the timing; when they conflict the market is transitioning.
      </div>
    </div>
  );
}