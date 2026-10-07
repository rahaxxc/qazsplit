// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateSplitForm } from "./create-split-form";

const state = vi.hoisted(() => ({
  connected: false,
  walletAddress: "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ",
  supportsV1: true,
  supportsV0: true,
  send: vi.fn(), build: vi.fn(), simulate: vi.fn(), getClient: vi.fn(),
}));
const recipients = [
  "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX",
  "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8",
  "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq",
];
const client = { sendTransaction: state.send };

vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({
  useConnectedWallet: () => state.connected ? {
    account: { address: state.walletAddress }, signer: {},
    supportedTransactionVersions: new Set([
      ...(state.supportsV1 ? [1] : []), ...(state.supportsV0 ? [0] : []),
    ]),
  } : null,
}));
vi.mock("@/lib/transaction-compat", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/transaction-compat")>(),
  getTransactionClient: state.getClient,
}));
vi.mock("@/lib/qazsplit-client", () => ({
  buildCreateSplitInstruction: state.build,
  simulateInstructions: state.simulate,
}));

function buttons() {
  return {
    simulate: screen.getByRole("button", { name: "Simulate config" }) as HTMLButtonElement,
    create: screen.getByRole("button", { name: "Create immutable split" }) as HTMLButtonElement,
  };
}
function fillRecipients(values = recipients) {
  values.forEach((value, i) => fireEvent.change(screen.getByLabelText(`Recipient ${i + 1} wallet`), { target: { value } }));
}
async function simulateValid() {
  fillRecipients();
  fireEvent.click(buttons().simulate);
  await waitFor(() => expect(buttons().create.disabled).toBe(false));
}

describe("Create Split CTA prerequisites", () => {
  beforeEach(() => {
    state.connected = true;
    state.walletAddress = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";
    state.supportsV1 = true;
    state.supportsV0 = true;
    vi.clearAllMocks();
    state.getClient.mockReturnValue(client);
    state.build.mockResolvedValue({ instruction: { programAddress: recipients[0] }, splitConfig: recipients[0] });
    state.simulate.mockResolvedValue(undefined);
    state.send.mockResolvedValue({ context: { signature: "mock-test-signature" } });
  });
  afterEach(cleanup);

  it("disables both CTAs with a clear wallet reason before connection", () => {
    state.connected = false;
    render(createElement(CreateSplitForm));
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText("Connect your wallet first")).toBeTruthy();
  });

  it("disables both CTAs with a recipient reason for empty connected fields", () => {
    render(createElement(CreateSplitForm));
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText("Enter valid recipient addresses")).toBeTruthy();
  });

  it("hydrates prerequisite feedback safely with an auto-reconnected wallet", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(CreateSplitForm));
    expect(container.textContent).toContain("Connect your wallet first");
    document.body.append(container);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, createElement(CreateSplitForm), { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Enter valid recipient addresses");
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });

  it.each(["invalid", "duplicates"])("blocks %s recipient addresses", (scenario) => {
    render(createElement(CreateSplitForm));
    fillRecipients(scenario === "invalid" ? ["not-an-address", ...recipients.slice(1)] : [recipients[0], recipients[0], recipients[2]]);
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText(scenario === "invalid" ? "Enter valid recipient addresses" : "Recipient addresses must be unique")).toBeTruthy();
    expect(state.simulate).not.toHaveBeenCalled();
  });

  it.each(["19.99", "20.001", "0"])("blocks invalid allocation %s", (percent) => {
    render(createElement(CreateSplitForm));
    fillRecipients();
    fireEvent.change(screen.getAllByLabelText("Share percentage")[2], { target: { value: percent } });
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText(/Allocation must total 100%/)).toBeTruthy();
  });

  it("blocks a zero share even if the total is exactly 100%", () => {
    render(createElement(CreateSplitForm));
    fillRecipients();
    ["50", "50", "0"].forEach((value, i) => fireEvent.change(screen.getAllByLabelText("Share percentage")[i], { target: { value } }));
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
  });

  it("enables simulation for valid 50/30/20, then enables Create only after it passes", async () => {
    render(createElement(CreateSplitForm));
    fillRecipients();
    expect(buttons().simulate.disabled).toBe(false);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText("Simulate config first")).toBeTruthy();
    fireEvent.click(buttons().simulate);
    await waitFor(() => expect(buttons().create.disabled).toBe(false));
    expect(state.build.mock.calls[0][0].sharesBps).toEqual([5000, 3000, 2000]);
    expect(state.send).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "switch"])("invalidates a prepared config on wallet %s", async (change) => {
    const view = render(createElement(CreateSplitForm));
    await simulateValid();
    if (change === "disconnect") state.connected = false;
    else state.walletAddress = recipients[0];
    view.rerender(createElement(CreateSplitForm));
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText(change === "disconnect" ? "Connect your wallet first" : "Simulate config first")).toBeTruthy();
    fireEvent.click(buttons().create);
    expect(state.send).not.toHaveBeenCalled();
  });

  it("requires simulation again after editing recipients", async () => {
    render(createElement(CreateSplitForm));
    await simulateValid();
    fireEvent.change(screen.getByLabelText("Recipient 1 wallet"), { target: { value: "" } });
    expect(buttons().create.disabled).toBe(true);
    expect(buttons().simulate.disabled).toBe(true);
  });

  it("shows failed simulation feedback without enabling Create", async () => {
    state.simulate.mockRejectedValueOnce(new Error("Devnet simulation failed"));
    render(createElement(CreateSplitForm));
    fillRecipients();
    fireEvent.click(buttons().simulate);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Devnet simulation failed"));
    expect(buttons().create.disabled).toBe(true);
  });

  it.each(["Wallet rejected request", "Transaction failed"])("shows transaction feedback for %s", async (message) => {
    state.send.mockRejectedValueOnce(new Error(message));
    render(createElement(CreateSplitForm));
    await simulateValid();
    fireEvent.click(buttons().create);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(
      message.includes("rejected") ? "Signature request was cancelled." : message,
    ));
    expect(buttons().create.disabled).toBe(false);
  });

  it("shows readable cancellation feedback when the SDK wraps a wallet rejection", async () => {
    state.send.mockRejectedValueOnce(new Error("Solana error #11", {
      cause: new Error("User rejected signature request"),
    }));
    render(createElement(CreateSplitForm));
    await simulateValid();
    fireEvent.click(buttons().create);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Signature request was cancelled."));
    expect(buttons().create.disabled).toBe(false);
  });

  it("explains unsupported wallet transaction versions", () => {
    state.supportsV1 = false;
    state.supportsV0 = false;
    render(createElement(CreateSplitForm));
    fillRecipients();
    expect(buttons().simulate.disabled).toBe(true);
    expect(buttons().create.disabled).toBe(true);
    expect(screen.getByText("This wallet cannot sign supported Solana transactions. Try Phantom or Solflare.")).toBeTruthy();
  });

  it.each([0, 1])("simulates and sends exactly one config transaction using wallet version %s", async (version) => {
    state.supportsV1 = version === 1;
    render(createElement(CreateSplitForm));
    await simulateValid();
    expect(state.simulate.mock.calls[0][3]).toBe(version);
    fireEvent.click(buttons().create);
    await waitFor(() => expect(screen.getByText("Split created")).toBeTruthy());
    expect(state.getClient).toHaveBeenCalledWith(client, version);
    expect(state.send).toHaveBeenCalledExactlyOnceWith([{
      programAddress: recipients[0],
    }]);
  });

  it("requires a new simulation when the connected wallet's version support changes", async () => {
    const view = render(createElement(CreateSplitForm));
    await simulateValid();
    state.supportsV1 = false;
    view.rerender(createElement(CreateSplitForm));
    expect(buttons().create.disabled).toBe(true);
    expect(buttons().simulate.disabled).toBe(false);
    expect(screen.getByText("Simulate config first")).toBeTruthy();
    expect(state.send).not.toHaveBeenCalled();
  });
});
