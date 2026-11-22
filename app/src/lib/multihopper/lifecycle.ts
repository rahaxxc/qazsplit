// What happens after the bundle is broadcast: making sure MultiHopper actually activated the transfer
// (audit H1), remembering what this device already broadcast and spent, and verifying SOL delivery
// on devnet independently of MultiHopper's status.
import { address, type Address, type Signature } from "@solana/kit";

import { RoutingApiError, type RoutingTransfer } from "./client";
import { MULTIHOPPER_PROGRAM_IDS } from "./inspection";
import { isAwaitingSignature } from "./shared";
import type { BundleGroup, ConfirmBroadcastBody, PreparedTxs } from "./transactions";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Per-transfer journals (this device only; MultiHopper and the chain stay the source of truth)
// ---------------------------------------------------------------------------------------------

const broadcastKey = (transferId: number) => `qazsplit:multihopper:v1:broadcast:${transferId}`;
const outflowKey = (transferId: number) => `qazsplit:multihopper:v1:outflow:${transferId}`;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

const isSignatureList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Signatures of bundle transactions this device saw land, merged across attempts. */
export function readBroadcastSignatures(transferId: number): ConfirmBroadcastBody | null {
  try {
    const raw = storage()?.getItem(broadcastKey(transferId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConfirmBroadcastBody>;
    if (!isSignatureList(parsed.routeInitSignatures)) return null;
    const body: ConfirmBroadcastBody = { routeInitSignatures: parsed.routeInitSignatures };
    if (typeof parsed.keeperFundingSignature === "string") body.keeperFundingSignature = parsed.keeperFundingSignature;
    if (typeof parsed.orchestratorInitSignature === "string") body.orchestratorInitSignature = parsed.orchestratorInitSignature;
    if (isSignatureList(parsed.sessionInitSignatures) && parsed.sessionInitSignatures.length) body.sessionInitSignatures = parsed.sessionInitSignatures;
    if (isSignatureList(parsed.dispersionInitSignatures) && parsed.dispersionInitSignatures.length) body.dispersionInitSignatures = parsed.dispersionInitSignatures;
    return body;
  } catch { return null; }
}

const union = (a: readonly string[] | undefined, b: readonly string[] | undefined) => [...new Set([...(a ?? []), ...(b ?? [])])];

/** Merges an attempt's landed signatures into what earlier attempts recorded (a resume only sends what is missing). */
export function mergeBroadcastSignatures(earlier: ConfirmBroadcastBody | null, next: ConfirmBroadcastBody): ConfirmBroadcastBody {
  const merged: ConfirmBroadcastBody = { routeInitSignatures: union(earlier?.routeInitSignatures, next.routeInitSignatures) };
  const keeper = next.keeperFundingSignature ?? earlier?.keeperFundingSignature;
  const orchestrator = next.orchestratorInitSignature ?? earlier?.orchestratorInitSignature;
  const session = union(earlier?.sessionInitSignatures, next.sessionInitSignatures);
  const dispersion = union(earlier?.dispersionInitSignatures, next.dispersionInitSignatures);
  if (keeper) merged.keeperFundingSignature = keeper;
  if (orchestrator) merged.orchestratorInitSignature = orchestrator;
  if (session.length) merged.sessionInitSignatures = session;
  if (dispersion.length) merged.dispersionInitSignatures = dispersion;
  return merged;
}

/** The confirm-broadcast field a landed transaction of `group` is reported in. */
export function signatureEntry(group: BundleGroup, signature: string): ConfirmBroadcastBody | null {
  switch (group) {
    case "keeperFunding": return { routeInitSignatures: [], keeperFundingSignature: signature };
    case "routeInit": return { routeInitSignatures: [signature] };
    case "orchestratorInit": return { routeInitSignatures: [], orchestratorInitSignature: signature };
    case "sessionInit": return { routeInitSignatures: [], sessionInitSignatures: [signature] };
    case "dispersionInit": return { routeInitSignatures: [], dispersionInitSignatures: [signature] };
    default: return null; // rescue / reclaim-rent signatures are confirmed through their own endpoints
  }
}

export function saveBroadcastSignatures(transferId: number, body: ConfirmBroadcastBody): ConfirmBroadcastBody {
  const merged = mergeBroadcastSignatures(readBroadcastSignatures(transferId), body);
  try { storage()?.setItem(broadcastKey(transferId), JSON.stringify(merged)); } catch { /* best effort: also recoverable from /prepare */ }
  return merged;
}

/** Lamports this device has already seen leave the wallet for this transfer (simulated outflow of landed transactions). */
export function readSpentLamports(transferId: number): bigint {
  try {
    const raw = storage()?.getItem(outflowKey(transferId));
    return raw && /^\d{1,20}$/.test(raw) ? BigInt(raw) : 0n;
  } catch { return 0n; }
}

export function addSpentLamports(transferId: number, lamports: bigint): void {
  if (lamports <= 0n) return;
  try { storage()?.setItem(outflowKey(transferId), (readSpentLamports(transferId) + lamports).toString()); } catch { /* best effort */ }
}

export function clearLifecycleJournals(transferId: number): void {
  try { storage()?.removeItem(broadcastKey(transferId)); storage()?.removeItem(outflowKey(transferId)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// Spending limits (audit M1/M3)
// ---------------------------------------------------------------------------------------------

/** Network base fee per signature on Solana. */
const BASE_FEE_LAMPORTS = 5_000n;

/**
 * Most SOL QazSplit lets a bundle take from the wallet, minus what earlier attempts already spent.
 * MultiHopper's docs disagree on whether `requiredSolUpFrontLamports` includes the routed amount
 * (the OpenAPI calls it the total; the compliance guide says the wallet must hold it "plus the
 * transfer amount"), so the bound is the documented worst case: up-front amount + routed amount,
 * plus 1% (at least 0.005 SOL) for rent and pricing drift, plus network and capped priority fees per
 * transaction. The simulation guard stops the bundle before any transaction that would exceed it.
 * Tighten this once a real devnet bundle has shown which reading is right.
 */
export function outflowLimitLamports(input: {
  requiredSolUpFrontLamports: number; amountLamports: bigint; transactionCount: number; alreadySpentLamports: bigint; priorityFeeCapLamports: bigint;
}): bigint {
  const required = BigInt(input.requiredSolUpFrontLamports) + input.amountLamports;
  const margin = required / 100n > 5_000_000n ? required / 100n : 5_000_000n;
  const fees = BigInt(input.transactionCount) * (BASE_FEE_LAMPORTS * 4n + input.priorityFeeCapLamports);
  const limit = required + margin + fees - input.alreadySpentLamports;
  return limit > 0n ? limit : 0n;
}

/** SOL the wallet must hold before signing: the quoted up-front amount still unspent, plus fees. Fails closed on unknowns. */
export function requiredBalanceLamports(input: { requiredSolUpFrontLamports: number | null; transactionCount: number; alreadySpentLamports: bigint }): bigint | null {
  if (input.requiredSolUpFrontLamports == null) return null;
  const remaining = BigInt(input.requiredSolUpFrontLamports) - input.alreadySpentLamports;
  return (remaining > 0n ? remaining : 0n) + BigInt(Math.max(1, input.transactionCount)) * BASE_FEE_LAMPORTS * 4n;
}

// ---------------------------------------------------------------------------------------------
// Activation after the final confirm-broadcast (audit H1)
// ---------------------------------------------------------------------------------------------

export type ActivationOutcome =
  /** MultiHopper moved the transfer past the pre-broadcast state. */
  | { state: "activated"; transfer: RoutingTransfer }
  /** /prepare still lists transactions that are not on chain: they must be signed again (Resume). */
  | { state: "needs-resume"; transfer: RoutingTransfer | null }
  /** Everything is on chain but MultiHopper has not advanced the transfer yet. Nothing more to sign. */
  | { state: "pending"; transfer: RoutingTransfer | null };

export type ActivationDeps = {
  status: () => Promise<RoutingTransfer>;
  prepare: () => Promise<{ transfer: RoutingTransfer | null; preparedTxs: PreparedTxs }>;
  confirm: (body: ConfirmBroadcastBody) => Promise<RoutingTransfer | null>;
  /** Everything known to have landed (this attempt merged with earlier ones). */
  signatures: ConfirmBroadcastBody;
  /** Waits before re-reading status; MultiHopper verifies on its own RPC, which can lag devnet. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export const activationTiming: { delaysMs: readonly number[] } = { delaysMs: [3_000, 5_000, 8_000] };

const advanced = (transfer: RoutingTransfer | null | undefined): transfer is RoutingTransfer => !!transfer && !isAwaitingSignature(transfer.status);

function withChainSignatures(body: ConfirmBroadcastBody, transfer: RoutingTransfer | null): ConfirmBroadcastBody {
  return transfer ? mergeBroadcastSignatures(body, { routeInitSignatures: transfer.routeInitSignatures ?? [], sessionInitSignatures: transfer.sessionInitSignatures ?? [] }) : body;
}

/**
 * The docs warn that a final confirm-broadcast MultiHopper cannot verify yet leaves the transfer in
 * its pre-broadcast state "with no error". So the returned status is checked; if it did not advance,
 * status is re-read a few times, then /prepare (no signing) shows whether anything is still missing.
 * Only when nothing is missing is the same confirmation sent once more. Nothing is signed or sent
 * to Solana here, and a still-awaiting transfer is never reported as active.
 */
export async function ensureActivated(confirmed: RoutingTransfer | null, deps: ActivationDeps): Promise<ActivationOutcome> {
  if (advanced(confirmed)) return { state: "activated", transfer: confirmed };
  const sleep = deps.sleep ?? defaultSleep;
  const delays = deps.delaysMs ?? activationTiming.delaysMs;
  let latest: RoutingTransfer | null = confirmed;
  /** Re-reads status after each delay; returns the transfer once it advanced. */
  const poll = async (): Promise<RoutingTransfer | null> => {
    for (const delay of delays) {
      await sleep(delay);
      let next: RoutingTransfer;
      try { next = await deps.status(); } catch { continue; }
      latest = next;
      if (advanced(next)) return next;
    }
    return null;
  };
  const first = await poll();
  if (first) return { state: "activated", transfer: first };
  let prepared: Awaited<ReturnType<ActivationDeps["prepare"]>>;
  try { prepared = await deps.prepare(); } catch { return { state: "pending", transfer: latest }; }
  if (advanced(prepared.transfer)) return { state: "activated", transfer: prepared.transfer };
  if (!prepared.preparedTxs.nothingToDo) return { state: "needs-resume", transfer: prepared.transfer ?? latest };
  try {
    const reconfirmed = await deps.confirm(withChainSignatures(deps.signatures, prepared.transfer ?? latest));
    if (advanced(reconfirmed)) return { state: "activated", transfer: reconfirmed };
  } catch (error) {
    if (!(error instanceof RoutingApiError)) throw error;
  }
  const second = await poll();
  if (second) return { state: "activated", transfer: second };
  return { state: "pending", transfer: latest };
}

// ---------------------------------------------------------------------------------------------
// Independent delivery verification
// ---------------------------------------------------------------------------------------------

type TransactionMeta = {
  blockTime?: bigint | number | null;
  meta: { err: unknown; preBalances: readonly (bigint | number)[]; postBalances: readonly (bigint | number)[]; loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } } | null;
  transaction: { message: { accountKeys: readonly (string | { pubkey: string })[] } };
} | null;

export type DeliveryRpc = {
  getSignaturesForAddress: (address: Address, config: { limit: number; commitment: "confirmed" | "finalized" }) => { send: () => Promise<readonly { signature: string; err: unknown; blockTime?: bigint | number | null }[]> };
  getTransaction: (signature: Signature, config: never) => { send: () => Promise<TransactionMeta> };
};

export type DeliveryCredit = { signature: string; lamports: bigint; blockTime: number | null };

export type DeliveryResult =
  /** Devnet shows MultiHopper transactions crediting the destination with at least the quoted amount. */
  | { state: "verified"; deliveredLamports: bigint; credits: DeliveryCredit[] }
  /** Some SOL from MultiHopper transactions reached the destination, but less than quoted. */
  | { state: "partial"; deliveredLamports: bigint; credits: DeliveryCredit[] }
  | { state: "not-found"; deliveredLamports: 0n; credits: [] }
  | { state: "unavailable"; reason: string };

const keyOf = (key: string | { pubkey: string }) => (typeof key === "string" ? key : key.pubkey);

/** The destination's balance change in one MultiHopper transaction, or null if it isn't one. */
export function destinationCredit(transaction: TransactionMeta, destination: string): bigint | null {
  if (!transaction?.meta || transaction.meta.err) return null;
  const keys = [
    ...transaction.transaction.message.accountKeys.map(keyOf),
    ...(transaction.meta.loadedAddresses?.writable ?? []),
    ...(transaction.meta.loadedAddresses?.readonly ?? []),
  ];
  if (!keys.some((key) => MULTIHOPPER_PROGRAM_IDS.includes(key))) return null;
  const index = keys.indexOf(destination);
  if (index < 0 || index >= transaction.meta.preBalances.length) return null;
  const delta = BigInt(transaction.meta.postBalances[index]) - BigInt(transaction.meta.preBalances[index]);
  return delta > 0n ? delta : null;
}

/**
 * Reads the destination's devnet history directly (not MultiHopper's API) and sums SOL credited to
 * it by successful transactions that invoke a MultiHopper program after the transfer was created.
 * The hop signatures MultiHopper reports are checked too, in case they fall outside the history page.
 */
export async function verifyDelivery(input: {
  rpc: DeliveryRpc;
  destination: string;
  expectedLamports: string | null;
  createdAt: string | null;
  reportedSignatures: readonly string[];
  historyLimit?: number;
}): Promise<DeliveryResult> {
  const since = input.createdAt ? Math.floor(Date.parse(input.createdAt) / 1000) - 120 : null;
  let candidates: string[];
  try {
    const history = await input.rpc.getSignaturesForAddress(address(input.destination), { limit: input.historyLimit ?? 50, commitment: "confirmed" }).send();
    candidates = [...new Set([
      ...input.reportedSignatures,
      ...history.filter((entry) => !entry.err && (since == null || entry.blockTime == null || Number(entry.blockTime) >= since)).map((entry) => entry.signature),
    ])];
  } catch {
    return { state: "unavailable", reason: "Devnet RPC did not return the destination's transaction history." };
  }
  const credits: DeliveryCredit[] = [];
  for (const signature of candidates) {
    let transaction: TransactionMeta;
    try {
      transaction = await input.rpc.getTransaction(signature as Signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 } as never).send();
    } catch {
      return { state: "unavailable", reason: "Devnet RPC did not return one of the delivery transactions." };
    }
    const blockTime = transaction?.blockTime == null ? null : Number(transaction.blockTime);
    if (since != null && blockTime != null && blockTime < since) continue;
    const lamports = destinationCredit(transaction, input.destination);
    if (lamports) credits.push({ signature, lamports, blockTime });
  }
  const deliveredLamports = credits.reduce((sum, credit) => sum + credit.lamports, 0n);
  if (!deliveredLamports) return { state: "not-found", deliveredLamports: 0n, credits: [] };
  const expected = input.expectedLamports && /^\d+$/.test(input.expectedLamports) ? BigInt(input.expectedLamports) : null;
  return expected != null && deliveredLamports >= expected
    ? { state: "verified", deliveredLamports, credits }
    : { state: "partial", deliveredLamports, credits };
}
