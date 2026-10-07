"use client";

import { address, type Address, type Instruction } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MOCK_USDC_DECIMALS, MOCK_USDC_MINT } from "@/lib/constants";
import { explorerTransactionUrl, truncateAddress } from "@/lib/format";
import {
  type SplitConfig,
  buildExecuteSplitInstructions,
  fetchSplitConfig,
  fetchTokenBalance,
  simulateInstructions,
} from "@/lib/qazsplit-client";
import type { AppClient } from "@/lib/solana-client";
import { getTransactionClient, getWalletTransactionVersion, type WalletTransactionVersion } from "@/lib/transaction-compat";
import {
  calculateAllocations,
  formatTokenAmount,
  parseTokenAmount,
} from "@/lib/split-math";

type PreparedPayment = {
  instructions: Instruction[];
  recipientAtas: Address[];
  payerAta: Address;
  rawAmount: bigint;
  payerAddress: Address;
  transactionVersion: WalletTransactionVersion;
};

function messageFromError(error: unknown): string {
  for (let depth = 0; depth < 5 && error instanceof Error && error.cause instanceof Error; depth++) {
    error = error.cause;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function PaySplitForm({ splitAddress }: { splitAddress: string }) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const transactionVersion = connected ? getWalletTransactionVersion(connected.supportedTransactionVersions) : null;
  const [config, setConfig] = useState<SplitConfig | null>(null);
  const [amount, setAmount] = useState("10");
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"idle" | "simulating" | "ready" | "signing" | "success">(
    "idle",
  );
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [balances, setBalances] = useState<bigint[]>([]);
  const [payerBalance, setPayerBalance] = useState<bigint | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preparedForWallet = !!prepared && prepared.payerAddress === connected?.account.address
    && prepared.transactionVersion === transactionVersion;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextConfig = await fetchSplitConfig(client, splitAddress);
      if (nextConfig.mint !== MOCK_USDC_MINT) {
        throw new Error("This payment link does not use the approved devnet Mock USDC mint.");
      }
      setConfig(nextConfig);
    } catch (loadError) {
      setConfig(null);
      setError(messageFromError(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, splitAddress]);

  useEffect(() => {
    let active = true;
    fetchSplitConfig(client, splitAddress)
      .then((nextConfig) => {
        if (!active) return;
        if (nextConfig.mint !== MOCK_USDC_MINT) {
          throw new Error("This payment link does not use the approved devnet Mock USDC mint.");
        }
        setConfig(nextConfig);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setConfig(null);
        setError(messageFromError(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, splitAddress]);

  const rawAmount = useMemo(
    () => parseTokenAmount(amount, MOCK_USDC_DECIMALS),
    [amount],
  );
  const allocations = useMemo(() => {
    if (!config || rawAmount == null) return [];
    try {
      return calculateAllocations(rawAmount, config.sharesBps);
    } catch {
      return [];
    }
  }, [config, rawAmount]);

  async function refreshBalances(payment: PreparedPayment) {
    const [nextPayerBalance, ...nextRecipientBalances] = await Promise.all([
      fetchTokenBalance(client, payment.payerAta),
      ...payment.recipientAtas.map((ata) => fetchTokenBalance(client, ata)),
    ]);
    setPayerBalance(nextPayerBalance);
    setBalances(nextRecipientBalances);
  }

  async function handleSimulate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSignature(null);
    if (!config) {
      setError("Load a valid split config before paying.");
      return;
    }
    if (!connected?.signer) {
      setError("Connect the client wallet that will pay Mock USDC.");
      return;
    }
    if (transactionVersion == null) {
      setError("This wallet cannot sign supported Solana transactions. Try Phantom or Solflare.");
      return;
    }
    if (rawAmount == null) {
      setError("Enter a positive Mock USDC amount with no more than six decimals.");
      return;
    }

    setPrepared(null);
    setPhase("simulating");
    try {
      const built = await buildExecuteSplitInstructions({
        payer: connected.signer,
        config,
        amount: rawAmount,
      });
      const payerAddress = address(connected.account.address);
      const nextPrepared = { ...built, rawAmount, payerAddress, transactionVersion };
      await refreshBalances(nextPrepared);
      await simulateInstructions(client, payerAddress, built.instructions, transactionVersion);
      setPrepared(nextPrepared);
      setPhase("ready");
    } catch (simulationError) {
      setPrepared(null);
      setPhase("idle");
      setError(messageFromError(simulationError));
    }
  }

  async function handlePay() {
    if (!prepared || !connected?.signer || !preparedForWallet) {
      setError("Simulate payment again for the connected wallet.");
      return;
    }
    setPhase("signing");
    setError(null);
    try {
      const result = await getTransactionClient(client, prepared.transactionVersion).sendTransaction(prepared.instructions);
      setSignature(result.context.signature);
      setPhase("success");
      await refreshBalances(prepared);
    } catch (sendError) {
      setPhase("ready");
      const message = messageFromError(sendError);
      setError(/reject|declin|cancel/i.test(message) ? "Signature request was cancelled." : message);
    }
  }

  if (loading) {
    return (
      <div className="form-panel" aria-busy="true" aria-label="Loading split config">
        <div className="skeleton h-8 w-52" />
        <div className="mt-4 skeleton h-16 w-full" />
        <div className="mt-5 space-y-3">
          <div className="skeleton h-14 w-full" />
          <div className="skeleton h-14 w-full" />
          <div className="skeleton h-14 w-full" />
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="form-panel error-empty-state" role="alert">
        <h1>Payment link unavailable</h1>
        <p>{error ?? "The split config could not be loaded from devnet."}</p>
        <button type="button" className="secondary-button" onClick={() => void loadConfig()}>
          <RefreshCw size={17} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }

  return (
    <form className="form-panel" onSubmit={handleSimulate} noValidate>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">2 · Pay Split</p>
          <h1>One signature. Every teammate paid.</h1>
          <p className="font-mono text-xs break-all">Config {config.address}</p>
        </div>
        <div className="verified-chip">
          <ShieldCheck size={16} aria-hidden="true" /> Immutable config
        </div>
      </div>

      <div className="payment-grid">
        <div>
          <label className="field-label" htmlFor="payment-amount">
            Client payment
          </label>
          <div className="amount-field">
            <input
              id="payment-amount"
              className="amount-input font-mono tabular-nums"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={phase === "simulating" || phase === "signing"}
              aria-invalid={rawAmount == null}
              aria-describedby="payment-help"
              onChange={(event) => {
                setAmount(event.target.value);
                setPrepared(null);
                setPhase("idle");
                setError(null);
              }}
            />
            <span>Mock USDC</span>
          </div>
          <p id="payment-help" className="field-help">
            Six decimals maximum. Funds remain in your wallet until the transaction succeeds.
          </p>
        </div>
        <div className="payer-balance">
          <span>Wallet balance</span>
          <strong className="font-mono tabular-nums">
            {payerBalance == null
              ? "—"
              : `${formatTokenAmount(payerBalance, MOCK_USDC_DECIMALS)} USDC`}
          </strong>
        </div>
      </div>

      <section aria-labelledby="allocation-preview" className="preview-section">
        <div className="section-title-row">
          <div>
            <h2 id="allocation-preview">Allocation preview</h2>
            <p>Calculated in integer token units. Any remainder goes to the final recipient.</p>
          </div>
          <span className="font-mono text-xs tabular-nums">10,000 bps</span>
        </div>
        <div className="recipient-list">
          {config.recipients.map((recipient, index) => (
            <div className="preview-row" key={recipient}>
              <div>
                <span className="recipient-index">{index + 1}</span>
                <span className="font-mono" title={recipient}>
                  {truncateAddress(recipient, 6)}
                </span>
              </div>
              <span className="font-mono tabular-nums">
                {(config.sharesBps[index] / 100).toFixed(2)}%
              </span>
              <strong className="font-mono tabular-nums">
                {allocations[index] == null
                  ? "—"
                  : `${formatTokenAmount(allocations[index], MOCK_USDC_DECIMALS)} USDC`}
              </strong>
              <span className="balance-cell font-mono tabular-nums">
                Balance: {balances[index] == null ? "—" : formatTokenAmount(balances[index], 6)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          <strong>Payment not ready.</strong>
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      ) : null}

      {phase === "ready" && preparedForWallet ? (
        <div className="success-banner" role="status">
          <Check size={18} aria-hidden="true" />
          <div>
            <strong>Simulation passed.</strong>
            <p>All transfers fit one atomic transaction. The next click requests one signature.</p>
          </div>
        </div>
      ) : null}

      {phase === "success" && signature ? (
        <div className="success-panel" role="status">
          <div className="success-icon" aria-hidden="true">
            <Check size={22} />
          </div>
          <div>
            <h2>Payment distributed</h2>
            <p>Recipient balances above have been refreshed from devnet.</p>
            <a
              className="primary-button mt-4 w-fit"
              href={explorerTransactionUrl(signature)}
              target="_blank"
              rel="noreferrer"
            >
              View transaction <ExternalLink size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : (
        <div className="action-row">
          <button
            type="submit"
            className="secondary-button flex-1"
            disabled={phase === "simulating" || phase === "signing"}
            aria-busy={phase === "simulating"}
          >
            {phase === "simulating" ? (
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
            ) : null}
            {phase === "simulating" ? "Simulating…" : "Simulate payment"}
          </button>
          <button
            type="button"
            className="primary-button flex-1"
            disabled={!preparedForWallet || phase === "signing" || phase === "simulating"}
            aria-busy={phase === "signing"}
            onClick={handlePay}
          >
            {phase === "signing" ? (
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
            ) : null}
            {phase === "signing" ? "Check wallet…" : "Sign atomic payment"}
          </button>
        </div>
      )}
    </form>
  );
}

