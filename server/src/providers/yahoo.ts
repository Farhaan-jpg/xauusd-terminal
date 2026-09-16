import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Yahoo's CDN fingerprints Node's TLS stack (undici) and 429s it on this
// network, while Windows' curl.exe (Schannel) passes. So chart/quote JSON is
// fetched through curl when it is installed — same endpoints, same headers —
// and falls back to plain fetch everywhere else.
let curlOk: boolean | null = null;
function hasCurl(): boolean {
  if (curlOk === null) {
    try {
      curlOk = spawnSync("curl", ["--version"], { windowsHide: true, timeout: 5_000 }).status === 0;
    } catch {
      curlOk = false;
    }
  }
  return curlOk;
}

function curlText(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "-m", "20", "-L", "-A", headers["User-Agent"] ?? UA];
    if (headers.Accept) args.push("-H", `Accept: ${headers.Accept}`);
    if (headers.Cookie) args.push("-H", `Cookie: ${headers.Cookie}`);
    args.push(url);
    execFile(
      "curl",
      args,
      { windowsHide: true, timeout: 25_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (stderr || "").match(/\b(429|401|403|404)\b/)?.[0];
          if (code === "429") {
            consecutive429s++;
            crumbCooldownUntil = Date.now() + Math.min(30_000 * consecutive429s, 5 * 60_000);
          }
          reject(new Error(`yahoo curl ${code ?? err.message} for ${url}`));
          return;
        }
        consecutive429s = 0;
        try {
          resolve(stdout);
        } catch {
          reject(new Error("yahoo curl: bad response"));
        }
      }
    );
  });
}

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  time: number | null;
  source: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

// ---- crumb/cookie session (needed for the v7 quote and options endpoints) ----

let session: { cookie: string; crumb: string; fetched: number } | null = null;
let sessionFailedUntil = 0;

function runCurl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("curl", args, { windowsHide: true, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function cookieFromJar(jarPath: string): string | null {
  try {
    const text = readFileSync(jarPath, "utf8");
    let fallback: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length >= 7 && parts[6].trim()) {
        const name = parts[5];
        const val = parts[6].trim();
        if (name === "A1") return `A1=${val}`;
        if (name === "A3") fallback = `A3=${val}`;
      }
    }
    return fallback;
  } catch {
    // jar absent → no cookie
  }
  return null;
}

/** Yahoo's edge returns HTTP 200 with the text "Too Many Requests" when
 *  throttled, so a crumb is only valid when it's a short token. Retry a few
 *  times with backoff so a transient throttle doesn't hard-fail the session. */
async function withCrumbRetry(fn: () => Promise<string>): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < 4; i++) {
    try {
      const crumb = (await fn()).trim();
      if (crumb && !crumb.includes("<") && !crumb.toLowerCase().includes("too many")) return crumb;
      lastErr = new Error(`yahoo: crumb fetch failed [${crumb.slice(0, 40) || "empty"}]`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr ?? new Error("yahoo: crumb fetch failed");
}

/** Session handshake via curl (Schannel passes Yahoo's TLS fingerprint check
 *  where undici does not). Cookie saved to a temp jar, crumb read back. The
 *  fc.yahoo.com step sometimes returns without cookies (edge throttling), so
 *  the whole handshake retries with backoff. */
async function getSessionCurl(): Promise<{ cookie: string; crumb: string }> {
  let lastErr: Error | null = null;
  for (let i = 0; i < 4; i++) {
    const jar = join(tmpdir(), `ycook-${process.pid}-${Date.now()}.txt`);
    try {
      await execFile("curl", ["-sS", "-m", "12", "-L", "-A", UA, "-c", jar, "-o", "NUL", "https://fc.yahoo.com/"], {
        windowsHide: true,
        timeout: 15_000,
      });
      const cookie = cookieFromJar(jar);
      if (!cookie) {
        lastErr = new Error("yahoo: no session cookie");
      } else {
        const crumb = await withCrumbRetry(() =>
          runCurl(["-sS", "-m", "15", "-A", UA, "-b", jar, "https://query2.finance.yahoo.com/v1/test/getcrumb"])
        );
        session = { cookie, crumb, fetched: Date.now() };
        return { cookie, crumb };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      try {
        if (existsSync(jar)) unlinkSync(jar);
      } catch {
        // best effort cleanup
      }
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr ?? new Error("yahoo: session fetch failed");
}

async function getSessionFetch(): Promise<{ cookie: string; crumb: string }> {
  const res = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("yahoo: no session cookie");
  const crumb = await withCrumbRetry(() =>
    fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.text())
  );
  return { cookie, crumb };
}

async function getSession(): Promise<{ cookie: string; crumb: string }> {
  if (session && Date.now() - session.fetched < 30 * 60 * 1000) return session;
  if (Date.now() < sessionFailedUntil) throw new Error("yahoo: crumb fetch failed (cached failure)");
  try {
    const s = hasCurl() ? await getSessionCurl() : await getSessionFetch();
    session = { ...s, fetched: Date.now() };
    return s;
  } catch (err) {
    sessionFailedUntil = Date.now() + 20_000;
    throw err;
  }
}

// Global politeness limiter: max 2 concurrent Yahoo requests with a minimum
// spacing between request starts, plus a cooldown window after a 429 (with
// backoff on repeat offenses) so we fail fast and let the cache serve stale data.
//
// Cooldowns are split between crumb-gated endpoints (v7 quote/options — these
// 401/429 from datacenter IPs where the crumb handshake fails) and the open
// v8 /chart endpoints (which work fine from servers). A crumb failure never
// blocks a chart request anymore — that coupling is what left ZQ/F implied
// rates and charts blank on cloud hosts.
const MAX_CONCURRENT = 2;
const MIN_SPACING_MS = 150;
let active = 0;
let nextSlotAt = 0;
const waiters: Array<() => void> = [];
let crumbCooldownUntil = 0;
let consecutive429s = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve, reject) => {
      const entry = { called: false };
      let bail: NodeJS.Timeout | null = null;
      const go = () => {
        if (entry.called) return;
        entry.called = true;
        if (bail) clearTimeout(bail);
        resolve();
      };
      bail = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        (go as unknown as { called: boolean }).called = true;
        reject(new Error("yahoo: request queue timeout"));
      }, 25_000);
      waiters.push(go);
    });
  }
  active++;
  const wait = nextSlotAt - Date.now();
  nextSlotAt = Math.max(Date.now(), nextSlotAt) + MIN_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

function release(): void {
  active--;
  waiters.shift()?.();
}

async function yfetch(url: string, withCrumb = false): Promise<any> {
  // Only crumb-gated endpoints share the cooldown counter; chart requests
  // (withCrumb=false) are never throttled by crumb failures.
  if (withCrumb && Date.now() < crumbCooldownUntil) {
    throw new Error("yahoo crumb rate-limited (cooling down)");
  }
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  let full = url;
  await acquire();
  try {
    if (hasCurl()) {
      if (withCrumb) {
        const s = await getSession();
        headers.Cookie = s.cookie;
        full += (url.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(s.crumb);
      }
      const text = await curlText(full, headers);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("yahoo curl: non-JSON response");
      }
    }
    if (withCrumb) {
      const s = await getSession();
      headers.Cookie = s.cookie;
      full += (url.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(s.crumb);
    }
    const res = await fetch(full, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      if (res.status === 429) {
        consecutive429s++;
        if (withCrumb) crumbCooldownUntil = Date.now() + Math.min(30_000 * consecutive429s, 5 * 60_000);
      }
      if (withCrumb && (res.status === 401 || res.status === 403)) session = null;
      throw new Error(`yahoo ${res.status} for ${url}`);
    }
    consecutive429s = 0;
    return res.json();
  } finally {
    release();
  }
}

const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

// ---- quotes ----

export async function quotes(symbols: string[]): Promise<Quote[]> {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(","));
  const json = await yfetch(url, true);
  const rows: any[] = json?.quoteResponse?.result ?? [];
  return rows.map((r) => ({
    symbol: r.symbol,
    name: r.longName ?? r.shortName ?? null,
    price: n(r.regularMarketPrice),
    change: n(r.regularMarketChange),
    changePercent: n(r.regularMarketChangePercent),
    open: n(r.regularMarketOpen),
    high: n(r.regularMarketDayHigh),
    low: n(r.regularMarketDayLow),
    previousClose: n(r.regularMarketPreviousClose),
    bid: n(r.bid),
    ask: n(r.ask),
    volume: n(r.regularMarketVolume),
    avgVolume: n(r.averageDailyVolume3Month),
    marketCap: n(r.marketCap),
    pe: n(r.trailingPE),
    eps: n(r.epsTrailingTwelveMonths),
    dividendYield: n(r.trailingAnnualDividendYield),
    week52High: n(r.fiftyTwoWeekHigh),
    week52Low: n(r.fiftyTwoWeekLow),
    beta: n(r.beta),
    sharesOutstanding: n(r.sharesOutstanding),
    currency: r.currency ?? null,
    exchange: r.fullExchangeName ?? r.exchange ?? null,
    marketState: r.marketState ?? null,
    time: n(r.regularMarketTime),
    source: "yahoo",
  }));
}

/** Quote fallback that works without crumb, using the chart endpoint's metadata. */
export async function quoteFromChart(symbol: string): Promise<Quote> {
  const json = await yfetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`
  );
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("yahoo chart: no meta for " + symbol);
  const price = n(meta.regularMarketPrice);
  const prev = n(meta.chartPreviousClose ?? meta.previousClose);
  return {
    symbol: meta.symbol ?? symbol,
    name: meta.longName ?? meta.shortName ?? null,
    price,
    change: price !== null && prev !== null ? price - prev : null,
    changePercent: price !== null && prev !== null && prev !== 0 ? ((price - prev) / prev) * 100 : null,
    open: null,
    high: n(meta.regularMarketDayHigh),
    low: n(meta.regularMarketDayLow),
    previousClose: prev,
    bid: null,
    ask: null,
    volume: n(meta.regularMarketVolume),
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: n(meta.fiftyTwoWeekHigh),
    week52Low: n(meta.fiftyTwoWeekLow),
    beta: null,
    sharesOutstanding: null,
    currency: meta.currency ?? null,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
    marketState: null,
    time: n(meta.regularMarketTime),
    source: "yahoo-chart",
  };
}

// ---- history ----

export async function history(symbol: string, range: string, interval: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  const json = await yfetch(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("yahoo: no chart data for " + symbol);
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return candles;
}

// ---- search ----

export type SearchResult = { symbol: string; name: string; exchange: string; type: string };

export async function search(query: string): Promise<SearchResult[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    query
  )}&quotesCount=12&newsCount=0`;
  const json = await yfetch(url);
  return (json?.quotes ?? [])
    .filter((r: any) => r.symbol)
    .map((r: any) => ({
      symbol: r.symbol,
      name: r.longname ?? r.shortname ?? r.symbol,
      exchange: r.exchDisp ?? r.exchange ?? "",
      type: r.quoteType ?? r.typeDisp ?? "",
    }));
}

// ---- options ----

export async function options(symbol: string, date?: number): Promise<any> {
  let url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  if (date) url += `?date=${date}`;
  const json = await yfetch(url, true);
  const result = json?.optionChain?.result?.[0];
  if (!result) throw new Error("yahoo: no option chain for " + symbol);
  const chain = result.options?.[0] ?? { calls: [], puts: [] };
  const pick = (o: any) => ({
    strike: n(o.strike),
    lastPrice: n(o.lastPrice),
    bid: n(o.bid),
    ask: n(o.ask),
    change: n(o.change),
    percentChange: n(o.percentChange),
    volume: n(o.volume),
    openInterest: n(o.openInterest),
    impliedVolatility: n(o.impliedVolatility),
    inTheMoney: !!o.inTheMoney,
  });
  return {
    symbol,
    underlyingPrice: n(result.quote?.regularMarketPrice),
    expirationDates: result.expirationDates ?? [],
    selectedDate: chain.expirationDate ?? null,
    calls: (chain.calls ?? []).map(pick),
    puts: (chain.puts ?? []).map(pick),
  };
}

