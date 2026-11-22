// Semantic inspection of MultiHopper-prepared transactions (audit C1 and M3).
//
// MultiHopper's own instructions cannot be decoded here (no public IDL), so integrity is enforced in
// three layers that do not depend on knowing their layout:
//   1. every invoked program must be on an allowlist (documented MultiHopper programs plus Solana's
//      system/token/compute-budget programs), and nothing may change the recipient wallet's owner,
//      delegate a token authority, or move tokens the wallet controls;
//   2. a wallet may only *add* Compute Budget instructions (Phantom's documented priority-fee
//      behaviour), and only to a transaction it signs alone; any other change is rejected;
//   3. each transaction is simulated right before it is sent, and the SOL leaving the recipient's
//      wallet across the whole bundle may never exceed the quoted up-front amount plus a margin.
// Every check fails closed: if a transaction cannot be decoded or simulated, it is not sent.
import {
  address, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, verifySignature,
  type Address, type ReadonlyUint8Array, type SignatureBytes, type Transaction,
} from "@solana/kit";

import { RoutingBundleError } from "./errors";

export const PROGRAMS = {
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  addressLookupTable: "AddressLookupTab1e1111111111111111111111111",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  memoV1: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  // https://dev-docs.multihopper.com/protocol/architecture
  multihopperCore: "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh",
  multihopperOrchestrator: "4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX",
  multihopperTransferHookGuard: "2JEv3pD6nczEvn1xDXaEzehkJofPPjoQQpnW5nGY3r52",
} as const;

export const PROGRAM_LABELS: Record<string, string> = {
  [PROGRAMS.system]: "System Program",
  [PROGRAMS.computeBudget]: "Compute Budget",
  [PROGRAMS.token]: "SPL Token",
  [PROGRAMS.token2022]: "Token-2022",
  [PROGRAMS.associatedToken]: "Associated Token Account",
  [PROGRAMS.addressLookupTable]: "Address Lookup Table",
  [PROGRAMS.memo]: "Memo",
  [PROGRAMS.memoV1]: "Memo (v1)",
  [PROGRAMS.multihopperCore]: "MultiHopper Core",
  [PROGRAMS.multihopperOrchestrator]: "MultiHopper Orchestrator",
  [PROGRAMS.multihopperTransferHookGuard]: "MultiHopper Transfer Hook Guard",
};
export const MULTIHOPPER_PROGRAM_IDS: readonly string[] = [PROGRAMS.multihopperCore, PROGRAMS.multihopperOrchestrator, PROGRAMS.multihopperTransferHookGuard];

// SPL Token: Transfer, Approve, SetAuthority, Burn, FreezeAccount, TransferChecked, ApproveChecked, BurnChecked.
const TOKEN_AUTHORITY_KINDS: ReadonlySet<number> = new Set([3, 4, 6, 8, 10, 12, 13, 15]);
// Token-2022 only: ConfidentialTransfer and WithdrawExcessLamports (26/1, TransferCheckedWithFee, is checked separately).
const TOKEN_2022_AUTHORITY_KINDS: ReadonlySet<number> = new Set([27, 38]);

/** Most a wallet-added priority fee may cost per transaction (0.005 SOL). */
export const PRIORITY_FEE_CAP_LAMPORTS = 5_000_000n;
const MAX_COMPUTE_UNITS = 1_400_000n;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;

type CompiledV0OrLegacy = {
  version: "legacy" | 0;
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: readonly string[];
  lifetimeToken: string;
  instructions: readonly { programAddressIndex: number; accountIndices?: readonly number[]; data?: ReadonlyUint8Array }[];
  addressTableLookups?: readonly { lookupTableAddress: string; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[];
};

/** An account as an instruction sees it, independent of where it sits in the message's index space. */
export type AccountRef =
  | { kind: "static"; address: string; signer: boolean; writable: boolean }
  | { kind: "lookup"; table: string; index: number; writable: boolean };

export type InstructionView = { program: string; accounts: AccountRef[]; data: Uint8Array };

export type DecodedMessage = {
  version: "legacy" | 0;
  feePayer: string;
  signers: string[];
  lifetimeToken: string;
  lookups: string;
  instructions: InstructionView[];
};

const integrity = (message: string) => new RoutingBundleError("TRANSACTION_INTEGRITY", message);

export function decodeMessage(messageBytes: ReadonlyUint8Array): DecodedMessage {
  let compiled: CompiledV0OrLegacy;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as CompiledV0OrLegacy;
  } catch {
    throw integrity("A prepared transaction could not be decoded.");
  }
  if (compiled.version !== "legacy" && compiled.version !== 0) throw integrity("A prepared transaction uses an unsupported message version.");
  const { numSignerAccounts: signers, numReadonlySignerAccounts: readonlySigners, numReadonlyNonSignerAccounts: readonlyOthers } = compiled.header;
  const total = compiled.staticAccounts.length;
  const refs: AccountRef[] = compiled.staticAccounts.map((account, index) => ({
    kind: "static", address: account, signer: index < signers,
    writable: index < signers ? index < signers - readonlySigners : index < total - readonlyOthers,
  }));
  const lookups = compiled.version === 0 ? compiled.addressTableLookups ?? [] : [];
  for (const lookup of lookups) for (const index of lookup.writableIndexes) refs.push({ kind: "lookup", table: lookup.lookupTableAddress, index, writable: true });
  for (const lookup of lookups) for (const index of lookup.readonlyIndexes) refs.push({ kind: "lookup", table: lookup.lookupTableAddress, index, writable: false });
  const instructions = compiled.instructions.map((instruction) => {
    const program = refs[instruction.programAddressIndex];
    // Programs are always static keys; a lookup-table program would be malformed.
    if (!program || program.kind !== "static") throw integrity("A prepared transaction invokes a program through a lookup table.");
    const accounts = (instruction.accountIndices ?? []).map((index) => {
      const ref = refs[index];
      if (!ref) throw integrity("A prepared transaction references an account index that does not exist.");
      return ref;
    });
    return { program: program.address, accounts, data: Uint8Array.from(instruction.data ?? []) };
  });
  return {
    version: compiled.version,
    feePayer: compiled.staticAccounts[0],
    signers: compiled.staticAccounts.slice(0, signers),
    lifetimeToken: compiled.lifetimeToken,
    lookups: JSON.stringify(lookups.map((l) => [l.lookupTableAddress, [...l.writableIndexes], [...l.readonlyIndexes]])),
    instructions,
  };
}

const u32 = (data: Uint8Array, offset = 0) => (data.length >= offset + 4 ? new DataView(data.buffer, data.byteOffset).getUint32(offset, true) : null);
const u64 = (data: Uint8Array, offset: number) => (data.length >= offset + 8 ? new DataView(data.buffer, data.byteOffset).getBigUint64(offset, true) : null);
const isWallet = (ref: AccountRef | undefined, wallet: string) => !!ref && ref.kind === "static" && ref.address === wallet;

/** Lamports a top-level System Program instruction moves out of `wallet` (CPI movements are covered by simulation). */
export function systemOutflow(instruction: InstructionView, wallet: string): bigint {
  if (instruction.program !== PROGRAMS.system || !isWallet(instruction.accounts[0], wallet)) return 0n;
  const kind = u32(instruction.data);
  if (kind === 0 || kind === 2) return u64(instruction.data, 4) ?? 0n; // CreateAccount / Transfer
  if (kind === 3) { // CreateAccountWithSeed: base(32) | seed(u64 len + bytes) | lamports | space | owner
    const seedLength = u64(instruction.data, 36);
    return seedLength == null ? 0n : u64(instruction.data, 44 + Number(seedLength)) ?? 0n;
  }
  return 0n;
}

type ComputeBudgetSettings = { kinds: number[]; unitLimit: bigint | null; microLamports: bigint | null };

function computeBudget(instructions: readonly InstructionView[]): ComputeBudgetSettings {
  const settings: ComputeBudgetSettings = { kinds: [], unitLimit: null, microLamports: null };
  for (const instruction of instructions) {
    if (instruction.program !== PROGRAMS.computeBudget) continue;
    const kind = instruction.data[0];
    if (instruction.accounts.length) throw integrity("A Compute Budget instruction references accounts.");
    if (settings.kinds.includes(kind)) throw integrity("A transaction contains duplicate Compute Budget instructions.");
    settings.kinds.push(kind);
    if (kind === 2 && instruction.data.length === 5) settings.unitLimit = BigInt(u32(instruction.data, 1) ?? 0);
    else if (kind === 3 && instruction.data.length === 9) settings.microLamports = u64(instruction.data, 1);
    else if (!((kind === 1 || kind === 4) && instruction.data.length === 5)) throw integrity("A transaction contains an unsupported Compute Budget instruction.");
  }
  return settings;
}

/** Worst-case priority fee implied by a transaction's Compute Budget instructions. */
export function priorityFeeLamports(instructions: readonly InstructionView[]): bigint {
  const settings = computeBudget(instructions);
  if (!settings.microLamports) return 0n;
  const others = BigInt(instructions.filter((i) => i.program !== PROGRAMS.computeBudget).length);
  const units = settings.unitLimit ?? (others * DEFAULT_UNITS_PER_INSTRUCTION < MAX_COMPUTE_UNITS ? others * DEFAULT_UNITS_PER_INSTRUCTION : MAX_COMPUTE_UNITS);
  return (settings.microLamports * units + 999_999n) / 1_000_000n;
}

/**
 * Static rules for one transaction the recipient is about to sign. Throws TRANSACTION_INTEGRITY with
 * a specific reason; returns the SOL this transaction moves out of the wallet through top-level
 * System Program instructions.
 */
export function assertTransactionSemantics(message: DecodedMessage, wallet: string): { systemOutflowLamports: bigint } {
  let outflow = 0n;
  for (const instruction of message.instructions) {
    if (!PROGRAM_LABELS[instruction.program]) {
      throw integrity(`A prepared transaction invokes a program QazSplit does not recognize (${instruction.program}). Nothing was signed.`);
    }
    if (instruction.program === PROGRAMS.system) {
      const kind = u32(instruction.data);
      if (kind == null) throw integrity("A System Program instruction is malformed.");
      if ([4, 5, 6, 7, 12].includes(kind)) throw integrity("A prepared transaction uses durable-nonce instructions, which QazSplit does not allow.");
      if ((kind === 1 || kind === 8) && isWallet(instruction.accounts[0], wallet)) throw integrity("A prepared transaction would change your wallet's owner or size. Nothing was signed.");
      if (![0, 1, 2, 3, 8, 9, 10, 11].includes(kind)) throw integrity("A prepared transaction uses an unsupported System Program instruction.");
      outflow += systemOutflow(instruction, wallet);
    }
    if (instruction.program === PROGRAMS.token || instruction.program === PROGRAMS.token2022) {
      // A wallet address can never be a token account, so wherever it appears in one of these
      // instructions it is the authority: the instruction would spend the wallet's tokens (for
      // example the milestone's mock USDC) or hand control of them to someone else.
      const kind = instruction.data[0];
      const referencesWallet = instruction.accounts.some((ref) => isWallet(ref, wallet));
      const exercisesAuthority = TOKEN_AUTHORITY_KINDS.has(kind)
        || (kind === 9 && !isWallet(instruction.accounts[1], wallet)) // CloseAccount to someone else
        || (instruction.program === PROGRAMS.token2022 && (kind === 26 ? instruction.data[1] === 1 : TOKEN_2022_AUTHORITY_KINDS.has(kind)));
      if (referencesWallet && exercisesAuthority) {
        throw integrity("A prepared transaction would move, burn, delegate or re-assign tokens your wallet controls. Nothing was signed.");
      }
    }
  }
  computeBudget(message.instructions); // well-formed and not duplicated
  if (priorityFeeLamports(message.instructions) > PRIORITY_FEE_CAP_LAMPORTS) throw integrity("A transaction's priority fee exceeds QazSplit's 0.005 SOL cap.");
  return { systemOutflowLamports: outflow };
}

function sameRef(a: AccountRef, b: AccountRef): boolean {
  return a.kind === "static" && b.kind === "static"
    ? a.address === b.address && a.signer === b.signer && a.writable === b.writable
    : a.kind === "lookup" && b.kind === "lookup" && a.table === b.table && a.index === b.index && a.writable === b.writable;
}

function sameInstruction(a: InstructionView, b: InstructionView): boolean {
  return a.program === b.program && a.accounts.length === b.accounts.length && a.accounts.every((ref, i) => sameRef(ref, b.accounts[i]))
    && a.data.length === b.data.length && a.data.every((byte, i) => byte === b.data[i]);
}

function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Accepts the transaction a wallet returned for `original`. Unchanged bytes keep every original
 * (MultiHopper) signature and add only the wallet's. A changed message is accepted only when the
 * wallet is the transaction's sole signer (so no other signature can be invalidated) and the only
 * difference is added, well-formed Compute Budget instructions within the priority-fee cap.
 */
export async function acceptWalletSignedTransaction(original: Transaction, signed: Transaction, wallet: string, label: string): Promise<Transaction> {
  const walletSignature = signed.signatures[wallet as keyof typeof signed.signatures];
  if (!walletSignature) throw new RoutingBundleError("WALLET_SIGNATURE_MISSING", `Your wallet did not sign ${label}. Nothing was sent.`);
  if (sameBytes(signed.messageBytes, original.messageBytes)) {
    // Key order (and so the wire slot order) comes from the original message's signer list.
    const signatures = Object.freeze({ ...original.signatures, [wallet]: walletSignature });
    return Object.freeze({ ...original, signatures }) as Transaction;
  }
  const rejected = (reason: string) => new RoutingBundleError("WALLET_MODIFIED_TRANSACTION",
    `Your wallet changed ${label} in a way QazSplit cannot accept (${reason}). Nothing was sent.`);
  const before = decodeMessage(original.messageBytes);
  let after: DecodedMessage;
  try { after = decodeMessage(signed.messageBytes); } catch { throw rejected("the changed transaction could not be decoded"); }
  if (before.signers.length !== 1 || before.signers[0] !== wallet) throw rejected("it is also signed by MultiHopper, so any change would invalidate that signature");
  if (after.signers.length !== 1 || after.signers[0] !== wallet || after.feePayer !== before.feePayer) throw rejected("signers or fee payer changed");
  if (after.version !== before.version || after.lifetimeToken !== before.lifetimeToken || after.lookups !== before.lookups) throw rejected("version, blockhash or lookup tables changed");
  const originalCb = before.instructions.filter((i) => i.program === PROGRAMS.computeBudget);
  const keptBefore = before.instructions.filter((i) => i.program !== PROGRAMS.computeBudget);
  const keptAfter = after.instructions.filter((i) => i.program !== PROGRAMS.computeBudget);
  if (keptBefore.length !== keptAfter.length || !keptBefore.every((instruction, i) => sameInstruction(instruction, keptAfter[i]))) {
    throw rejected("instructions other than Compute Budget were added, removed or changed");
  }
  const addedCb = after.instructions.filter((i) => i.program === PROGRAMS.computeBudget);
  if (originalCb.length && (originalCb.length !== addedCb.length || !originalCb.every((instruction, i) => sameInstruction(instruction, addedCb[i])))) {
    throw rejected("existing Compute Budget settings were changed");
  }
  try { computeBudget(after.instructions); } catch { throw rejected("Compute Budget instructions are malformed or duplicated"); }
  if (priorityFeeLamports(after.instructions) > PRIORITY_FEE_CAP_LAMPORTS) throw rejected("the added priority fee exceeds 0.005 SOL");
  const keys = Object.keys(signed.signatures);
  if (keys.length !== 1 || keys[0] !== wallet) throw rejected("unexpected signatures");
  let valid = false;
  try { valid = await verifySignature(await getPublicKeyFromAddress(address(wallet)), walletSignature as SignatureBytes, signed.messageBytes); } catch { valid = false; }
  if (!valid) throw rejected("the wallet's signature does not match the changed transaction");
  return Object.freeze({ messageBytes: signed.messageBytes, signatures: Object.freeze({ [wallet]: walletSignature }) }) as Transaction;
}

export type TransactionReview = {
  version: "legacy" | 0;
  feePayer: string;
  signers: { address: string; role: "you" | "multihopper-presigned" | "missing" }[];
  programs: string[];
  systemOutflowLamports: bigint;
  hasComputeBudget: boolean;
};

/** What the recipient is shown before approving: who signs, which programs run, what SOL leaves directly. */
export function reviewTransaction(transaction: Transaction, wallet: string): TransactionReview {
  const message = decodeMessage(transaction.messageBytes);
  const { systemOutflowLamports } = assertTransactionSemantics(message, wallet);
  return {
    version: message.version,
    feePayer: message.feePayer,
    signers: message.signers.map((signer) => ({
      address: signer,
      role: signer === wallet ? "you" : transaction.signatures[signer as keyof typeof transaction.signatures] ? "multihopper-presigned" : "missing",
    })),
    programs: [...new Set(message.instructions.map((i) => PROGRAM_LABELS[i.program] ?? i.program))],
    systemOutflowLamports,
    hasComputeBudget: message.instructions.some((i) => i.program === PROGRAMS.computeBudget),
  };
}

/** Delay before re-simulating a transaction whose simulation failed (adjustable in tests). */
export const simulationTiming: { retryDelayMs: number } = { retryDelayMs: 2_000 };

export type OutflowRpc = {
  getBalance: (address: Address, config: { commitment: "confirmed" }) => { send: () => Promise<{ value: bigint }> };
  simulateTransaction: (wire: never, config: never) => { send: () => Promise<{ value: { err: unknown; accounts?: ({ lamports: bigint } | null)[] | null } }> };
};

/**
 * Simulates each transaction against current devnet state just before it is sent and tracks how
 * much SOL leaves the recipient's wallet. Exceeding `limitLamports` in total, a simulation that fails
 * after retries, or an RPC that cannot answer all stop the bundle before that transaction is sent.
 */
export function createOutflowGuard(input: {
  rpc: OutflowRpc;
  wallet: string;
  limitLamports: bigint;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = input.retries ?? 2;
  let spent = 0n;
  return {
    get spentLamports() { return spent; },
    /** Throws before anything is sent; returns the simulated outflow to `record` once the transaction lands. */
    async check(transaction: Transaction): Promise<bigint> {
      const wire = getBase64EncodedWireTransaction(transaction);
      for (let attempt = 0; ; attempt++) {
        let pre: bigint; let post: bigint | null | undefined; let err: unknown;
        try {
          pre = (await input.rpc.getBalance(address(input.wallet), { commitment: "confirmed" }).send()).value;
          const simulated = await input.rpc.simulateTransaction(wire as never, {
            encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false,
            accounts: { addresses: [address(input.wallet)], encoding: "base64" },
          } as never).send();
          err = simulated.value.err;
          post = simulated.value.accounts?.[0]?.lamports;
        } catch {
          throw new RoutingBundleError("VALIDATION_UNAVAILABLE", "QazSplit could not simulate this transaction on devnet, so it was not sent. Resume when devnet RPC is reachable.");
        }
        if (err) {
          // Dependent transactions can briefly fail simulation while RPC nodes catch up.
          if (attempt < retries) { await sleep(input.retryDelayMs ?? simulationTiming.retryDelayMs); continue; }
          throw new RoutingBundleError("SIMULATION_REJECTED", "This transaction fails in a devnet simulation, so it was not sent. Resume to rebuild the remaining transactions.");
        }
        if (post == null) throw new RoutingBundleError("VALIDATION_UNAVAILABLE", "Devnet RPC did not return your wallet's simulated balance, so the transaction was not sent.");
        const outflow = pre > post ? pre - post : 0n;
        if (spent + outflow > input.limitLamports) {
          throw new RoutingBundleError("OUTFLOW_LIMIT_EXCEEDED", "This bundle would take more SOL from your wallet than MultiHopper quoted, so it was stopped before this transaction was sent.");
        }
        return outflow;
      }
    },
    record(outflow: bigint) { spent += outflow; },
  };
}

/** Errors raised before a transaction is sent: the transaction provably did not reach the network. */
export const NOT_SENT_CODES: ReadonlySet<string> = new Set(["VALIDATION_UNAVAILABLE", "SIMULATION_REJECTED", "OUTFLOW_LIMIT_EXCEEDED", "TRANSACTION_INTEGRITY"]);
