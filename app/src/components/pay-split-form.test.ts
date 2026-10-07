// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_USDC_MINT } from "@/lib/constants";
import { PaySplitForm } from "./pay-split-form";

const state = vi.hoisted(() => ({
  version: 0 as number | null,
  connected: true,
  walletAddress: "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ",
  send: vi.fn(), getClient: vi.fn(), fetchConfig: vi.fn(), build: vi.fn(), simulate: vi.fn(), balance: vi.fn(),
}));
const recipients = [
  "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX",
  "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8",
  "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq",
];
const client = { sendTransaction: state.send };
const instructions = [{ programAddress: recipients[0] }, { programAddress: recipients[1] }];

vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({
  useConnectedWallet: () => state.connected ? {
    account: { address: state.walletAddress }, signer: { address: state.walletAddress },
    supportedTransactionVersions: new Set<number | string>(state.version == null ? ["legacy"] : [state.version]),
  } : null,
}));
vi.mock("@/lib/qazsplit-client", () => ({
  buildExecuteSplitInstructions: state.build, fetchSplitConfig: state.fetchConfig,
  fetchTokenBalance: state.balance, simulateInstructions: state.simulate,
}));
vi.mock("@/lib/transaction-compat", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/transaction-compat")>(),
  getTransactionClient: state.getClient,
}));

function renderPayment() {
  return render(createElement(PaySplitForm, { splitAddress: recipients[0] }));
}
async function simulatePayment() {
  await screen.findByRole("button", { name: "Simulate payment" });
  fireEvent.click(screen.getByRole("button", { name: "Simulate payment" }));
  await screen.findByText("Simulation passed.");
}

describe("Pay Split transaction version compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.version = 0;
    state.connected = true;
    state.walletAddress = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";
    state.getClient.mockReturnValue(client);
    state.fetchConfig.mockResolvedValue({ address: recipients[0], mint: MOCK_USDC_MINT, recipients, sharesBps: [5000, 3000, 2000] });
    state.build.mockResolvedValue({ instructions, recipientAtas: recipients, payerAta: state.walletAddress });
    state.balance.mockResolvedValue(100_000_000n);
    state.simulate.mockResolvedValue(undefined);
    state.send.mockResolvedValue({ context: { signature: "mock-test-signature" } });
  });
  afterEach(cleanup);

  it.each([0, 1])("simulates and sends all payment instructions together using v%s", async (version) => {
    state.version = version;
    renderPayment();
    await simulatePayment();
    expect(state.simulate).toHaveBeenCalledExactlyOnceWith(client, state.walletAddress, instructions, version);
    fireEvent.click(screen.getByRole("button", { name: "Sign atomic payment" }));
    await screen.findByText("Payment distributed");
    expect(state.getClient).toHaveBeenCalledWith(client, version);
    expect(state.send).toHaveBeenCalledExactlyOnceWith(instructions);
  });

  it("shows unsupported-version feedback rather than requesting a signature", async () => {
    state.version = null;
    renderPayment();
    await screen.findByRole("button", { name: "Simulate payment" });
    fireEvent.click(screen.getByRole("button", { name: "Simulate payment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Try Phantom or Solflare"));
    expect(state.simulate).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });

  it.each(["version", "wallet"])("requires a new simulation after a %s change", async (change) => {
    const view = renderPayment();
    await simulatePayment();
    if (change === "version") state.version = 1;
    else state.walletAddress = recipients[0];
    view.rerender(createElement(PaySplitForm, { splitAddress: recipients[0] }));
    expect((screen.getByRole("button", { name: "Sign atomic payment" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Simulation passed.")).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
  });
});
