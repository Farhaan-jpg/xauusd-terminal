import { describe, expect, it } from "vitest";
import type { Candle } from "../providers/yahoo.js";
import {
  aggregate,
  beijingToday,
  computeSeasonality,
  computeSessions,
  isGoldSymbol,
  lastCompletedClose,
  rangeSpec,
  spotFallback,
  toMonthly,
  toWeekly,
  yahooSymbol,
} from "./market.js";

describe("market rangeSpec", () => {
  it("maps every chart timeframe to a Yahoo range/interval", () => {
    expect(rangeSpec("1m")).toEqual({ range: "1d", interval: "1m", intraday: true });
    expect(rangeSpec("5m")).toEqual({ range: "5d", interval: "5m", intraday: true });
    expect(rangeSpec("15m")).toEqual({ range: "1mo", interval: "15m", intraday: true });
    expect(rangeSpec("30m")).toEqual({ range: "1mo", interval: "30m", intraday: true });
    expect(rangeSpec("1h")).toEqual({ range: "3mo", interval: "60m", intraday: true });
    expect(rangeSpec("4h")).toEqual({ range: "3mo", interval: "60m", agg: 4, intraday: true });
  });

  it("falls back to a sane default for unknown ranges", () => {
    expect(rangeSpec("nonsense").range).toBe("2y");
  });
});

describe("market aggregate", () => {
  const bars: Candle[] = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 2, open: 11, high: 14, low: 10, close: 13, volume: 150 },
    { time: 3, open: 13, high: 15, low: 12, close: 14, volume: 200 },
    { time: 4, open: 14, high: 16, low: 13, close: 15, volume: 250 },
  ];

  it("aggregates in chunks of n preserving first open / last close", () => {
    const out = aggregate(bars, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 1, open: 10, high: 14, low: 9, close: 13, volume: 250 });
    expect(out[1]).toEqual({ time: 3, open: 13, high: 16, low: 12, close: 15, volume: 450 });
  });

  it("aggregate(n=1) is a no-op", () => {
    expect(aggregate(bars, 1)).toEqual(bars);
  });
});

describe("market toWeekly", () => {
  const day = (date: string, close: number): Candle =>
    ({ time: Date.parse(date + "T00:00:00Z") / 1000, open: close, high: close, low: close, close, volume: 10 });

  it("buckets candles into Monday-start weeks across a weekend", () => {
    // Tue and Fri of one week, then the following Monday.
    const bars = [day("2026-01-13", 100), day("2026-01-16", 101), day("2026-01-19", 102)];
    const out = toWeekly(bars);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(101);
    expect(out[1].close).toBe(102);
  });

  it("returns a single bucket when all bars share a week", () => {
    const out = toWeekly([day("2026-01-12", 1), day("2026-01-16", 2)]);
    expect(out).toHaveLength(1);
  });
});

describe("market toMonthly", () => {
  const bar = (iso: string): Candle =>
    ({ time: Date.parse(iso) / 1000, open: 1, high: 2, low: 1, close: Number(iso.slice(8, 10)), volume: 1 });

  it("buckets daily bars into calendar months", () => {
    const out = toMonthly([bar("2026-01-05T00:00:00Z"), bar("2026-01-30T00:00:00Z"), bar("2026-02-12T00:00:00Z")]);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(30);
    expect(out[1].close).toBe(12);
  });
});

describe("market symbol helpers", () => {
  it("isGoldSymbol covers spot and futures variants", () => {
    expect(isGoldSymbol("XAUUSD")).toBe(true);
    expect(isGoldSymbol("XAUUSD=X")).toBe(true);
    expect(isGoldSymbol("GC=F")).toBe(true);
    expect(isGoldSymbol("XAGUSD=X")).toBe(false);
  });

  it("yahooSymbol maps bare spot symbols to Yahoo pairs", () => {
    expect(yahooSymbol("XAUUSD")).toBe("XAUUSD=X");
    expect(yahooSymbol("GC=F")).toBe("GC=F");
  });

  it("spotFallback routes gold/silver to the equivalent futures", () => {
    expect(spotFallback("XAUUSD")).toBe("GC=F");
    expect(spotFallback("XAUUSD=X")).toBe("GC=F");
    expect(spotFallback("XAGUSD")).toBe("SI=F");
    expect(spotFallback("EURUSD=X")).toBeNull();
  });
});

describe("market lastCompletedClose", () => {
  const bar = (iso: string, close: number): Candle =>
    ({ time: Date.parse(iso) / 1000, open: close, high: close, low: close, close, volume: 1 });

  it("skips the live (today) bar when the last bar is still forming", () => {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const sorted = [bar("2026-01-10T00:00:00Z", 100), bar(`${today}T00:00:00Z`, 103)];
    expect(lastCompletedClose(sorted)).toBe(100);
  });

  it("uses the last bar when it is completed (prior session)", () => {
    const sorted = [bar("2026-01-10T00:00:00Z", 100), bar("2026-01-11T00:00:00Z", 103)];
    expect(lastCompletedClose(sorted)).toBe(103);
  });

  it("handles a single-bar list", () => {
    expect(lastCompletedClose([bar("2026-01-10T00:00:00Z", 100)])).toBe(100);
  });

  it("beijingToday returns the current Beijing calendar day", () => {
    const expected = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    expect(beijingToday()).toBe(expected);
  });
});

describe("market computeSeasonality", () => {
  const bar = (iso: string, close: number): Candle =>
    ({ time: Date.parse(iso + "T00:00:00Z") / 1000, open: close, high: close, low: close, close, volume: 1 });

  it("attributes a month's return to the month it closes into", () => {
    // One bar per month start, each +10% over the previous month: the return
    // computed against that month's first bar belongs to that month alone.
    const starts = [
      "2025-01-02", "2025-02-03", "2025-03-03", "2025-04-01",
      "2025-05-01", "2025-06-02", "2025-07-01", "2025-08-01",
      "2025-09-02", "2025-10-01", "2025-11-03", "2025-12-01",
    ];
    const bars = starts.map((iso, i) => bar(iso, 100 * Math.pow(1.1, i)));
    const rows = computeSeasonality(bars);

    expect(rows).toHaveLength(12);
    expect(rows[2]).toMatchObject({ month: 3, label: "Mar", avgPct: 10, medianPct: 10, winRate: 1, count: 1 });
    expect(rows[11]).toMatchObject({ month: 12, label: "Dec", avgPct: 10, winRate: 1, count: 1 });
    expect(rows[0]).toMatchObject({ month: 1, count: 0 }); // no prior bar → no January return
  });

  it("handles an empty / single-bar series without throwing", () => {
    expect(computeSeasonality([])).toHaveLength(12);
    expect(computeSeasonality([bar("2025-01-02", 100)])).toHaveLength(12);
    expect(computeSeasonality([bar("2025-01-02", 100)])[0].count).toBe(0);
  });
});

describe("market computeSessions", () => {
  const bar = (iso: string, o: number, h: number, l: number, c: number): Candle =>
    ({ time: Date.parse(iso + "T00:00:00Z") / 1000 + 3600, open: o, high: h, low: l, close: c, volume: 1 });

  it("buckets intraday bars by UTC day and fills older sessions from daily", () => {
    // 2026-09-14 is the reference "now" — the last intraday bucket is the forming session.
    const NOW = Date.parse("2026-09-14T12:00:00Z");
    const intraday = [
      bar("2026-09-13", 100, 105, 99, 104),
      bar("2026-09-13", 104, 107, 103, 106),
      bar("2026-09-14", 106, 110, 108, 109),
    ];
    const daily = [
      bar("2026-09-11", 90, 95, 89, 92),
      bar("2026-09-12", 92, 99, 91, 100),
    ];
    const sessions = computeSessions(intraday, daily, 7, NOW);

    expect(sessions).toHaveLength(4);
    expect(sessions[0].date).toBe("2026-09-11");
    expect(sessions[0]).toMatchObject({ open: 90, high: 95, low: 89, close: 92, isCurrent: false });
    expect(sessions[0].movePct).toBeCloseTo(2.222, 3);

    expect(sessions[2].date).toBe("2026-09-13");
    expect(sessions[2]).toMatchObject({ open: 100, high: 107, low: 99, close: 106, move: 6, movePct: 6, isCurrent: false });

    expect(sessions[3].date).toBe("2026-09-14");
    expect(sessions[3]).toMatchObject({ open: 106, high: 110, low: 108, close: 109, isCurrent: true });
    expect(sessions[3].rangePct).toBeCloseTo((110 - 108) / 106 * 100, 3);
  });

  it("respects the limit and never duplicates daily+intraday for the same day", () => {
    const intraday = [bar("2026-09-13", 100, 100, 100, 100)];
    const daily = [bar("2026-09-13", 90, 90, 90, 90), bar("2026-09-10", 80, 80, 80, 80)];
    const sessions = computeSessions(intraday, daily, 2);
    expect(sessions.map((s) => s.date)).toEqual(["2026-09-10", "2026-09-13"]);
    expect(sessions[1].open).toBe(100); // intraday wins over daily for the same day
  });
});