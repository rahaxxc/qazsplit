// @vitest-environment jsdom
import {
  appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, generateKeyPair, getAddressFromPublicKey, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLifetimeUsingDurableNonce, signTransaction,
  type Address, type Blockhash, type Nonce, type Transaction,
} from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RoutingApiError } from "./client";
import {
  assertKeeperFundingTrackable, assertNoDuplicateKeeperFunding, keeperFundingNotice, readKeeperFunding, reconcileKeeperFunding, recordKeeperFunding,
  saveKeeperFunding, sendTrackedKeeperFunding, type KeeperFundingRecord, type KeeperFundingState,
} from "./keeper-funding";
import { RoutingBundleError, type BroadcastRpc, type BundleStep } from "./transactions";

const TRANSFER = 42;
const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as Blockhash;
const OTHER_BLOCKHASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as Blockhash;
const PROGRAM = "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh" as Address;
const NONCE_ACCOUNT = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ" as Address;
const prepared: { recentBlockhash: string | null; lastValidBlockHeight: number | null } = { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100 };
let keys: CryptoKeyPair;
let payer: Address;
let keeperTx: Transaction;
let signature: string;

async function keeperTransaction(lifetime: "blockhash" | "nonce" = "blockhash", blockhash: Blockhash = BLOCKHASH): Promise<Transaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => lifetime === "nonce"
      ? setTransactionMessageLifetimeUsingDurableNonce({ nonce: blockhash as string as Nonce, nonceAccountAddress: NONCE_ACCOUNT, nonceAuthorityAddress: payer }, m)
      : setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: PROGRAM, accounts: [], data: new Uint8Array([1]) }, m),
  );
  return signTransaction([keys], compileTransaction(message));
}
const step = (transaction: Transaction): BundleStep => ({
  group: "keeperFunding", index: 0, transaction, version: 0,
  review: { version: 0, feePayer: "", signers: [], programs: [], systemOutflowLamports: 0n, hasComputeBudget: false },
});

type Status = { confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null;
type Finalized = { blockHeight: bigint; absoluteSlot: bigint };
/** Scripted devnet RPC; each method replays its script, then repeats the last entry. */
function chain(script: { statuses?: (Status | Error)[]; finalized?: (Finalized | Error)[]; statusSlot?: bigint } = {}) {
  const next = <T>(list: T[], fallback: T): T => (list.length > 1 ? list.shift()! : list[0] ?? fallback);
  const statuses = [...(script.statuses ?? [null])];
  const finalized = [...(script.finalized ?? [{ blockHeight: 90n, absoluteSlot: 140n }])];
  const getSignatureStatuses = vi.fn(() => ({ send: async () => {
    const status = next<Status | Error>(statuses, null);
    if (status instanceof Error) throw status;
    return { context: { slot: script.statusSlot ?? 10_000n }, value: [status] };
  } }));
  const getEpochInfo = vi.fn(() => ({ send: async () => {
    const epoch = next<Finalized | Error>(finalized, { blockHeight: 90n, absoluteSlot: 140n });
    if (epoch instanceof Error) throw epoch;
    return epoch;
  } }));
  return { rpc: { getSignatureStatuses, getEpochInfo } as unknown as BroadcastRpc, getSignatureStatuses, getEpochInfo };
}
const landedStatus: Status = { confirmationStatus: "confirmed", err: null };
const expiredFinalized: Finalized = { blockHeight: 101n, absoluteSlot: 180n };
const mh036 = () => new RoutingApiError(404, "MH_036", "Broadcast signature not found on chain");
const record = (state: KeeperFundingState): KeeperFundingRecord => ({
  v: 1, transferId: TRANSFER, signature, blockhash: BLOCKHASH, lastValidBlockHeight: 100, state, updatedAt: "2026-11-15T09:00:00.000Z",
});
const stateOf = () => { const read = readKeeperFunding(TRANSFER); return read.status === "record" ? read.record.state : read.status; };
const reconcile = (rpc: BroadcastRpc, confirm = vi.fn(async () => ({}))) =>
  reconcileKeeperFunding({ transferId: TRANSFER, rpc, confirm, delaysMs: [1, 1], sleep: async () => {} });

beforeAll(async () => {
  keys = await generateKeyPair();
  payer = await getAddressFromPublicKey(keys.publicKey);
  keeperTx = await keeperTransaction();
  signature = getSignatureFromTransaction(keeperTx);
});
beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("tracked keeper-funding send", () => {
  it("writes the record before the first byte is sent and marks it landed once confirmed", async () => {
    const send = vi.fn(async () => {
      expect(readKeeperFunding(TRANSFER)).toMatchObject({ status: "record", record: { state: "sending", signature, blockhash: BLOCKHASH, lastValidBlockHeight: 100 } });
      return signature;
    });
    await expect(sendTrackedKeeperFunding({ transferId: TRANSFER, transaction: keeperTx, prepared, send })).resolves.toBe(signature);
    expect(send).toHaveBeenCalledTimes(1);
    expect(stateOf()).toBe("landed");
  });

  it.each([
    ["OUTCOME_UNKNOWN", "sending"],      // may still land: keep blocking
    ["BROADCAST_REJECTED", "rejected"],  // definitive, but still reconciled before any new bundle
    ["BLOCKHASH_EXPIRED", "none"],       // proven never landed
    ["TRANSACTION_FAILED", "none"],      // landed and failed: nothing was funded
  ])("after %s the record is %s", async (code, expected) => {
    const send = vi.fn(async () => { throw new RoutingBundleError(code, code, signature); });
    await expect(sendTrackedKeeperFunding({ transferId: TRANSFER, transaction: keeperTx, prepared, send })).rejects.toMatchObject({ code });
    expect(stateOf()).toBe(expected);
  });

  it("refuses to send when this browser cannot store the record", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const send = vi.fn(async () => signature);
    await expect(sendTrackedKeeperFunding({ transferId: TRANSFER, transaction: keeperTx, prepared, send })).rejects.toMatchObject({ code: "KEEPER_JOURNAL_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("keeper-funding trackability (checked before the wallet prompt)", () => {
  it("accepts a blockhash-based keeper funding that matches the bundle", () => {
    expect(() => assertKeeperFundingTrackable(prepared, [step(keeperTx)])).not.toThrow();
    expect(() => assertKeeperFundingTrackable({ recentBlockhash: null, lastValidBlockHeight: null }, [])).not.toThrow(); // no keeper funding in bundle
  });

  it.each([
    ["no lastValidBlockHeight", async () => ({ prepared: { ...prepared, lastValidBlockHeight: null }, tx: keeperTx })],
    ["no recentBlockhash", async () => ({ prepared: { ...prepared, recentBlockhash: null }, tx: keeperTx })],
    ["a different blockhash than the bundle", async () => ({ prepared, tx: await keeperTransaction("blockhash", OTHER_BLOCKHASH) })],
    ["a durable nonce (never expires by height)", async () => ({ prepared, tx: await keeperTransaction("nonce") })],
  ])("refuses %s, before signing and before sending", async (_, setup) => {
    const { prepared: bundle, tx } = await setup();
    expect(() => assertKeeperFundingTrackable(bundle, [step(tx)])).toThrowError(RoutingBundleError);
    const send = vi.fn(async () => "x");
    await expect(sendTrackedKeeperFunding({ transferId: TRANSFER, transaction: tx, prepared: bundle, send })).rejects.toMatchObject({ code: "KEEPER_FUNDING_UNTRACKABLE" });
    expect(send).not.toHaveBeenCalled();
    expect(stateOf()).toBe("none");
  });
});

describe("recording keeper funding (confirm-broadcast #1)", () => {
  it("MH_036 is retried with the same signature until MultiHopper records it", async () => {
    saveKeeperFunding(record("landed"));
    const sleep = vi.fn(async () => {});
    const confirm = vi.fn().mockRejectedValueOnce(mh036()).mockRejectedValueOnce(mh036()).mockResolvedValueOnce({ transfer: null });
    await recordKeeperFunding({ transferId: TRANSFER, signature, confirm, delaysMs: [2_000, 4_000, 8_000], sleep });
    expect(confirm).toHaveBeenCalledTimes(3);
    for (const [body] of confirm.mock.calls) expect(body).toEqual({ routeInitSignatures: [], keeperFundingSignature: signature });
    expect(sleep.mock.calls).toEqual([[2_000], [4_000]]);
    expect(stateOf()).toBe("recorded");
  });

  it("stops after bounded retries, leaving the funding landed but unrecorded", async () => {
    saveKeeperFunding(record("landed"));
    const confirm = vi.fn(async () => { throw mh036(); });
    await expect(recordKeeperFunding({ transferId: TRANSFER, signature, confirm, delaysMs: [1, 1], sleep: async () => {} })).rejects.toMatchObject({ code: "MH_036" });
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(stateOf()).toBe("landed");
  });

  it("does not retry errors that are not transient", async () => {
    const confirm = vi.fn(async () => { throw new RoutingApiError(422, "MH_037", "failed onchain"); });
    await expect(recordKeeperFunding({ transferId: TRANSFER, signature, confirm, delaysMs: [1, 1], sleep: async () => {} })).rejects.toMatchObject({ code: "MH_037" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("reconciliation before Resume", () => {
  it("is clear when nothing was ever sent from this device", async () => {
    const { rpc, getSignatureStatuses } = chain();
    await expect(reconcile(rpc)).resolves.toEqual({ outcome: "clear" });
    expect(getSignatureStatuses).not.toHaveBeenCalled();
  });

  it.each([
    ["not visible yet and still within its validity window", { statuses: [null], finalized: [{ blockHeight: 90n, absoluteSlot: 140n }] }],
    ["only processed so far", { statuses: [{ confirmationStatus: "processed", err: null } as Status] }],
  ])("stays pending while the transaction is %s, without contacting MultiHopper", async (_, script) => {
    saveKeeperFunding(record("sending"));
    const confirm = vi.fn(async () => ({}));
    await expect(reconcile(chain(script).rpc, confirm)).resolves.toMatchObject({ outcome: "pending", reason: "in-flight", signature });
    expect(confirm).not.toHaveBeenCalled();
    expect(stateOf()).toBe("sending");
  });

  it("clears the record only when the blockhash expired at finalized and a caught-up view shows it never landed", async () => {
    saveKeeperFunding(record("sending"));
    await expect(reconcile(chain({ statuses: [null], finalized: [expiredFinalized], statusSlot: 150n }).rpc)).resolves.toMatchObject({ outcome: "unknown" });
    expect(stateOf()).toBe("sending");
    await expect(reconcile(chain({ statuses: [null], finalized: [expiredFinalized], statusSlot: 180n }).rpc)).resolves.toEqual({ outcome: "clear" });
    expect(stateOf()).toBe("none");
  });

  it("reports unknown, never clear, when the RPC cannot answer", async () => {
    saveKeeperFunding(record("sending"));
    await expect(reconcile(chain({ statuses: [new TypeError("fetch failed")] }).rpc)).resolves.toMatchObject({ outcome: "unknown", signature });
    await expect(reconcile(chain({ statuses: [null], finalized: [new TypeError("fetch failed")] }).rpc)).resolves.toMatchObject({ outcome: "unknown" });
    expect(stateOf()).toBe("sending");
  });

  it("records a keeper funding that landed, so MultiHopper acknowledges it before anything is prepared", async () => {
    saveKeeperFunding(record("sending"));
    const confirm = vi.fn(async () => ({}));
    await expect(reconcile(chain({ statuses: [landedStatus] }).rpc, confirm)).resolves.toEqual({ outcome: "recorded", signature });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ routeInitSignatures: [], keeperFundingSignature: signature });
    expect(stateOf()).toBe("recorded");
  });

  it("MH_036 followed by successful reconciliation: pending first, recorded once MultiHopper sees it", async () => {
    saveKeeperFunding(record("landed"));
    const lagging = vi.fn(async () => { throw mh036(); });
    await expect(reconcile(chain().rpc, lagging)).resolves.toMatchObject({ outcome: "pending", reason: "unrecorded", message: expect.stringContaining("MH_036") });
    expect(stateOf()).toBe("landed");
    const caughtUp = vi.fn(async () => ({}));
    await expect(reconcile(chain().rpc, caughtUp)).resolves.toEqual({ outcome: "recorded", signature });
    expect(stateOf()).toBe("recorded");
  });

  it("clears a keeper funding that failed onchain (nothing was funded)", async () => {
    saveKeeperFunding(record("sending"));
    await expect(reconcile(chain({ statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] }).rpc)).resolves.toEqual({ outcome: "clear" });
  });

  it("resolves a definitive preflight rejection quickly, unless a status contradicts it", async () => {
    saveKeeperFunding(record("rejected"));
    const notFound = chain({ statuses: [null] });
    await expect(reconcile(notFound.rpc)).resolves.toEqual({ outcome: "clear" });
    expect(notFound.getEpochInfo).not.toHaveBeenCalled();
    saveKeeperFunding(record("rejected"));
    await expect(reconcile(chain({ statuses: [landedStatus] }).rpc)).resolves.toEqual({ outcome: "recorded", signature });
  });

  it("treats MH_035 as resolved: the transfer has moved past keeper funding", async () => {
    saveKeeperFunding(record("landed"));
    await expect(reconcile(chain().rpc, vi.fn(async () => { throw new RoutingApiError(409, "MH_035", "not allowed"); }))).resolves.toEqual({ outcome: "recorded", signature });
  });

  it("needs no RPC or API call once recorded, and blocks on an unreadable record", async () => {
    saveKeeperFunding(record("recorded"));
    const { rpc, getSignatureStatuses } = chain();
    const confirm = vi.fn(async () => ({}));
    await expect(reconcile(rpc, confirm)).resolves.toEqual({ outcome: "recorded", signature });
    expect(getSignatureStatuses).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    window.localStorage.setItem(`qazsplit:multihopper:v1:keeper-funding:${TRANSFER}`, "{corrupt");
    await expect(reconcile(rpc)).resolves.toMatchObject({ outcome: "unknown", signature: null });
  });

  it("repeated Resume attempts stay blocked until the chain proves an outcome", async () => {
    saveKeeperFunding(record("sending"));
    const confirm = vi.fn(async () => ({}));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(reconcile(chain({ statuses: [null], finalized: [{ blockHeight: 95n + BigInt(attempt), absoluteSlot: 150n }] }).rpc, confirm)).resolves.toMatchObject({ outcome: "pending" });
      expect(stateOf()).toBe("sending");
    }
    expect(confirm).not.toHaveBeenCalled();
    await expect(reconcile(chain({ statuses: [null], finalized: [expiredFinalized], statusSlot: 200n }).rpc, confirm)).resolves.toEqual({ outcome: "clear" });
  });

  it("two tabs share one record: a funding sent in one tab blocks the other until reconciled", async () => {
    let finishFirstTab!: () => void;
    const firstTab = sendTrackedKeeperFunding({ transferId: TRANSFER, transaction: keeperTx, prepared,
      send: () => new Promise<string>((_, reject) => { finishFirstTab = () => reject(new RoutingBundleError("OUTCOME_UNKNOWN", "unknown", signature)); }) });
    // Second tab (same browser storage) tries to resume while the first tab's broadcast is unresolved.
    await expect(reconcile(chain({ statuses: [null] }).rpc)).resolves.toMatchObject({ outcome: "pending" });
    expect(keeperFundingNotice(TRANSFER)).toMatchObject({ kind: "needs-check", signature });
    finishFirstTab();
    await expect(firstTab).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(reconcile(chain({ statuses: [null] }).rpc)).resolves.toMatchObject({ outcome: "pending" });
  });
});

describe("duplicate keeper-funding guard and notices", () => {
  it("refuses a second keeper funding after MultiHopper recorded the first", () => {
    expect(() => assertNoDuplicateKeeperFunding({ keeperFundingTx: "AQAB" }, { outcome: "recorded", signature })).toThrowError(/won't sign a second one/);
    expect(() => assertNoDuplicateKeeperFunding({ keeperFundingTx: null }, { outcome: "recorded", signature })).not.toThrow();
    expect(() => assertNoDuplicateKeeperFunding({ keeperFundingTx: "AQAB" }, { outcome: "clear" })).not.toThrow();
  });

  it("asks the UI to show a check for unresolved records only", () => {
    expect(keeperFundingNotice(TRANSFER)).toBeNull();
    for (const [state, kind] of [["sending", "needs-check"], ["landed", "needs-check"], ["rejected", null], ["recorded", null]] as const) {
      saveKeeperFunding(record(state));
      expect(keeperFundingNotice(TRANSFER)?.kind ?? null).toBe(kind);
    }
  });
});
