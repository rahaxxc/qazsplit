// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_USDC_MINT } from "@/lib/constants";
import { AgreementForm } from "./agreement-form";

// Same mocking approach as agreement-form.test.ts: settlement functions are spies, so any
// accidental call from the routing panel would be visible.
const state = vi.hoisted(() => ({ wallet: "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", paid: true,
  fetch: vi.fn(), signature: vi.fn(), approve: vi.fn(), build: vi.fn(), simulate: vi.fn(), send: vi.fn(), getClient: vi.fn(), balance: vi.fn(),
  estimate: vi.fn(), create: vi.fn(), status: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), getBalance: vi.fn() }));
const recipients = ["aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq"];
const payer = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";
const client = { sendTransaction: state.send, rpc: { getBalance: state.getBalance }, wallet: { signMessage: vi.fn() } };
const agreement = () => ({ address: recipients[0], creator: recipients[0], mint: MOCK_USDC_MINT, version: 1, splitId: 1n, bump: 1,
  recipients, sharesBps: [5000, 3000, 2000], approvalMask: 7,
  milestones: [{ name: "Design", amount: 10_000_001n, paid: state.paid, payer, paidAt: state.paid ? 1791590400n : 0n, paidSlot: state.paid ? 1n : 0n }] });

vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({ useConnectedWallet: () => ({
  account: { address: state.wallet, features: ["solana:signMessage", "solana:signTransaction"] },
  signer: { address: state.wallet, modifyAndSignTransactions: vi.fn() }, supportedTransactionVersions: new Set(["legacy", 0]),
}) }));
vi.mock("@/lib/agreement-client", async (original) => ({
  ...await original<typeof import("@/lib/agreement-client")>(), fetchAgreement: state.fetch,
  fetchMilestoneSignature: state.signature, buildApproveSplitInstruction: state.approve, buildPayMilestoneInstructions: state.build,
}));
vi.mock("@/lib/qazsplit-client", async (original) => ({
  ...await original<typeof import("@/lib/qazsplit-client")>(), simulateInstructions: state.simulate, fetchTokenBalance: state.balance,
}));
vi.mock("@/lib/transaction-compat", async (original) => ({ ...await original<typeof import("@/lib/transaction-compat")>(), getTransactionClient: state.getClient }));
vi.mock("@/lib/multihopper/client", async (original) => ({
  ...await original<typeof import("@/lib/multihopper/client")>(),
  routingApi: { estimate: state.estimate, create: state.create, status: state.status, prepare: state.prepare, confirmBroadcast: state.confirm },
}));

const mount = () => render(createElement(AgreementForm, { splitAddress: recipients[0] }));

describe("onward routing inside the agreement page", () => {
  beforeEach(() => {
    vi.clearAllMocks(); window.localStorage.clear(); state.wallet = recipients[1]; state.paid = true;
    state.fetch.mockImplementation(async () => agreement()); state.signature.mockResolvedValue("verified-payment-signature");
    state.balance.mockResolvedValue(100_000_000n); state.getClient.mockReturnValue(client);
    state.getBalance.mockReturnValue({ send: async () => ({ value: 5_000_000_000n }) });
    state.estimate.mockResolvedValue({ estimate: { tier: "tier_0", percentFeeBps: 50, percentFeeRaw: "1242500", flatFeeLamportsPerHop: 0, totalFlatFeeLamports: 0,
      hopAmountRaw: "248757500", usdEquivalent: 30, priceSource: "onchain_pool", cappedAtTierBoundary: false, isTestMode: true,
      requiredSolUpFrontLamports: 290000000, minTransferAmountLamports: 2039280, refundableLamports: 16000000, netCostLamports: 274000000, screeningFeeLamports: 0 } });
  });
  afterEach(cleanup);

  it("appears after the Paid receipt for a recipient, collapsed, with no routing or payment calls", async () => {
    mount();
    await screen.findByText("verified-payment-signature");
    expect(screen.getByRole("region", { name: "Optional onward routing" })).toBeTruthy();
    expect((screen.getByLabelText("Route SOL onward with MultiHopper") as HTMLInputElement).checked).toBe(false);
    for (const call of [state.estimate, state.create, state.status, state.prepare, state.confirm, state.build, state.simulate, state.send]) expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["the milestone is not Paid", () => { state.paid = false; }],
    ["the connected wallet is the payer, not a recipient", () => { state.wallet = payer; }],
  ])("is not offered when %s", async (_, arrange) => {
    arrange();
    mount();
    await screen.findByText("3 of 3 members approved");
    expect(screen.queryByRole("region", { name: "Optional onward routing" })).toBeNull();
    expect(state.estimate).not.toHaveBeenCalled();
  });

  it("opting in and previewing fees never builds, simulates or sends a milestone payment", async () => {
    mount();
    await screen.findByText("verified-payment-signature");
    fireEvent.click(screen.getByLabelText("Route SOL onward with MultiHopper"));
    fireEvent.change(screen.getByLabelText("Amount to route (SOL)"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Destination wallet"), { target: { value: recipients[2] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview fees" }));
    await screen.findByText("Fee preview");
    expect(state.estimate).toHaveBeenCalledTimes(1);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.simulate).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    // The settled milestone stays Paid and payment stays locked, whatever routing does.
    expect(screen.getByRole("region", { name: "Payment receipt" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign atomic payment" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
