import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

// DATA_DIR lets the Docker image point this at the mounted volume: once
// compiled, dist/auth.js sits two levels below /app instead of server/src,
// so the source-relative default below would otherwise resolve outside /app.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");
mkdirSync(dataDir, { recursive: true });

const keyFile = join(dataDir, ".api-key");

function resolveApiKey(): string {
  if (process.env.API_KEY) return process.env.API_KEY;
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  const generated = randomBytes(24).toString("hex");
  writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

export const apiKey = resolveApiKey();

if (!process.env.API_KEY) {
  console.warn(
    `No API_KEY set — generated one and saved it to ${keyFile}. ` +
      "The bundled web app reads this file automatically for local use. " +
      "For any deployment reachable beyond localhost, set API_KEY explicitly " +
      "on both the api and web services and keep this file private."
  );
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-api-key") ?? "";
  const expected = Buffer.from(apiKey);
  const actual = Buffer.from(provided);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
    next();
    return;
  }
  res.status(401).json({ error: "missing or invalid X-Api-Key header" });
}