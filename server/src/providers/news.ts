import { XMLParser } from "fast-xml-parser";

export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
  symbol: string | null;
  impact?: "High" | "Medium" | "Low";
  sentiment?: "bullish" | "bearish" | "neutral";
};

const parser = new XMLParser({ ignoreAttributes: false });
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchRss(url: string, publisher: string, symbol: string | null): Promise<NewsItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`rss ${res.status} ${url}`);
  const xml = await res.text();
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  return list
    .filter((i: any) => i?.title && i?.link)
    .map((i: any) => ({
      title: String(i.title),
      link: String(i.link),
      publisher: i.source?.["#text"] ?? publisher,
      publishedAt: i.pubDate ? new Date(i.pubDate).toISOString() : null,
      symbol,
    }));
}

export async function symbolNews(symbol: string): Promise<NewsItem[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  return fetchRss(url, "Yahoo Finance", symbol);
}

export async function topNews(query = "stock market"): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return fetchRss(url, "Google News", null);
}

// ---- Geopolitics / safe-haven news ----
// Direct RSS from Al Jazeera, BBC World & Business, plus focused Google News
// queries covering war, sanctions, tariffs, central-bank gold buying, etc.

const GEOPOLITICS_FEEDS: Array<{ url: string; publisher: string }> = [
  { url: "https://www.aljazeera.com/xml/rss/all.xml", publisher: "Al Jazeera" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", publisher: "BBC World" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", publisher: "BBC Business" },
];

const GEOPOLITICS_QUERIES = [
  "war gold markets",
  "central bank gold reserves",
  "sanctions geopolitics",
  "tariff trade war",
  "middle east tensions gold",
  "sanctions dollar markets",
];

const GEO_KEYWORDS =
  /\b(war|attack|missile|conflict|ceasefire|sanction|tariff|crisis|invasion|nuclear|blockade|embargo|protest|coup|election|central bank|gold reserve|geopolit|tension|escalat|security|military|diplom|opec|oil shock)\b/i;

/**
 * Classify how market-moving a headline is. High → something big is happening
 * (war, strikes, sanctions waves, nuclear, coups…) that a gold trader must
 * know immediately; Medium → macro/policy noise; Low → routine reports.
 */
export type Impact = "High" | "Medium" | "Low";

const HIGH_INFLUENCE =
  /\b(war|missile|air ?strike|drone ?strike|invad|nuclear|nuke|ceasefire|embargo|coup|martial law|attack on|terror attack|offensive|escalat|shot down|retali|military action|declare war|breaking)\b/i;
const MEDIUM_INFLUENCE =
  /\b(conflict|tensions?|sanctions?|tariffs?|crisis|crises|protest|election|central bank|gold reserve|opec|oil|diplom|border|security|policy|inflation|recession|fed|interest rate|retail sales|gdp)\b/i;

export function impactOf(title: string): Impact {
  if (HIGH_INFLUENCE.test(title)) return "High";
  if (MEDIUM_INFLUENCE.test(title)) return "Medium";
  return "Low";
}

// ---- gold-relative sentiment (bullish / bearish / neutral) ----

export type Sentiment = "bullish" | "bearish" | "neutral";

type Lex = Array<[RegExp, number]>;

/** Phrases that push gold price expectations higher. */
const BULLISH_LEX: Lex = [
  [/\b(record high|all[- ]time high)\b/i, 6],
  [/\b(surge|surges|spike|spikes|soar|soars|skyrocket|rally|rallies|jump|jumps|gain|gains|climb|climbs|advance|advances)\b/i, 4],
  [/\b(dovish|rate cut|cuts rates|cut rates|ease|easing|stimulus|quantitative easing|qe|bazooka|pivot|loosen)\b/i, 5],
  [/\b(dollar weak|dollar falls|dollar drop|dollar slump|dollar slides|greenback falls|usd falls|weak usd|weak dollar|dxy drops)\b/i, 4],
  [/\b(inflation|inflationary|cpi|pce) (soars?|surges?|jumps?|rises?|climbs?|higher|hot|spikes?)\b/i, 4],
  [/\b(recession|recessionary|slowdown|downturn|debt crisis|financial crisis|fiscal collapse)\b/i, 4],
  [/\b(safe haven|haven demand|flight to safety|gold demand|gold buying|central bank.*(buy|buying|purchase)|gold reserves?|bullion)\b/i, 3],
  [/\b(war|missile|air ?strike|drone ?strike|invad|nuclear|ceasefire|sanction|tariff|tension|escalat|conflict|blockade|embargo|uncertainty|instability)\b/i, 3],
  [/\b(yields?|treasury yield|real yield|dollar index) (fall|falls|drop|drops|slide|slides|retreat|plunge|dip|slip)\b/i, 3],
  [/\b(sharper|weaker|soften|weakness)\b/i, 1],
];

/** Phrases that push gold price expectations lower. */
const BEARISH_LEX: Lex = [
  [/\b(plunge|plunges|plummet|plummets|crash|crashes|tumble|tumbles|collapse|collapses|slump|slumps|slide|slides|retreat|retreats|sink|sinks|dump|shed|drop|drops)\b/i, 4],
  [/\b(slips?|falls?|declines?|dips?|loses|losses?|weakens?|worse|under pressure)\b/i, 3],
  [/\b(hawkish|rate hike|hikes?|hike rates|raises rates|tightening|tapering|hike cycle|higher for longer)\b/i, 5],
  [/\b(dollar strong|dollar surges|dollar jumps|dollar gains|dollar rises|dollar advances|greenback strong|usd strong|dxy rises)\b/i, 4],
  [/\b(inflation|cpi|pce) (falls?|drops?|cools?|eases?|declines?|slows?|slower|lower|below|soft)\b/i, 4],
  [/\b(yields?|treasury yield|real yield|dollar index) (rise|rises|jump|jumps|climb|climbs|surge|surges|advance|advances|soar)\b/i, 3],
  [/\b(risk on|risk-on|stocks rally|equities rally|shares rally|market rally|appetite for risk)\b/i, 3],
  [/\b(gold|bullion|the metal) (falls?|drops?|slides?|declines?|dips?|sinks|weakens?|loses?|under pressure|retreats?)\b/i, 5],
  [/\b(deflation|disinflation|stronger|firmer|solid)\b/i, 1],
];

export function sentimentOf(title: string): Sentiment {
  const text = title.toLowerCase().replace(/\s+/g, " ");
  let score = 0;
  for (const [re, w] of BULLISH_LEX) if (re.test(text)) score += w;
  for (const [re, w] of BEARISH_LEX) if (re.test(text)) score -= w;
  return score > 1 ? "bullish" : score < -1 ? "bearish" : "neutral";
}

/** Fetch geopolitics news; returns deduplicated, newest-first list. */
export async function geopoliticsNews(): Promise<NewsItem[]> {
  const tasks = [
    ...GEOPOLITICS_QUERIES.map((q) => topNews(q)),
    ...GEOPOLITICS_FEEDS.map((f) => fetchRss(f.url, f.publisher, null)),
  ];
  const results = await Promise.allSettled(tasks);
  const items = results
    .filter((r): r is PromiseFulfilledResult<NewsItem[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);
  // keep only geopolitically relevant items (avoids generic "market" noise)
  const filtered = items.filter((n) => GEO_KEYWORDS.test(n.title));
  return dedupe([filtered])
    .slice(0, 40)
    .map((n) => ({ ...n, impact: impactOf(n.title), sentiment: sentimentOf(n.title) }));
}

/** Merge, de-duplicate by normalized title, newest first. */
export function dedupe(lists: NewsItem[][]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of lists.flat()) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}