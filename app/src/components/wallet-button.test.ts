// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletButton } from "./wallet-button";

const wallet = vi.hoisted(() => ({ ready: false, connected: false }));

vi.mock("@solana/react", () => ({ useClient: () => ({}) }));
vi.mock("@solana/kit-plugin-wallet/react", () => ({
  WalletReadyGate: ({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) =>
    wallet.ready ? children : fallback,
  useWallets: () => [{ name: "Test Wallet" }],
  useConnectedWallet: () => wallet.connected
    ? { account: { address: "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ" } }
    : null,
  useWalletStatus: () => wallet.connected ? "connected" : "disconnected",
  useConnect: () => ({ dispatch: vi.fn(), error: null }),
  useDisconnect: () => ({ dispatch: vi.fn() }),
}));

describe("WalletButton hydration", () => {
  beforeEach(() => {
    wallet.ready = false;
    wallet.connected = false;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("server-renders only the skeleton even if the wallet store is ready", () => {
    wallet.ready = true;
    expect(renderToString(createElement(WalletButton))).toBe(
      '<div class="skeleton h-10 w-40" aria-label="Loading wallets"></div>',
    );
  });

  it.each([false, true])("hydrates safely when browser wallet connected=%s", async (connected) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(WalletButton));
    document.body.append(container);
    // Browser discovery/auto-reconnect finishes before the first client render.
    wallet.ready = true;
    wallet.connected = connected;
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, createElement(WalletButton), { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.querySelector('[aria-label="Loading wallets"]')).toBeNull();
      expect(connected
        ? container.querySelector('[aria-label="Wallet connection"]')
        : container.textContent?.includes("Connect wallet")).toBeTruthy();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});
