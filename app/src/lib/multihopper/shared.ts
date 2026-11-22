// Shared by the browser UI and the server routes. Nothing in this file is secret.
// MultiHopper onward routing is optional and separate from QazSplit settlement:
// it never builds, signs or changes a pay_milestone transaction.
import { isAddress, isOffCurveAddress, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { MOCK_USDC_MINT, PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS } from "../constants";
import { formatTokenAmount, parseTokenAmount } from "../split-math";

export const MULTIHOPPER_CLUSTER = "devnet" as const;
/** Native SOL mint, as used by the MultiHopper API examples for SOL transfers. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
export const SOL_SYMBOL = "SOL";
/** Prototype safety cap. MultiHopper enforces its own minimum (MH_012). */
export const MAX_ROUTING_LAMPORTS = 100n * 1_000_000_000n;
export const MIN_HOPS = 3;
export const MAX_HOPS = 10;
export const DEFAULT_HOPS = 3;
export const MIN_ARRIVAL_SECONDS = 60;
/** The API allows up to 30 days; this prototype keeps routes within one day. */
export const MAX_ARRIVAL_SECONDS = 86_400;
export const ARRIVAL_PRESETS = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 21_600, label: "6 hours" },
  { seconds: 86_400, label: "24 hours" },
] as const;
export const DEFAULT_ARRIVAL_SECONDS = 300;
/** A signed routing approval is accepted for this long after it was issued. */
export const APPROVAL_MAX_AGE_SECONDS = 300;
export const APPROVAL_MAX_FUTURE_SKEW_SECONDS = 60;
export const EXTERNAL_ID_PREFIX = "qzs-";
export const TERMINAL_STATUSES = ["completed", "failed", "expired", "refunded"] as const;
export const AWAITING_SIGNATURE_STATUSES = ["quote", "awaiting_signature"] as const;

const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// Addresses that can technically receive lamports but are never a person's wallet.
const NON_WALLET_DESTINATIONS = new Set<string>([
  SYSTEM_PROGRAM_ADDRESS, SOL_MINT, PROGRAM_ADDRESS, MOCK_USDC_MINT, TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LAMPORTS = /^[1-9]\d{0,20}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type TransferStatus = "quote" | "awaiting_signature" | "processing" | "active" | "completed" | "failed" | "expired" | "refunded";

/** The routing parameters a recipient approves by signing {@link buildRoutingApprovalMessage}. */
export type RoutingRequest = {
  wallet: string;
  agreement: string;
  milestoneIndex: number;
  amountLamports: string;
  destination: string;
  hops: number;
  arrivalSeconds: number;
  requestId: string;
  issuedAt: string;
  /** The QazSplit site the recipient approved on, e.g. "https://qazsplit.example" (audit M5). */
  origin: string;
};

/** Proves control of a wallet to re-issue routing access on a new device (audit H3). Moves no funds. */
export type RecoveryRequest = { wallet: string; requestId: string; issuedAt: string; origin: string };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string; message: string };

/** Parses a user-entered SOL amount into lamports, or explains why it is invalid. */
export function parseSolAmount(value: string): ValidationResult<bigint> {
  const lamports = parseTokenAmount(value, SOL_DECIMALS);
  if (lamports == null) return { ok: false, field: "amount", message: "Enter a positive SOL amount with at most 9 decimals." };
  if (lamports > MAX_ROUTING_LAMPORTS) return { ok: false, field: "amount", message: "This devnet prototype routes at most 100 SOL per transfer." };
  return { ok: true, value: lamports };
}

export function formatSol(lamports: bigint | number | string): string {
  return formatTokenAmount(BigInt(lamports), SOL_DECIMALS);
}

/** Plain decimal (no thousands separators), as MultiHopper's `amountTokens` expects, e.g. "1.0". */
export function lamportsToTokenString(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(SOL_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fraction || "0"}`;
}

export function validateDestination(destination: string, sourceWallet?: string): ValidationResult<string> {
  const value = destination.trim();
  if (!isAddress(value)) return { ok: false, field: "destination", message: "Enter a valid Solana wallet address." };
  if (sourceWallet && value === sourceWallet) return { ok: false, field: "destination", message: "Choose a destination other than your connected wallet." };
  if (NON_WALLET_DESTINATIONS.has(value)) return { ok: false, field: "destination", message: "That address is a program or mint, not a wallet." };
  // Program-derived addresses have no private key, so nothing could ever sign for SOL sent there (audit M9).
  if (isOffCurveAddress(value as Address)) return { ok: false, field: "destination", message: "That address is program-derived (no private key can control it). Enter a regular wallet address." };
  return { ok: true, value };
}

/**
 * A site origin as a browser reports it: https, or http only for local development. Returns the
 * normalized origin or null.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== value) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
}

export function validateHops(hops: unknown): ValidationResult<number> {
  return Number.isInteger(hops) && (hops as number) >= MIN_HOPS && (hops as number) <= MAX_HOPS
    ? { ok: true, value: hops as number }
    : { ok: false, field: "hops", message: `Hops must be a whole number from ${MIN_HOPS} to ${MAX_HOPS}.` };
}

export function validateArrivalSeconds(seconds: unknown): ValidationResult<number> {
  return Number.isInteger(seconds) && (seconds as number) >= MIN_ARRIVAL_SECONDS && (seconds as number) <= MAX_ARRIVAL_SECONDS
    ? { ok: true, value: seconds as number }
    : { ok: false, field: "arrivalSeconds", message: "Arrival time must be between 1 minute and 24 hours." };
}

export function validateLamports(value: unknown): ValidationResult<bigint> {
  if (typeof value !== "string" || !LAMPORTS.test(value)) return { ok: false, field: "amountLamports", message: "Amount must be a positive whole number of lamports." };
  const lamports = BigInt(value);
  if (lamports > MAX_ROUTING_LAMPORTS) return { ok: false, field: "amountLamports", message: "This devnet prototype routes at most 100 SOL per transfer." };
  return { ok: true, value: lamports };
}

function fail(field: string, message: string): { ok: false; field: string; message: string } {
  return { ok: false, field, message };
}

/** Authoritative validation of an untrusted routing request body (server) or form state (client). */
export function validateRoutingRequest(input: unknown): ValidationResult<RoutingRequest> {
  if (!input || typeof input !== "object") return fail("body", "Request body must be a JSON object.");
  const body = input as Record<string, unknown>;
  if (typeof body.wallet !== "string" || !isAddress(body.wallet)) return fail("wallet", "Connected wallet address is invalid.");
  if (typeof body.agreement !== "string" || !isAddress(body.agreement)) return fail("agreement", "Agreement address is invalid.");
  if (!Number.isInteger(body.milestoneIndex) || (body.milestoneIndex as number) < 0 || (body.milestoneIndex as number) > 4) return fail("milestoneIndex", "Milestone index is invalid.");
  const lamports = validateLamports(body.amountLamports);
  if (!lamports.ok) return lamports;
  if (typeof body.destination !== "string") return fail("destination", "Enter a valid Solana wallet address.");
  const destination = validateDestination(body.destination, body.wallet);
  if (!destination.ok) return destination;
  if (destination.value !== body.destination) return fail("destination", "Destination must not contain surrounding spaces.");
  const hops = validateHops(body.hops);
  if (!hops.ok) return hops;
  const arrival = validateArrivalSeconds(body.arrivalSeconds);
  if (!arrival.ok) return arrival;
  if (typeof body.requestId !== "string" || !UUID_V4.test(body.requestId)) return fail("requestId", "Request ID must be a lowercase UUID v4.");
  if (typeof body.issuedAt !== "string" || !ISO_UTC.test(body.issuedAt) || Number.isNaN(Date.parse(body.issuedAt))) return fail("issuedAt", "Issued-at time must be an ISO 8601 UTC timestamp.");
  const origin = normalizeOrigin(body.origin);
  if (!origin) return fail("origin", "Site origin is missing or invalid.");
  return { ok: true, value: {
    wallet: body.wallet, agreement: body.agreement, milestoneIndex: body.milestoneIndex as number,
    amountLamports: body.amountLamports as string, destination: destination.value, hops: hops.value,
    arrivalSeconds: arrival.value, requestId: body.requestId, issuedAt: body.issuedAt, origin,
  } };
}

export function validateRecoveryRequest(input: unknown): ValidationResult<RecoveryRequest> {
  if (!input || typeof input !== "object") return fail("body", "Request body must be a JSON object.");
  const body = input as Record<string, unknown>;
  if (typeof body.wallet !== "string" || !isAddress(body.wallet)) return fail("wallet", "Connected wallet address is invalid.");
  if (typeof body.requestId !== "string" || !UUID_V4.test(body.requestId)) return fail("requestId", "Request ID must be a lowercase UUID v4.");
  if (typeof body.issuedAt !== "string" || !ISO_UTC.test(body.issuedAt) || Number.isNaN(Date.parse(body.issuedAt))) return fail("issuedAt", "Issued-at time must be an ISO 8601 UTC timestamp.");
  const origin = normalizeOrigin(body.origin);
  if (!origin) return fail("origin", "Site origin is missing or invalid.");
  return { ok: true, value: { wallet: body.wallet, requestId: body.requestId, issuedAt: body.issuedAt, origin } };
}

/** Text signed to recover routing access on a new device. It cannot create, prepare or move anything. */
export function buildRecoveryMessage(request: RecoveryRequest): string {
  return [
    `${new URL(request.origin).host} asks you to restore QazSplit routing access (Solana devnet)`,
    "",
    "I want to view and continue the MultiHopper onward routings I started from this wallet.",
    "This message moves no funds and cannot create or sign any transfer.",
    "",
    `Website: ${request.origin}`,
    `Wallet: ${request.wallet}`,
    `Request ID: ${request.requestId}`,
    `Issued at: ${request.issuedAt}`,
  ].join("\n");
}

/**
 * The exact text the recipient signs with `solana:signMessage`. The server rebuilds it from the
 * structured request and verifies the signature, so what is signed is what gets created.
 * Milestone names are deliberately excluded: they are free-form onchain text.
 */
export function buildRoutingApprovalMessage(request: RoutingRequest): string {
  return [
    // The site is named first so a recipient can spot a lookalike site asking for this approval;
    // the server refuses approvals signed for any other site (audit M5).
    `${new URL(request.origin).host} asks you to approve a QazSplit onward routing request (Solana devnet)`,
    "",
    "I request an optional MultiHopper transfer of SOL from my wallet.",
    "This message moves no funds. Nothing is sent until I sign the prepared transactions.",
    "My QazSplit milestone payout is already final and is not affected.",
    "",
    `Website: ${request.origin}`,
    `Wallet: ${request.wallet}`,
    `Agreement: ${request.agreement}`,
    `Milestone index: ${request.milestoneIndex}`,
    `Amount: ${formatSol(request.amountLamports)} SOL (${request.amountLamports} lamports)`,
    `Destination: ${request.destination}`,
    `Hops: ${request.hops}`,
    `Arrival target: ${request.arrivalSeconds} seconds`,
    `Request ID: ${request.requestId}`,
    `Issued at: ${request.issuedAt}`,
  ].join("\n");
}

export function externalIdForRequest(requestId: string): string {
  return `${EXTERNAL_ID_PREFIX}${requestId}`;
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isAwaitingSignature(status: string): boolean {
  return (AWAITING_SIGNATURE_STATUSES as readonly string[]).includes(status);
}

/** Error codes returned by the QazSplit routing API (MultiHopper `MH_*` codes are passed through). */
export const ROUTING_ERROR_CODES = {
  notConfigured: "MULTIHOPPER_NOT_CONFIGURED",
  invalidRequest: "INVALID_REQUEST",
  unsupportedMediaType: "UNSUPPORTED_MEDIA_TYPE",
  invalidSignature: "INVALID_SIGNATURE",
  approvalExpired: "APPROVAL_EXPIRED",
  unauthorized: "UNAUTHORIZED",
  notARecipient: "NOT_A_RECIPIENT",
  milestoneNotPaid: "MILESTONE_NOT_PAID",
  agreementNotFound: "AGREEMENT_NOT_FOUND",
  transferNotFound: "TRANSFER_NOT_FOUND",
  transferMismatch: "TRANSFER_MISMATCH",
  rpcUnavailable: "RPC_UNAVAILABLE",
  rateLimited: "RATE_LIMITED",
  originMismatch: "ORIGIN_MISMATCH",
  recoveryNotAvailable: "RECOVERY_NOT_AVAILABLE",
  upstreamTimeout: "UPSTREAM_TIMEOUT",
  upstreamUnavailable: "UPSTREAM_UNAVAILABLE",
  upstreamInvalidResponse: "UPSTREAM_INVALID_RESPONSE",
  internal: "INTERNAL_ERROR",
} as const;
