import "server-only";

import { EXTERNAL_ID_PREFIX, ROUTING_ERROR_CODES } from "../shared";
import { MultiHopperApiError, type ConfirmBroadcastRequest, type MultiHopperTransfer } from "./api";
import { decodeSignature, readBearerToken, verifyAccessToken, type AccessClaims } from "./auth";
import { MultiHopperConfigError, redactSecrets } from "./config";
import { RoutingContextError } from "./context";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SIGNATURES_PER_GROUP = 32;

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = "RequestError";
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

type LogValue = string | number | boolean | null | undefined;

/** Structured, allow-listed logging. Callers pass identifiers and codes only — never keys, tokens or wallets. */
export function logRoutingEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, LogValue> = {}): void {
  const safe: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) safe[key] = typeof value === "string" ? redactSecrets(value).slice(0, 200) : value;
  console[level](JSON.stringify({ scope: "multihopper", event, ...safe }));
}

export async function readJsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new RequestError(415, ROUTING_ERROR_CODES.unsupportedMediaType, "Send the request body as application/json.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new RequestError(413, ROUTING_ERROR_CODES.invalidRequest, "Request body is too large.");
  try { return JSON.parse(raw); } catch { throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, "Request body is not valid JSON."); }
}

function signatureList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SIGNATURES_PER_GROUP || value.some((item) => !decodeSignature(item))) {
    throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, `${field} must be a list of base58 transaction signatures.`);
  }
  return value as string[];
}

function optionalSignature(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!decodeSignature(value)) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, `${field} must be a base58 transaction signature.`);
  return value as string;
}

/** Validates a confirm-broadcast body; only documented fields are forwarded upstream. */
export function parseConfirmBroadcastBody(body: unknown): ConfirmBroadcastRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, "Request body must be a JSON object.");
  const input = body as Record<string, unknown>;
  const parsed: ConfirmBroadcastRequest = { routeInitSignatures: signatureList(input.routeInitSignatures, "routeInitSignatures") };
  const keeperFundingSignature = optionalSignature(input.keeperFundingSignature, "keeperFundingSignature");
  const orchestratorInitSignature = optionalSignature(input.orchestratorInitSignature, "orchestratorInitSignature");
  const sessionInitSignatures = input.sessionInitSignatures === undefined ? [] : signatureList(input.sessionInitSignatures, "sessionInitSignatures");
  const dispersionInitSignatures = input.dispersionInitSignatures === undefined ? [] : signatureList(input.dispersionInitSignatures, "dispersionInitSignatures");
  if (keeperFundingSignature) parsed.keeperFundingSignature = keeperFundingSignature;
  if (orchestratorInitSignature) parsed.orchestratorInitSignature = orchestratorInitSignature;
  if (sessionInitSignatures.length) parsed.sessionInitSignatures = sessionInitSignatures;
  if (dispersionInitSignatures.length) parsed.dispersionInitSignatures = dispersionInitSignatures;
  return parsed;
}

export function parseTransferId(value: string): number {
  const id = /^[1-9]\d{0,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, "Transfer ID is invalid.");
  return id;
}

/** Requires a routing access token issued for exactly this transfer. */
export async function authorizeTransferAccess(request: Request, tokenSecret: string, transferId: number): Promise<AccessClaims> {
  const token = readBearerToken(request);
  const claims = token ? await verifyAccessToken(tokenSecret, token) : null;
  // One response for missing, expired, forged and other-transfer tokens: reveal nothing.
  if (!claims || claims.transferId !== transferId) {
    throw new RequestError(401, ROUTING_ERROR_CODES.unauthorized, "Routing access expired or is not valid for this transfer.");
  }
  return claims;
}

/** Defense in depth on top of the token: the upstream transfer must be QazSplit's and this wallet's. */
export function assertOwnedTransfer(transfer: MultiHopperTransfer | null, claims: AccessClaims): void {
  if (!transfer) return;
  const foreign = transfer.id !== claims.transferId
    || (transfer.sourceOwner != null && transfer.sourceOwner !== claims.wallet)
    || (transfer.externalId != null && !transfer.externalId.startsWith(EXTERNAL_ID_PREFIX));
  if (foreign) throw new RequestError(404, ROUTING_ERROR_CODES.transferNotFound, "Transfer not found.");
}

export type PublicTransfer = ReturnType<typeof toPublicTransfer>;

/** Only the fields the routing UI shows. */
export function toPublicTransfer(transfer: MultiHopperTransfer) {
  return {
    id: transfer.id,
    externalId: transfer.externalId,
    supportBundleId: transfer.supportBundleId,
    status: transfer.status,
    phase: transfer.phase,
    progress: transfer.progress,
    lastError: transfer.lastError,
    amountLamports: transfer.amountRaw,
    recipientWallet: transfer.recipientWallet,
    recipientReceivesLamports: transfer.recipientReceivesRaw,
    hops: transfer.hops,
    arrivalSeconds: transfer.arrivalSeconds,
    pricingTier: transfer.pricingTier,
    percentFeeBps: transfer.percentFeeBps,
    percentFeeLamports: transfer.percentFeeRaw,
    totalFlatFeeLamports: transfer.totalFlatFeeLamports,
    isTest: transfer.isTest,
    quotedAt: transfer.quotedAt,
    expiresAt: transfer.expiresAt,
    createdAt: transfer.createdAt,
    completedAt: transfer.completedAt,
    hopSignatures: transfer.signatures?.hops ?? [],
    routeInitSignatures: transfer.signatures?.routeInit ?? [],
    sessionInitSignatures: transfer.signatures?.sessionInit ?? [],
    route: transfer.routeHops?.map((hop) => ({ index: hop.index, scheduledAt: hop.scheduledAt, executedAt: hop.executedAt, txSignature: hop.txSignature })) ?? null,
    recovery: transfer.recovery,
  };
}

const CONTEXT_STATUS: Record<RoutingContextError["code"], number> = {
  AGREEMENT_NOT_FOUND: 404, NOT_A_RECIPIENT: 403, MILESTONE_NOT_PAID: 409, RPC_UNAVAILABLE: 502,
};

/** Maps every failure to a safe JSON error. Upstream MultiHopper `MH_*` codes are passed through. */
export function toErrorResponse(error: unknown, route: string): Response {
  if (error instanceof RequestError) return errorResponse(error.status, error.code, error.message, error.headers);
  if (error instanceof MultiHopperConfigError) {
    logRoutingEvent("error", "config_error", { route, reason: error.reason });
    return errorResponse(503, ROUTING_ERROR_CODES.notConfigured, "MultiHopper routing is not configured on this server.");
  }
  if (error instanceof RoutingContextError) {
    logRoutingEvent("warn", "context_rejected", { route, code: error.code });
    return errorResponse(CONTEXT_STATUS[error.code], error.code, error.message);
  }
  if (error instanceof MultiHopperApiError) {
    logRoutingEvent(error.status >= 500 ? "error" : "warn", "upstream_error", { route, status: error.status, code: error.code, upstreamRequestId: error.upstreamRequestId });
    // A rejected server key is not the user's credential problem: never surface it as 401/403.
    if (error.status === 401 || error.status === 403) {
      return errorResponse(503, error.code, "MultiHopper rejected this server's API key. Routing is unavailable until it is fixed.");
    }
    if (error.status === 429) {
      return errorResponse(429, error.code, "MultiHopper rate limit reached. Wait a moment and retry.", error.retryAfter ? { "Retry-After": error.retryAfter } : {});
    }
    const status = error.status >= 500 ? (error.status === 504 ? 504 : 502) : error.status;
    return errorResponse(status, error.code, error.message);
  }
  logRoutingEvent("error", "unexpected_error", { route, name: error instanceof Error ? error.name : typeof error });
  return errorResponse(500, ROUTING_ERROR_CODES.internal, "Unexpected server error.");
}
