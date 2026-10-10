// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletHistory } from "./wallet-history";
const state = vi.hoisted(() => ({ wallet: "DENNUUamXbytAJBV5EfvvLPwUZpQBbCpis1rU7unmUDn" as string | null, fetch: vi.fn() }));
const client = {};
vi.mock("@solana/react", () => ({ useClient: () => client }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({ useConnectedWallet: () => state.wallet ? { account: { address: state.wallet } } : null }));
vi.mock("@/lib/history-client", async (original) => ({ ...await original<typeof import("@/lib/history-client")>(), fetchWalletHistory: state.fetch }));
const wallet = "DENNUUamXbytAJBV5EfvvLPwUZpQBbCpis1rU7unmUDn";
const config = { address: wallet, creator: wallet, recipients: [wallet], sharesBps: [10000] };
const payment = { id: "sig:0", signature: "verified-signature", split: wallet, name: "Design", amount: 10_000_001n,
  payer: wallet, recipients: [wallet], allocations: [10_000_001n], timestamp: 1791590400n };
const data = () => ({ splits: [{ kind: "legacy", config }], payments: [payment], nextBefore: null, unavailable: 0 });
describe("wallet archive UI", () => {
  beforeEach(() => { state.wallet = wallet; vi.clearAllMocks(); state.fetch.mockResolvedValue(data()); });
  afterEach(cleanup);
  it("does not query or request a signature when disconnected", () => {
    state.wallet = null; render(createElement(WalletHistory)); expect(screen.getByText(/Connect your wallet to see/)).toBeTruthy(); expect(state.fetch).not.toHaveBeenCalled();
  });
  it("has an honest loading state", () => {
    state.fetch.mockReturnValue(new Promise(() => {})); render(createElement(WalletHistory)); expect(screen.getByRole("status").textContent).toContain("Loading");
  });
  it("shows old agreements and exact receipt amounts with devnet links", async () => {
    render(createElement(WalletHistory)); await screen.findByText("Design");
    expect(screen.getAllByText("10.000001 mock USDC")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Explorer/ }).getAttribute("href")).toContain("cluster=devnet");
    expect(screen.getByText("QazSplit never held the funds")).toBeTruthy();
  });
  it("shows empty state with a create action", async () => {
    state.fetch.mockResolvedValue({ splits: [], payments: [], nextBefore: null, unavailable: 0 });
    render(createElement(WalletHistory)); await screen.findByText("No agreements yet"); expect(screen.getByRole("link", { name: "Create a split" })).toBeTruthy();
  });
  it("retries failed loads without inventing data", async () => {
    state.fetch.mockRejectedValueOnce(new Error("RPC unavailable")); render(createElement(WalletHistory));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("Design");
  });
  it("deduplicates pages and makes incomplete history visible", async () => {
    state.fetch.mockResolvedValueOnce({ ...data(), nextBefore: "cursor", unavailable: 1 }).mockResolvedValueOnce(data());
    render(createElement(WalletHistory)); await screen.findByText(/Some transaction details/);
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull());
    expect(screen.getAllByText("Design")).toHaveLength(1);
  });
  it("refreshes from chain, and clears another wallet's history on switch", async () => {
    const view = render(createElement(WalletHistory)); await screen.findByText("Design");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" })); await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(2));
    state.wallet = "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX";
    state.fetch.mockReturnValue(new Promise(() => {})); view.rerender(createElement(WalletHistory));
    expect(screen.queryByText("Design")).toBeNull(); expect(screen.getByRole("status")).toBeTruthy();
  });
});
