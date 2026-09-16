import { describe, expect, it } from "vitest";
import { aggregateCandles, beijingTs, dayTs, parseFx, parseHf } from "./sina.js";
import type { Candle } from "./yahoo.js";

describe("sina parseHf", () => {
  it("maps the live-verified hf_XAU layout", () => {
    const fields = ["2677.30", "2668.00", "2677.20", "2677.40", "2682.60", "2658.10", "15:29:59", "2668.00", "2660.00", "0", "0", "0", "2026-09-14", "黄金现货"];
    const p = parseHf(fields);
    expect(p.price).toBe(2677.3);
    expect(p.previousClose).toBe(2668);
    expect(p.open).toBe(2660);
    expect(p.dayHigh).toBe(2682.6);
    expect(p.dayLow).toBe(2658.1);
    expect(p.bid).toBe(2677.2);
    expect(p.ask).toBe(2677.4);
    expect(p.time).not.toBeNull();
  });

  it("parses empty fields as null instead of NaN", () => {
    const p = parseHf(["", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    expect(p.price).toBeNull();
    expect(p.dayHigh).toBeNull();
  });

  it("returns a UTC epoch seconds timestamp for Beijing date+time", () => {
    const p = parseHf(["1", "1", "1", "1", "1", "1", "15:29:59", "1", "1", "0", "0", "0", "2026-09-14", "x"]);
    const expected = beijingTs("2026-09-14 15:29:59");
    expect(p.time).toBe(expected);
  });
});

describe("sina parseFx", () => {
  it("maps the fx_ layout (time, bid, ask, last, volume, hi, lo)", () => {
    const p = parseFx(["15:30:00", "2677.20", "2677.40", "2677.30", "0", "2682.00", "2660.00"]);
    expect(p.bid).toBe(2677.2);
    expect(p.ask).toBe(2677.4);
    expect(p.price).toBe(2677.3);
    expect(p.dayHigh).toBe(2682);
    expect(p.dayLow).toBe(2660);
  });

  it("falls back to bid when the last price is missing", () => {
    const p = parseFx(["15:30:00", "2677.20", "2677.40", "", "0", "2682.00", "2660.00"]);
    expect(p.price).toBe(2677.2);
  });
});

describe("sina timestamps", () => {
  it("beijingTs converts a Beijing date-time to epoch seconds", () => {
    const ts = beijingTs("2026-09-14 09:30:00");
    expect(ts).toBe(Date.parse("2026-09-14T09:30:00+08:00") / 1000);
  });

  it("dayTs maps a date to UTC midnight", () => {
    expect(dayTs("2026-09-14")).toBe(Date.parse("2026-09-14T00:00:00Z") / 1000);
  });
});

describe("sina aggregateCandles", () => {
  const bars: Candle[] = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 2, open: 11, high: 14, low: 10, close: 13, volume: 150 },
    { time: 3, open: 13, high: 15, low: 12, close: 14, volume: 200 },
  ];

  it("aggregates flat 1m candles into larger bars", () => {
    const out = aggregateCandles(bars, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 1, open: 10, high: 14, low: 9, close: 13, volume: 250 });
    expect(out[1].close).toBe(14);
  });
});