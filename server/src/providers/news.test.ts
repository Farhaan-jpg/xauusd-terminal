import { describe, expect, it } from "vitest";
import { dedupe, impactOf, sentimentOf, type NewsItem } from "./news.js";

describe("news impactOf", () => {
  it("flags genuinely market-moving headlines as High", () => {
    expect(impactOf("US and Iran on brink of war after missile strikes")).toBe("High");
    expect(impactOf("Breaking: North Korea nuclear test detected")).toBe("High");
  });

  it("marks macro/policy noise as Medium", () => {
    expect(impactOf("Fed signals interest rate uncertainty ahead")).toBe("Medium");
    expect(impactOf("New US tariffs target steel imports")).toBe("Medium");
  });

  it("treats routine reports as Low", () => {
    expect(impactOf("Gold mining output rises in Nevada")).toBe("Low");
  });
});

describe("news sentimentOf", () => {
  it("scores bullishly for safe-haven / weak-dollar headlines", () => {
    expect(sentimentOf("Gold surges to record high as dollar weakens")).toBe("bullish");
  });

  it("scores bearishly for hawkish / strong-dollar headlines", () => {
    expect(sentimentOf("Gold prices plunge as Fed hikes rates")).toBe("bearish");
  });

  it("stays neutral for balanced headlines", () => {
    expect(sentimentOf("Gold prices hold steady in quiet trading")).toBe("neutral");
  });
});

describe("news dedupe", () => {
  const item = (title: string, publishedAt = "2026-09-14T12:00:00Z"): NewsItem => ({
    title,
    link: "https://example.com",
    publisher: "test",
    publishedAt,
    symbol: null,
  });

  it("merges lists, removing duplicates by normalized title", () => {
    const out = dedupe([
      [item("Gold Prices Rise on Weak Dollar")],
      [item("Gold Prices Rise on Weak Dollar!", "2026-09-14T11:00:00Z")],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].publishedAt).toBe("2026-09-14T12:00:00Z");
  });

  it("sorts newest first", () => {
    const out = dedupe([[item("Old", "2026-09-14T12:00:00Z")], [item("New", "2026-09-14T13:00:00Z")]]);
    expect(out.map((x) => x.title)).toEqual(["New", "Old"]);
  });
});