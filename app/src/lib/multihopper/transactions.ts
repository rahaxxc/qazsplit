// Browser-side signing and broadcasting for MultiHopper's prepared bundles, following
// https://dev-docs.multihopper.com/guides/agentic-integration. Private keys stay in the wallet;
// only public signatures ever reach the QazSplit server.
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  getBase64EncodedWireTransaction, getBase64Encoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, isSolanaError,
  type Signature, type Transaction, type TransactionModifyingSigner,
} from "@solana/kit";

import type { AppClient } from "../solana-client";
import { RoutingBundleError } from "./errors";
import { acceptWalletSignedTransaction, reviewTransaction, type TransactionReview } from "./inspection";

export { RoutingBundleError } from "./errors";

export type BundleGroup = "keeperFunding" | "routeInit" | "orchestratorInit" | "sessionInit" | "dispersionInit" | "rescue" | "reclaimRent";

export const GROUP_LABELS: Record<BundleGroup, string> = {
  keeperFunding: "Keeper funding",
  routeInit: "Route setup",
  orchestratorInit: "Orchestrator setup",
  sessionInit: "Session setup",
  dispersionInit: "Payout binding",
  rescue: "Rescue locked SOL",
  reclaimRent: "Reclaim rent",
};

/** Mirrors the server's sanitized `preparedTxs`; null/empty groups are already confirmed onchain. */
export type PreparedTxs = {
  keeperFundingTx: string | null;
  routeInitTxs: string[];
  orchestratorInitTx: string | null;
  sessionInitTxs: string[];
  dispersionInitTxs: string[];
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  nothingToDo: boolean;
};

export type TransactionVersion = "legacy" | 0;

export type BundleStep = {
  group: BundleGroup;
  /** Position within its group, e.g. routeInitTxs[1]. */
  index: number;
  transaction: Transaction;
  version: TransactionVersion;
  /** Signers, programs and direct SOL outflow, checked against QazSplit's rules (inspection.ts). */
  review: TransactionReview;
};

export type ConfirmBroadcastBody = {
  routeInitSignatures: string[];
  keeperFundingSignature?: string;
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  dispersionInitSignatures?: string[];
};

export function stepLabel(step: Pick<BundleStep, "group" | "index">, groupSize = 1): string {
  return groupSize > 1 ? `${GROUP_LABELS[step.group]} ${step.index + 1} of ${groupSize}` : GROUP_LABELS[step.group];
}

/**
 * Decodes the bundle in the documented broadcast order and checks every transaction before the
 * wallet is asked for anything: it must decode, be legacy or v0 (the documented types), be a
 * version this wallet can sign, actually require this wallet's signature, already carry every
 * other signature it needs, and pass QazSplit's program and authority rules (inspection.ts).
 */
export function planBundle(prepared: PreparedTxs, wallet: string, supportedVersions: ReadonlySet<"legacy" | 0 | 1>): BundleStep[] {
  const groups: [BundleGroup, string[]][] = [
    ["keeperFunding", prepared.keeperFundingTx ? [prepared.keeperFundingTx] : []],
    ["routeInit", prepared.routeInitTxs],
    ["orchestratorInit", prepared.orchestratorInitTx ? [prepared.orchestratorInitTx] : []],
    ["sessionInit", prepared.sessionInitTxs],
    ["dispersionInit", prepared.dispersionInitTxs],
  ];
  return groups.flatMap(([group, encoded]) => planGroup(group, encoded, wallet, supportedVersions));
}

/** Decodes and checks one group of MultiHopper-built transactions (bundle, rescue or rent reclaim). */
export function planGroup(group: BundleGroup, encoded: readonly string[], wallet: string, supportedVersions: ReadonlySet<"legacy" | 0 | 1>): BundleStep[] {
  return encoded.map((base64, index): BundleStep => {
    const label = stepLabel({ group, index }, encoded.length);
    let transaction: Transaction;
    let version: "legacy" | number;
    try {
      transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
      version = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).version;
    } catch {
      throw new RoutingBundleError("MALFORMED_TRANSACTION", `${label} could not be decoded. Nothing was signed.`);
    }
    if (version !== "legacy" && version !== 0) {
      throw new RoutingBundleError("UNSUPPORTED_TRANSACTION_VERSION", `${label} uses an unexpected transaction version. Nothing was signed.`);
    }
    if (!supportedVersions.has(version)) {
      throw new RoutingBundleError("WALLET_VERSION_UNSUPPORTED", `Your wallet cannot sign ${version === "legacy" ? "legacy" : "version 0"} transactions, which MultiHopper requires. Try Phantom or Solflare.`);
    }
    if (!Object.prototype.hasOwnProperty.call(transaction.signatures, wallet)) {
      throw new RoutingBundleError("WALLET_NOT_SIGNER", `${label} does not require your wallet's signature. Nothing was signed.`);
    }
    const missing = Object.entries(transaction.signatures).filter(([signer, signature]) => signer !== wallet && !signature).length;
    if (missing) throw new RoutingBundleError("INCOMPLETE_SIGNATURES", `${label} still needs ${missing} signature(s) that only MultiHopper can provide. Nothing was signed; prepare again.`);
    let review: TransactionReview;
    try {
      review = reviewTransaction(transaction, wallet);
    } catch (error) {
      if (error instanceof RoutingBundleError) throw new RoutingBundleError(error.code, `${label}: ${error.message}`);
      throw error;
    }
    return { group, index, transaction, version, review };
  });
}

/** How long QazSplit waits for the wallet's approval; the prepared blockhash is long gone after this. */
export const WALLET_SIGNING_TIMEOUT_MS = 120_000;

export type SignBundleOptions = {
  timeoutMs?: number;
  /** Returns the wallet account connected right now; signing is discarded if it changed meanwhile. */
  currentAccount?: () => string | null | undefined;
};

/** Throws if the connected wallet account is no longer the one the bundle was prepared for. */
export function assertSameAccount(wallet: string, currentAccount?: () => string | null | undefined): void {
  if (currentAccount && currentAccount() !== wallet) {
    throw new RoutingBundleError("WALLET_ACCOUNT_CHANGED", "Your wallet switched accounts during routing. Nothing more was sent; reconnect the recipient wallet and resume.");
  }
}

/**
 * Asks the wallet to sign the whole bundle in one approval. For each transaction:
 *   - unchanged bytes: the original message and every original (MultiHopper) partial signature
 *     are kept and only the wallet's signature is added, so signatures a wallet drops are restored;
 *   - changed bytes: accepted only when the wallet is the sole signer and merely added Compute
 *     Budget instructions within QazSplit's priority-fee cap (Phantom's documented behaviour);
 *     anything else is rejected before broadcast (inspection.ts).
 * A wallet that does not answer within the timeout, or an account switch, discards the result.
 */
export async function signBundle(steps: readonly BundleStep[], signer: TransactionModifyingSigner, wallet: string, options: SignBundleOptions = {}): Promise<BundleStep[]> {
  if (!steps.length) return [];
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new RoutingBundleError("WALLET_TIMEOUT", "Your wallet did not respond in time. Nothing was sent. If a wallet prompt is still open, reject it, then resume."));
    }, options.timeoutMs ?? WALLET_SIGNING_TIMEOUT_MS);
  });
  let signed: Awaited<ReturnType<TransactionModifyingSigner["modifyAndSignTransactions"]>>;
  try {
    signed = await Promise.race([signer.modifyAndSignTransactions(steps.map((step) => step.transaction), { abortSignal: abort.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  assertSameAccount(wallet, options.currentAccount);
  if (signed.length !== steps.length) throw new RoutingBundleError("WALLET_SIGNING_FAILED", "Your wallet did not return every signed transaction. Nothing was sent.");
  const counts = new Map<BundleGroup, number>();
  for (const step of steps) counts.set(step.group, (counts.get(step.group) ?? 0) + 1);
  const accepted: BundleStep[] = [];
  for (const [position, step] of steps.entries()) {
    const label = stepLabel(step, counts.get(step.group));
    const transaction = await acceptWalletSignedTransaction(step.transaction, signed[position], wallet, label);
    const missing = Object.values(transaction.signatures).filter((signature) => !signature).length;
    if (missing) throw new RoutingBundleError("INCOMPLETE_SIGNATURES", `${label} still needs ${missing} signature(s) that only MultiHopper can provide. Nothing was sent; prepare again.`);
    accepted.push({ ...step, transaction, review: reviewTransaction(transaction, wallet) });
  }
  return accepted;
}

export type BroadcastRpc = Pick<AppClient["rpc"], "sendTransaction" | "getSignatureStatuses" | "getBlockHeight" | "getEpochInfo">;

export type ConfirmOptions = {
  /** From /prepare: the last block height at which this transaction can be included. */
  lastValidBlockHeight: number | null;
  pollIntervalMs?: number;
  /** After an ambiguous send error, how often the *same* signed bytes are re-sent. */
  rebroadcastIntervalMs?: number;
  /** How long to try to establish an outcome before reporting it as unknown (never as failed). */
  timeoutMs?: number;
  /**
   * Re-sends after a definitive preflight rejection, for public devnet RPC nodes that have not yet
   * seen the accounts an earlier transaction in the bundle created (audit M6).
   */
  preflightRetries?: number;
  preflightRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Defaults for re-sending after a definitive preflight rejection (adjustable in tests). */
export const broadcastTiming: { preflightRetryDelayMs: number } = { preflightRetryDelayMs: 2_000 };

function messageOf(error: unknown): string {
  for (let i = 0; i < 5 && error instanceof Error && error.cause instanceof Error; i++) error = error.cause;
  return error instanceof Error ? error.message : "Unknown RPC error.";
}

const isConfirmed = (status: { confirmationStatus: string | null } | null | undefined) =>
  status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";

const isAlreadyProcessed = (error: unknown) =>
  isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  && isSolanaError((error as Error).cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED);

/**
 * Agave's sendTransaction (rpc.rs) returns -32002 SendTransactionPreflightFailure, carrying the
 * simulation error in `data.err`, before it forwards anything; Kit exposes that error as `cause`.
 * Only that response proves this attempt was not sent, and `AlreadyProcessed` means the opposite.
 * Every other failure (network, timeout, HTTP status, -32005 node health, unknown codes, other
 * providers' variations) is ambiguous: the transaction may have been forwarded and may still land.
 */
export function isDefinitivePreflightRejection(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    && isSolanaError((error as Error).cause) && !isAlreadyProcessed(error);
}

/** What the chain can currently prove about one signature. Only "failed" and "never-landed" are final negatives. */
export type ChainObservation = "landed" | "failed" | "pending" | "never-landed" | "unknown";

type StatusLike = { confirmationStatus: string | null; err: unknown } | null | undefined;

/** null = no status known for this signature. */
export function classifySignatureStatus(status: StatusLike): ChainObservation | null {
  return classifyStatus(status);
}

function classifyStatus(status: StatusLike): ChainObservation | null {
  if (!status) return null;
  // A processed-only result (even a failed one) can still be dropped with its fork: keep waiting.
  if (!isConfirmed(status)) return "pending";
  return status.err ? "failed" : "landed";
}

/**
 * One reconciliation pass. "never-landed" requires (a) the *finalized* chain to be past the
 * transaction's lastValidBlockHeight, so no block can include it any more, and (b) a status lookup
 * that searches rooted history, answered from a view whose context slot has reached that finalized
 * slot, to find nothing. A stale or lagging RPC view yields "unknown", never "never-landed".
 */
export async function observeSignature(
  rpc: Pick<BroadcastRpc, "getSignatureStatuses" | "getEpochInfo">,
  signature: Signature,
  lastValidBlockHeight: number | null,
  options: { searchTransactionHistory?: boolean } = {},
): Promise<ChainObservation> {
  let seen: ChainObservation | null;
  try {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: options.searchTransactionHistory ?? false }).send();
    seen = classifyStatus(value[0]);
  } catch { return "unknown"; }
  if (seen) return seen;
  if (lastValidBlockHeight == null) return "pending"; // expiry cannot be proven
  let finalized: { absoluteSlot: bigint; blockHeight: bigint };
  try { finalized = await rpc.getEpochInfo({ commitment: "finalized" }).send(); } catch { return "unknown"; }
  if (finalized.blockHeight <= BigInt(lastValidBlockHeight)) return "pending";
  try {
    const check = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
    const again = classifyStatus(check.value[0]);
    if (again) return again;
    return check.context.slot >= finalized.absoluteSlot ? "never-landed" : "unknown";
  } catch { return "unknown"; }
}

/** Fails before sending anything if the prepared blockhash already expired (e.g. a slow wallet approval). */
export async function assertBundleNotExpired(rpc: Pick<BroadcastRpc, "getBlockHeight">, lastValidBlockHeight: number | null): Promise<void> {
  if (lastValidBlockHeight == null) return;
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  if (height > BigInt(lastValidBlockHeight)) {
    throw new RoutingBundleError("BLOCKHASH_EXPIRED", "The prepared transactions expired before broadcast (they are valid for about 60 seconds). Nothing was sent; prepare again.");
  }
}

/**
 * Broadcasts one signed transaction to devnet RPC and waits until its outcome is *established*:
 * confirmed, failed onchain, definitively rejected before sending, or provably never landed after
 * its blockhash expired. An ambiguous send error is never treated as a failure; the identical
 * signed bytes are re-sent (they can land at most once) while the chain is watched. If nothing can
 * be established within the time budget the outcome is reported as unknown.
 */
export async function sendAndConfirmTransaction(rpc: BroadcastRpc, transaction: Transaction, options: ConfirmOptions): Promise<string> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const rebroadcastIntervalMs = options.rebroadcastIntervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  const send = () => rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const preflightRetries = options.preflightRetries ?? 2;
  let rebroadcast = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await send();
        break;
      } catch (error) {
        // A definitive rejection proves this attempt was not forwarded, so re-sending the same bytes is safe.
        if (!isDefinitivePreflightRejection(error) || attempt >= preflightRetries) throw error;
        await sleep(options.preflightRetryDelayMs ?? broadcastTiming.preflightRetryDelayMs);
      }
    }
  } catch (error) {
    if (isDefinitivePreflightRejection(error)) {
      // Not forwarded by this RPC. Make sure nothing exists under this signature before saying so.
      let existing: ChainObservation | null | undefined;
      try {
        const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
        existing = classifyStatus(value[0]);
      } catch { existing = undefined; } // cannot verify: fall through and watch the chain
      if (existing === null) throw new RoutingBundleError("BROADCAST_REJECTED", `The RPC rejected this transaction before sending it: ${messageOf(error)}`, signature);
      if (existing === "landed") return signature;
      if (existing === "failed") throw new RoutingBundleError("TRANSACTION_FAILED", "This routing transaction failed onchain.", signature);
    } else {
      // Ambiguous: the RPC may already have forwarded it. Watch the chain; re-send only these bytes.
      rebroadcast = !isAlreadyProcessed(error);
    }
  }
  const started = now();
  let lastSent = started;
  for (;;) {
    const observed = await observeSignature(rpc, signature, options.lastValidBlockHeight);
    if (observed === "landed") return signature;
    if (observed === "failed") throw new RoutingBundleError("TRANSACTION_FAILED", "This routing transaction failed onchain.", signature);
    if (observed === "never-landed") {
      throw new RoutingBundleError("BLOCKHASH_EXPIRED", "This transaction's blockhash expired and it never landed. Resume to continue from what already landed.", signature);
    }
    if (now() - started > timeoutMs) {
      throw new RoutingBundleError("OUTCOME_UNKNOWN", "QazSplit could not confirm whether this transaction landed. It may still land until its blockhash expires, so it must be reconciled before anything is retried.", signature);
    }
    if (rebroadcast && now() - lastSent >= rebroadcastIntervalMs) {
      lastSent = now();
      await send().catch(() => undefined); // same signature: duplicates are impossible
    }
    await sleep(pollIntervalMs);
  }
}

/** A check that must pass before a transaction is sent, such as the simulation-based outflow guard. */
export type PreSendCheck = { check: (transaction: Transaction) => Promise<bigint>; record: (outflow: bigint) => void };

/**
 * Runs `guard.check` before `send`, so a rejected transaction provably never reaches the network
 * (and keeper funding is journaled only for a transaction that passed), then records its outflow.
 */
export function guarded(guard: PreSendCheck | null | undefined, send: (step: BundleStep) => Promise<string>): (step: BundleStep) => Promise<string> {
  if (!guard) return send;
  return async (step) => {
    const outflow = await guard.check(step.transaction);
    const signature = await send(step);
    guard.record(outflow);
    return signature;
  };
}

export type BroadcastEvent =
  | { type: "step"; step: BundleStep; state: "sending" | "confirmed"; signature?: string }
  | { type: "confirm"; stage: "keeperFunding" | "final"; state: "sending" | "done" }
  | { type: "wait"; ms: number };

export class BundleExecutionError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: unknown,
    /** Signatures already confirmed in this attempt, so the UI can show what landed. */
    readonly landed: ConfirmBroadcastBody,
  ) {
    super(reason instanceof Error ? reason.message : "Routing broadcast failed.");
    this.name = "BundleExecutionError";
  }
}

export type ExecuteBundleDeps<T> = {
  steps: readonly BundleStep[];
  sendAndConfirm: (step: BundleStep) => Promise<string>;
  confirmBroadcast: (body: ConfirmBroadcastBody) => Promise<T>;
  onProgress?: (event: BroadcastEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Propagation delay after the last routeInitTx and after orchestratorInitTx (documented: 3 s). */
  settleDelayMs?: number;
  /** Overrides for keeperFundingTx: tracked sending and MH_036-tolerant recording (duplicate-funding protection). */
  keeperFunding?: {
    send?: (step: BundleStep) => Promise<string>;
    confirm?: (body: ConfirmBroadcastBody) => Promise<T>;
  };
};

/**
 * Strict documented order: keeperFundingTx → confirm-broadcast(keeper only) → routeInitTxs →
 * orchestratorInitTx → sessionInitTxs → dispersionInitTxs → final confirm-broadcast. Each
 * transaction confirms before the next is sent. Any failure stops immediately; the caller resumes
 * with a fresh /prepare, which skips whatever already landed.
 */
export async function executeBundle<T>(deps: ExecuteBundleDeps<T>): Promise<{ signatures: ConfirmBroadcastBody; transfer: T }> {
  const sleep = deps.sleep ?? defaultSleep;
  const settleDelayMs = deps.settleDelayMs ?? 3_000;
  const signatures: ConfirmBroadcastBody = { routeInitSignatures: [] };
  const landed = (): ConfirmBroadcastBody => ({
    ...signatures,
    routeInitSignatures: [...signatures.routeInitSignatures],
    ...(signatures.sessionInitSignatures ? { sessionInitSignatures: [...signatures.sessionInitSignatures] } : {}),
    ...(signatures.dispersionInitSignatures ? { dispersionInitSignatures: [...signatures.dispersionInitSignatures] } : {}),
  });
  const inGroup = (group: BundleGroup) => deps.steps.filter((step) => step.group === group);

  async function run(step: BundleStep, send: (step: BundleStep) => Promise<string> = deps.sendAndConfirm): Promise<string> {
    deps.onProgress?.({ type: "step", step, state: "sending" });
    try {
      const signature = await send(step);
      deps.onProgress?.({ type: "step", step, state: "confirmed", signature });
      return signature;
    } catch (error) {
      throw new BundleExecutionError(stepLabel(step, inGroup(step.group).length), error, landed());
    }
  }
  async function confirm(stage: "keeperFunding" | "final", body: ConfirmBroadcastBody, call: (body: ConfirmBroadcastBody) => Promise<T> = deps.confirmBroadcast): Promise<T> {
    deps.onProgress?.({ type: "confirm", stage, state: "sending" });
    try {
      const result = await call(body);
      deps.onProgress?.({ type: "confirm", stage, state: "done" });
      return result;
    } catch (error) {
      throw new BundleExecutionError(stage === "final" ? "Final broadcast confirmation" : "Keeper funding confirmation", error, landed());
    }
  }
  async function settle(): Promise<void> {
    deps.onProgress?.({ type: "wait", ms: settleDelayMs });
    await sleep(settleDelayMs);
  }

  for (const step of inGroup("keeperFunding")) {
    signatures.keeperFundingSignature = await run(step, deps.keeperFunding?.send);
    // Recorded immediately, before anything else, so an interrupted deploy is never funded twice.
    await confirm("keeperFunding", { routeInitSignatures: [], keeperFundingSignature: signatures.keeperFundingSignature }, deps.keeperFunding?.confirm);
  }
  const routeInit = inGroup("routeInit");
  for (const [position, step] of routeInit.entries()) {
    signatures.routeInitSignatures.push(await run(step));
    if (position < routeInit.length - 1) await settle();
  }
  if (routeInit.length) await settle();
  for (const step of inGroup("orchestratorInit")) {
    signatures.orchestratorInitSignature = await run(step);
    await settle();
  }
  for (const step of inGroup("sessionInit")) (signatures.sessionInitSignatures ??= []).push(await run(step));
  for (const step of inGroup("dispersionInit")) (signatures.dispersionInitSignatures ??= []).push(await run(step));
  const transfer = await confirm("final", signatures);
  return { signatures, transfer };
}
