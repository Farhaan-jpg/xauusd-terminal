// Alert rule engine. The rules themselves are pure and live here (unit-tested
// in notify.test.ts). The stream engine (stream.ts) is the single evaluator —
// it calls evaluateRules on its 5s cadence and delivers the fired alerts to
// every sink (SSE clients + the optional webhook), so a level-crossing can
// never double-fire or be missed because two loops raced on shared state.
import type { AlertSettings } from "./settings.js";
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
