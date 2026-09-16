import { describe, it, expect } from "vitest";
import {
  pctReturns,
  computeStats,
  computeCorrelations,
  gcContract,
  nextContracts,
  contractMonthLabel,
  computeFuturesCurve,
  computeOptionsSummary,
  computeRateProbs,
  computeEtfFlowProxy,
  computeCotSummary,
  nextFomc,
  smaLast,
  rsiLast,
  macdLast,
  atrLast,
  adxLast,
  vwapLast,
  classicPivots,
  fibPivots,
  structureVote,
  computeBias,
} from "./analytics.js";
import type { BiasInput, BiasMacro } from "./analytics.js";
import type { Candle } from "./providers/yahoo.js";

const candle = (time: number, close: number): Candle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1000 });

function rising(n: number, start = 2000, step = 2): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(candle(86400 * i, start + step * i));
  return out;
}

describe("pctReturns", () => {
  it("computes simple returns and skips bad prev", () => {
    expect(pctReturns([100, 110, 110]).map((r) => Math.round(r * 1e4) / 1e4)).toEqual([0.1, 0]);
    expect(pctReturns([0, 5])).toEqual([]);
  });
});

describe("computeStats", () => {
  it("reports last, year high/low, ytd, drawdown, up days and a positive rv", () => {
    const s = computeStats(rising(300));
    expect(s.last).toBe(2000 + 2 * 299);
    expect(s.yearHigh).toBe(s.last! + 1); // synthetic high = close + 1
    expect(s.ddFromHighPct).toBeCloseTo(0, 1);
    expect(s.ytdPct).toBeGreaterThan(0);
    expect(s.rv20).toBeGreaterThan(0);
    expect(s.rv250).toBeGreaterThan(0);
    expect(s.atr14).toBe(3); // TR = max(2 range, 3 gap to prev close)
    expect(s.upDaysPct).toBe(100);
    expect(s.bars).toBe(300);
  });

  it("returns nulls on empty input", () => {
    const s = computeStats([]);
    expect(s.last).toBeNull();
    expect(s.rv20).toBeNull();
    expect(s.bars).toBe(0);
  });
});

describe("computeCorrelations", () => {
  it("gives 1 on identical series and ~0 on an opposite one", () => {
    const a = rising(120);
    const flip = a.map((c) => ({ ...c, close: 1 / c.close }));
    const m = computeCorrelations({ A: a, B: a , C: flip }, 90);
    expect(m.symbols).toEqual(["A", "B", "C"]);
    expect(m.rows[0][1]).toBeCloseTo(1, 2);
    expect(m.rows[0][2]).toBeLessThan(0);
    expect(m.n).toBe(90);
  });
});

describe("GC contract naming", () => {
  it("formats month codes and labels", () => {
    expect(gcContract(0, 2027)).toBe("GCF27");
    expect(gcContract(8, 2026)).toBe("GCU26");
    expect(contractMonthLabel("GCZ26")).toBe("Dec '26");
    expect(nextContracts(new Date(Date.UTC(2026, 8, 1)), 3)[0]).toBe("GCU26");
  });
});

describe("computeFuturesCurve", () => {
  it("flags backwardation when deferreds trade below spot", () => {
    const curve = computeFuturesCurve(2700, [
      { symbol: "GCU26", price: 2700 },
      { symbol: "GCZ26", price: 2690 },
    ]);
    expect(curve.status).toBe("backwardation");
    expect(curve.rows[1].basis).toBe(-10);
    expect(curve.rows[1].basisPct).toBeCloseTo(-0.3704, 2);
  });

  it("flags contango when deferreds trade above spot", () => {
    const curve = computeFuturesCurve(2700, [{ symbol: "GCZ26", price: 2710 }]);
    expect(curve.status).toBe("contango");
  });

  it("is n/a with no prices", () => {
    const curve = computeFuturesCurve(null, [{ symbol: "GCZ26", price: null }]);
    expect(curve.status).toBe("n/a");
  });
});

describe("computeOptionsSummary", () => {
  const chain = {
    underlyingPrice: 2700,
    expirationDate: 1780617600,
    calls: [
      { strike: 2650, openInterest: 100, impliedVolatility: 0.18 },
      { strike: 2700, openInterest: 400, impliedVolatility: 0.15 },
      { strike: 2750, openInterest: 800, impliedVolatility: 0.17 },
    ],
    puts: [
      { strike: 2650, openInterest: 900, impliedVolatility: 0.21 },
      { strike: 2700, openInterest: 300, impliedVolatility: 0.16 },
      { strike: 2750, openInterest: 50, impliedVolatility: 0.14 },
    ],
  };

  it("finds ATM strike/IV, skew proxy (OTM call − OTM put) and OI ratio", () => {
    const o = computeOptionsSummary(chain as any);
    expect(o.atmStrike).toBe(2700);
    expect(o.atmIv).toBeCloseTo(0.155, 2);
    expect(o.skewProxy).toBeCloseTo(0.17 - 0.21, 2);
    expect(o.putCallOiRatio).toBeCloseTo(1250 / 1300, 3);
    expect(o.maxOiStrike).toBe(2650); // 1000 OI at 2650 beats 850 at 2750
  });

  it("handles a hollow chain", () => {
    const o = computeOptionsSummary({ underlyingPrice: null, calls: [], puts: [] } as any);
    expect(o.atmStrike).toBeNull();
    expect(o.atmIv).toBeNull();
  });
});

describe("computeRateProbs", () => {
  it("is roughly flat when futures imply no change", () => {
    const p = computeRateProbs(433, 433);
    expect(p.expectedChangeBp).toBeCloseTo(0, 2);
    // zero expected move → both tail probs are ~2×σ below the ±12.5 thresholds
    expect(p.probHold ?? 0).toBeGreaterThan(0.7);
    expect(p.probHike25 ?? 1).toBeLessThan(0.15);
    expect(p.probCut25 ?? 1).toBeLessThan(0.15);
  });

  it("leans hike when futures imply +25bp", () => {
    const p = computeRateProbs(433, 458);
    expect(p.probHike25 ?? 0).toBeGreaterThan(0.85);
  });

  it("exposes next FOMC in the future", () => {
    const { at } = nextFomc(Date.UTC(2026, 8, 1));
    expect(at).toBeGreaterThan(Date.UTC(2026, 8, 1));
  });
});

describe("computeEtfFlowProxy", () => {
  it("sums directional dollars over 1/5/20d", () => {
    const daily = rising(40, 100, 1).map((c, i) => ({
      ...c,
      volume: 1_000_000,
      close: 100 + 1 * i + (i % 2 === 0 ? 0 : 1), // monotonic-ish
    }));
    const f = computeEtfFlowProxy("GLD", daily);
    expect(f.sum1dM).not.toBeNull();
    expect(f.sum5dM).not.toBeNull();
    expect(f.bars).toBe(39);
    expect(f.series[f.series.length - 1].flowM).toBeCloseTo((daily[39].close - daily[38].close) * 1_000_000 / 1_000_000, 2);
  });
});

describe("computeCotSummary", () => {
  it("net managed money, week-over-week change and status", () => {
    const rows = [
      { reportDate: "2026-09-09", managedLong: 300_000, managedShort: 150_000, swapLong: 200_000, swapShort: 100_000, otherLong: 50_000, otherShort: 40_000, contractUnits: 100 },
      { reportDate: "2026-09-02", managedLong: 280_000, managedShort: 150_000, swapLong: 190_000, swapShort: 110_000, otherLong: 50_000, otherShort: 40_000, contractUnits: 100 },
    ];
    const s = computeCotSummary(rows);
    expect(s.netManaged).toBe(15_000_000);
    expect(s.wwChange).toBe(2_000_000);
    expect(s.status).toBe("managed_bull");
    expect(s.reportDate).toBe("2026-09-09");
  });

  it("is n/a with no rows", () => {
    const s = computeCotSummary([]);
    expect(s.status).toBe("n/a");
    expect(s.netManaged).toBeNull();
  });
});

describe("indicator toolkit", () => {
  it("smaLast averages the trailing window and rejects short series", () => {
    expect(smaLast([1, 2, 3, 4], 2)).toBe(3.5);
    expect(smaLast([1, 2, 3], 4)).toBeNull();
  });

  it("rsiLast is 100 on a monotone rally and 0 on a rout", () => {
    expect(rsiLast([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    expect(rsiLast([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(0);
  });

  it("macdLast histogram is positive on an uptrend", () => {
    const m = macdLast(Array.from({ length: 60 }, (_, i) => 100 + i * 2));
    expect(m).not.toBeNull();
    expect(m!.histogram).toBeGreaterThan(0);
  });

  it("adxLast is high on a clean trend", () => {
    expect(adxLast(rising(60))).not.toBeNull();
    expect(adxLast(rising(60))!).toBeGreaterThan(40);
  });

  it("atrLast/vwapLast are finite and inside expectations", () => {
    expect(atrLast(rising(30))!).toBeGreaterThan(0);
    const cs = rising(20);
    const v = vwapLast(cs)!;
    expect(v).toBeGreaterThan(cs[0].close);
    expect(v).toBeLessThan(cs[cs.length - 1].close);
  });

  it("classic/fib pivots match hand-rolled values", () => {
    const cp = classicPivots(100, 90, 95);
    expect(cp.p).toBe(95);
    expect(cp.r1).toBeCloseTo(100, 5);
    expect(cp.s1).toBeCloseTo(90, 5);
    const fp = fibPivots(100, 90, 95);
    expect(fp.r1).toBeGreaterThan(fp.p);
    expect(fp.s1).toBeLessThan(fp.p);
  });

  it("structureVote reads HH/HL on a rally and LH/LL on a selloff", () => {
    // explicit hammer pattern: rising swing highs (112→118→124) and rising
    // swing lows (106→112) force HH/HL fractals; the mirror is LH/LL.
    const bull = [100, 108, 112, 110, 106, 114, 118, 116, 112, 120, 124, 126, 128, 130, 132, 134].map((c, i) => candle(86400 * i, c));
    const bear = [134, 126, 122, 124, 128, 120, 116, 118, 122, 114, 110, 108, 106, 104, 102, 100].map((c, i) => candle(86400 * i, c));
    expect(structureVote(bull)!.vote).toBe(1);
    expect(structureVote(bear)!.vote).toBe(-1);
    expect(structureVote([])!.vote).toBe(0);
  });
});

describe("computeBias", () => {
  const up = () => rising(40, 2000, 2);
  const down = () => rising(40, 2000, -2);
  const now = Date.UTC(2026, 5, 15, 10);

  const base = (overrides: Partial<BiasInput> = {}): BiasInput => ({
    symbol: "XAUUSD",
    m5: up(),
    m15: up(),
    h4: up(),
    daily: up(),
    price: null,
    feedT: null,
    macro: null,
    events: null,
    options: null,
    rateProbs: null,
    etf: null,
    cot: null,
    stats: null,
    correlations: null,
    seasonality: null,
    sessions: null,
    news: null,
    tape: null,
    now,
    ...overrides,
  });

  const seasonality = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: "X",
    avgPct: 1,
    medianPct: 0.5,
    winRate: 0.8,
    count: 20,
  }));

  const macro = (fx: 0.4 | -0.4, yield10: number, silver: number, gdx: number): BiasMacro => ({
    rates: [
      { id: "DFII10", label: "r", pct: true, value: yield10 },
      { id: "VIXCLS", label: "v", pct: false, value: 12 },
    ],
    markets: [
      { symbol: "DX-Y.NYB", label: "", price: 105, change: fx, changePercent: fx },
      { symbol: "XAGUSD=X", label: "", price: 30, change: silver, changePercent: silver },
      { symbol: "GDX", label: "", price: 40, change: gdx, changePercent: gdx },
      { symbol: "XAUUSD", label: "", price: 2078, change: 0, changePercent: 0 },
      { symbol: "GC=F", label: "", price: 2078, change: 0, changePercent: 0 },
    ],
  });

  it("aggregates an evenly bullish tape into a strong BULL readout", () => {
    const r = computeBias(
      base({
        price: 2078,
        feedT: now - 2_000,
        macro: macro(-0.4, 1.2, 0.5, 0.5),
        cot: { reportDate: "2026-06-09", netManaged: 150_000, wwChange: 10_000, netSwap: null, netOther: null, status: "managed_bull" },
        etf: { symbol: "GLD", series: [], sum1dM: 10, sum5dM: 50, sum20dM: 80, bars: 21 },
        options: { underlying: 2078, expiry: now + 40_000_000, atmStrike: 2078, atmIv: 0.18, skewProxy: 0.012, putCallOiRatio: 1.0, maxOiStrike: 2050, avgIv: 0.18, nCalls: 50, nPuts: 50 },
        rateProbs: { currentRateBp: 425, impliedRateBp: 415, expectedChangeBp: -10, nextFomcAt: now + 60_000_000, nextFomcLabel: "2026-07-29", probHike25: 0.05, probCut25: 0.55, probHold: 0.4 },
        seasonality,
        sessions: [{ movePct: 1.2, rangePct: 2.0, isCurrent: true }],
        news: [
          { sentiment: "bullish" }, { sentiment: "bullish" }, { sentiment: "bullish" }, { sentiment: "bullish" },
          { sentiment: "bullish" }, { sentiment: "bullish" }, { sentiment: "bearish" }, { sentiment: "bearish" },
        ],
        tape: Array.from({ length: 20 }, (_, i) => ({ t: now - 20_000 + i * 1_000, price: 2040 + i * 2 })),
      })
    );
    expect(r.bias).toBe("BULL");
    expect(r.primary.bias).toBe("BULL");
    expect(r.score).toBeGreaterThan(0);
    expect(Math.abs(r.score)).toBeLessThanOrEqual(100);
    expect(r.pillars).toHaveLength(8);
    expect(r.levels.length).toBeGreaterThan(0);
    expect(r.factors.some((f) => f.label === "DXY (inverse)" && f.vote > 0)).toBe(true);
    expect(r.feed.fresh).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it("flips to a bearish readout when every layer turns against gold", () => {
    const r = computeBias(
      base({
        m5: down(),
        m15: down(),
        h4: down(),
        daily: down(),
        price: 1922,
        macro: macro(0.4, 3.5, -0.6, -0.5),
        cot: { reportDate: "2026-06-09", netManaged: -150_000, wwChange: -10_000, netSwap: null, netOther: null, status: "managed_bear" },
        etf: { symbol: "GLD", series: [], sum1dM: -20, sum5dM: -60, sum20dM: -100, bars: 21 },
        options: { underlying: 1922, expiry: now + 40_000_000, atmStrike: 1922, atmIv: 0.22, skewProxy: -0.015, putCallOiRatio: 1.6, maxOiStrike: 1960, avgIv: 0.22, nCalls: 50, nPuts: 60 },
        rateProbs: { currentRateBp: 425, impliedRateBp: 435, expectedChangeBp: 10, nextFomcAt: now + 60_000_000, nextFomcLabel: "2026-07-29", probHike25: 0.6, probCut25: 0.05, probHold: 0.35 },
        news: [{ sentiment: "bearish" }, { sentiment: "bearish" }, { sentiment: "bearish" }, { sentiment: "bullish" }],
        tape: Array.from({ length: 20 }, (_, i) => ({ t: now - 20_000 + i * 1_000, price: 1960 - i * 2 })),
      })
    );
    expect(r.bias).toBe("BEAR");
    expect(r.primary.bias).toBe("BEAR");
    expect(r.score).toBeLessThan(0);
    expect(r.warnings.length).toBeGreaterThan(0); // put/call hedge-demand flag
  });

  it("is deterministic and degrades to NEUTRAL on empty data", () => {
    const empty: Partial<BiasInput> = { m5: [], m15: [], h4: [], daily: [] };
    const a = computeBias(base(empty));
    expect(a).toEqual(computeBias(base(empty)));
    expect(a.bias).toBe("NEUTRAL");
    expect(a.score).toBe(0);
    expect(a.pillars).toHaveLength(8);
    expect(a.price).toBeNull();
  });
});