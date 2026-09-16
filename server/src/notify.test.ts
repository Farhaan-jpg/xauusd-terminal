import { describe, expect, it } from "vitest";
import { evaluateRules } from "./notify.js";
import type { AlertSettings } from "./settings.js";
import type { EconEvent } from "./providers/econcalendar.js";

function alerts(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return {
    enabled: true,
    sound: true,
    thresholdPct: 0.5,
    highImpact: true,
    display: "tone",
    volume: 0.15,
    levels: [],
    notifications: true,
    countdownMin: 15,
    newsKeywords: [],
    webhook: { enabled: true, url: "https://example.com/hook" },
    ...overrides,
  };
}

function event(dateIso: string, impact: EconEvent["impact"] = "High", title = "CPI m/m"): EconEvent {
  return { title, country: "USA", date: dateIso, impact, forecast: "0.3%", previous: "0.2%", actual: null };
}

describe("notify evaluateRules · price levels", () => {
  it("fires once when price crosses the level and re-arms after pulling back", () => {
    const cfg = alerts({ levels: [{ symbol: "XAUUSD", level: 100, dir: "above" }] });
    const prices = new Map<string, number | null>([["XAUUSD", 105]]);
    const now = Date.now();

    const first = evaluateRules({ now, alerts: cfg, prices, events: [], headlines: [] });
    expect(first.map((e) => e.type)).toEqual(["level"]);
    expect(first[0].text).toContain("crossed above");

    // Still above — must not fire a second time.
    expect(evaluateRules({ now: now + 5_000, alerts: cfg, prices, events: [], headlines: [] })).toHaveLength(0);

    // Pulls back below, then re-crosses → fires again.
    prices.set("XAUUSD", 95);
    expect(evaluateRules({ now: now + 10_000, alerts: cfg, prices, events: [], headlines: [] })).toHaveLength(0);
    prices.set("XAUUSD", 105);
    const again = evaluateRules({ now: now + 20_000, alerts: cfg, prices, events: [], headlines: [] });
    expect(again.map((e) => e.type)).toEqual(["level"]);
  });

  it("respects the 'below' direction and skips symbols with no price", () => {
    const cfg = alerts({ levels: [{ symbol: "GC=F", level: 3000, dir: "below" }] });
    const now = Date.now();
    expect(evaluateRules({ now, alerts: cfg, prices: new Map(), events: [], headlines: [] })).toHaveLength(0);
    const fired = evaluateRules({ now, alerts: cfg, prices: new Map([["GC=F", 2950]]), events: [], headlines: [] });
    expect(fired.map((e) => e.tone)).toEqual(["down"]);
    expect(fired[0].text).toContain("fell below");
  });
});

describe("notify evaluateRules · event countdown", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");

  it("fires a countdown for high-impact events inside the window", () => {
    const cfg = alerts({ countdownMin: 30 });
    const ev = event(new Date(now + 10 * 60_000).toISOString());
    const fired = evaluateRules({ now, alerts: cfg, prices: new Map(), events: [ev], headlines: [] });
    expect(fired.map((e) => e.type)).toEqual(["event"]);
    expect(fired[0].text).toContain("CPI");
  });

  it("skips low-impact events, past events and events beyond the window", () => {
    const cfg = alerts({ countdownMin: 15 });
    const lowImpact = event(new Date(now + 5 * 60_000).toISOString(), "Low");
    const past = event(new Date(now - 60_000).toISOString(), "High");
    const far = event(new Date(now + 60 * 60_000).toISOString(), "High");
    const out = evaluateRules({ now, alerts: cfg, prices: new Map(), events: [lowImpact, past, far], headlines: [] });
    expect(out).toHaveLength(0);
  });

  it("dedupes the same event across consecutive evaluations", () => {
    const cfg = alerts({ countdownMin: 30 });
    const ev = event(new Date(now + 10 * 60_000).toISOString(), "High", "GDP q/q");
    expect(evaluateRules({ now, alerts: cfg, prices: new Map(), events: [ev], headlines: [] })).toHaveLength(1);
    expect(evaluateRules({ now: now + 30_000, alerts: cfg, prices: new Map(), events: [ev], headlines: [] })).toHaveLength(0);
  });
});

describe("notify evaluateRules · news keywords", () => {
  it("fires on any headline containing a keyword (case-insensitive)", () => {
    const cfg = alerts({ newsKeywords: ["cpi", "fed"] });
    const first = evaluateRules({ now: Date.now(), alerts: cfg, prices: new Map(), events: [], headlines: ["CPI comes in hot", "Stocks flat"] });
    expect(first.map((e) => e.type)).toEqual(["news"]);
    expect(first[0].text).toContain("CPI comes in hot");
  });

  it("skips non-matching headlines and dedupes repeats", () => {
    const cfg = alerts({ newsKeywords: ["rate cut"] });
    const now = Date.now();
    const h = ["Fed signals possible rate cut"];
    expect(evaluateRules({ now, alerts: cfg, prices: new Map(), events: [], headlines: ["Gold steady"] })).toHaveLength(0);
    expect(evaluateRules({ now, alerts: cfg, prices: new Map(), events: [], headlines: h })).toHaveLength(1);
    expect(evaluateRules({ now: now + 5_000, alerts: cfg, prices: new Map(), events: [], headlines: h })).toHaveLength(0);
  });
});