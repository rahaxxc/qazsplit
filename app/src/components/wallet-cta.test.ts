// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletButton } from "./wallet-button";

const state = vi.hoisted(() => ({
  installed: false, connected: false, connecting: false, error: null as Error | null,
  connect: vi.fn(), disconnect: vi.fn(),
}));
const phantom = { name: "Phantom" };

vi.mock("@solana/react", () => ({ useClient: () => ({}) }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({
  WalletReadyGate: ({ children }: { children: React.ReactNode }) => children,
  useWallets: () => state.installed ? [phantom] : [],
  useConnectedWallet: () => state.connected ? {
    account: { address: "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ" },
  } : null,
  useWalletStatus: () => state.connecting ? "connecting" : "disconnected",
  useConnect: () => ({ dispatch: state.connect, error: state.error }),
  useDisconnect: () => ({ dispatch: state.disconnect }),
}));

describe("Wallet CTA", () => {
  beforeEach(() => {
    state.installed = false;
    state.connected = false;
    state.connecting = false;
    state.error = null;
    vi.clearAllMocks();
    // jsdom does not implement the native modal API. Browser tests cover focus/Escape.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } },
      close: { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } },
    });
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  it("opens Phantom and Solflare official install links without an installed wallet", () => {
    render(createElement(WalletButton));
    const install = screen.getByRole("button", { name: "Install a Solana wallet" }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    const dialog = screen.getByRole("dialog", { name: "Install a Solana wallet" });
    expect(dialog.hasAttribute("open")).toBe(true);
    for (const [name, href] of [["Phantom", "https://phantom.com/download"], ["Solflare", "https://www.solflare.com/download"]]) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    fireEvent.click(screen.getByRole("button", { name: "Close wallet options" }));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("connects the discovered Phantom wallet instead of offering installation", () => {
    state.installed = true;
    render(createElement(WalletButton));
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(state.connect).toHaveBeenCalledWith(phantom);
    expect(screen.queryByRole("button", { name: "Install a Solana wallet" })).toBeNull();
  });

  it("shows a shortened connected address", () => {
    state.connected = true;
    render(createElement(WalletButton));
    expect(screen.getByTitle("Copy wallet address").textContent).toContain("Hnmu…jaEQ");
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("visibly reports connection failure and allows retry", () => {
    state.installed = true;
    state.error = new Error("Wallet locked");
    render(createElement(WalletButton));
    expect(screen.getByRole("alert").textContent).toContain("Wallet connection failed");
    expect((screen.getByRole("button", { name: "Connect wallet" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("prevents duplicate connect attempts while connecting", () => {
    state.installed = true;
    state.connecting = true;
    render(createElement(WalletButton));
    const button = screen.getByRole("button", { name: "Connecting…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
