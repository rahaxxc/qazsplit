import "server-only";

import { ROUTING_ERROR_CODES, normalizeOrigin } from "../shared";
import { RequestError } from "./http";

// ---------------------------------------------------------------------------------------------
// Rate limiting (audit M4)
// ---------------------------------------------------------------------------------------------
//
// MultiHopper's limits are per API key (e.g. 30 estimates and 10 creates per minute), and every
// QazSplit user shares this server's key. Two fixed-window limits protect it: one per client and
// one for the whole instance, kept just under MultiHopper's own. They are in-memory and therefore
// per server instance; a multi-instance deployment needs a shared store (documented).

export type RateLimitRule = { perClient: number; global: number; windowMs: number };

export const RATE_LIMITS = {
  estimate: { perClient: 10, global: 25, windowMs: 60_000 },
  create: { perClient: 4, global: 8, windowMs: 60_000 },
  status: { perClient: 30, global: 50, windowMs: 60_000 },
  prepare: { perClient: 10, global: 25, windowMs: 60_000 },
  confirm: { perClient: 15, global: 30, windowMs: 60_000 },
  recover: { perClient: 3, global: 10, windowMs: 60_000 },
  recovery: { perClient: 6, global: 15, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

type Window = { start: number; count: number };
const windows = new Map<string, Window>();
const MAX_TRACKED = 10_000;

/** Best-effort client identity: the first forwarded address (set by the hosting proxy), else one shared bucket. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "direct";
  return ip.slice(0, 64);
}

function hit(key: string, limit: number, windowMs: number, now: number): number | null {
  let entry = windows.get(key);
  if (!entry || now - entry.start >= windowMs) {
    if (!entry && windows.size >= MAX_TRACKED) {
      for (const [stale, value] of windows) if (now - value.start >= windowMs) windows.delete(stale);
      if (windows.size >= MAX_TRACKED) windows.clear();
    }
    entry = { start: now, count: 0 };
    windows.set(key, entry);
  }
  if (entry.count >= limit) return Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
  entry.count += 1;
  return null;
}

/** Throws 429 RATE_LIMITED with Retry-After when this client or the whole instance is over its limit. */
export function enforceRateLimit(request: Request, route: keyof typeof RATE_LIMITS, now = Date.now()): void {
  const rule: RateLimitRule = RATE_LIMITS[route];
  const retryAfter = hit(`global:${route}`, rule.global, rule.windowMs, now) ?? hit(`client:${route}:${clientKey(request)}`, rule.perClient, rule.windowMs, now);
  if (retryAfter != null) {
    throw new RequestError(429, ROUTING_ERROR_CODES.rateLimited, "Too many routing requests. Wait a moment and retry.", { "Retry-After": String(retryAfter) });
  }
}

export function resetRateLimits(): void {
  windows.clear();
}

// ---------------------------------------------------------------------------------------------
// Origin binding (audit M5)
// ---------------------------------------------------------------------------------------------

/** The public origin of this deployment: QAZSPLIT_PUBLIC_ORIGIN when set, else the request's own origin. */
export function expectedOrigin(request: Request, env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.QAZSPLIT_PUBLIC_ORIGIN?.trim();
  if (configured) return normalizeOrigin(configured);
  try { return normalizeOrigin(new URL(request.url).origin); } catch { return null; }
}

/**
 * The origin written into a signed approval must be this deployment's, and a browser's Origin
 * header (sent with every cross-site and same-site POST) must agree. An approval signed on another
 * site, or for another deployment, is refused.
 */
export function assertSignedOrigin(request: Request, signedOrigin: string, env?: Record<string, string | undefined>): void {
  const expected = expectedOrigin(request, env);
  const header = request.headers.get("origin");
  if (!expected || signedOrigin !== expected || (header != null && header !== expected)) {
    throw new RequestError(403, ROUTING_ERROR_CODES.originMismatch, "This approval was not made on this QazSplit site. Approve it again here.");
  }
}
