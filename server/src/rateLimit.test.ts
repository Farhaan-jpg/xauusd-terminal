import { describe, expect, it } from "vitest";
import { rateLimit } from "./rateLimit.js";

function fakeExchange(ip = "127.0.0.1") {
  const state = { status: 0, jsonBody: null as unknown, nextCount: 0, retryAfter: "" };
  const req = { ip } as any;
  const res = {
    status: (s: number) => {
      state.status = s;
      return res;
    },
    json: (b: unknown) => {
      state.jsonBody = b;
      return res;
    },
    setHeader: (k: string, v: string) => {
      if (k === "Retry-After") state.retryAfter = v;
      return res;
    },
  } as any;
  const next = () => {
    state.nextCount += 1;
  };
  return { req, res, next, state };
}

describe("market rateLimit", () => {
  it("allows requests under the cap and 429s the excess", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const { req, res, next, state } = fakeExchange();

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);
    expect(state.nextCount).toBe(3);
    expect(state.status).toBe(0);

    limiter(req, res, next);
    expect(state.status).toBe(429);
    expect(state.nextCount).toBe(3);
  });

  it("tracks callers independently", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const a = fakeExchange("10.0.0.1");
    const b = fakeExchange("10.0.0.2");

    limiter(a.req, a.res, a.next);
    limiter(b.req, b.res, b.next);
    limiter(a.req, a.res, a.next); // a exceeded, b not
    expect(a.state.status).toBe(429);
    expect(b.state.status).toBe(0);
  });

  it("sets Retry-After and the window resets after timeout", () => {
    const limiter = rateLimit({ windowMs: 10, max: 1 });
    const { req, res, next, state } = fakeExchange();
    limiter(req, res, next);
    limiter(req, res, next);
    expect(state.status).toBe(429);
    expect(Number(state.retryAfter)).toBeGreaterThan(0);
  });
});