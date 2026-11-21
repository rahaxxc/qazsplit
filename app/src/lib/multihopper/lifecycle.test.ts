// @vitest-environment jsdom
import { getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoutingApiError, type RoutingTransfer } from "./client";
import { PROGRAMS } from "./inspection";
import {
  addSpentLamports, ensureActivated, mergeBroadcastSignatures, outflowLimitLamports, readBroadcastSignatures, readSpentLamports, requiredBalanceLamports,
  saveBroadcastSignatures, signatureEntry, verifyDelivery, type DeliveryRpc,
} from "./lifecycle";
import type { PreparedTxs } from "./transactions";

const sig = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const destination = "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8";
const keeper = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";

const transfer = (status: string, overrides: Partial<RoutingTransfer> = {}): RoutingTransfer => ({
  id: 42, externalId: "qzs-a", supportBundleId: null, status, phase: null, progress: null, lastError: null, amountLamports: "50000000",
  recipientWallet: destination, recipientReceivesLamports: "49751243", hops: 3, arrivalSeconds: 300, pricingTier: null, percentFeeBps: 50,
  percentFeeLamports: null, totalFlatFeeLamports: 0, isTest: true, quotedAt: null, expiresAt: null, createdAt: "2026-11-21T10:00:00.000Z",
  completedAt: null, hopSignatures: [], route: null, ...overrides,
});
const bundle = (nothingToDo: boolean): PreparedTxs => ({
  keeperFundingTx: null, routeInitTxs: nothingToDo ? [] : ["AQID"], orchestratorInitTx: null, sessionInitTxs: [], dispersionInitTxs: [],
  recentBlockhash: null, lastValidBlockHeight: null, nothingToDo,
});

beforeEach(() => window.localStorage.clear());

describe("activation after the final confirm-broadcast (audit H1)", () => {
  function deps(script: { statuses?: string[]; prepared?: PreparedTxs | Error; reconfirmed?: string | Error }) {
    const statuses = [...(script.statuses ?? [])];
    const status = vi.fn(async () => transfer(statuses.length > 1 ? statuses.shift()! : statuses[0] ?? "awaiting_signature"));
    const prepare = vi.fn(async () => {
      if (script.prepared instanceof Error) throw script.prepared;
      return { transfer: transfer("awaiting_signature", { routeInitSignatures: [sig(9)] }), preparedTxs: script.prepared ?? bundle(true) };
    });
    const confirm = vi.fn(async () => {
      if (script.reconfirmed instanceof Error) throw script.reconfirmed;
      return transfer(script.reconfirmed ?? "awaiting_signature");
    });
    const sleep = vi.fn(async () => {});
    return { status, prepare, confirm, sleep, signatures: { routeInitSignatures: [sig(2)], keeperFundingSignature: sig(1), sessionInitSignatures: [sig(3)] } };
  }

  it("is activated when the confirm itself advanced the transfer, without extra calls", async () => {
    const d = deps({});
    await expect(ensureActivated(transfer("processing"), d)).resolves.toMatchObject({ state: "activated", transfer: { status: "processing" } });
    expect(d.status).not.toHaveBeenCalled();
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it("waits for MultiHopper's RPC to catch up when the confirm still shows the pre-broadcast state", async () => {
    const d = deps({ statuses: ["awaiting_signature", "processing"] });
    await expect(ensureActivated(transfer("awaiting_signature"), d)).resolves.toMatchObject({ state: "activated" });
    expect(d.status).toHaveBeenCalledTimes(2);
    expect(d.prepare).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("re-confirms once, with everything that landed, only when /prepare shows nothing missing", async () => {
    const d = deps({ statuses: ["awaiting_signature"], prepared: bundle(true), reconfirmed: "processing" });
    await expect(ensureActivated(null, d)).resolves.toMatchObject({ state: "activated", transfer: { status: "processing" } });
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.confirm).toHaveBeenCalledWith({ routeInitSignatures: [sig(2), sig(9)], keeperFundingSignature: sig(1), sessionInitSignatures: [sig(3)] });
  });

  it("asks for Resume, and confirms nothing, when /prepare still lists transactions that are not on chain", async () => {
    const d = deps({ statuses: ["awaiting_signature"], prepared: bundle(false) });
    await expect(ensureActivated(transfer("awaiting_signature"), d)).resolves.toMatchObject({ state: "needs-resume" });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("never reports activation while MultiHopper still shows the transfer awaiting signatures", async () => {
    const stalled = deps({ statuses: ["awaiting_signature"], prepared: bundle(true), reconfirmed: "awaiting_signature" });
    await expect(ensureActivated(transfer("awaiting_signature"), stalled)).resolves.toMatchObject({ state: "pending" });
    const failing = deps({ statuses: ["awaiting_signature"], prepared: bundle(true), reconfirmed: new RoutingApiError(404, "MH_036", "not found") });
    await expect(ensureActivated(transfer("awaiting_signature"), failing)).resolves.toMatchObject({ state: "pending" });
    const unreachable = deps({ statuses: ["awaiting_signature"], prepared: new RoutingApiError(0, "NETWORK_ERROR", "offline") });
    await expect(ensureActivated(transfer("awaiting_signature"), unreachable)).resolves.toMatchObject({ state: "pending" });
  });
});

describe("broadcast journal", () => {
  it("merges landed signatures across attempts, per documented field, without duplicates", () => {
    saveBroadcastSignatures(42, signatureEntry("keeperFunding", sig(1))!);
    saveBroadcastSignatures(42, signatureEntry("routeInit", sig(2))!);
    saveBroadcastSignatures(42, signatureEntry("routeInit", sig(2))!);
    saveBroadcastSignatures(42, signatureEntry("orchestratorInit", sig(3))!);
    saveBroadcastSignatures(42, signatureEntry("sessionInit", sig(4))!);
    expect(readBroadcastSignatures(42)).toEqual({ routeInitSignatures: [sig(2)], keeperFundingSignature: sig(1), orchestratorInitSignature: sig(3), sessionInitSignatures: [sig(4)] });
    expect(mergeBroadcastSignatures(readBroadcastSignatures(42), { routeInitSignatures: [sig(5)], dispersionInitSignatures: [sig(6)] })).toMatchObject({
      routeInitSignatures: [sig(2), sig(5)], dispersionInitSignatures: [sig(6)], keeperFundingSignature: sig(1),
    });
    expect(signatureEntry("rescue", sig(7))).toBeNull();
    expect(readBroadcastSignatures(43)).toBeNull();
  });

  it("ignores corrupted journals and tracks spent lamports", () => {
    window.localStorage.setItem("qazsplit:multihopper:v1:broadcast:42", "{not json");
    expect(readBroadcastSignatures(42)).toBeNull();
    addSpentLamports(42, 1_000n);
    addSpentLamports(42, 2_500n);
    addSpentLamports(42, -5n);
    expect(readSpentLamports(42)).toBe(3_500n);
    window.localStorage.setItem("qazsplit:multihopper:v1:outflow:42", "lots");
    expect(readSpentLamports(42)).toBe(0n);
  });
});

describe("spending limits (audits M1 and M3)", () => {
  it("bounds a bundle by the quoted up-front SOL plus margin and capped fees, minus what already left", () => {
    // Devnet estimate observed for 0.05 SOL / 3 hops: requiredSolUpFrontLamports = 100,210,313. The docs disagree on
    // whether that includes the 0.05 SOL principal, so the bound adds it (documented worst case).
    const limit = outflowLimitLamports({ requiredSolUpFrontLamports: 100_210_313, amountLamports: 50_000_000n, transactionCount: 6, alreadySpentLamports: 0n, priorityFeeCapLamports: 5_000_000n });
    expect(limit).toBe(150_210_313n + 5_000_000n + 6n * (20_000n + 5_000_000n)); // 0.185330313 SOL
    expect(outflowLimitLamports({ requiredSolUpFrontLamports: 100_000_000, amountLamports: 0n, transactionCount: 1, alreadySpentLamports: 400_000_000n, priorityFeeCapLamports: 0n })).toBe(0n);
    expect(outflowLimitLamports({ requiredSolUpFrontLamports: 2_000_000_000, amountLamports: 0n, transactionCount: 0, alreadySpentLamports: 0n, priorityFeeCapLamports: 0n })).toBe(2_020_000_000n); // 1% margin
  });

  it("requires the unspent up-front amount plus fees, and fails closed when MultiHopper quoted nothing", () => {
    expect(requiredBalanceLamports({ requiredSolUpFrontLamports: 100_000_000, transactionCount: 5, alreadySpentLamports: 0n })).toBe(100_100_000n);
    expect(requiredBalanceLamports({ requiredSolUpFrontLamports: 100_000_000, transactionCount: 2, alreadySpentLamports: 60_000_000n })).toBe(40_040_000n);
    expect(requiredBalanceLamports({ requiredSolUpFrontLamports: null, transactionCount: 5, alreadySpentLamports: 0n })).toBeNull();
  });
});

describe("independent delivery verification", () => {
  type Tx = { blockTime: number; err?: unknown; keys: string[]; pre: number[]; post: number[]; loaded?: { writable: string[]; readonly: string[] } };
  function rpc(history: { signature: string; err?: unknown; blockTime: number }[] | Error, transactions: Record<string, Tx | Error>) {
    const getSignaturesForAddress = vi.fn(() => ({ send: async () => {
      if (history instanceof Error) throw history;
      return history.map((entry) => ({ err: null, ...entry }));
    } }));
    const getTransaction = vi.fn((signature: string) => ({ send: async () => {
      const tx = transactions[signature];
      if (tx instanceof Error) throw tx;
      if (!tx) return null;
      return {
        blockTime: tx.blockTime,
        meta: { err: tx.err ?? null, preBalances: tx.pre.map(BigInt), postBalances: tx.post.map(BigInt), loadedAddresses: tx.loaded ?? { writable: [], readonly: [] } },
        transaction: { message: { accountKeys: tx.keys } },
      };
    } }));
    return { rpc: { getSignaturesForAddress, getTransaction } as unknown as DeliveryRpc, getTransaction };
  }
  const created = Date.parse("2026-11-21T10:00:00.000Z") / 1000;
  const hop = (lamports: number, overrides: Partial<Tx> = {}): Tx => ({
    blockTime: created + 400, keys: [keeper, destination, PROGRAMS.multihopperCore], pre: [5_000_000_000, 0, 1], post: [5_000_000_000 - lamports, lamports, 1], ...overrides,
  });
  const verify = (mock: DeliveryRpc, reported: string[] = []) => verifyDelivery({
    rpc: mock, destination, expectedLamports: "49751243", createdAt: "2026-11-21T10:00:00.000Z", reportedSignatures: reported,
  });

  it("verifies delivery from MultiHopper transactions crediting the destination with at least the locked amount", async () => {
    const { rpc: mock } = rpc([{ signature: sig(1), blockTime: created + 400 }, { signature: sig(2), blockTime: created + 500 }], {
      [sig(1)]: hop(49_751_243),
      [sig(2)]: { blockTime: created + 500, keys: [keeper, destination, "11111111111111111111111111111111"], pre: [9, 0, 1], post: [0, 9, 1] }, // not MultiHopper
    });
    const result = await verify(mock);
    expect(result).toMatchObject({ state: "verified", deliveredLamports: 49_751_243n });
    expect(result.state === "verified" && result.credits.map((credit) => credit.signature)).toEqual([sig(1)]);
  });

  it("reports partial delivery, and ignores failed or earlier transactions", async () => {
    const { rpc: mock } = rpc([{ signature: sig(1), blockTime: created + 400 }, { signature: sig(2), blockTime: created + 401 }, { signature: sig(3), blockTime: created - 3_600 }], {
      [sig(1)]: hop(20_000_000),
      [sig(2)]: hop(29_751_243, { err: { InstructionError: [0, "Custom"] } }),
      [sig(3)]: hop(49_751_243, { blockTime: created - 3_600 }),
    });
    await expect(verify(mock)).resolves.toMatchObject({ state: "partial", deliveredLamports: 20_000_000n });
  });

  it("finds reported hop signatures and destinations loaded through lookup tables", async () => {
    const { rpc: mock, getTransaction } = rpc([], {
      [sig(4)]: { blockTime: created + 600, keys: [keeper, PROGRAMS.multihopperOrchestrator], loaded: { writable: [destination], readonly: [] }, pre: [9_000_000_000, 1, 0], post: [8_950_248_757, 1, 49_751_243] },
    });
    await expect(verify(mock, [sig(4)])).resolves.toMatchObject({ state: "verified", deliveredLamports: 49_751_243n });
    expect(getTransaction).toHaveBeenCalledWith(sig(4), expect.objectContaining({ maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  });

  it("says not found when nothing arrived, and unavailable when devnet RPC fails, never verified", async () => {
    await expect(verify(rpc([], {}).rpc)).resolves.toEqual({ state: "not-found", deliveredLamports: 0n, credits: [] });
    await expect(verify(rpc(new TypeError("fetch failed"), {}).rpc)).resolves.toMatchObject({ state: "unavailable" });
    await expect(verify(rpc([{ signature: sig(1), blockTime: created + 400 }], { [sig(1)]: new TypeError("fetch failed") }).rpc)).resolves.toMatchObject({ state: "unavailable" });
  });
});
