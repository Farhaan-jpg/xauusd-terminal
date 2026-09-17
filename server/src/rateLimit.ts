import type { NextFunction, Request, Response } from "express";

/** Minimal in-memory fixed-window limiter — good enough for a single-process,
 * single-instance deployment. Protects the paid AI endpoint from being
 * hammered even by a caller that does have a valid API key. */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  // Bound memory: a caller rotating source addresses (or a long-lived process on
  // a busy host) would otherwise grow `hits` without limit. Sweep expired
  // windows at most once per windowMs, and only once the table is non-trivial.
  function sweep(now: number): void {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    lastSweep = now;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    if (hits.size > 5_000 && now - lastSweep > windowMs) sweep(now);
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "rate limit exceeded, try again shortly" });
      return;
    }

    entry.count += 1;
    next();
  };
}
