import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Entry = { value: unknown; expires: number };

// Stale entries survive restarts so a cold boot with providers unreachable can
// still serve last-known data. The file lives next to settings.json / the API
// key in DATA_DIR (mirrors how auth.ts resolves its data directory).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");
mkdirSync(dataDir, { recursive: true });
const staleFile = join(dataDir, "cache-stale.json");

const store = new Map<string, Entry>();

export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

// Stale entries are kept around so provider outages can fall back to last-known data.
// The store is capped (LRU by recency of access) so an unbounded number of cached
// keys can't grow cache-stale.json without limit across many feature types.
const staleStore = new Map<string, unknown>();
const STALE_MAX = process.env.STALE_MAX ? Math.max(50, Number(process.env.STALE_MAX)) : 400;

// Restore previous run's last-known values at boot (best effort: a corrupt or
// oversized file must never prevent the server from starting).
try {
  if (existsSync(staleFile)) {
    const parsed = JSON.parse(readFileSync(staleFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (v !== undefined) staleStore.set(k, v);
    }
  }
} catch {
  // ignore — treat as a fresh first boot
}

let writeTimer: NodeJS.Timeout | null = null;
let dirty = false;
let lastWriteAt = 0;
const WRITE_MIN_INTERVAL = 1_000;

function persistStale(): void {
  const tmp = staleFile + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(staleStore)));
    renameSync(tmp, staleFile);
    lastWriteAt = Date.now();
  } catch (err) {
    console.error("[cache] failed to persist stale store", err);
  }
}

export function flushStaleCache(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (dirty) {
    dirty = false;
    persistStale();
    // Anything that dirtied the store while we were writing is picked up on the
    // next scheduled flush — no further rapid-fire writes for a live poller.
    if (writeTimer === null) writeTimer = setTimeout(() => flushStaleCache(), WRITE_MIN_INTERVAL);
  }
}

export function staleSet(key: string, value: unknown): void {
  staleStore.set(key, value);
  while (Number.isFinite(STALE_MAX) && staleStore.size > STALE_MAX) {
    const oldest = staleStore.keys().next();
    if (oldest.done) break;
    staleStore.delete(oldest.value);
  }
  dirty = true;
  if (writeTimer === null) {
    const delay = Math.max(0, lastWriteAt + WRITE_MIN_INTERVAL - Date.now());
    writeTimer = setTimeout(() => flushStaleCache(), delay);
  }
}

export function staleGet<T>(key: string): T | undefined {
  const value = staleStore.get(key);
  if (value === undefined) return undefined;
  // LRU touch: move to the back so active keys survive the size cap longest.
  if (Number.isFinite(STALE_MAX) && staleStore.size > 1) {
    staleStore.delete(key);
    staleStore.set(key, value);
  }
  return value as T | undefined;
}

/** Number of last-known entries currently held in the stale store. */
export function staleCount(): number {
  return staleStore.size;
}

// In-flight dedup: N concurrent misses for the same key share ONE provider
// fetch instead of stampeding upstream. The promise is removed when it settles
// so the next interval's cache miss starts a fresh fetch.
const inflight = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const running = inflight.get(key);
  if (running !== undefined) return running as Promise<T>;

  const p = (async (): Promise<T> => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs);
      staleSet(key, value);
      return value;
    } catch (err) {
      const stale = staleGet<T>(key);
      if (stale !== undefined) return stale;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function cacheStore(key: string, value: unknown, ttlMs: number): void {
  cacheSet(key, value, ttlMs);
  staleSet(key, value);
}

