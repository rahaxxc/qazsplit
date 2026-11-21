// Duplicate keeper-funding protection (audit C2).
//
// MultiHopper's /prepare only skips keeper funding that has *landed* on chain. A keeper-funding
// transaction that is still in flight, or one MultiHopper's RPC has not indexed yet (MH_036), would
// make /prepare emit a second keeperFundingTx, and both could land. This module keeps a per-transfer
// record of the keeper-funding transaction on this device (shared by tabs, surviving reloads) and
// reconciles it before any new bundle is prepared. It never builds, signs or re-sends a transaction.
import { getCompiledTransactionMessageDecoder, getSignatureFromTransaction, type Signature, type Transaction } from "@solana/kit";

import { RoutingApiError } from "./client";
import {
  RoutingBundleError, classifySignatureStatus, observeSignature,
  type BroadcastRpc, type BundleStep, type ChainObservation, type ConfirmBroadcastBody, type PreparedTxs,
} from "./transactions";

/**
 * sending   written before the first byte is sent; the outcome is not established yet
 * rejected  definitive preflight rejection: this RPC never forwarded it
 * landed    confirmed on devnet; MultiHopper has not acknowledged it yet
 * recorded  confirm-broadcast #1 succeeded: MultiHopper knows the keeper is funded
 */
export type KeeperFundingState = "sending" | "rejected" | "landed" | "recorded";

export type KeeperFundingRecord = {
  v: 1;
  transferId: number;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  state: KeeperFundingState;
  updatedAt: string;
};

export type KeeperFundingRead = { status: "none" } | { status: "record"; record: KeeperFundingRecord } | { status: "unreadable" };

export type KeeperReconciliation =
  | { outcome: "clear" }
  | { outcome: "recorded"; signature: string }
  | { outcome: "pending"; signature: string; reason: "in-flight" | "unrecorded"; message: string }
  | { outcome: "unknown"; signature: string | null; message: string };

export type KeeperFundingNotice = { kind: "needs-check" | "pending" | "unknown"; signature: string | null; message: string };

/** Retry delays for confirm-broadcast #1 while MultiHopper cannot see a landed keeper funding (MH_036). */
export const keeperFundingTiming: { confirmRetryDelaysMs: readonly number[] } = { confirmRetryDelaysMs: [2_000, 4_000, 8_000] };

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const ADVANCE_NONCE_ACCOUNT = [4, 0, 0, 0]; // SystemInstruction::AdvanceNonceAccount, u32 little-endian
const STATES: readonly string[] = ["sending", "rejected", "landed", "recorded"];
const storageKey = (transferId: number) => `qazsplit:multihopper:v1:keeper-funding:${transferId}`;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MESSAGES = {
  inFlight: "Your earlier keeper-funding transaction may still land. QazSplit won't prepare another one until it confirms or its blockhash expires (usually within two minutes). Check again shortly.",
  unrecorded: (code: string | null) => `Your keeper funding is confirmed on devnet, but MultiHopper hasn't recorded it yet${code ? ` (${code})` : ""}. QazSplit won't request a second one. Check again in a few seconds.`,
  unknown: "QazSplit couldn't determine whether your earlier keeper-funding transaction landed (devnet RPC unavailable or behind). Nothing new will be prepared until it can. Check again shortly.",
  unreadable: "The keeper-funding record saved on this device can't be read, so QazSplit can't rule out a pending keeper funding. Nothing new will be prepared for this routing.",
  needsCheck: "A keeper-funding transaction from an earlier attempt hasn't been reconciled yet. QazSplit checks whether it landed before preparing anything new.",
};

function isRecord(value: unknown, transferId: number): value is KeeperFundingRecord {
  const record = value as KeeperFundingRecord;
  return !!record && record.v === 1 && record.transferId === transferId && typeof record.signature === "string" && typeof record.blockhash === "string"
    && Number.isSafeInteger(record.lastValidBlockHeight) && STATES.includes(record.state) && typeof record.updatedAt === "string";
}

/** A present-but-unreadable record is reported as such, never as "none": it may describe a pending funding. */
export function readKeeperFunding(transferId: number): KeeperFundingRead {
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey(transferId)); } catch { return { status: "unreadable" }; }
  if (raw == null) return { status: "none" };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed, transferId) ? { status: "record", record: parsed } : { status: "unreadable" };
  } catch { return { status: "unreadable" }; }
}

/** Persists and reads back; false means this device cannot currently protect against a duplicate. */
export function saveKeeperFunding(record: KeeperFundingRecord): boolean {
  try {
    const serialized = JSON.stringify(record);
    window.localStorage.setItem(storageKey(record.transferId), serialized);
    return window.localStorage.getItem(storageKey(record.transferId)) === serialized;
  } catch { return false; }
}

export function clearKeeperFunding(transferId: number): void {
  try { window.localStorage.removeItem(storageKey(transferId)); } catch { /* nothing to clear */ }
}

function withState(record: KeeperFundingRecord, state: KeeperFundingState): boolean {
  return saveKeeperFunding({ ...record, state, updatedAt: new Date().toISOString() });
}

function markRecorded(transferId: number, signature: string): void {
  const read = readKeeperFunding(transferId);
  if (read.status === "record" && read.record.signature === signature) withState(read.record, "recorded");
}

const untrackable = () => new RoutingBundleError("KEEPER_FUNDING_UNTRACKABLE",
  "MultiHopper's keeper-funding transaction doesn't carry a blockhash validity window QazSplit can track, so it can't be protected against duplicate funding. Nothing was signed.");

/**
 * Keeper funding is only sent when its validity window can be tracked: it must use the bundle's
 * recent blockhash (not a durable nonce, which never expires by height) and /prepare must report
 * that blockhash's lastValidBlockHeight. Checked before the wallet is asked to sign anything.
 */
export function assertKeeperFundingTrackable(prepared: Pick<PreparedTxs, "recentBlockhash" | "lastValidBlockHeight">, steps: readonly BundleStep[]): void {
  const keeper = steps.find((step) => step.group === "keeperFunding");
  if (keeper) assertTrackableTransaction(prepared, keeper.transaction);
}

function assertTrackableTransaction(prepared: Pick<PreparedTxs, "recentBlockhash" | "lastValidBlockHeight">, transaction: Transaction): void {
  if (!prepared.recentBlockhash || prepared.lastValidBlockHeight == null) throw untrackable();
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version !== "legacy" && compiled.version !== 0) throw untrackable();
  if (compiled.lifetimeToken !== prepared.recentBlockhash) throw untrackable();
  const first = compiled.instructions[0];
  const usesDurableNonce = !!first && compiled.staticAccounts[first.programAddressIndex] === SYSTEM_PROGRAM_ADDRESS
    && !!first.data && ADVANCE_NONCE_ACCOUNT.every((byte, index) => first.data?.[index] === byte);
  if (usesDurableNonce) throw untrackable();
}

/**
 * Sends keeperFundingTx with its record written first, so a crash, reload or another tab still knows
 * a funding may be in flight. Only provable outcomes change the record: a definitive rejection marks
 * it rejected, an onchain failure or a never-landed expiry clears it, and an unknown outcome keeps it.
 */
export async function sendTrackedKeeperFunding(input: {
  transferId: number;
  transaction: Transaction;
  prepared: Pick<PreparedTxs, "recentBlockhash" | "lastValidBlockHeight">;
  send: (transaction: Transaction) => Promise<string>;
}): Promise<string> {
  assertTrackableTransaction(input.prepared, input.transaction);
  const { recentBlockhash, lastValidBlockHeight } = input.prepared;
  if (!recentBlockhash || lastValidBlockHeight == null) throw untrackable(); // narrowing; checked above
  const record: KeeperFundingRecord = {
    v: 1, transferId: input.transferId, signature: getSignatureFromTransaction(input.transaction), blockhash: recentBlockhash,
    lastValidBlockHeight, state: "sending", updatedAt: new Date().toISOString(),
  };
  if (!saveKeeperFunding(record)) {
    throw new RoutingBundleError("KEEPER_JOURNAL_UNAVAILABLE",
      "This browser can't save the keeper-funding record that prevents duplicate funding, so nothing was sent. Allow site storage for QazSplit and try again.");
  }
  try {
    const signature = await input.send(input.transaction);
    withState(record, "landed");
    return signature;
  } catch (error) {
    if (error instanceof RoutingBundleError) {
      if (error.code === "BROADCAST_REJECTED") withState(record, "rejected");
      else if (error.code === "TRANSACTION_FAILED" || error.code === "BLOCKHASH_EXPIRED") clearKeeperFunding(input.transferId); // provably not funded
    }
    throw error; // OUTCOME_UNKNOWN or anything unexpected keeps "sending": it may still land
  }
}

const retryableConfirm = (error: unknown) => error instanceof RoutingApiError
  && (error.code === "MH_036" || error.code === "MH_004" || error.status === 0 || error.status >= 500);

/**
 * confirm-broadcast #1 for keeper funding that already landed. MH_036 means MultiHopper's RPC has not
 * indexed it yet, so the *same* signature is reported again after a delay; nothing new is created.
 */
export async function recordKeeperFunding<T>(input: {
  transferId: number;
  signature: string;
  confirm: (body: ConfirmBroadcastBody) => Promise<T>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const delays = input.delaysMs ?? keeperFundingTiming.confirmRetryDelaysMs;
  const sleep = input.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await input.confirm({ routeInitSignatures: [], keeperFundingSignature: input.signature });
      markRecorded(input.transferId, input.signature);
      return result;
    } catch (error) {
      if (!retryableConfirm(error) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

async function observeRejected(rpc: Pick<BroadcastRpc, "getSignatureStatuses">, signature: string): Promise<ChainObservation> {
  // Rejected by preflight before forwarding and never re-sent: only an existing status could contradict that.
  try {
    const { value } = await rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
    return classifySignatureStatus(value[0]) ?? "never-landed";
  } catch { return "unknown"; }
}

/**
 * Must run before every /prepare for a transfer. "clear" and "recorded" allow preparing; "pending"
 * and "unknown" mean a keeper funding may still land or has not been acknowledged, so nothing new
 * may be prepared or signed for this transfer yet.
 */
export async function reconcileKeeperFunding<T>(input: {
  transferId: number;
  rpc: Pick<BroadcastRpc, "getSignatureStatuses" | "getEpochInfo">;
  confirm: (body: ConfirmBroadcastBody) => Promise<T>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<KeeperReconciliation> {
  const read = readKeeperFunding(input.transferId);
  if (read.status === "none") return { outcome: "clear" };
  if (read.status === "unreadable") return { outcome: "unknown", signature: null, message: MESSAGES.unreadable };
  const { record } = read;
  if (record.state === "recorded") return { outcome: "recorded", signature: record.signature };
  if (record.state !== "landed") {
    const observed = record.state === "rejected"
      ? await observeRejected(input.rpc, record.signature)
      : await observeSignature(input.rpc, record.signature as Signature, record.lastValidBlockHeight, { searchTransactionHistory: true });
    if (observed === "failed" || observed === "never-landed") {
      clearKeeperFunding(input.transferId); // provably not funded: a new keeper funding is safe
      return { outcome: "clear" };
    }
    if (observed === "pending") return { outcome: "pending", signature: record.signature, reason: "in-flight", message: MESSAGES.inFlight };
    if (observed === "unknown") return { outcome: "unknown", signature: record.signature, message: MESSAGES.unknown };
    withState(record, "landed");
  }
  try {
    await recordKeeperFunding({ transferId: input.transferId, signature: record.signature, confirm: input.confirm, delaysMs: input.delaysMs, sleep: input.sleep });
    return { outcome: "recorded", signature: record.signature };
  } catch (error) {
    if (error instanceof RoutingApiError && error.code === "MH_035") {
      // The transfer has moved past keeper funding (or ended): MultiHopper will not ask for it again.
      markRecorded(input.transferId, record.signature);
      return { outcome: "recorded", signature: record.signature };
    }
    return { outcome: "pending", signature: record.signature, reason: "unrecorded", message: MESSAGES.unrecorded(error instanceof RoutingApiError ? error.code : null) };
  }
}

/** Refuses to sign a second keeper funding after MultiHopper acknowledged the first one. */
export function assertNoDuplicateKeeperFunding(prepared: Pick<PreparedTxs, "keeperFundingTx">, reconciliation: KeeperReconciliation): void {
  if (prepared.keeperFundingTx && reconciliation.outcome === "recorded") {
    throw new RoutingBundleError("KEEPER_FUNDING_ALREADY_RECORDED",
      "MultiHopper asked for keeper funding again although your earlier keeper funding is confirmed and recorded. QazSplit won't sign a second one. Check again in a minute; if this persists, contact MultiHopper support with this transfer's support reference.",
      reconciliation.signature);
  }
}

/** What the UI must show for this transfer before Resume can be offered (null = nothing pending). */
export function keeperFundingNotice(transferId: number): KeeperFundingNotice | null {
  const read = readKeeperFunding(transferId);
  if (read.status === "unreadable") return { kind: "unknown", signature: null, message: MESSAGES.unreadable };
  if (read.status === "record" && (read.record.state === "sending" || read.record.state === "landed")) {
    return { kind: "needs-check", signature: read.record.signature, message: MESSAGES.needsCheck };
  }
  return null; // none, recorded, or rejected (Resume reconciles a rejected record first)
}

export function noticeFromReconciliation(result: KeeperReconciliation): KeeperFundingNotice | null {
  return result.outcome === "pending" || result.outcome === "unknown" ? { kind: result.outcome, signature: result.signature, message: result.message } : null;
}
