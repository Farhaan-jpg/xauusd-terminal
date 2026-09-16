// Server-side alert notifier. When the user configures a webhook URL
// (Settings → Alerts), the running terminal polls quotes / calendar / news and
// POSTs alert payloads to that URL — so alerts keep firing even while the app
// window is closed or on another machine. Fire-and-forget: nothing here ever
// throws into the request path.
import { getSettings, type AlertSettings } from "./settings.js";
import { cached } from "./cache.js";
import { tracked } from "./providers/registry.js";
import { getQuotes } from "./routes/market.js";
import { topNews, dedupe, type NewsItem } from "./providers/news.js";
import type { EconEvent } from "./providers/econcalendar.js";

export type NotifyEvent = {
  type: "level" | "event" | "move" | "news";
  text: string;
  tone: "up" | "down" | "amber";
  key: string;
};

// Re-arm tracking for price levels — a level fires once per crossing and is
// re-armed only once price returns to the safe side of the trigger.
const armed = new Map<string, boolean>();
const fired = new Map<string, number>();
let prevSpot: { price: number; at: number } | null = null;

function setFired(key: string, now: number, cooldownMs: number): boolean {
  const last = fired.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  fired.set(key, now);
  return true;
}

function levelKey(l: { symbol: string; level: number; dir: "above" | "below" }) {
  return `lvl:${l.symbol}:${l.level}:${l.dir}`;
}

/** Pure rule evaluation — the crossing/countdown/keyword logic, decoupled from
 *  the fetch loop so it can be unit tested. Returns the events that should fire. */
export function evaluateRules(params: {
  now: number;
  alerts: AlertSettings;
  prices: Map<string, number | null>;
  events: EconEvent[];
  headlines: string[];
}): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  const { now, alerts, prices, events, headlines } = params;

  if (alerts.levels?.length) {
    for (const level of alerts.levels ?? []) {
      const price = prices.get(level.symbol);
      if (price === undefined || price === null || !Number.isFinite(price)) continue;
      const key = levelKey(level);
      const isArmed = armed.get(key) ?? true;
      const crossedUp = level.dir === "above" && price >= level.level;
      const crossedDown = level.dir === "below" && price <= level.level;
      if ((crossedUp || crossedDown) && isArmed) {
        armed.set(key, false);
        const label = level.label ?? level.symbol;
        out.push({
          type: "level",
          tone: crossedUp ? "up" : "down",
          text: `${label} ${crossedUp ? "crossed above" : "fell below"} ${level.level.toLocaleString(undefined, { maximumFractionDigits: 3 })} (now ${price.toLocaleString(undefined, { maximumFractionDigits: 3 })})`,
          key,
        });
      } else {
        const safeSide = level.dir === "above" ? price < level.level : price > level.level;
        if (safeSide) armed.set(key, true);
      }
    }
  }

  if (alerts.highImpact && alerts.countdownMin > 0) {
    const windowSec = Math.max(1, alerts.countdownMin) * 60_000;
    for (const ev of events) {
      if (ev.impact !== "High" && ev.impact !== "Medium") continue;
      const t = Date.parse(ev.date);
      if (!Number.isFinite(t)) continue;
      const until = t - now;
      if (until < 0 || until > windowSec) continue;
      const key = `cd:${ev.country}:${ev.title}:${ev.date}`;
      if (setFired(key, now, windowSec + 60_000)) {
        const mins = Math.max(1, Math.ceil(until / 60_000));
        out.push({
          type: "event",
          tone: "amber",
          text: `${ev.title} (${ev.country}) in ~${mins} min${alerts.countdownMin >= 10 ? " — high-impact release" : ""}`,
          key,
        });
      }
    }
  }

  const keywords = (alerts.newsKeywords ?? []).filter((k) => k.length > 0);
  if (keywords.length) {
    for (const title of headlines) {
      const lower = title.toLowerCase();
      const hit = keywords.find((k) => lower.includes(k.toLowerCase()));
      if (!hit) continue;
      const key = `kw:${title}`;
      if (setFired(key, now, 10 * 60_000)) {
        out.push({ type: "news", tone: "amber", text: `“${title.slice(0, 90)}”`, key });
      }
    }
  }

  return out;
}

async function currentPrices(symbols: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (symbols.length === 0) return map;
  try {
    const quotes = await getQuotes([...new Set(symbols)]);
    for (const q of quotes) map.set(q.symbol, q.price ?? null);
  } catch {
    // partial data is still useful; missing symbols just never fire
  }
  return map;
}

async function currentHeadlines(): Promise<string[]> {
  try {
    const lists = await Promise.allSettled([
      tracked("news", () => topNews("gold price")),
    ]);
    const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value) as NewsItem[][];
    return dedupe(ok).slice(0, 40).map((n) => n.title).filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function post(url: string, ev: NotifyEvent): Promise<boolean> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: ev.type, text: ev.text, tone: ev.tone, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => r.ok)
    .catch((err) => {
      console.error(`[notify] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
}

let lastMoveKeyAt = 0;

async function tick(): Promise<void> {
  const { alerts } = getSettings();
  const url = alerts.webhook?.url?.trim();
  if (!alerts.enabled || !alerts.webhook?.enabled || !url) return;

  const symbols = ["XAUUSD", ...(alerts.levels ?? []).map((l) => l.symbol)];
  const [prices, events, headlines] = await Promise.all([
    currentPrices(symbols),
    cached("econ-calendar", 300_000, () => tracked("forexfactory", () => import("./providers/econcalendar.js").then((m) => m.weeklyEvents()))).catch(() => [] as EconEvent[]),
    currentHeadlines(),
  ]);

  // Spot-move detection: percent change of XAUUSD between consecutive polls.
  const spot = prices.get("XAUUSD");
  const now = Date.now();
  if (spot !== undefined && spot !== null && Number.isFinite(spot) && prevSpot) {
    const pct = Math.abs((spot / prevSpot.price - 1) * 100);
    if (pct >= alerts.thresholdPct && now - lastMoveKeyAt > 10 * 60_000) {
      lastMoveKeyAt = now;
      const dir = spot > prevSpot.price ? "up" : "down";
      const ev: NotifyEvent = {
        type: "move",
        tone: dir === "up" ? "up" : "down",
        text: `Gold ${dir} ${pct.toFixed(2)}% in the last ${Math.round((now - prevSpot.at) / 1000)}s → ${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        key: `mv:${Math.floor(now / 600_000)}`,
      };
      await post(url, ev);
    }
  }
  if (spot !== undefined && spot !== null && Number.isFinite(spot)) {
    prevSpot = { price: spot, at: now };
  }

  const firedNow = evaluateRules({ now, alerts, prices, events, headlines });
  await Promise.allSettled(firedNow.map((ev) => post(url, ev)));
}

export function startNotifier(): NodeJS.Timeout | null {
  const timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref();
  void tick(); // first evaluation immediately
  return timer;
}