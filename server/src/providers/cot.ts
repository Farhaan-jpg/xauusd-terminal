// COT (Commitments of Traders) gold positioning from the CFTC public API —
// the disaggregated Futures & Options report for "GOLD". No key required.
// https://publicreporting.cftc.gov simplifies to a Socrata SODA2 endpoint.
import type { CotRow } from "../analytics.js";

const ENDPOINT = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
const SELECT =
  "market_and_exchange_names,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all,nonrept_positions_long_all,nonrept_positions_short_all,contract_units";

/** Raw commitments rows for COMEX gold (futures-only line in this report),
 *  newest report date first. Same-date rows are merged by summing positions. */
export async function cotGold(): Promise<CotRow[]> {
  const params = new URLSearchParams({
    $where: "market_and_exchange_names = 'GOLD - COMMODITY EXCHANGE INC.'",
    $order: "report_date_as_yyyy_mm_dd desc",
    $limit: "20",
    $select: SELECT,
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": "XAUUSD-Terminal/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`cftc ${res.status}`);
  const json: any[] = await res.json();
  if (!Array.isArray(json)) throw new Error("cftc: bad response");

  const merged = new Map<
    string,
    { managedLong: number; managedShort: number; swapLong: number; swapShort: number; otherLong: number; otherShort: number; units: number }
  >();
  for (const r of json) {
    const date = String(r?.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ml = num(r?.noncomm_positions_long_all);
    const ms = num(r?.noncomm_positions_short_all);
    const sl = num(r?.comm_positions_long_all);
    const ss = num(r?.comm_positions_short_all);
    const ol = num(r?.nonrept_positions_long_all);
    const os = num(r?.nonrept_positions_short_all);
    if (ml === null && ms === null && sl === null && ss === null) continue;
    const cur = merged.get(date) ?? { managedLong: 0, managedShort: 0, swapLong: 0, swapShort: 0, otherLong: 0, otherShort: 0, units: 1 };
    cur.managedLong += ml ?? 0;
    cur.managedShort += ms ?? 0;
    cur.swapLong += sl ?? 0;
    cur.swapShort += ss ?? 0;
    cur.otherLong += ol ?? 0;
    cur.otherShort += os ?? 0;
    merged.set(date, cur);
  }

  return [...merged.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // newest first
    .map(([reportDate, s]) => ({
      reportDate,
      managedLong: s.managedLong,
      managedShort: s.managedShort,
      swapLong: s.swapLong,
      swapShort: s.swapShort,
      otherLong: s.otherLong,
      otherShort: s.otherShort,
      contractUnits: null,
    }));
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}