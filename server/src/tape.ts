// In-memory recent-tick ring for the tape widget + SSE push. Symbols are
// recorded from the quote cache by the stream engine (stream.ts) and by the
// /api/tape route. Pure, synchronous, no I/O.
export type TapeTick = {
  t: number; // epoch ms
  price: number;
  changePercent: number | null;
  volume: number | null;
  source: string;
};

const RING = new Map<string, TapeTick[]>();
const MAX = 600;

export function recordTapeTick(symbol: string, tick: TapeTick): void {
  const key = symbol.toUpperCase();
  let arr = RING.get(key);
  if (!arr) {
    arr = [];
    RING.set(key, arr);
  }
  const last = arr[arr.length - 1];
  if (last && last.t === tick.t && last.price === tick.price) return; // dedupe duplicate timestamps
  arr.push(tick);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
}

export function getTape(symbol: string, n = 250): TapeTick[] {
  const arr = RING.get(symbol.toUpperCase()) ?? [];
  return arr.slice(-Math.max(0, n));
}

export function clearTape(symbol: string): void {
  RING.delete(symbol.toUpperCase());
}