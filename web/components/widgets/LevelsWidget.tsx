"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiGet, fmt, pctClass, type Candle, type Quote } from "../../lib/api";
import { GOLD_SYMBOL } from "../../store/terminal";
import Flash from "../Flash";

// ---- pivot calculations ----

interface Pivots {
  p: number;
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
}

function classicPivots(h: number, l: number, c: number): Pivots {
  const p = (h + l + c) / 3;
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l), r3: h + 2 * (p - l), s3: l - 2 * (h - p) };
}

function fibPivots(h: number, l: number, c: number): Pivots {
  const p = (h + l + c) / 3;
  const r = h - l;
  return { p, r1: p + 0.382 * r, r2: p + 0.618 * r, r3: p + r, s1: p - 0.382 * r, s2: p - 0.618 * r, s3: p - r };
}

/** ISO week key (Monday-start). */
function weekKey(timeSec: number): number {
  const d = new Date(timeSec * 1000);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return Math.floor((d.getTime() + diff * 86_400_000) / (7 * 86_400_000));
}

function levelTag(price: number, current: number): string {
  if (Math.abs(price - current) / current < 0.001) return "nearest";
  if (price > current) return "resistance";
  return "support";
}

const LEVEL_COLOR: Record<string, string> = {
  resistance: "var(--up)",
  support: "var(--down)",
  nearest: "var(--amber)",
};

/** Beijing calendar date string for live-bar detection. */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export default function LevelsWidget() {
  const { data: spot } = useQuery({
    queryKey: ["quote", GOLD_SYMBOL],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${GOLD_SYMBOL}`))[0],
    refetchInterval: 5_000,
  });

  const { data: daily, error } = useQuery({
    queryKey: ["history", "XAUUSD", "1D"],
    queryFn: () => apiGet<Candle[]>(`/api/history/${GOLD_SYMBOL}?range=1D`),
    staleTime: 300_000,
  });

  const current = spot?.price ?? 0;

  const levels = useMemo(() => {
    if (!daily || daily.length < 2) return null;

    const sorted = [...daily].sort((a, b) => a.time - b.time);
    const lastBar = sorted[sorted.length - 1];
    // If the last daily bar is today (Beijing), it's still forming → use the bar
    // before it for pivot calculations. Over a weekend the last bar IS the last
    // completed session, so pivots should be based on that bar directly.
    const lastBarDate = new Date(lastBar.time * 1000).toISOString().slice(0, 10);
    const liveBar = lastBarDate === beijingToday();
    const prev = liveBar ? sorted[sorted.length - 2] : lastBar;
    const prevClassic = classicPivots(prev.high, prev.low, prev.close);
    const prevFib = fibPivots(prev.high, prev.low, prev.close);

    // Build weekly candles from daily bars, take last completed week
    const weeks = new Map<number, Candle[]>();
    for (const c of sorted) {
      const k = weekKey(c.time);
      const arr = weeks.get(k) ?? [];
      arr.push(c);
      weeks.set(k, arr);
    }
    const weekKeys = [...weeks.keys()].sort((a, b) => a - b);
    const lastWeekKey = weekKeys[weekKeys.length - 1];
    const prevWeekKey = weekKeys.length > 1 ? weekKeys[weekKeys.length - 2] : lastWeekKey;
    const lastWeekCandles = weeks.get(prevWeekKey) ?? [];
    let weeklyP: Pivots | null = null;
    let lastWeekOHLC = null;
    if (lastWeekCandles.length >= 2) {
      const wH = Math.max(...lastWeekCandles.map((c) => c.high));
      const wL = Math.min(...lastWeekCandles.map((c) => c.low));
      const wC = lastWeekCandles[lastWeekCandles.length - 1].close;
      weeklyP = fibPivots(wH, wL, wC);
      lastWeekOHLC = {
        open: lastWeekCandles[0].open,
        high: wH,
        low: wL,
        close: wC,
      };
    }

    // Today's range so far (live forming bar) or last session's range (weekend)
    const today = sorted[sorted.length - 1];
    const todayRange = { high: today.high, low: today.low, label: liveBar ? "Today" : "Last Session" };

    return { prevClassic, prevFib, weeklyP, lastWeekOHLC, todayRange };
  }, [daily]);

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!levels) return <div className="p-2 dim">Loading levels…</div>;

  const s = current || 0;

  const classRow = (label: string, price: number) => {
    const tag = current ? levelTag(price, current) : "";
    return (
      <tr key={label}>
        <td className="!text-left dim">{label}</td>
        <td style={{ color: LEVEL_COLOR[tag] }}>{fmt(price)}</td>
      </tr>
    );
  };

  const fibRow = (label: string, price: number) => {
    const tag = current ? levelTag(price, current) : "";
    return (
      <tr key={label}>
        <td className="!text-left dim">{label}</td>
        <td style={{ color: LEVEL_COLOR[tag] }}>{fmt(price)}</td>
      </tr>
    );
  };

  return (
    <div className="p-2 overflow-auto h-full text-[11px]">
      {current > 0 && (
        <div className="mb-2 flex items-baseline gap-2">
          <Flash value={current} className="font-bold">{fmt(current)}</Flash>
          <Flash value={spot?.changePercent} className={pctClass(spot?.changePercent)}>
            {fmt(spot?.changePercent)}%
          </Flash>
        </div>
      )}

      <div className="flex gap-4 flex-wrap">
        {/* Daily Pivots */}
        <div className="min-w-[140px]">
          <div className="amber font-bold mb-1">DAILY PIVOTS</div>
          <table className="data-table">
            <thead><tr><th>Level</th><th>Price</th></tr></thead>
            <tbody>
              {classRow("S3", levels.prevClassic.s3)}
              {classRow("S2", levels.prevClassic.s2)}
              {classRow("S1", levels.prevClassic.s1)}
              {classRow("Pivot", levels.prevClassic.p)}
              {classRow("R1", levels.prevClassic.r1)}
              {classRow("R2", levels.prevClassic.r2)}
              {classRow("R3", levels.prevClassic.r3)}
            </tbody>
          </table>
        </div>

        {/* Fib Pivots */}
        <div className="min-w-[140px]">
          <div className="amber font-bold mb-1">FIB PIVOTS</div>
          <table className="data-table">
            <thead><tr><th>Level</th><th>Price</th></tr></thead>
            <tbody>
              {fibRow("S3", levels.prevFib.s3)}
              {fibRow("S2", levels.prevFib.s2)}
              {fibRow("S1", levels.prevFib.s1)}
              {fibRow("Pivot", levels.prevFib.p)}
              {fibRow("R1", levels.prevFib.r1)}
              {fibRow("R2", levels.prevFib.r2)}
              {fibRow("R3", levels.prevFib.r3)}
            </tbody>
          </table>
        </div>

        {/* Today + Prev Week */}
        <div className="min-w-[140px]">
          <div className="amber font-bold mb-1">RANGE</div>
          <table className="data-table">
            <thead><tr><th>Level</th><th>Value</th></tr></thead>
            <tbody>
              <tr>
                <td className="!text-left dim">{levels.todayRange.label} High</td>
                <td className="up">{fmt(levels.todayRange.high)}</td>
              </tr>
              <tr>
                <td className="!text-left dim">{levels.todayRange.label} Low</td>
                <td className="down">{fmt(levels.todayRange.low)}</td>
              </tr>
              {levels.lastWeekOHLC && (
                <>
                  <tr>
                    <td className="!text-left dim">Prev Wk High</td>
                    <td className="up">{fmt(levels.lastWeekOHLC.high)}</td>
                  </tr>
                  <tr>
                    <td className="!text-left dim">Prev Wk Low</td>
                    <td className="down">{fmt(levels.lastWeekOHLC.low)}</td>
                  </tr>
                  <tr>
                    <td className="!text-left dim">Prev Wk Close</td>
                    <td>{fmt(levels.lastWeekOHLC.close)}</td>
                  </tr>
                </>
              )}
              {levels.weeklyP && (
                <>
                  <tr>
                    <td className="!text-left dim">Wkly S1</td>
                    <td style={{ color: LEVEL_COLOR[current ? levelTag(levels.weeklyP.s1, current) : ""] }}>
                      {fmt(levels.weeklyP.s1)}
                    </td>
                  </tr>
                  <tr>
                    <td className="!text-left dim">Wkly Pivot</td>
                    <td>{fmt(levels.weeklyP.p)}</td>
                  </tr>
                  <tr>
                    <td className="!text-left dim">Wkly R1</td>
                    <td style={{ color: LEVEL_COLOR[current ? levelTag(levels.weeklyP.r1, current) : ""] }}>
                      {fmt(levels.weeklyP.r1)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}