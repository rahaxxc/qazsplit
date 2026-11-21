// @vitest-environment jsdom
import {
  appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, decompileTransactionMessage, generateKeyPair, getAddressFromPublicKey,
  getBase58Decoder, getBase64EncodedWireTransaction, getBase64Encoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getSolanaErrorFromJsonRpcError,
  getTransactionDecoder, pipe,
  prependTransactionMessageInstructions, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signBytes,
  type Address, type Blockhash, type Transaction,
} from "@solana/kit";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SplitAgreement } from "@/lib/agreement-client";
import { DEVNET_GENESIS_HASH } from "@/lib/constants";
import { RoutingApiError, type RoutingEstimate, type RoutingTransfer } from "@/lib/multihopper/client";
import { PROGRAMS, simulationTiming } from "@/lib/multihopper/inspection";
import { keeperFundingTiming, readKeeperFunding, saveKeeperFunding, type KeeperFundingState } from "@/lib/multihopper/keeper-funding";
import { activationTiming, readBroadcastSignatures } from "@/lib/multihopper/lifecycle";
import { buildRecoveryMessage, buildRoutingApprovalMessage, type RecoveryRequest, type RoutingRequest } from "@/lib/multihopper/shared";
import { broadcastTiming } from "@/lib/multihopper/transactions";

const state = vi.hoisted(() => ({
  wallet: "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX",
  chains: ["solana:mainnet", "solana:devnet"] as string[],
  features: ["solana:signMessage", "solana:signTransaction"] as string[],
  versions: new Set<"legacy" | 0 | 1>(["legacy", 0]),
  signMessage: vi.fn(), modifyAndSign: vi.fn(), getBalance: vi.fn(), sendTransaction: vi.fn(), getSignatureStatuses: vi.fn(), getEpochInfo: vi.fn(),
  simulate: vi.fn(), getSignaturesForAddress: vi.fn(), getTransaction: vi.fn(),
  estimate: vi.fn(), create: vi.fn(), status: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), recoverAccess: vi.fn(), prepareRecovery: vi.fn(), confirmRecovery: vi.fn(),
}));
const client = { wallet: { signMessage: state.signMessage }, rpc: {
  getBalance: state.getBalance, sendTransaction: state.sendTransaction, getSignatureStatuses: state.getSignatureStatuses, getEpochInfo: state.getEpochInfo,
  simulateTransaction: state.simulate, getSignaturesForAddress: state.getSignaturesForAddress, getTransaction: state.getTransaction,
  getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }), getBlockHeight: () => ({ send: async () => 10n }),
} };
vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({ useConnectedWallet: () => ({
  account: { address: state.wallet, features: state.features, chains: state.chains },
  signer: { address: state.wallet, modifyAndSignTransactions: state.modifyAndSign },
  supportedTransactionVersions: state.versions,
}) }));
vi.mock("@/lib/multihopper/client", async (original) => ({
  ...await original<typeof import("@/lib/multihopper/client")>(),
  routingApi: {
    estimate: state.estimate, create: state.create, status: state.status, prepare: state.prepare, confirmBroadcast: state.confirm,
    recoverAccess: state.recoverAccess, prepareRecovery: state.prepareRecovery, confirmRecovery: state.confirmRecovery,
  },
}));

import { OnwardRouting } from "./onward-routing";

const agreement = { address: "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq" } as SplitAgreement;
const destination = "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8";
const BALANCE = 5_000_000_000n;
const estimate: RoutingEstimate = {
  tier: "tier_0", percentFeeBps: 50, percentFeeRaw: "1242500", flatFeeLamportsPerHop: 0, totalFlatFeeLamports: 0, hopAmountRaw: "248757500",
  usdEquivalent: 30, priceSource: "onchain_pool", cappedAtTierBoundary: false, isTestMode: true, requiredSolUpFrontLamports: 290_000_000,
  minTransferAmountLamports: 2_039_280, refundableLamports: 16_000_000, netCostLamports: 274_000_000, screeningFeeLamports: 0,
};
const quote = (overrides: Partial<RoutingTransfer> = {}): RoutingTransfer => ({
  id: 42, externalId: "qzs-x", supportBundleId: "MH-qazsplit-42", status: "quote", phase: "quoted", progress: null, lastError: null,
  amountLamports: "250000000", recipientWallet: destination, recipientReceivesLamports: "248757500", hops: 3, arrivalSeconds: 300,
  pricingTier: "tier_0", percentFeeBps: 50, percentFeeLamports: "1242500", totalFlatFeeLamports: 0, isTest: true, quotedAt: null,
  expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-11-21T09:00:00.000Z", completedAt: null, hopSignatures: [], route: null, ...overrides,
});
let user: { address: Address; keys: CryptoKeyPair };

const SIGN = /^(Prepare transactions|Resume|Check and activate)$/;
const mount = () => render(createElement(OnwardRouting, { agreement, milestoneIndex: 0 }));
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
function optIn() { fireEvent.click(screen.getByLabelText("Route SOL onward with MultiHopper")); }
function fill(amount: string, to = destination) {
  fireEvent.change(screen.getByLabelText("Amount to route (SOL)"), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText("Destination wallet"), { target: { value: to } });
}
async function previewed() { mount(); optIn(); fill("0.25"); fireEvent.click(button("Preview fees")); await screen.findByText("Fee preview"); }
/** Simulated post-transaction wallet balance: each transaction costs `outflow` lamports. */
const simulateOutflow = (outflow: bigint) => () => ({ send: async () => ({ value: { err: null, accounts: [{ lamports: BALANCE - outflow }] } }) });

beforeAll(async () => {
  const keys = await generateKeyPair();
  user = { keys, address: await getAddressFromPublicKey(keys.publicKey) };
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  state.wallet = user.address; state.features = ["solana:signMessage", "solana:signTransaction"]; state.versions = new Set(["legacy", 0]);
  state.chains = ["solana:mainnet", "solana:devnet"];
  state.getBalance.mockReturnValue({ send: async () => ({ value: BALANCE }) });
  state.simulate.mockImplementation(simulateOutflow(2_000_000n));
  state.estimate.mockResolvedValue({ estimate });
  state.signMessage.mockImplementation(async (bytes: Uint8Array) => signBytes(user.keys.privateKey, bytes));
  state.create.mockResolvedValue({ transfer: quote(), accessToken: "qzr1.token.for42", reused: false });
  state.status.mockResolvedValue({ transfer: quote() });
  state.getEpochInfo.mockReturnValue({ send: async () => ({ blockHeight: 10n, absoluteSlot: 20n }) });
  state.getSignaturesForAddress.mockReturnValue({ send: async () => [] });
  broadcastTiming.preflightRetryDelayMs = 1;
  simulationTiming.retryDelayMs = 1;
  activationTiming.delaysMs = [1, 1];
});
afterEach(() => {
  cleanup();
  keeperFundingTiming.confirmRetryDelaysMs = [2_000, 4_000, 8_000];
  broadcastTiming.preflightRetryDelayMs = 2_000;
  simulationTiming.retryDelayMs = 2_000;
  activationTiming.delaysMs = [3_000, 5_000, 8_000];
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
});

describe("optional onward routing panel", () => {
  it("is opt-in: collapsed by default and silent until the recipient chooses MultiHopper", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Optional onward routing" })).toBeTruthy();
    expect((screen.getByLabelText("Route SOL onward with MultiHopper") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("Amount to route (SOL)")).toBeNull();
    for (const call of [state.estimate, state.create, state.status, state.prepare, state.getBalance, state.signMessage]) expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/payout is final and stays Paid/)).toBeTruthy();
  });

  it("validates amount and destination before any request", () => {
    mount(); optIn();
    fill("abc");
    expect(screen.getByText("Enter a positive SOL amount with at most 9 decimals.")).toBeTruthy();
    expect(button("Preview fees").disabled).toBe(true);
    fill("0.25", user.address);
    expect(screen.getByText("Choose a destination other than your connected wallet.")).toBeTruthy();
    fill("0.25", "not-a-wallet");
    expect(screen.getByText("Enter a valid Solana wallet address.")).toBeTruthy();
    expect(button("Preview fees").disabled).toBe(true);
    expect(state.estimate).not.toHaveBeenCalled();
  });

  it("previews fees and the expected recipient amount for the exact inputs; any edit invalidates it", async () => {
    await previewed();
    expect(state.estimate).toHaveBeenCalledExactlyOnceWith({ amountLamports: "250000000", hops: 3, arrivalSeconds: 300 });
    const preview = screen.getByLabelText("Fee preview");
    expect(preview.textContent).toContain("Destination receives (quoted)0.2487575 SOL");
    expect(preview.textContent).toContain("SOL needed in wallet before signing (MultiHopper)0.29 SOL");
    expect(preview.textContent).toContain("Your wallet now5 SOL");
    expect(button("Review transfer").disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Hops"), { target: { value: "4" } });
    expect(screen.queryByText("Fee preview")).toBeNull();
  });

  it("blocks review when the wallet cannot cover MultiHopper's up-front SOL plus fees", async () => {
    state.getBalance.mockReturnValue({ send: async () => ({ value: 290_000_000n }) }); // exactly the quote: network fees are not covered
    await previewed();
    expect(button("Review transfer").disabled).toBe(true);
    expect(screen.getByText("Your wallet needs about 0.29016 SOL (up-front amount plus network fees) before signing.")).toBeTruthy();
  });

  it.each([
    ["the balance cannot be read", () => state.getBalance.mockReturnValue({ send: async () => { throw new TypeError("fetch failed"); } }), "couldn't read your wallet balance"],
    ["MultiHopper quotes no up-front SOL", () => state.estimate.mockResolvedValue({ estimate: { ...estimate, requiredSolUpFrontLamports: null } }), "did not quote the SOL needed"],
  ])("fails closed when %s (audit M1)", async (_, arrange, reason) => {
    arrange();
    await previewed();
    expect(button("Review transfer").disabled).toBe(true);
    expect(screen.getByText(new RegExp(reason))).toBeTruthy();
  });

  it("expires a fee preview after two minutes (audit M2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await previewed();
    expect(button("Review transfer").disabled).toBe(false);
    await act(async () => {}); // let the preview's expiry timer start (passive effect)
    act(() => { vi.advanceTimersByTime(121_000); });
    expect(screen.queryByText("Fee preview")).toBeNull();
    expect(screen.getByText(/more than 2 minutes old/)).toBeTruthy();
  });

  it("explains wallets that cannot prove ownership, sign legacy + v0 transactions, or are not on devnet", async () => {
    state.features = ["solana:signTransaction"];
    await previewed();
    expect(button("Review transfer").disabled).toBe(true);
    expect(screen.getAllByText(/must support message signing/).length).toBeGreaterThan(0);
    cleanup();
    state.features = ["solana:signMessage", "solana:signTransaction"]; state.versions = new Set([0]);
    await previewed();
    expect(screen.getAllByText(/both legacy and version 0/).length).toBeGreaterThan(0);
    cleanup();
    state.versions = new Set(["legacy", 0]); state.chains = ["solana:mainnet"];
    await previewed();
    expect(button("Review transfer").disabled).toBe(true);
    expect(screen.getAllByText(/not available on Solana devnet/).length).toBeGreaterThan(0);
  });

  it("requires review, acknowledgement and a wallet-signed approval of the exact request, naming this site, before a quote exists", async () => {
    await previewed();
    fireEvent.click(button("Review transfer"));
    const approve = button("Approve request in wallet");
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/separate SOL transfer from my wallet/));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await screen.findByRole("heading", { name: "Transfer #42" });
    expect(state.signMessage).toHaveBeenCalledTimes(1);
    const submitted = state.create.mock.calls[0][0] as RoutingRequest & { signature: string };
    const signedText = new TextDecoder().decode(state.signMessage.mock.calls[0][0] as Uint8Array);
    const { signature, ...request } = submitted;
    expect(signedText).toBe(buildRoutingApprovalMessage(request));
    expect(request).toMatchObject({ wallet: user.address, agreement: agreement.address, milestoneIndex: 0, amountLamports: "250000000", destination, hops: 3, arrivalSeconds: 300, origin: window.location.origin });
    expect(signedText).toContain(`Website: ${window.location.origin}`);
    expect(signature).toBe(getBase58Decoder().decode(await state.signMessage.mock.results[0].value));
    expect(state.prepare).not.toHaveBeenCalled(); // signing the bundle is a separate, explicit step
    expect(button("Prepare transactions")).toBeTruthy();
    expect(screen.getByText("MH-qazsplit-42")).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem(`qazsplit:multihopper:v1:${user.address}`)!);
    expect(stored[0]).toMatchObject({ transferId: 42, accessToken: "qzr1.token.for42", agreement: agreement.address, destination, previewReceivesLamports: "248757500" });
  });

  it("makes the recipient acknowledge a locked amount that differs from the preview before preparing (audit M2)", async () => {
    state.create.mockResolvedValue({ transfer: quote({ recipientReceivesLamports: "240000000" }), accessToken: "qzr1.token.for42", reused: false });
    state.status.mockResolvedValue({ transfer: quote({ recipientReceivesLamports: "240000000" }) });
    await previewed();
    fireEvent.click(button("Review transfer"));
    fireEvent.click(screen.getByLabelText(/separate SOL transfer from my wallet/));
    fireEvent.click(button("Approve request in wallet"));
    await screen.findByText("MultiHopper locked a different amount");
    expect(screen.queryByRole("button", { name: SIGN })).toBeNull();
    fireEvent.click(screen.getByLabelText("Continue with the locked amount"));
    expect(button("Prepare transactions")).toBeTruthy();
  });

  it("reports an unconfigured server without touching anything else", async () => {
    state.estimate.mockRejectedValue(new RoutingApiError(503, "MULTIHOPPER_NOT_CONFIGURED", "not configured"));
    mount(); optIn(); fill("0.25"); fireEvent.click(button("Preview fees"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not configured on this deployment");
    expect(alert.textContent).toContain("Your QazSplit payout is unaffected.");
  });

  it("restores routings from another device after a recovery signature that moves no funds (audit H3)", async () => {
    state.recoverAccess.mockResolvedValue({ routings: [{ transfer: quote({ id: 77, status: "processing" }), accessToken: "qzr1.restored.77" }] });
    state.status.mockResolvedValue({ transfer: quote({ id: 77, status: "processing" }) });
    mount();
    fireEvent.click(button("Restore routings started on another device"));
    await screen.findByRole("heading", { name: "Transfer #77" });
    const submitted = state.recoverAccess.mock.calls[0][0] as RecoveryRequest & { signature: string };
    const { signature: _signature, ...request } = submitted; void _signature;
    expect(new TextDecoder().decode(state.signMessage.mock.calls[0][0] as Uint8Array)).toBe(buildRecoveryMessage(request));
    expect(screen.getByText(/restored from MultiHopper/)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
  });
});

describe("signing and broadcasting a prepared bundle from the UI", () => {
  const TRANSFER = 42;
  const KEEPER_SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
  const confirmedStatus = { confirmationStatus: "confirmed", err: null };
  async function preparedTx(tag: number) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(user.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: DEVNET_GENESIS_HASH as Blockhash, lastValidBlockHeight: 100n }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: PROGRAMS.multihopperCore as Address, accounts: [], data: new Uint8Array([tag]) }, m),
    );
    return getBase64EncodedWireTransaction(compileTransaction(message));
  }
  async function bundleOf(groups: { keeper: boolean; sessions: number[] }) {
    return {
      keeperFundingTx: groups.keeper ? await preparedTx(1) : null, routeInitTxs: [], orchestratorInitTx: null,
      sessionInitTxs: await Promise.all(groups.sessions.map(preparedTx)), dispersionInitTxs: [],
      recentBlockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 100, nothingToDo: !groups.keeper && !groups.sessions.length,
    };
  }
  const signAll = async (transactions: Transaction[]) =>
    Promise.all(transactions.map(async (tx) => ({ ...tx, signatures: { ...tx.signatures, [user.address]: await signBytes(user.keys.privateKey, tx.messageBytes) } })));
  /** Phantom's documented behaviour on unsigned transactions: prepend priority-fee instructions, then sign. */
  const phantomSignAll = async (transactions: Transaction[]) => Promise.all(transactions.map(async (tx) => {
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never, { lastValidBlockHeight: 100n });
    const withFee = prependTransactionMessageInstructions([
      { programAddress: PROGRAMS.computeBudget as Address, data: Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]) }, // 200,000 units
      { programAddress: PROGRAMS.computeBudget as Address, data: Uint8Array.from([3, 0xa0, 0x86, 0x01, 0, 0, 0, 0, 0]) }, // 100,000 µlamports
    ], message as never);
    const compiled = compileTransaction(withFee as never) as Transaction;
    return { ...compiled, signatures: { [user.address]: await signBytes(user.keys.privateKey, compiled.messageBytes) } };
  }));
  const statuses = (value: unknown, slot = 10_000n) => () => ({ send: async () => ({ context: { slot }, value: [value] }) });
  const finalized = (blockHeight: bigint, absoluteSlot: bigint) => ({ send: async () => ({ blockHeight, absoluteSlot }) });
  const keeperState = () => { const read = readKeeperFunding(TRANSFER); return read.status === "record" ? read.record.state : read.status; };
  function storeRouting(extra: Record<string, unknown> = {}) {
    window.localStorage.setItem(`qazsplit:multihopper:v1:${user.address}`, JSON.stringify([{
      transferId: TRANSFER, accessToken: "qzr1.token.for42", agreement: agreement.address, milestoneIndex: 0, destination, amountLamports: "250000000",
      createdAt: "2026-11-15T09:00:00.000Z", ...extra,
    }]));
  }
  function earlierKeeperFunding(stateName: KeeperFundingState) {
    saveKeeperFunding({ v: 1, transferId: TRANSFER, signature: KEEPER_SIG, blockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 100, state: stateName, updatedAt: "2026-11-15T09:00:00.000Z" });
  }
  const isKeeperOnly = (body: Record<string, unknown>) => !body.sessionInitSignatures && (body.routeInitSignatures as unknown[]).length === 0 && !!body.keeperFundingSignature;
  const mh036 = () => new RoutingApiError(404, "MH_036", "Broadcast signature not found on chain");
  /** Starts the flow and approves the review panel (the step before the wallet prompt). */
  async function prepareAndApprove(scope: Pick<typeof screen, "findByRole"> = screen, label: RegExp = SIGN) {
    fireEvent.click(await scope.findByRole("button", { name: label }));
    fireEvent.click(await scope.findByRole("button", { name: /^Sign \d+ transaction\(s\) in wallet$/ }));
  }
  const PROCESSING = "Processing · MultiHopper is verifying the deployment";

  it("prepares, shows every transaction for review, asks the wallet once, broadcasts keeper funding first, confirms twice, then tracks status", async () => {
    storeRouting();
    const order: string[] = [];
    state.prepare.mockImplementation(async () => {
      order.push("prepare");
      return { transfer: quote({ status: "awaiting_signature" }), preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) };
    });
    state.modifyAndSign.mockImplementation(async (transactions: Transaction[]) => { order.push(`wallet signs ${transactions.length}`); return signAll(transactions); });
    state.simulate.mockImplementation((...args: unknown[]) => { order.push("simulate"); return simulateOutflow(2_000_000n)(...(args as [])); });
    state.sendTransaction.mockImplementation(() => ({ send: async () => { order.push("broadcast"); return "sig"; } }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirm.mockImplementation(async (_id: number, _token: string, body: Record<string, unknown>) => {
      order.push(body.sessionInitSignatures ? "confirm final" : "confirm keeper");
      return { transfer: quote({ status: body.sessionInitSignatures ? "processing" : "awaiting_signature" }) };
    });
    state.status.mockResolvedValueOnce({ transfer: quote() }).mockResolvedValue({ transfer: quote({ status: "processing", phase: "deploying" }) });

    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Prepare transactions" }));
    const review = await screen.findByLabelText("Review prepared transactions");
    expect(review.textContent).toContain("Keeper funding");
    expect(review.textContent).toContain("Programs: MultiHopper Core");
    expect(review.textContent).toContain("QazSplit stops the bundle above");
    expect(state.modifyAndSign).not.toHaveBeenCalled(); // nothing is signed until the recipient approves the review
    fireEvent.click(button("Sign 2 transaction(s) in wallet"));
    await screen.findByText(PROCESSING);
    expect(order).toEqual(["prepare", "wallet signs 2", "simulate", "broadcast", "confirm keeper", "simulate", "broadcast", "confirm final"]);
    expect(state.estimate).toHaveBeenCalledWith({ amountLamports: "250000000", hops: 3, arrivalSeconds: 300 }); // fresh quote check before signing
    expect(state.confirm.mock.calls[0]).toEqual([42, "qzr1.token.for42", { routeInitSignatures: [], keeperFundingSignature: expect.any(String) }]);
    expect(state.confirm.mock.calls[1][2]).toMatchObject({ routeInitSignatures: [], sessionInitSignatures: [expect.any(String)], keeperFundingSignature: state.confirm.mock.calls[0][2].keeperFundingSignature });
    const progress = screen.getByRole("list", { name: "Broadcast progress" });
    expect(progress.textContent).toContain("Keeper funding · v0 transaction");
    expect(progress.textContent).not.toContain("failed");
    expect(within(progress).getAllByRole("link", { name: /Explorer/ }).length).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(keeperState()).toBe("recorded");
    expect(readBroadcastSignatures(TRANSFER)).toMatchObject({ keeperFundingSignature: expect.any(String), sessionInitSignatures: [expect.any(String)] });
  });

  it("accepts Phantom adding a priority fee to recipient-only transactions and tracks the changed signature (audit C1)", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [] }) });
    state.modifyAndSign.mockImplementation(phantomSignAll);
    const wires: string[] = [];
    state.sendTransaction.mockImplementation((wire: string) => ({ send: async () => { wires.push(wire); return "sig"; } }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirm.mockResolvedValue({ transfer: quote({ status: "processing" }) });
    mount();
    await prepareAndApprove();
    await screen.findByText(PROCESSING);
    expect(wires).toHaveLength(1);
    const sent = getTransactionDecoder().decode(getBase64Encoder().encode(wires[0]));
    const keeperSignature = getSignatureFromTransaction(sent);
    const read = readKeeperFunding(TRANSFER);
    expect(read.status === "record" && read.record.signature).toBe(keeperSignature); // the journal follows the wallet's version
    expect(state.confirm.mock.calls[0][2]).toEqual({ routeInitSignatures: [], keeperFundingSignature: keeperSignature });
  });

  it("stops before sending anything when a simulation shows more SOL leaving than quoted", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    state.modifyAndSign.mockImplementation(signAll);
    state.simulate.mockImplementation(simulateOutflow(3_000_000_000n)); // 3 SOL from a 0.29 SOL quote
    mount();
    await prepareAndApprove();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("more SOL from your wallet than MultiHopper quoted");
    expect(alert.textContent).toContain("OUTFLOW_LIMIT_EXCEEDED");
    expect(state.sendTransaction).not.toHaveBeenCalled();
    expect(keeperState()).toBe("none"); // the guard runs before the keeper journal is written
    await waitFor(() => expect(screen.queryByRole("button", { name: SIGN })).toBeTruthy());
    expect(button(SIGN).textContent).toBe("Resume");
  });

  it("refuses to prepare a signature request when the wallet cannot cover the re-checked quote", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    state.getBalance.mockReturnValue({ send: async () => ({ value: 100_000_000n }) });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Prepare transactions" }));
    expect((await screen.findByRole("alert")).textContent).toContain("needs about 0.29004 SOL");
    expect(state.modifyAndSign).not.toHaveBeenCalled();
    expect(state.sendTransaction).not.toHaveBeenCalled();
  });

  it("cancelling the review signs and sends nothing", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Prepare transactions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled. Nothing was signed.");
    expect(state.modifyAndSign).not.toHaveBeenCalled();
    expect(state.sendTransaction).not.toHaveBeenCalled();
    expect(keeperState()).toBe("none");
  });

  it("reports a declined wallet prompt as cancelled with nothing sent", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    state.modifyAndSign.mockRejectedValue(new Error("User rejected the request."));
    mount();
    await prepareAndApprove();
    expect((await screen.findByRole("alert")).textContent).toContain("Signature request was cancelled. Nothing was sent.");
    expect(state.sendTransaction).not.toHaveBeenCalled();
  });

  it("never prepares an expired quote", async () => {
    storeRouting();
    state.status.mockResolvedValue({ transfer: quote({ expiresAt: "2026-01-01T00:00:00.000Z" }) });
    mount();
    await screen.findByText(/This quote expired before it was funded/);
    expect(screen.queryByRole("button", { name: SIGN })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove from this device" })).toBeTruthy();
  });

  it("does not call a transfer active when MultiHopper hasn't advanced it after the final confirm (audit H1)", async () => {
    storeRouting();
    state.prepare
      .mockResolvedValueOnce({ transfer: null, preparedTxs: await bundleOf({ keeper: false, sessions: [5] }) })
      .mockResolvedValue({ transfer: quote({ status: "awaiting_signature" }), preparedTxs: await bundleOf({ keeper: false, sessions: [] }) });
    state.modifyAndSign.mockImplementation(signAll);
    state.sendTransaction.mockImplementation(() => ({ send: async () => "sig" }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirm.mockResolvedValue({ transfer: quote({ status: "awaiting_signature" }) }); // "stalls with no error"
    state.status.mockResolvedValue({ transfer: quote({ status: "awaiting_signature" }) });
    mount();
    await prepareAndApprove();
    await screen.findByText("Broadcast confirmed · waiting for MultiHopper to activate");
    expect(screen.getByText(/nothing more needs signing/)).toBeTruthy();
    expect(state.confirm).toHaveBeenCalledTimes(2); // final confirm, then one re-confirm after /prepare showed nothing missing
    expect(state.prepare).toHaveBeenCalledTimes(2);
    expect(state.modifyAndSign).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Completed/)).toBeNull();
  });

  it("only shows delivery as verified when devnet shows SOL reaching the destination", async () => {
    const hopSig = getBase58Decoder().decode(new Uint8Array(64).fill(9));
    storeRouting();
    state.status.mockResolvedValue({ transfer: quote({ status: "completed", completedAt: "2026-11-21T10:00:00.000Z", hopSignatures: [hopSig] }) });
    state.getTransaction.mockReturnValue({ send: async () => ({
      blockTime: BigInt(Date.parse("2026-11-21T09:30:00.000Z") / 1000),
      meta: { err: null, preBalances: [9_000_000_000n, 0n, 1n], postBalances: [8_751_242_500n, 248_757_500n, 1n], loadedAddresses: { writable: [], readonly: [] } },
      transaction: { message: { accountKeys: ["HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ", destination, PROGRAMS.multihopperCore] } },
    }) });
    mount();
    await screen.findByText("Delivered · verified on devnet");
    expect(screen.getByLabelText("Delivery verification").textContent).toContain("0.2487575 SOL reached the destination");
    cleanup();
    state.getTransaction.mockReturnValue({ send: async () => null });
    mount();
    await screen.findByText(/No SOL from MultiHopper transactions has reached the destination/);
    expect(screen.getByText("Completed per MultiHopper · checking delivery")).toBeTruthy();
    expect(screen.queryByText("Delivered · verified on devnet")).toBeNull();
  });

  it("shows a finished routing from this device's cache without polling MultiHopper (audit M4)", async () => {
    storeRouting({ final: quote({ status: "refunded" }) });
    mount();
    await screen.findByText("Refunded");
    expect(state.status).not.toHaveBeenCalled();
    fireEvent.click(button("Refresh routing status"));
    await waitFor(() => expect(state.status).toHaveBeenCalledTimes(1));
  });

  it("rescues locked SOL with MultiHopper-built transactions that may only cost fees (audit H3)", async () => {
    storeRouting();
    state.status.mockResolvedValue({ transfer: quote({ status: "failed", recovery: { canRescue: true, rescuableLamports: 5_000_000, canReclaimRent: false, reclaimableLamports: null } }) });
    state.prepareRecovery.mockResolvedValue({ transfer: quote({ status: "failed" }), recoveryTxs: { transactions: [await preparedTx(8)], recentBlockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 100, totalLamports: 5_000_000 } });
    state.modifyAndSign.mockImplementation(signAll);
    state.simulate.mockImplementation(() => ({ send: async () => ({ value: { err: null, accounts: [{ lamports: BALANCE + 4_995_000n }] } }) }));
    state.sendTransaction.mockImplementation(() => ({ send: async () => "sig" }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirmRecovery.mockResolvedValue({ transfer: quote({ status: "refunded" }), confirmed: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rescue 0.005 SOL" }));
    await screen.findByText(/Recovery transactions confirmed on devnet/);
    expect(state.prepareRecovery).toHaveBeenCalledWith(42, "qzr1.token.for42", "rescue");
    expect(state.confirmRecovery).toHaveBeenCalledWith(42, "qzr1.token.for42", "rescue", [expect.any(String)]);
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("refuses a rescue bundle that would take more than fees from the wallet", async () => {
    storeRouting();
    state.status.mockResolvedValue({ transfer: quote({ status: "failed", recovery: { canRescue: true, rescuableLamports: 5_000_000, canReclaimRent: false, reclaimableLamports: null } }) });
    state.prepareRecovery.mockResolvedValue({ transfer: quote({ status: "failed" }), recoveryTxs: { transactions: [await preparedTx(8)], recentBlockhash: DEVNET_GENESIS_HASH, lastValidBlockHeight: 100, totalLamports: 5_000_000 } });
    state.modifyAndSign.mockImplementation(signAll);
    state.simulate.mockImplementation(simulateOutflow(1_000_000_000n));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rescue 0.005 SOL" }));
    expect((await screen.findByRole("alert")).textContent).toContain("OUTFLOW_LIMIT_EXCEEDED");
    expect(state.sendTransaction).not.toHaveBeenCalled();
    expect(state.confirmRecovery).not.toHaveBeenCalled();
  });

  it("stops at a definitive preflight rejection (after devnet retries), keeps the payout message, and offers Resume", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [] }) });
    state.modifyAndSign.mockImplementation(signAll);
    state.sendTransaction.mockImplementation(() => ({ send: async () => {
      throw getSolanaErrorFromJsonRpcError({ code: -32002, message: "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
        data: { err: "AccountNotFound", logs: [], accounts: null, unitsConsumed: 0 } });
    } }));
    state.getSignatureStatuses.mockImplementation(statuses(null));

    mount();
    await prepareAndApprove();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Keeper funding: The RPC rejected this transaction before sending it");
    expect(alert.textContent).toContain("Your QazSplit payout is unaffected.");
    expect(state.sendTransaction).toHaveBeenCalledTimes(3);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(keeperState()).toBe("rejected");
    await waitFor(() => expect(button("Resume").disabled).toBe(false));
    expect(screen.queryByRole("status", { name: "Keeper funding check" })).toBeNull();
  });

  it("an earlier keeper funding that may still land blocks Resume, across repeated attempts, until the chain settles it", async () => {
    storeRouting();
    earlierKeeperFunding("sending"); // e.g. the tab crashed mid-broadcast, or another tab sent it
    state.getSignatureStatuses.mockImplementation(statuses(null, 500n));
    state.getEpochInfo.mockReturnValue(finalized(90n, 150n)); // still within the validity window

    mount();
    const panel = await screen.findByRole("status", { name: "Keeper funding check" });
    expect(panel.textContent).toContain("Keeper funding needs a check");
    expect(screen.queryByRole("button", { name: SIGN })).toBeNull();
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.click(button("Check keeper funding status"));
      await waitFor(() => expect(state.getEpochInfo).toHaveBeenCalledTimes(attempt));
      await screen.findByText("Waiting for keeper funding to settle");
      await waitFor(() => expect(button("Check keeper funding status").disabled).toBe(false));
      expect(screen.queryByRole("button", { name: SIGN })).toBeNull();
    }
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.modifyAndSign).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
    expect(keeperState()).toBe("sending");

    // The blockhash expires at finalized and a caught-up status view shows it never landed.
    state.getEpochInfo.mockReturnValue(finalized(101n, 180n));
    fireEvent.click(button("Check keeper funding status"));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Keeper funding check" })).toBeNull());
    expect(keeperState()).toBe("none");

    // Only now may a new keeper funding be prepared and signed.
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [] }) });
    state.modifyAndSign.mockImplementation(signAll);
    state.sendTransaction.mockImplementation(() => ({ send: async () => "sig" }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirm.mockResolvedValue({ transfer: quote({ status: "processing" }) });
    state.getEpochInfo.mockReturnValue(finalized(10n, 20n));
    await prepareAndApprove();
    await screen.findByText(PROCESSING);
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(keeperState()).toBe("recorded");
  });

  it("a keeper broadcast that times out but lands is recorded once and never funded twice", async () => {
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    state.modifyAndSign.mockImplementation(signAll);
    const wires: string[] = [];
    state.sendTransaction.mockImplementation((wire: string) => ({ send: async () => {
      wires.push(wire);
      if (wires.length === 1) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return "sig";
    } }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus)); // it did land
    state.confirm.mockImplementation(async (_id: number, _token: string, body: Record<string, unknown>) => ({ transfer: quote({ status: isKeeperOnly(body) ? "awaiting_signature" : "processing" }) }));

    mount();
    await prepareAndApprove();
    await screen.findByText(PROCESSING);
    expect(wires.filter((wire) => wire === wires[0])).toHaveLength(1); // keeper funding sent once
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(state.confirm.mock.calls.filter(([, , body]) => isKeeperOnly(body))).toHaveLength(1);
    expect(keeperState()).toBe("recorded");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MH_036 after keeper funding leaves a visible check; reconciling records it and Resume never funds the keeper again", async () => {
    keeperFundingTiming.confirmRetryDelaysMs = [1, 1];
    storeRouting();
    state.prepare
      .mockResolvedValueOnce({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) })
      .mockResolvedValueOnce({ transfer: null, preparedTxs: await bundleOf({ keeper: false, sessions: [6] }) }); // MultiHopper now has the funding
    state.modifyAndSign.mockImplementation(signAll);
    const wires: string[] = [];
    state.sendTransaction.mockImplementation((wire: string) => ({ send: async () => { wires.push(wire); return "sig"; } }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    let multiHopperSeesKeeper = false;
    state.confirm.mockImplementation(async (_id: number, _token: string, body: Record<string, unknown>) => {
      if (isKeeperOnly(body) && !multiHopperSeesKeeper) throw mh036();
      return { transfer: quote({ status: isKeeperOnly(body) ? "awaiting_signature" : "processing" }) };
    });

    mount();
    await prepareAndApprove();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Keeper funding confirmation");
    const panel = await screen.findByRole("status", { name: "Keeper funding check" });
    expect(panel.textContent).toContain("Keeper funding needs a check");
    await waitFor(() => expect(screen.queryByRole("button", { name: SIGN })).toBeNull());
    expect(keeperState()).toBe("landed");
    expect(state.confirm.mock.calls.filter(([, , body]) => isKeeperOnly(body))).toHaveLength(3); // first try + 2 retries, same signature

    multiHopperSeesKeeper = true;
    fireEvent.click(button("Check keeper funding status"));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Keeper funding check" })).toBeNull());
    expect(keeperState()).toBe("recorded");
    await prepareAndApprove();
    await screen.findByText(PROCESSING);
    expect(state.prepare).toHaveBeenCalledTimes(2);
    expect(state.modifyAndSign.mock.calls[1][0]).toHaveLength(1); // second bundle: only the session transaction
    expect(wires.filter((wire) => wire === wires[0])).toHaveLength(1); // keeper funding broadcast exactly once overall
    // The final confirm reports everything that landed across both attempts.
    expect(state.confirm.mock.calls.at(-1)?.[2]).toMatchObject({ keeperFundingSignature: expect.any(String), sessionInitSignatures: [expect.any(String)] });
  });

  it("two tabs: the second cannot prepare while the first reviews and signs, and the first tab's record blocks it afterwards", async () => {
    keeperFundingTiming.confirmRetryDelaysMs = [1, 1];
    const held = new Set<string>();
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({ name }); } finally { held.delete(name); }
      },
    } });
    storeRouting();
    state.prepare.mockResolvedValue({ transfer: null, preparedTxs: await bundleOf({ keeper: true, sessions: [5] }) });
    let approveInWallet!: () => void;
    state.modifyAndSign.mockImplementation((transactions: Transaction[]) => new Promise((resolve) => { approveInWallet = () => resolve(signAll(transactions)); }));
    state.sendTransaction.mockImplementation(() => ({ send: async () => "sig" }));
    state.getSignatureStatuses.mockImplementation(statuses(confirmedStatus));
    state.confirm.mockImplementation(async (_id: number, _token: string, body: Record<string, unknown>) => {
      if (isKeeperOnly(body)) throw mh036(); // MultiHopper's RPC keeps lagging during this test
      return { transfer: quote({ status: "processing" }) };
    });

    const tabA = within(mount().container);
    const tabB = within(mount().container);
    fireEvent.click(await tabA.findByRole("button", { name: "Prepare transactions" }));
    await tabA.findByLabelText("Review prepared transactions"); // tab A holds the lock during its review
    fireEvent.click(await tabB.findByRole("button", { name: "Prepare transactions" }));
    expect((await tabB.findByRole("alert")).textContent).toContain("already being signed in another tab");
    expect(state.prepare).toHaveBeenCalledTimes(1);
    fireEvent.click(tabA.getByRole("button", { name: /^Sign \d+ transaction\(s\) in wallet$/ }));
    await waitFor(() => expect(state.modifyAndSign).toHaveBeenCalledTimes(1));

    approveInWallet(); // tab A broadcasts keeper funding; MultiHopper answers MH_036
    await tabA.findByRole("status", { name: "Keeper funding check" });
    expect(keeperState()).toBe("landed");

    // Tab B resumes later: it reconciles the record tab A left and refuses to prepare a second funding.
    fireEvent.click(tabB.getByRole("button", { name: "Resume" }));
    await tabB.findByText("Waiting for keeper funding to settle");
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(state.modifyAndSign).toHaveBeenCalledTimes(1);
    expect(keeperState()).toBe("landed");
  });
});
