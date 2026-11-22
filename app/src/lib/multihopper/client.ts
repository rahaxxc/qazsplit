// Browser client for QazSplit's own /api/multihopper routes. The MultiHopper API key never
// reaches the browser: every MultiHopper call is made server-side.
import { RoutingBundleError } from "./errors";
import { isTerminalStatus, type RecoveryRequest, type RoutingRequest } from "./shared";
import { BundleExecutionError, type ConfirmBroadcastBody, type PreparedTxs } from "./transactions";

export type RoutingEstimate = {
  tier: string | null;
  percentFeeBps: number | null;
  percentFeeRaw: string | null;
  flatFeeLamportsPerHop: number | null;
  totalFlatFeeLamports: number | null;
  hopAmountRaw: string;
  usdEquivalent: number | null;
  priceSource: string | null;
  cappedAtTierBoundary: boolean;
  isTestMode: boolean | null;
  requiredSolUpFrontLamports: number | null;
  minTransferAmountLamports: number | null;
  refundableLamports: number | null;
  netCostLamports: number | null;
  screeningFeeLamports: number | null;
};

export type RoutingTransfer = {
  id: number;
  externalId: string | null;
  supportBundleId: string | null;
  status: string;
  phase: string | null;
  progress: { hopsCompleted: number; hopsTotal: number } | null;
  lastError: { code: string | null; message: string | null; at: string | null } | null;
  amountLamports: string | null;
  recipientWallet: string | null;
  recipientReceivesLamports: string | null;
  hops: number | null;
  arrivalSeconds: number | null;
  pricingTier: string | null;
  percentFeeBps: number | null;
  percentFeeLamports: string | null;
  totalFlatFeeLamports: number | null;
  isTest: boolean | null;
  quotedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  hopSignatures: string[];
  routeInitSignatures?: string[];
  sessionInitSignatures?: string[];
  route: { index: number; scheduledAt: string | null; executedAt: string | null; txSignature: string | null }[] | null;
  recovery?: { canRescue: boolean; rescuableLamports: number | null; canReclaimRent: boolean; reclaimableLamports: number | null } | null;
};

export type RecoveryTxs = { transactions: string[]; recentBlockhash: string | null; lastValidBlockHeight: number | null; totalLamports: number | null };

export class RoutingApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "RoutingApiError";
  }
}

const API_BASE = "/api/multihopper";
const REQUEST_TIMEOUT_MS = 45_000;
// Older browsers lack AbortSignal.timeout; they fall back to the platform's own fetch timeout.
const timeoutSignal = (ms: number) => (typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

async function call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown; token?: string }): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method, headers, cache: "no-store", signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new RoutingApiError(0, "NETWORK_ERROR", "Could not reach the QazSplit server. Check your connection and retry.");
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  if (!response.ok) {
    const code = typeof payload?.error?.code === "string" ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload?.error?.message === "string" ? payload.error.message : "Routing request failed.";
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RoutingApiError(response.status, code, message, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3_600) : null);
  }
  if (!payload) throw new RoutingApiError(response.status, "INVALID_RESPONSE", "The QazSplit server returned an unexpected response.");
  return payload as T;
}

export const routingApi = {
  estimate: (input: { amountLamports: string; hops: number; arrivalSeconds: number }) =>
    call<{ estimate: RoutingEstimate }>("/estimate", { method: "POST", body: input }),
  create: (input: RoutingRequest & { signature: string }) =>
    call<{ transfer: RoutingTransfer; accessToken: string; reused: boolean }>("/transfers", { method: "POST", body: input }),
  status: (transferId: number, token: string) =>
    call<{ transfer: RoutingTransfer }>(`/transfers/${transferId}`, { method: "GET", token }),
  prepare: (transferId: number, token: string) =>
    call<{ transfer: RoutingTransfer | null; preparedTxs: PreparedTxs }>(`/transfers/${transferId}/prepare`, { method: "POST", token }),
  confirmBroadcast: (transferId: number, token: string, body: ConfirmBroadcastBody) =>
    call<{ transfer: RoutingTransfer | null }>(`/transfers/${transferId}/confirm-broadcast`, { method: "POST", token, body }),
  recoverAccess: (input: RecoveryRequest & { signature: string }) =>
    call<{ routings: { transfer: RoutingTransfer; accessToken: string }[] }>("/transfers/recover", { method: "POST", body: input }),
  prepareRecovery: (transferId: number, token: string, kind: "rescue" | "reclaim-rent") =>
    call<{ transfer: RoutingTransfer; recoveryTxs: RecoveryTxs }>(`/transfers/${transferId}/recovery`, { method: "POST", token, body: { kind, step: "prepare" } }),
  confirmRecovery: (transferId: number, token: string, kind: "rescue" | "reclaim-rent", signatures: string[]) =>
    call<{ transfer: RoutingTransfer; confirmed: string[] | null }>(`/transfers/${transferId}/recovery`, { method: "POST", token, body: { kind, step: "confirm", signatures } }),
};

/** A routing this browser created. The access token only reads/drives this one transfer. */
export type StoredRouting = {
  transferId: number;
  accessToken: string;
  agreement: string;
  milestoneIndex: number;
  destination: string;
  amountLamports: string;
  createdAt: string;
  /** What the fee preview quoted for the destination, compared with what MultiHopper locked at create (audit M2). */
  previewReceivesLamports?: string | null;
  /** Set when access was restored from MultiHopper: the agreement is not known then. */
  restored?: boolean;
  /** Last terminal status, so finished routings are not re-fetched on every page load (audit M4). */
  final?: RoutingTransfer | null;
};

const MAX_STORED = 20;
const storageKey = (wallet: string) => `qazsplit:multihopper:v1:${wallet}`;

function isStoredRouting(value: unknown): value is StoredRouting {
  const entry = value as StoredRouting;
  return !!entry && Number.isSafeInteger(entry.transferId) && typeof entry.accessToken === "string" && typeof entry.agreement === "string"
    && Number.isInteger(entry.milestoneIndex) && typeof entry.destination === "string" && typeof entry.amountLamports === "string"
    && typeof entry.createdAt === "string";
}

// Per-device convenience only: transfer state lives with MultiHopper and onchain, never here.
export function loadStoredRoutings(wallet: string): StoredRouting[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(wallet)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isStoredRouting) : [];
  } catch { return []; }
}

export function saveStoredRouting(wallet: string, entry: StoredRouting): StoredRouting[] {
  const next = [entry, ...loadStoredRoutings(wallet).filter((item) => item.transferId !== entry.transferId)].slice(0, MAX_STORED);
  try { window.localStorage.setItem(storageKey(wallet), JSON.stringify(next)); } catch { /* storage unavailable: keep in memory only */ }
  return next;
}

/** Remembers a terminal status for this routing; non-terminal statuses are never cached. */
export function saveFinalStatus(wallet: string, transfer: RoutingTransfer): void {
  if (!isTerminalStatus(transfer.status)) return;
  const entry = loadStoredRoutings(wallet).find((item) => item.transferId === transfer.id);
  if (entry && entry.final?.status !== transfer.status) saveStoredRouting(wallet, { ...entry, final: transfer });
}

/** Adds routings restored from MultiHopper without overwriting what this device already knows. */
export function mergeRestoredRoutings(wallet: string, restored: readonly StoredRouting[]): StoredRouting[] {
  let next = loadStoredRoutings(wallet);
  for (const entry of restored) {
    const known = next.find((item) => item.transferId === entry.transferId);
    next = known
      ? next.map((item) => (item.transferId === entry.transferId ? { ...item, accessToken: entry.accessToken } : item))
      : [...next, entry];
  }
  next = next.slice(0, MAX_STORED);
  try { window.localStorage.setItem(storageKey(wallet), JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

export function removeStoredRouting(wallet: string, transferId: number): StoredRouting[] {
  const next = loadStoredRoutings(wallet).filter((item) => item.transferId !== transferId);
  try { window.localStorage.setItem(storageKey(wallet), JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

/**
 * Runs `task` while holding a cross-tab lock for one transfer, so two tabs can never prepare
 * and broadcast the same bundle concurrently (which could fund the keeper twice). Browsers
 * without the Web Locks API fall back to the in-page busy guard.
 */
export async function withRoutingLock<T>(transferId: number, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return task();
  return locks.request(`qazsplit-multihopper-${transferId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new RoutingBundleError("ROUTING_IN_PROGRESS", "This routing is already being signed in another tab or window. Finish it there.");
    return task();
  }) as Promise<T>;
}

export type DescribedRoutingError = {
  message: string;
  code: string | null;
  /** Safe to retry through a fresh /prepare, which skips groups already onchain. */
  resumable: boolean;
  /** The quote can no longer be used; the recipient must create a new transfer. */
  requiresNewQuote: boolean;
};

const API_HINTS: Record<string, Omit<DescribedRoutingError, "code">> = {
  MULTIHOPPER_NOT_CONFIGURED: { message: "Onward routing is not configured on this deployment (the server has no MultiHopper devnet API key).", resumable: false, requiresNewQuote: false },
  UNAUTHORIZED: { message: "Routing access for this transfer expired on this device. Your QazSplit payout is unaffected.", resumable: false, requiresNewQuote: false },
  MH_004: { message: "MultiHopper rate limit reached. Wait a minute and retry.", resumable: true, requiresNewQuote: false },
  MH_012: { message: "The amount is below MultiHopper's minimum for SOL transfers.", resumable: false, requiresNewQuote: false },
  MH_014: { message: "That arrival time is too short for the number of hops. Choose a longer arrival time.", resumable: false, requiresNewQuote: false },
  MH_016: { message: "The amount does not cover MultiHopper's fees. Route a larger amount.", resumable: false, requiresNewQuote: false },
  MH_034: { message: "This quote expired before it was funded. Create a new routing.", resumable: false, requiresNewQuote: true },
  MH_035: { message: "This transfer cannot be prepared in its current state. Refresh its status.", resumable: false, requiresNewQuote: false },
  MH_036: { message: "MultiHopper could not see a broadcast transaction onchain yet. Wait a few seconds, then resume.", resumable: true, requiresNewQuote: false },
  MH_037: { message: "A routing transaction failed onchain. Resume to rebuild only what is still missing.", resumable: true, requiresNewQuote: false },
  MH_038: { message: "A reported transaction did not invoke MultiHopper. Resume to rebuild the remaining transactions.", resumable: true, requiresNewQuote: false },
  MH_039: { message: "MultiHopper needs the keeper funding signature. Resume to continue.", resumable: true, requiresNewQuote: false },
  MH_040: { message: "MultiHopper's fee tier moved since this quote. Create a new routing to get a fresh quote.", resumable: false, requiresNewQuote: true },
  MH_041: { message: "The payout binding is not onchain yet. Resume to broadcast what is still missing.", resumable: true, requiresNewQuote: false },
  MH_091: { message: "MultiHopper is temporarily unavailable (MH_091). If this persists, the integration's rewards wallet may need its rent-exempt minimum on devnet.", resumable: true, requiresNewQuote: false },
  RATE_LIMITED: { message: "Too many routing requests right now. Wait a moment and retry.", resumable: true, requiresNewQuote: false },
  ORIGIN_MISMATCH: { message: "This approval was signed for a different site. Approve the request again on this QazSplit site.", resumable: false, requiresNewQuote: false },
};
// Resume is always safe to offer for these: it reconciles any earlier keeper funding before /prepare,
// and the UI hides it while a keeper-funding record is unresolved. KEEPER_* codes are never resumable,
// and neither are integrity or outflow-limit failures: those mean the bundle itself looked wrong.
const RESUMABLE_BUNDLE_CODES = new Set([
  "BLOCKHASH_EXPIRED", "BROADCAST_REJECTED", "TRANSACTION_FAILED", "OUTCOME_UNKNOWN", "INCOMPLETE_SIGNATURES",
  "SIMULATION_REJECTED", "VALIDATION_UNAVAILABLE", "WALLET_TIMEOUT", "WALLET_ACCOUNT_CHANGED", "INSUFFICIENT_SOL", "ACTIVATION_PENDING",
]);

export function describeRoutingError(error: unknown): DescribedRoutingError {
  const reason = error instanceof BundleExecutionError ? error.reason : error;
  const stage = error instanceof BundleExecutionError ? `${error.stage}: ` : "";
  if (reason instanceof RoutingApiError) {
    const hint = API_HINTS[reason.code];
    const resumable = hint?.resumable ?? (reason.status === 0 || reason.status >= 500 || reason.status === 429);
    const wait = reason.status === 429 && reason.retryAfterSeconds ? ` Retry in about ${reason.retryAfterSeconds} s.` : "";
    return { message: `${stage}${hint?.message ?? reason.message}${wait}`, code: reason.code, resumable, requiresNewQuote: hint?.requiresNewQuote ?? false };
  }
  if (reason instanceof RoutingBundleError) {
    return { message: `${stage}${reason.message}`, code: reason.code, resumable: RESUMABLE_BUNDLE_CODES.has(reason.code), requiresNewQuote: false };
  }
  let cause = reason;
  for (let i = 0; i < 5 && cause instanceof Error && cause.cause instanceof Error; i++) cause = cause.cause;
  const text = cause instanceof Error ? cause.message : "Routing failed. Try again.";
  if (/reject|declin|cancel/i.test(text)) return { message: "Signature request was cancelled. Nothing was sent.", code: "WALLET_REJECTED", resumable: true, requiresNewQuote: false };
  return { message: `${stage}${text}`, code: null, resumable: !!stage, requiresNewQuote: false };
}
