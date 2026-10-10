// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_USDC_MINT } from "@/lib/constants";
import { AgreementForm } from "./agreement-form";

const state = vi.hoisted(() => ({ connected: true, wallet: "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", version: 0,
  fetch: vi.fn(), signature: vi.fn(), approve: vi.fn(), build: vi.fn(), simulate: vi.fn(), send: vi.fn(), getClient: vi.fn(), balance: vi.fn() }));
const recipients = ["aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq"];
const client = { sendTransaction: state.send };
const instructions = [{ programAddress: recipients[0] }, { programAddress: recipients[1] }];
const makeAgreement = (mask = 0, paid = false) => ({ address: recipients[0], creator: recipients[0], mint: MOCK_USDC_MINT, version: 1, splitId: 1n, bump: 1,
  recipients, sharesBps: [5000, 3000, 2000], approvalMask: mask,
  milestones: [
    { name: "Design", amount: 10_000_001n, paid, payer: recipients[0], paidAt: paid ? 1791590400n : 0n, paidSlot: paid ? 1n : 0n },
    { name: "Development", amount: 20_000_000n, paid: false, payer: recipients[0], paidAt: 0n, paidSlot: 0n },
  ] });
vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({ useConnectedWallet: () => state.connected ? {
  account: { address: state.wallet }, signer: { address: state.wallet }, supportedTransactionVersions: new Set([state.version]),
} : null }));
vi.mock("@/lib/agreement-client", async (original) => ({
  ...await original<typeof import("@/lib/agreement-client")>(), fetchAgreement: state.fetch,
  fetchMilestoneSignature: state.signature, buildApproveSplitInstruction: state.approve, buildPayMilestoneInstructions: state.build,
}));
vi.mock("@/lib/qazsplit-client", () => ({ simulateInstructions: state.simulate, fetchTokenBalance: state.balance }));
vi.mock("@/lib/transaction-compat", async (original) => ({ ...await original<typeof import("@/lib/transaction-compat")>(), getTransactionClient: state.getClient }));
const mount = () => render(createElement(AgreementForm, { splitAddress: recipients[0] }));
const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

describe("recipient approvals, milestones, and receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.connected = true; state.wallet = recipients[0]; state.version = 0;
    state.fetch.mockResolvedValue(makeAgreement()); state.signature.mockResolvedValue("verified-payment-signature");
    state.approve.mockReturnValue(instructions[0]); state.build.mockResolvedValue({ instructions, payerAta: recipients[0], recipientAtas: recipients });
    state.simulate.mockResolvedValue({}); state.getClient.mockReturnValue(client);
    state.send.mockResolvedValue({ context: { signature: "confirmed-payment-signature" } }); state.balance.mockResolvedValue(100_000_000n);
  });
  afterEach(cleanup);
  it("shows Pending, 0 of 3 and disables payment with an explicit reason", async () => {
    mount(); await screen.findByText("0 of 3 members approved");
    expect(screen.getByText("Pending approvals")).toBeTruthy(); expect(disabled("Simulate milestone payment")).toBe(true);
    expect(screen.getByText("Every recipient must approve before payment")).toBeTruthy();
    expect(disabled("Approve my 50.00% share")).toBe(false);
  });
  it.each(["disconnected", "outsider", "duplicate"])("does not allow %s approval", async (kind) => {
    if (kind === "disconnected") state.connected = false;
    if (kind === "outsider") state.wallet = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";
    if (kind === "duplicate") state.fetch.mockResolvedValue(makeAgreement(1));
    mount(); await screen.findByText(/of 3 members approved/);
    const button = screen.getByRole("button", { name: /Approve my|Share already approved|Approve assigned share/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); expect(state.send).not.toHaveBeenCalled();
  });
  it("simulates and sends only the connected recipient approval then refreshes progress", async () => {
    mount(); await screen.findByText("0 of 3 members approved");
    state.fetch.mockResolvedValue(makeAgreement(1));
    fireEvent.click(screen.getByRole("button", { name: "Approve my 50.00% share" }));
    await screen.findByText("1 of 3 members approved");
    expect(state.approve).toHaveBeenCalledWith(recipients[0], recipients[0]);
    expect(state.simulate).toHaveBeenCalledWith(client, recipients[0], [instructions[0]], 0);
    expect(state.send).toHaveBeenCalledExactlyOnceWith([instructions[0]]);
  });
  it("keeps payments blocked at 2 of 3", async () => {
    state.fetch.mockResolvedValue(makeAgreement(3)); mount(); await screen.findByText("2 of 3 members approved");
    expect(disabled("Simulate milestone payment")).toBe(true);
  });
  it.each([0, 1])("pays one selected milestone atomically with v%s, exact amounts, receipt and refreshed balances", async (version) => {
    state.version = version; state.fetch.mockResolvedValue(makeAgreement(7)); mount(); await screen.findByText("Active / Locked");
    fireEvent.click(screen.getByRole("button", { name: "Simulate milestone payment" }));
    await screen.findByText("Simulation passed."); expect(state.send).not.toHaveBeenCalled();
    state.fetch.mockResolvedValue(makeAgreement(7, true));
    fireEvent.click(screen.getByRole("button", { name: "Sign atomic payment" }));
    await screen.findByRole("heading", { name: "Payment receipt" });
    expect(state.send).toHaveBeenCalledExactlyOnceWith(instructions);
    expect(state.getClient).toHaveBeenCalledWith(client, version);
    expect(screen.getByText("confirmed-payment-signature")).toBeTruthy();
    expect(screen.getByText("QazSplit never held the funds")).toBeTruthy();
    const receipt = screen.getByRole("region", { name: "Payment receipt" });
    expect(receipt.textContent).toContain("10.000001 mock USDC");
    expect(receipt.textContent).toContain("2.000001 mock USDC");
    expect(receipt.textContent).toContain(recipients[2]);
    expect(screen.getAllByText(/Balance: 100 mock USDC/)).toHaveLength(3);
  });
  it("invalidates simulation when a different milestone or wallet is selected", async () => {
    state.fetch.mockResolvedValue(makeAgreement(7)); const view = mount(); await screen.findByText("Active / Locked");
    fireEvent.click(screen.getByRole("button", { name: "Simulate milestone payment" })); await screen.findByText("Simulation passed.");
    state.wallet = recipients[1]; view.rerender(createElement(AgreementForm, { splitAddress: recipients[0] }));
    expect(disabled("Sign atomic payment")).toBe(true);
    fireEvent.change(screen.getByLabelText("Project milestone"), { target: { value: "1" } });
    expect(disabled("Sign atomic payment")).toBe(true);
  });
  it("recovers a paid milestone receipt after reload, without permitting double payment", async () => {
    state.fetch.mockResolvedValue(makeAgreement(7, true)); mount(); await screen.findByText("verified-payment-signature");
    expect(disabled("Simulate milestone payment")).toBe(true); expect(disabled("Sign atomic payment")).toBe(true);
    expect(screen.getByRole("region", { name: "Payment receipt" })).toBeTruthy();
  });
  it("shows simulation and signing errors without marking a milestone Paid", async () => {
    state.fetch.mockResolvedValue(makeAgreement(7)); state.simulate.mockRejectedValueOnce(new Error("Insufficient mock USDC"));
    mount(); await screen.findByText("Active / Locked"); fireEvent.click(screen.getByRole("button", { name: "Simulate milestone payment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Insufficient mock USDC"));
    expect(state.send).not.toHaveBeenCalled(); expect(disabled("Sign atomic payment")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Simulate milestone payment" })); await screen.findByText("Simulation passed.");
    state.send.mockRejectedValueOnce(new Error("Wallet rejected request"));
    fireEvent.click(screen.getByRole("button", { name: "Sign atomic payment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Signature request was cancelled."));
    expect(screen.queryByRole("heading", { name: "Payment receipt" })).toBeNull();
  });
});
