"use client";

import { Copy, ExternalLink, LogOut, Wallet, X } from "lucide-react";
import {
  WalletReadyGate,
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWalletStatus,
  useWallets,
} from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useRef, useState, useSyncExternalStore } from "react";

import { explorerAddressUrl, truncateAddress } from "@/lib/format";
import type { AppClient } from "@/lib/solana-client";

const subscribeToHydration = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function WalletControls({ client }: { client: AppClient }) {
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const status = useWalletStatus(client);
  const { dispatch: connect, error: connectError } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [copied, setCopied] = useState(false);
  const installDialog = useRef<HTMLDialogElement>(null);

  if (connected) {
    const walletAddress = connected.account.address;
    return (
      <div className="wallet-cluster" aria-label="Wallet connection">
        <button
          type="button"
          className="wallet-address"
          onClick={async () => {
            await navigator.clipboard.writeText(walletAddress);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy wallet address"
        >
          <span className="status-dot" aria-hidden="true" />
          <span className="font-mono tabular-nums">
            {copied ? "Copied" : truncateAddress(walletAddress)}
          </span>
          <Copy size={15} aria-hidden="true" />
        </button>
        <a
          className="icon-button"
          href={explorerAddressUrl(walletAddress)}
          target="_blank"
          rel="noreferrer"
          aria-label="View wallet on Solana Explorer"
        >
          <ExternalLink size={17} aria-hidden="true" />
        </a>
        <button
          type="button"
          className="icon-button"
          onClick={() => disconnect()}
          aria-label="Disconnect wallet"
        >
          <LogOut size={17} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const firstWallet = wallets[0];
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className="primary-button min-w-40"
        disabled={status === "connecting"}
        aria-busy={status === "connecting"}
        aria-haspopup={!firstWallet ? "dialog" : undefined}
        title={firstWallet ? `Connect ${firstWallet.name}` : undefined}
        onClick={() => {
          if (firstWallet) connect(firstWallet);
          else installDialog.current?.showModal();
        }}
      >
        <Wallet size={17} aria-hidden="true" />
        {status === "connecting"
          ? "Connecting…"
          : firstWallet
            ? "Connect wallet"
            : "Install a Solana wallet"}
      </button>
      <dialog
        ref={installDialog}
        className="wallet-install-dialog"
        aria-labelledby="wallet-install-title"
        aria-describedby="wallet-install-help"
      >
        <div className="wallet-install-heading">
          <h2 id="wallet-install-title">Install a Solana wallet</h2>
          <button
            type="button"
            className="secondary-button"
            aria-label="Close wallet options"
            onClick={() => installDialog.current?.close()}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <p id="wallet-install-help" className="field-help">
          Choose a wallet. Installation opens on its official website in a new tab.
        </p>
        <div className="wallet-install-options">
          <a className="secondary-button" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
            Phantom <ExternalLink size={16} aria-hidden="true" />
          </a>
          <a className="secondary-button" href="https://www.solflare.com/download" target="_blank" rel="noopener noreferrer">
            Solflare <ExternalLink size={16} aria-hidden="true" />
          </a>
        </div>
      </dialog>
      {connectError ? (
        <p className="max-w-64 text-right text-xs text-danger" role="alert">
          Wallet connection failed. Unlock the wallet and try again.
        </p>
      ) : null}
    </div>
  );
}

export function WalletButton() {
  const client = useClient<AppClient>();
  // Wallet discovery/storage can settle before hydration. Keep the server and
  // first client render identical, then mount the browser-only wallet UI.
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientSnapshot,
    getServerSnapshot,
  );
  const fallback = <div className="skeleton h-10 w-40" aria-label="Loading wallets" />;
  if (!hydrated) return fallback;

  return (
    <WalletReadyGate
      client={client}
      fallback={fallback}
    >
      <WalletControls client={client} />
    </WalletReadyGate>
  );
}

