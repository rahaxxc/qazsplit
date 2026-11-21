import "server-only";

import { MULTIHOPPER_DEVNET_API_BASE_URL, redactSecrets, type MultiHopperConfig } from "./config";

// Request/response shapes follow https://dev-docs.multihopper.com (OpenAPI 1.0.0):
// POST /transfers/estimate, POST /transfers, POST /transfers/{id}/prepare,
// POST /transfers/{id}/confirm-broadcast, GET /transfers/{id}, GET /transfers/by-external/{externalId}.

const ESTIMATE_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 15_000;
const PREPARE_TIMEOUT_MS = 25_000; // /prepare probes onchain state before building the bundle
const CONFIRM_TIMEOUT_MS = 25_000; // /confirm-broadcast verifies signatures onchain
const GET_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_TXS_PER_GROUP = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_TX_BASE64_CHARS = 5_600; // 4,096-byte transaction ceiling, base64 encoded
const DIGITS = /^\d+$/;

export class MultiHopperApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: string | null = null,
    readonly upstreamRequestId: string | null = null,
  ) {
    super(message);
    this.name = "MultiHopperApiError";
  }
}

export type MultiHopperTransfer = {
  id: number;
  externalId: string | null;
  supportBundleId: string | null;
  tokenMint: string | null;
  amountRaw: string | null;
  sourceOwner: string | null;
  recipientWallet: string | null;
  recipientReceivesRaw: string | null;
  status: string;
  phase: string | null;
  progress: { hopsCompleted: number; hopsTotal: number } | null;
  lastError: { code: string | null; message: string | null; at: string | null } | null;
  hops: number | null;
  arrivalSeconds: number | null;
  pricingTier: string | null;
  percentFeeBps: number | null;
  percentFeeRaw: string | null;
  totalFlatFeeLamports: number | null;
  isTest: boolean | null;
  quotedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  routeHops: { index: number; scheduledAt: string | null; executedAt: string | null; txSignature: string | null }[] | null;
  signatures: { routeInit: string[]; sessionInit: string[]; hops: string[] } | null;
  /** TransferExtended.recovery: SOL that can be rescued from a stuck transfer, or rent reclaimed after one completes. */
  recovery: { canRescue: boolean; rescuableLamports: number | null; canReclaimRent: boolean; reclaimableLamports: number | null } | null;
};

/** /rescue/prepare and /reclaim-rent/prepare: transactions that return SOL to sourceOwner. */
export type RecoveryTxBundle = {
  transactions: string[];
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  totalLamports: number | null;
};

export type PreparedTxBundle = {
  keeperFundingTx: string | null;
  routeInitTxs: string[];
  orchestratorInitTx: string | null;
  sessionInitTxs: string[];
  dispersionInitTxs: string[];
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  nothingToDo: boolean;
};

export type MultiHopperEstimate = {
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

export type EstimateRequest = { tokenMint: string; amountRaw: string; tokenDecimals: number; hops: number; arrivalSeconds: number };
export type CreateTransferRequest = EstimateRequest & {
  amountTokens: string; tokenSymbol: string; sourceOwner: string; recipientWallet: string; externalId: string;
};
export type ConfirmBroadcastRequest = {
  routeInitSignatures: string[];
  keeperFundingSignature?: string;
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  dispersionInitSignatures?: string[];
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const integer = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const rawAmount = (value: unknown): string | null => {
  if (typeof value === "string" && DIGITS.test(value)) return value;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : null;
};
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function invalid(detail: string): MultiHopperApiError {
  return new MultiHopperApiError(502, "UPSTREAM_INVALID_RESPONSE", `MultiHopper returned an unexpected response (${detail}).`);
}

export function parseTransfer(raw: unknown): MultiHopperTransfer {
  // The reference shows GET /transfers/{id} at the top level, while one guide example reads
  // `{ transfer }`. Accept both without guessing any other shape.
  const source = isObject(raw) && !("id" in raw) && isObject(raw.transfer) ? raw.transfer : raw;
  if (!isObject(source)) throw invalid("transfer is not an object");
  const id = integer(source.id);
  const status = text(source.status);
  if (id == null || id <= 0 || !status) throw invalid("transfer id or status missing");
  const progress = isObject(source.progress) && integer(source.progress.hopsCompleted) != null && integer(source.progress.hopsTotal) != null
    ? { hopsCompleted: source.progress.hopsCompleted as number, hopsTotal: source.progress.hopsTotal as number } : null;
  const lastError = isObject(source.lastError)
    ? { code: text(source.lastError.code), message: text(source.lastError.message), at: text(source.lastError.at) } : null;
  const route = isObject(source.route) && Array.isArray(source.route.hops)
    ? source.route.hops.filter(isObject).map((hop) => ({
      index: integer(hop.index) ?? 0, scheduledAt: text(hop.scheduledAt), executedAt: text(hop.executedAt), txSignature: text(hop.txSignature),
    })) : null;
  const signatures = isObject(source.signatures)
    ? { routeInit: textList(source.signatures.routeInit), sessionInit: textList(source.signatures.sessionInit), hops: textList(source.signatures.hops) } : null;
  const recovery = isObject(source.recovery)
    ? {
      canRescue: source.recovery.canRescue === true, rescuableLamports: integer(source.recovery.rescuableLamports),
      canReclaimRent: source.recovery.canReclaimRent === true, reclaimableLamports: integer(source.recovery.reclaimableLamports),
    } : null;
  return {
    id, status, externalId: text(source.externalId), supportBundleId: text(source.supportBundleId), tokenMint: text(source.tokenMint),
    amountRaw: rawAmount(source.amountRaw), sourceOwner: text(source.sourceOwner), recipientWallet: text(source.recipientWallet),
    recipientReceivesRaw: rawAmount(source.recipientReceivesRaw), phase: text(source.phase), progress, lastError,
    hops: integer(source.hops), arrivalSeconds: integer(source.arrivalSeconds), pricingTier: text(source.pricingTier),
    percentFeeBps: integer(source.percentFeeBps), percentFeeRaw: rawAmount(source.percentFeeRaw), totalFlatFeeLamports: integer(source.totalFlatFeeLamports),
    isTest: bool(source.isTest), quotedAt: text(source.quotedAt), expiresAt: text(source.expiresAt), createdAt: text(source.createdAt),
    completedAt: text(source.completedAt), routeHops: route, signatures, recovery,
  };
}

/** Parses /rescue/prepare (`rescueTxs`) or /reclaim-rent/prepare (`reclaimTxs`). */
export function parseRecoveryTxs(raw: unknown, field: "rescueTxs" | "reclaimTxs"): RecoveryTxBundle {
  if (!isObject(raw)) throw invalid(`${field} response is not an object`);
  const summary = isObject(raw.rescuable) ? raw.rescuable : isObject(raw.reclaimable) ? raw.reclaimable : {};
  return {
    transactions: transactionList(raw[field], field, true),
    recentBlockhash: text(raw.recentBlockhash),
    lastValidBlockHeight: integer(raw.lastValidBlockHeight),
    totalLamports: integer(summary.totalLamports),
  };
}

/** GET /transfers → items (TransferExtended) and pagination. */
export function parseTransferList(raw: unknown): { items: MultiHopperTransfer[]; total: number | null } {
  if (!isObject(raw) || !Array.isArray(raw.items)) throw invalid("transfer list is not an object with items");
  const items: MultiHopperTransfer[] = [];
  for (const item of raw.items) {
    try { items.push(parseTransfer(item)); } catch { /* skip malformed entries rather than failing recovery */ }
  }
  return { items, total: isObject(raw.pagination) ? integer(raw.pagination.total) : null };
}

function transaction(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > MAX_TX_BASE64_CHARS || !BASE64.test(value)) throw invalid(`${label} is not a base64 transaction`);
  return value;
}

function optionalTransaction(value: unknown, label: string): string | null {
  return value == null ? null : transaction(value, label);
}

function transactionList(value: unknown, label: string, wrapped: boolean): string[] {
  if (value == null) return []; // null/omitted groups are already confirmed onchain: skip them
  if (!Array.isArray(value) || value.length > MAX_TXS_PER_GROUP) throw invalid(`${label} is not a transaction list`);
  return value.map((entry, index) => {
    // routeInitTxs entries are documented as `{ base64 }`; the other groups are plain strings.
    const encoded = wrapped && isObject(entry) ? entry.base64 : entry;
    return transaction(encoded, `${label}[${index}]`);
  });
}

export function parsePreparedTxs(raw: unknown): PreparedTxBundle {
  if (!isObject(raw)) throw invalid("preparedTxs is not an object");
  const resume = isObject(raw.resume) ? raw.resume : null;
  return {
    keeperFundingTx: optionalTransaction(raw.keeperFundingTx, "keeperFundingTx"),
    routeInitTxs: transactionList(raw.routeInitTxs, "routeInitTxs", true),
    orchestratorInitTx: optionalTransaction(raw.orchestratorInitTx, "orchestratorInitTx"),
    sessionInitTxs: transactionList(raw.sessionInitTxs, "sessionInitTxs", false),
    dispersionInitTxs: transactionList(raw.dispersionInitTxs, "dispersionInitTxs", false),
    recentBlockhash: text(raw.recentBlockhash),
    lastValidBlockHeight: integer(raw.lastValidBlockHeight),
    nothingToDo: resume?.nothingToDo === true,
  };
}

export function parseEstimate(raw: unknown): MultiHopperEstimate {
  if (!isObject(raw)) throw invalid("estimate is not an object");
  const sol = isObject(raw.sol) ? raw.sol : {};
  const breakdown = isObject(sol.breakdown) ? sol.breakdown : {};
  const tokens = isObject(raw.tokens) ? raw.tokens : {};
  const hopAmountRaw = rawAmount(raw.hopAmountRaw) ?? rawAmount(tokens.netDeliveredRaw);
  if (!hopAmountRaw) throw invalid("hopAmountRaw missing");
  return {
    tier: text(raw.tier), percentFeeBps: integer(raw.percentFeeBps), percentFeeRaw: rawAmount(raw.percentFeeRaw),
    flatFeeLamportsPerHop: integer(raw.flatFeeLamportsPerHop), totalFlatFeeLamports: integer(raw.totalFlatFeeLamports), hopAmountRaw,
    usdEquivalent: finite(raw.usdEquivalent), priceSource: text(raw.priceSource), cappedAtTierBoundary: raw.cappedAtTierBoundary === true,
    isTestMode: bool(raw.isTestMode), requiredSolUpFrontLamports: integer(sol.requiredSolUpFrontLamports),
    minTransferAmountLamports: integer(sol.minTransferAmountLamports), refundableLamports: integer(sol.refundableLamports),
    netCostLamports: integer(sol.netCostLamports), screeningFeeLamports: integer(breakdown.screeningFeeLamports),
  };
}

type RequestOptions = { method: "GET" | "POST"; path: string; body?: unknown; idempotencyKey?: string; timeoutMs: number };

export type MultiHopperClient = ReturnType<typeof createMultiHopperClient>;

export function createMultiHopperClient(config: Pick<MultiHopperConfig, "apiKey">) {
  async function request(options: RequestOptions): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": config.apiKey,
      // Echoed back as error.requestId, so support can correlate a failure without any secret.
      "x-request-id": crypto.randomUUID(),
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`${MULTIHOPPER_DEVNET_API_BASE_URL}${options.path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        // Custom headers survive cross-origin redirects; never follow one with the API key attached.
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw timedOut
        ? new MultiHopperApiError(504, "UPSTREAM_TIMEOUT", "MultiHopper did not respond in time.")
        : new MultiHopperApiError(502, "UPSTREAM_UNAVAILABLE", "MultiHopper could not be reached.");
    }
    let bodyText = "";
    try { bodyText = await response.text(); } catch { /* handled as an empty body below */ }
    if (bodyText.length > MAX_RESPONSE_CHARS) throw invalid("response too large");
    let payload: unknown = null;
    if (bodyText) {
      try { payload = JSON.parse(bodyText); } catch { payload = null; }
    }
    if (!response.ok) {
      const envelope = isObject(payload) && isObject(payload.error) ? payload.error : null;
      const code = text(envelope?.code) ?? (response.status >= 500 ? "UPSTREAM_UNAVAILABLE" : `HTTP_${response.status}`);
      const message = redactSecrets((text(envelope?.message) ?? `MultiHopper request failed with HTTP ${response.status}.`).slice(0, 400), config.apiKey);
      throw new MultiHopperApiError(response.status, code, message, response.headers.get("retry-after"), text(envelope?.requestId));
    }
    if (payload === null) throw invalid("response was not JSON");
    return payload;
  }

  return {
    async estimate(body: EstimateRequest): Promise<MultiHopperEstimate> {
      // Estimate has no side effects; a fresh key satisfies the POST Idempotency-Key rule harmlessly.
      return parseEstimate(await request({ method: "POST", path: "/transfers/estimate", body, idempotencyKey: crypto.randomUUID(), timeoutMs: ESTIMATE_TIMEOUT_MS }));
    },
    async createTransfer(body: CreateTransferRequest, idempotencyKey: string): Promise<MultiHopperTransfer> {
      return parseTransfer(await request({ method: "POST", path: "/transfers", body, idempotencyKey, timeoutMs: CREATE_TIMEOUT_MS }));
    },
    async getTransfer(transferId: number): Promise<MultiHopperTransfer> {
      return parseTransfer(await request({ method: "GET", path: `/transfers/${transferId}`, timeoutMs: GET_TIMEOUT_MS }));
    },
    async getTransferByExternalId(externalId: string): Promise<MultiHopperTransfer> {
      return parseTransfer(await request({ method: "GET", path: `/transfers/by-external/${encodeURIComponent(externalId)}`, timeoutMs: GET_TIMEOUT_MS }));
    },
    async prepareTransfer(transferId: number, idempotencyKey: string): Promise<{ transfer: MultiHopperTransfer | null; preparedTxs: PreparedTxBundle }> {
      const payload = await request({ method: "POST", path: `/transfers/${transferId}/prepare`, idempotencyKey, timeoutMs: PREPARE_TIMEOUT_MS });
      if (!isObject(payload)) throw invalid("prepare response is not an object");
      return { transfer: isObject(payload.transfer) && "id" in payload.transfer ? parseTransfer(payload.transfer) : null, preparedTxs: parsePreparedTxs(payload.preparedTxs) };
    },
    async confirmBroadcast(transferId: number, body: ConfirmBroadcastRequest, idempotencyKey: string): Promise<MultiHopperTransfer | null> {
      const payload = await request({ method: "POST", path: `/transfers/${transferId}/confirm-broadcast`, body, idempotencyKey, timeoutMs: CONFIRM_TIMEOUT_MS });
      return isObject(payload) && isObject(payload.transfer) && "id" in payload.transfer ? parseTransfer(payload.transfer) : null;
    },
    async listTransfers(query: { limit: number; offset: number; fromDate?: string }): Promise<{ items: MultiHopperTransfer[]; total: number | null }> {
      const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
      if (query.fromDate) params.set("fromDate", query.fromDate);
      return parseTransferList(await request({ method: "GET", path: `/transfers?${params.toString()}`, timeoutMs: GET_TIMEOUT_MS }));
    },
    async prepareRecovery(transferId: number, kind: "rescue" | "reclaim-rent", idempotencyKey: string): Promise<RecoveryTxBundle> {
      const payload = await request({ method: "POST", path: `/transfers/${transferId}/${kind}/prepare`, idempotencyKey, timeoutMs: PREPARE_TIMEOUT_MS });
      return parseRecoveryTxs(payload, kind === "rescue" ? "rescueTxs" : "reclaimTxs");
    },
    async confirmRecovery(transferId: number, kind: "rescue" | "reclaim-rent", signatures: string[], idempotencyKey: string): Promise<{ transfer: MultiHopperTransfer | null; confirmed: string[] | null }> {
      const body = kind === "rescue" ? { rescueSignatures: signatures } : { reclaimSignatures: signatures };
      const payload = await request({ method: "POST", path: `/transfers/${transferId}/${kind}/confirm`, body, idempotencyKey, timeoutMs: CONFIRM_TIMEOUT_MS });
      const transfer = isObject(payload) && isObject(payload.transfer) && "id" in payload.transfer ? parseTransfer(payload.transfer) : null;
      return { transfer, confirmed: isObject(payload) && Array.isArray(payload.confirmed) ? textList(payload.confirmed) : null };
    },
  };
}
