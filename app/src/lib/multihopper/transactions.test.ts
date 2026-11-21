import {
  AccountRole, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, appendTransactionMessageInstruction, compileTransaction, createSolanaRpcFromTransport,
  createTransactionMessage, generateKeyPair, getAddressFromPublicKey, getBase64EncodedWireTransaction, getBase64Encoder, getPublicKeyFromAddress,
  getSignatureFromTransaction, getSolanaErrorFromJsonRpcError, getTransactionDecoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signBytes, verifySignature,
  type Address, type Blockhash, type SignatureBytes, type Transaction, type TransactionModifyingSigner,
} from "@solana/kit";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  BundleExecutionError, RoutingBundleError, assertBundleNotExpired, executeBundle, isDefinitivePreflightRejection, planBundle, sendAndConfirmTransaction,
  signBundle, type BroadcastRpc, type BundleStep, type ConfirmBroadcastBody, type PreparedTxs,
} from "./transactions";

// Exact JSON-RPC error payloads, as Agave's sendTransaction returns them, turned into errors by Kit itself.
const rpcErrors = {
  preflightRejected: () => getSolanaErrorFromJsonRpcError({ code: -32002, message: "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
    data: { accounts: null, err: "AccountNotFound", innerInstructions: null, logs: [], replacementBlockhash: null, returnData: null, unitsConsumed: 0 } }),
  alreadyProcessed: () => getSolanaErrorFromJsonRpcError({ code: -32002, message: "Transaction simulation failed: This transaction has already been processed",
    data: { err: "AlreadyProcessed", logs: [] } }),
  nodeUnhealthy: () => getSolanaErrorFromJsonRpcError({ code: -32005, message: "Node is behind by 42 slots", data: { numSlotsBehind: 42 } }),
  httpUnavailable: () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Service Unavailable", statusCode: 503 }),
  timedOut: () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  networkDown: () => new TypeError("fetch failed"),
  lookalike: () => new Error("Transaction simulation failed: insufficient lamports"), // message text alone proves nothing
};

const PROGRAM = "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh" as Address; // any program id works for wire-format tests
const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as Blockhash;
const BOTH = new Set<"legacy" | 0 | 1>(["legacy", 0]);
let user: { address: Address; keys: CryptoKeyPair };
let ephemeral: { address: Address; keys: CryptoKeyPair };

async function keyPair() {
  const keys = await generateKeyPair();
  return { keys, address: await getAddressFromPublicKey(keys.publicKey) };
}

/** A prepared transaction as MultiHopper ships it: user is fee payer, optional server pre-signature. */
async function prepared(version: "legacy" | 0, options: { coSigner?: boolean; tag?: number } = {}): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(user.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstruction({
      programAddress: PROGRAM,
      accounts: options.coSigner ? [{ address: ephemeral.address, role: AccountRole.READONLY_SIGNER }] : [],
      data: new Uint8Array([options.tag ?? 1]),
    }, m),
  );
  const compiled = compileTransaction(message);
  const signed = options.coSigner ? await partiallySignTransaction([ephemeral.keys], compiled) : compiled;
  return getBase64EncodedWireTransaction(signed);
}

/** A wallet signer standing in for Phantom/Solflare's `solana:signTransaction`. */
function wallet(behavior: "preserve" | "drop-others" | "modify" | "skip" = "preserve"): TransactionModifyingSigner & { calls: number } {
  const signer = {
    address: user.address,
    calls: 0,
    async modifyAndSignTransactions(transactions: readonly Transaction[]) {
      signer.calls++;
      return Promise.all(transactions.map(async (tx) => {
        const messageBytes = behavior === "modify" ? Uint8Array.from([...tx.messageBytes.slice(0, -1), 99]) : tx.messageBytes;
        const own = behavior === "skip" ? null : await signBytes(user.keys.privateKey, messageBytes);
        const signatures = behavior === "drop-others"
          ? Object.fromEntries(Object.keys(tx.signatures).map((key) => [key, key === user.address ? own : null]))
          : { ...tx.signatures, [user.address]: own };
        return { ...tx, messageBytes, signatures, lifetimeConstraint: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } };
      }));
    },
  };
  return signer as unknown as TransactionModifyingSigner & { calls: number };
}

async function bundle(overrides: Partial<PreparedTxs> = {}): Promise<PreparedTxs> {
  return {
    keeperFundingTx: await prepared(0, { tag: 1 }),
    routeInitTxs: [await prepared(0, { coSigner: true, tag: 2 }), await prepared(0, { coSigner: true, tag: 3 })],
    orchestratorInitTx: await prepared("legacy", { tag: 4 }),
    sessionInitTxs: [await prepared(0, { coSigner: true, tag: 5 }), await prepared(0, { coSigner: true, tag: 6 })],
    dispersionInitTxs: [],
    recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100, nothingToDo: false,
    ...overrides,
  };
}

beforeAll(async () => { user = await keyPair(); ephemeral = await keyPair(); });

describe("planBundle", () => {
  it("decodes groups in documented broadcast order and skips null/empty groups", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    expect(steps.map((s) => `${s.group}:${s.index}:${s.version}`)).toEqual([
      "keeperFunding:0:0", "routeInit:0:0", "routeInit:1:0", "orchestratorInit:0:legacy", "sessionInit:0:0", "sessionInit:1:0",
    ]);
    const resumed = planBundle(await bundle({ keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null }), user.address, BOTH);
    expect(resumed.map((s) => s.group)).toEqual(["sessionInit", "sessionInit"]);
    expect(planBundle(await bundle({ keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }), user.address, BOTH)).toEqual([]);
  });

  it("refuses bundles the connected wallet cannot or should not sign", async () => {
    const ready = await bundle();
    const codeOf = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return error instanceof RoutingBundleError ? error.code : String(error); } };
    expect(codeOf(() => planBundle(ready, user.address, new Set([0])))).toBe("WALLET_VERSION_UNSUPPORTED"); // orchestratorInitTx is legacy
    expect(() => planBundle(ready, user.address, new Set(["legacy"]))).toThrow(/version 0/);
    expect(codeOf(() => planBundle(ready, ephemeral.address, BOTH))).toBe("WALLET_NOT_SIGNER");
    expect(codeOf(() => planBundle({ ...ready, keeperFundingTx: "AQID" }, user.address, BOTH))).toBe("MALFORMED_TRANSACTION");
  });
});

describe("signBundle", () => {
  it("asks the wallet once and preserves MultiHopper's partial signatures (v0) alongside the wallet's", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    const signer = wallet();
    const signed = await signBundle(steps, signer, user.address);
    expect(signer.calls).toBe(1);
    const userKey = await getPublicKeyFromAddress(user.address);
    const ephemeralKey = await getPublicKeyFromAddress(ephemeral.address);
    for (const [i, step] of signed.entries()) {
      expect(step.transaction.messageBytes).toEqual(steps[i].transaction.messageBytes);
      expect(Object.keys(step.transaction.signatures)).toEqual(Object.keys(steps[i].transaction.signatures)); // slot order kept
      expect(await verifySignature(userKey, step.transaction.signatures[user.address] as SignatureBytes, step.transaction.messageBytes)).toBe(true);
      const serverSignature = steps[i].transaction.signatures[ephemeral.address];
      if (serverSignature) {
        expect(step.transaction.signatures[ephemeral.address]).toEqual(serverSignature);
        expect(await verifySignature(ephemeralKey, serverSignature, step.transaction.messageBytes)).toBe(true);
      }
    }
    // The re-encoded wire bytes decode to the same fully signed transaction.
    const roundTrip = getTransactionDecoder().decode(getBase64Encoder().encode(getBase64EncodedWireTransaction(signed[1].transaction)));
    expect(roundTrip.signatures).toEqual(signed[1].transaction.signatures);
  });

  it("restores server signatures even when a wallet drops them", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    const signed = await signBundle(steps, wallet("drop-others"), user.address);
    expect(signed[1].transaction.signatures[ephemeral.address]).toEqual(steps[1].transaction.signatures[ephemeral.address]);
    expect(Object.values(signed[1].transaction.signatures).every(Boolean)).toBe(true);
  });

  it("rejects a wallet that modifies a prepared message or omits its signature, before anything is sent", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    await expect(signBundle(steps, wallet("modify"), user.address)).rejects.toMatchObject({ code: "WALLET_MODIFIED_TRANSACTION" });
    await expect(signBundle(steps, wallet("skip"), user.address)).rejects.toMatchObject({ code: "WALLET_SIGNATURE_MISSING" });
  });

  it("refuses to send a transaction still missing a server signature", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    const unsignedByServer: BundleStep[] = steps.map((step) => step.transaction.signatures[ephemeral.address]
      ? { ...step, transaction: { ...step.transaction, signatures: { ...step.transaction.signatures, [ephemeral.address]: null } } as Transaction } : step);
    await expect(signBundle(unsignedByServer, wallet(), user.address)).rejects.toMatchObject({ code: "INCOMPLETE_SIGNATURES" });
  });
});

describe("executeBundle ordering", () => {
  async function run(overrides: { failAt?: string; confirmFailsAt?: "keeperFunding" | "final"; prepared?: Partial<PreparedTxs> } = {}) {
    const steps = await signBundle(planBundle(await bundle(overrides.prepared), user.address, BOTH), wallet(), user.address);
    const log: string[] = [];
    const confirmations: ConfirmBroadcastBody[] = [];
    const result = executeBundle({
      steps,
      sendAndConfirm: async (step) => {
        const key = `${step.group}:${step.index}`;
        log.push(`send ${key}`);
        if (key === overrides.failAt) throw new RoutingBundleError("TRANSACTION_FAILED", "failed onchain");
        return `sig-${key}`;
      },
      confirmBroadcast: async (body) => {
        const stage = body.routeInitSignatures.length === 0 && !body.orchestratorInitSignature && !body.sessionInitSignatures && body.keeperFundingSignature ? "keeperFunding" : "final";
        log.push(`confirm ${stage}`); confirmations.push(body);
        if (stage === overrides.confirmFailsAt) throw new Error("confirm-broadcast unavailable");
        return { status: "processing" };
      },
      sleep: async (ms) => { log.push(`wait ${ms}`); },
    });
    return { result, log, confirmations };
  }

  it("broadcasts keeper funding first, records it immediately, then the rest in order with settle delays", async () => {
    const { result, log, confirmations } = await run();
    await expect(result).resolves.toMatchObject({ transfer: { status: "processing" } });
    expect(log).toEqual([
      "send keeperFunding:0", "confirm keeperFunding",
      "send routeInit:0", "wait 3000", "send routeInit:1", "wait 3000",
      "send orchestratorInit:0", "wait 3000",
      "send sessionInit:0", "send sessionInit:1",
      "confirm final",
    ]);
    expect(confirmations[0]).toEqual({ routeInitSignatures: [], keeperFundingSignature: "sig-keeperFunding:0" });
    expect(confirmations[1]).toEqual({
      routeInitSignatures: ["sig-routeInit:0", "sig-routeInit:1"], keeperFundingSignature: "sig-keeperFunding:0",
      orchestratorInitSignature: "sig-orchestratorInit:0", sessionInitSignatures: ["sig-sessionInit:0", "sig-sessionInit:1"],
    });
  });

  it("stops before any other transaction when recording keeper funding fails", async () => {
    const { result, log } = await run({ confirmFailsAt: "keeperFunding" });
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BundleExecutionError);
    expect((error as BundleExecutionError).landed).toEqual({ routeInitSignatures: [], keeperFundingSignature: "sig-keeperFunding:0" });
    expect(log).toEqual(["send keeperFunding:0", "confirm keeperFunding"]);
  });

  it("stops at a partial failure, reports what landed and never sends the final confirmation", async () => {
    const { result, log } = await run({ failAt: "routeInit:1" });
    const error = (await result.catch((e: unknown) => e)) as BundleExecutionError;
    expect(error.stage).toBe("Route setup 2 of 2");
    expect(error.landed).toEqual({ routeInitSignatures: ["sig-routeInit:0"], keeperFundingSignature: "sig-keeperFunding:0" });
    expect(log).not.toContain("confirm final");
    expect(log.at(-1)).toBe("send routeInit:1");
  });

  it("on resume sends only what /prepare still returns, and nothing-to-do goes straight to the final confirmation", async () => {
    const resumed = await run({ prepared: { keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null } });
    await resumed.result;
    expect(resumed.log).toEqual(["send sessionInit:0", "send sessionInit:1", "confirm final"]);
    expect(resumed.confirmations[0]).toEqual({ routeInitSignatures: [], sessionInitSignatures: ["sig-sessionInit:0", "sig-sessionInit:1"] });
    const nothing = await run({ prepared: { keeperFundingTx: null, routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [], nothingToDo: true } });
    await nothing.result;
    expect(nothing.log).toEqual(["confirm final"]);
    expect(nothing.confirmations[0]).toEqual({ routeInitSignatures: [] });
  });

  it("reports a failed final broadcast confirmation with every landed signature", async () => {
    const { result } = await run({ confirmFailsAt: "final" });
    const error = (await result.catch((e: unknown) => e)) as BundleExecutionError;
    expect(error.stage).toBe("Final broadcast confirmation");
    expect(error.landed.sessionInitSignatures).toEqual(["sig-sessionInit:0", "sig-sessionInit:1"]);
  });
});

describe("executeBundle keeper-funding hooks", () => {
  it("routes only keeperFundingTx through the tracked send and the MH_036-tolerant confirmation", async () => {
    const steps = await signBundle(planBundle(await bundle({ routeInitTxs: [], orchestratorInitTx: null }), user.address, BOTH), wallet(), user.address);
    const log: string[] = [];
    await executeBundle({
      steps,
      sendAndConfirm: async (step) => { log.push(`plain send ${step.group}`); return `sig-${step.group}-${step.index}`; },
      confirmBroadcast: async (body) => { log.push(`plain confirm ${body.sessionInitSignatures ? "final" : "keeper"}`); return {}; },
      keeperFunding: {
        send: async (step) => { log.push(`tracked send ${step.group}`); return "sig-keeper"; },
        confirm: async (body) => { log.push(`tracked confirm ${body.keeperFundingSignature}`); return {}; },
      },
      sleep: async () => {},
    });
    expect(log).toEqual(["tracked send keeperFunding", "tracked confirm sig-keeper", "plain send sessionInit", "plain send sessionInit", "plain confirm final"]);
  });
});

describe("sendAndConfirmTransaction", () => {
  type Status = { confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null;
  type Finalized = { blockHeight: bigint; absoluteSlot: bigint };
  async function signedTransaction() {
    const [step] = await signBundle(planBundle(await bundle({ routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }), user.address, BOTH), wallet(), user.address);
    return step.transaction;
  }
  /** A scripted devnet RPC. Each method replays its script and then repeats the last entry. */
  function chain(script: { send?: unknown[]; statuses?: (Status | Error)[]; finalized?: (Finalized | Error)[]; statusSlot?: bigint } = {}) {
    const next = <T>(list: T[], fallback: T): T => (list.length > 1 ? list.shift()! : list[0] ?? fallback);
    const sends = [...(script.send ?? [])];
    const statuses = [...(script.statuses ?? [null])];
    const finalized = [...(script.finalized ?? [{ blockHeight: 50n, absoluteSlot: 60n }])];
    const sendTransaction = vi.fn(() => ({ send: async () => { const outcome = sends.shift(); if (outcome) throw outcome; return "sig"; } }));
    const getSignatureStatuses = vi.fn(() => ({ send: async () => {
      const status = next<Status | Error>(statuses, null);
      if (status instanceof Error) throw status;
      return { context: { slot: script.statusSlot ?? 10_000n }, value: [status] };
    } }));
    const getEpochInfo = vi.fn(() => ({ send: async () => {
      const epoch = next<Finalized | Error>(finalized, { blockHeight: 50n, absoluteSlot: 60n });
      if (epoch instanceof Error) throw epoch;
      return epoch;
    } }));
    const getBlockHeight = vi.fn(() => ({ send: async () => 50n }));
    return { rpc: { sendTransaction, getSignatureStatuses, getEpochInfo, getBlockHeight } as unknown as BroadcastRpc, sendTransaction, getEpochInfo };
  }
  /** Virtual time: every read advances one second, so budgets elapse without real waiting. */
  const options = (overrides: Record<string, unknown> = {}) => {
    let time = 0;
    return { lastValidBlockHeight: 100, sleep: async () => {}, pollIntervalMs: 1_000, rebroadcastIntervalMs: 2_000, timeoutMs: 60_000, now: () => (time += 1_000), ...overrides };
  };
  const confirmed: Status = { confirmationStatus: "confirmed", err: null };
  const notYetExpired: Finalized = { blockHeight: 90n, absoluteSlot: 140n };
  const expired: Finalized = { blockHeight: 101n, absoluteSlot: 180n };

  it("sends base64 wire bytes with preflight and waits for confirmed", async () => {
    const transaction = await signedTransaction();
    const { rpc, sendTransaction } = chain({ statuses: [null, { confirmationStatus: "processed", err: null }, confirmed] });
    await expect(sendAndConfirmTransaction(rpc, transaction, options())).resolves.toBe(getSignatureFromTransaction(transaction));
    expect(sendTransaction).toHaveBeenCalledExactlyOnceWith(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" });
  });

  it("a broadcast request that times out but later lands is confirmed, re-sending only the identical bytes", async () => {
    const transaction = await signedTransaction();
    const { rpc, sendTransaction } = chain({ send: [rpcErrors.timedOut()], statuses: [null, null, null, null, null, confirmed], finalized: [notYetExpired] });
    await expect(sendAndConfirmTransaction(rpc, transaction, options())).resolves.toBe(getSignatureFromTransaction(transaction));
    expect(sendTransaction.mock.calls.length).toBeGreaterThan(1);
    for (const [wire] of sendTransaction.mock.calls as unknown as [string][]) expect(wire).toBe(getBase64EncodedWireTransaction(transaction));
  });

  it.each([
    ["a network failure", rpcErrors.networkDown],
    ["a request timeout", rpcErrors.timedOut],
    ["an HTTP 503 from the RPC", rpcErrors.httpUnavailable],
    ["-32005 node unhealthy", rpcErrors.nodeUnhealthy],
    ["a plain error whose message mentions simulation", rpcErrors.lookalike],
  ])("treats %s as ambiguous: never 'rejected', and 'never landed' only after finalized expiry", async (_, makeError) => {
    expect(isDefinitivePreflightRejection(makeError())).toBe(false);
    const transaction = await signedTransaction();
    const { rpc, sendTransaction } = chain({ send: [makeError()], statuses: [null], finalized: [notYetExpired, notYetExpired, notYetExpired, expired], statusSlot: 200n });
    const error = await sendAndConfirmTransaction(rpc, transaction, options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BLOCKHASH_EXPIRED" });
    expect(sendTransaction.mock.calls.length).toBeGreaterThan(1); // the same bytes were re-sent while waiting
  });

  it("never reports a failure when the outcome cannot be established", async () => {
    const rpcDown = chain({ send: [rpcErrors.networkDown()], statuses: [rpcErrors.networkDown()] });
    await expect(sendAndConfirmTransaction(rpcDown.rpc, await signedTransaction(), options({ timeoutMs: 20_000 }))).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const noExpiry = chain({ send: [rpcErrors.timedOut()], statuses: [null] });
    await expect(sendAndConfirmTransaction(noExpiry.rpc, await signedTransaction(), options({ lastValidBlockHeight: null, timeoutMs: 20_000 }))).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("does not conclude 'never landed' from a status view that is behind the finalized expiry", async () => {
    const lagging = chain({ statuses: [null], finalized: [expired], statusSlot: 150n }); // 150 < finalized slot 180
    await expect(sendAndConfirmTransaction(lagging.rpc, await signedTransaction(), options({ timeoutMs: 20_000 }))).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const caughtUp = chain({ statuses: [null], finalized: [expired], statusSlot: 180n });
    await expect(sendAndConfirmTransaction(caughtUp.rpc, await signedTransaction(), options())).rejects.toMatchObject({ code: "BLOCKHASH_EXPIRED" });
  });

  it("waits while only the finalized chain is still within the validity window", async () => {
    const { rpc, getEpochInfo } = chain({ statuses: [null, null, null, confirmed], finalized: [notYetExpired] });
    await expect(sendAndConfirmTransaction(rpc, await signedTransaction(), options())).resolves.toBeTypeOf("string");
    expect(getEpochInfo).toHaveBeenCalledWith({ commitment: "finalized" });
  });

  it("retries a definitive preflight rejection twice (lagging devnet node, audit M6), then reports it without watching the chain", async () => {
    expect(isDefinitivePreflightRejection(rpcErrors.preflightRejected())).toBe(true);
    const sleeps: number[] = [];
    const { rpc, sendTransaction, getEpochInfo } = chain({ send: [rpcErrors.preflightRejected(), rpcErrors.preflightRejected(), rpcErrors.preflightRejected()], statuses: [null] });
    const transaction = await signedTransaction();
    await expect(sendAndConfirmTransaction(rpc, transaction, options({ sleep: async (ms: number) => { sleeps.push(ms); } }))).rejects.toMatchObject({ code: "BROADCAST_REJECTED" });
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    for (const [wire] of sendTransaction.mock.calls as unknown as [string][]) expect(wire).toBe(getBase64EncodedWireTransaction(transaction)); // identical bytes only
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(getEpochInfo).not.toHaveBeenCalled();
  });

  it("a rejection from a node that had not seen an earlier transaction yet succeeds on retry", async () => {
    const { rpc, sendTransaction } = chain({ send: [rpcErrors.preflightRejected()], statuses: [null, confirmed] });
    await expect(sendAndConfirmTransaction(rpc, await signedTransaction(), options())).resolves.toBeTypeOf("string");
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("can disable preflight retries", async () => {
    const { rpc, sendTransaction } = chain({ send: [rpcErrors.preflightRejected()], statuses: [null] });
    await expect(sendAndConfirmTransaction(rpc, await signedTransaction(), options({ preflightRetries: 0 }))).rejects.toMatchObject({ code: "BROADCAST_REJECTED" });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats AlreadyProcessed and rejections contradicted by an existing status as landed", async () => {
    expect(isDefinitivePreflightRejection(rpcErrors.alreadyProcessed())).toBe(false);
    await expect(sendAndConfirmTransaction(chain({ send: [rpcErrors.alreadyProcessed()], statuses: [confirmed] }).rpc, await signedTransaction(), options())).resolves.toBeTypeOf("string");
    await expect(sendAndConfirmTransaction(chain({ send: [rpcErrors.preflightRejected()], statuses: [confirmed] }).rpc, await signedTransaction(), options())).resolves.toBeTypeOf("string");
  });

  it("classifies errors produced by Kit's real RPC pipeline from Agave's JSON-RPC payloads", async () => {
    type Transport = Parameters<typeof createSolanaRpcFromTransport>[0];
    const respond = (error: object | null, method: string) => createSolanaRpcFromTransport((async ({ payload }: { payload: unknown }) => {
      const { id, method: called } = payload as { id: number; method: string };
      if (called === "sendTransaction") return error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result: "sig" };
      if (called === "getSignatureStatuses") return { jsonrpc: "2.0", id, result: { context: { slot: 10 }, value: [method === "landed" ? { slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed", status: { Ok: null } } : null] } };
      return { jsonrpc: "2.0", id, result: { absoluteSlot: 1, blockHeight: 1, epoch: 0, slotIndex: 1, slotsInEpoch: 1, transactionCount: 0 } };
    }) as unknown as Transport) as unknown as BroadcastRpc;
    const rejected = { code: -32002, message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound", logs: [] } };
    await expect(sendAndConfirmTransaction(respond(rejected, "missing"), await signedTransaction(), options())).rejects.toMatchObject({ code: "BROADCAST_REJECTED" });
    const unhealthy = { code: -32005, message: "Node is behind by 42 slots", data: { numSlotsBehind: 42 } };
    await expect(sendAndConfirmTransaction(respond(unhealthy, "landed"), await signedTransaction(), options())).resolves.toBeTypeOf("string");
  });

  it("treats a confirmed onchain error as final, but a processed-only error as still pending", async () => {
    const failed = chain({ statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] });
    await expect(sendAndConfirmTransaction(failed.rpc, await signedTransaction(), options())).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const forked = chain({ statuses: [{ confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }, confirmed] });
    await expect(sendAndConfirmTransaction(forked.rpc, await signedTransaction(), options())).resolves.toBeTypeOf("string");
  });

  it("detects an expired bundle before broadcasting anything", async () => {
    const height = (value: bigint) => ({ getBlockHeight: () => ({ send: async () => value }) }) as unknown as BroadcastRpc;
    await expect(assertBundleNotExpired(height(101n), 100)).rejects.toMatchObject({ code: "BLOCKHASH_EXPIRED" });
    await expect(assertBundleNotExpired(height(100n), 100)).resolves.toBeUndefined();
  });
});
