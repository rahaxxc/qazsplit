"use client";

import { address, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { buildApproveSplitInstruction, buildPayMilestoneInstructions, fetchAgreement, fetchMilestoneSignature, getApprovalProgress, type SplitAgreement } from "@/lib/agreement-client";
import { MOCK_USDC_MINT } from "@/lib/constants";
import { explorerTransactionUrl, truncateAddress } from "@/lib/format";
import { fetchTokenBalance, simulateInstructions } from "@/lib/qazsplit-client";
import type { AppClient } from "@/lib/solana-client";
import { calculateAllocations, formatTokenAmount } from "@/lib/split-math";
import { getTransactionClient, getWalletTransactionVersion, type WalletTransactionVersion } from "@/lib/transaction-compat";

type Prepared = { instructions: Instruction[]; payer: Address; version: WalletTransactionVersion; index: number };
type ReceiptProof = { index: number; signature: string; clientTimestamp?: string };
function message(error: unknown): string {
  for (let i = 0; i < 5 && error instanceof Error && error.cause instanceof Error; i++) error = error.cause;
  const text = error instanceof Error ? error.message : "Request failed. Try again.";
  return /reject|declin|cancel/i.test(text) ? "Signature request was cancelled." : text;
}

export function AgreementForm({ splitAddress }: { splitAddress: string }) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const walletAddress = connected?.account.address;
  const version = connected ? getWalletTransactionVersion(connected.supportedTransactionVersions) : null;
  const [agreement, setAgreement] = useState<SplitAgreement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"idle" | "simulating" | "ready" | "signing" | "approving">("idle");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [receipt, setReceipt] = useState<ReceiptProof | null>(null);
  const [balances, setBalances] = useState<bigint[]>([]);
  const [payerBalance, setPayerBalance] = useState<bigint | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = phase === "simulating" || phase === "signing" || phase === "approving";

  const load = useCallback(async () => {
    const stored = await fetchAgreement(client, splitAddress);
    if (stored.mint !== MOCK_USDC_MINT) throw new Error("Only the approved devnet mock-USDC mint is supported.");
    return stored;
  }, [client, splitAddress]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const stored = await load(); if (active) { setAgreement(stored); setNotice(null); } }
      catch (error) { if (active) setError(message(error)); }
      finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [load]);

  const readBalances = useCallback(async (stored: SplitAgreement) => {
    const owners = walletAddress ? [address(walletAddress), ...stored.recipients] : stored.recipients;
    const amounts = await Promise.all(owners.map(async (owner) => {
      const [ata] = await findAssociatedTokenPda({ owner, mint: stored.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      return fetchTokenBalance(client, ata);
    }));
    return { payerBalance: walletAddress ? amounts[0] : null, balances: walletAddress ? amounts.slice(1) : amounts };
  }, [client, walletAddress]);

  async function refreshBalances(stored: SplitAgreement) {
    const result = await readBalances(stored);
    setPayerBalance(result.payerBalance);
    setBalances(result.balances);
  }

  useEffect(() => {
    if (!agreement) return;
    let active = true;
    void readBalances(agreement).then((result) => {
      if (!active) return;
      setPayerBalance(result.payerBalance); setBalances(result.balances);
    }).catch(() => { if (active) setNotice("Balances could not refresh. Use Refresh status to retry."); });
    return () => { active = false; };
  }, [agreement, readBalances]);

  const milestone = agreement?.milestones[index];
  useEffect(() => {
    if (!agreement || !milestone?.paid || receipt?.index === index) return;
    let active = true;
    void fetchMilestoneSignature(client, agreement, index)
      .then((signature) => { if (active && signature) setReceipt({ index, signature }); })
      .catch(() => { if (active) setNotice("Payment is recorded onchain. Receipt signature lookup failed; refresh to retry."); });
    return () => { active = false; };
  }, [client, agreement, index, milestone?.paid, receipt?.index]);

  const progress = agreement ? getApprovalProgress(agreement) : null;
  const memberIndex = agreement?.recipients.findIndex((recipient) => recipient === walletAddress) ?? -1;
  const alreadyApproved = !!agreement && memberIndex >= 0 && (agreement.approvalMask & (1 << memberIndex)) !== 0;
  const walletReason = !connected?.signer ? "Connect your wallet first" : version == null ? "This wallet cannot sign supported Solana transactions. Try Phantom or Solflare." : null;
  const approvalReason = walletReason ?? (memberIndex < 0 ? "Connect a recipient wallet to approve its assigned share" : alreadyApproved ? "Your share is already approved onchain" : null);
  const paymentReason = walletReason ?? (!progress?.active ? "Every recipient must approve before payment" : milestone?.paid ? "This milestone is already Paid" : null);
  const preparedForSelection = !!prepared && prepared.payer === walletAddress && prepared.version === version && prepared.index === index;
  const allocations = agreement && milestone ? calculateAllocations(milestone.amount, agreement.sharesBps) : [];

  async function refresh() {
    setError(null);
    try { const stored = await load(); setAgreement(stored); await refreshBalances(stored); }
    catch (error) { setError(message(error)); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { setError("Clipboard unavailable. Select and copy the address manually."); }
  }
  async function approve() {
    if (!agreement || approvalReason || !connected?.signer || version == null || busy) return;
    setError(null); setPrepared(null); setPhase("approving");
    try {
      const recipient = address(connected.account.address);
      const instruction = buildApproveSplitInstruction(recipient, agreement.address);
      await simulateInstructions(client, recipient, [instruction], version);
      await getTransactionClient(client, version).sendTransaction([instruction]);
      // A confirmed signature is not undone by a later RPC refresh failure.
      try { setAgreement(await load()); } catch { setNotice("Approval sent. Refresh status to see confirmation."); }
    } catch (error) { setError(message(error)); }
    finally { setPhase("idle"); }
  }
  async function simulate() {
    if (!agreement || paymentReason || !connected?.signer || version == null || busy) return;
    setError(null); setPrepared(null); setPhase("simulating");
    try {
      const built = await buildPayMilestoneInstructions({ payer: connected.signer, agreement, milestoneIndex: index });
      const payer = address(connected.account.address);
      await refreshBalances(agreement);
      await simulateInstructions(client, payer, built.instructions, version);
      setPrepared({ instructions: built.instructions, payer, version, index }); setPhase("ready");
    } catch (error) { setError(message(error)); setPhase("idle"); }
  }
  async function pay() {
    if (!prepared || !agreement || !milestone || !preparedForSelection || paymentReason || busy) return;
    setError(null); setPhase("signing");
    try {
      const result = await getTransactionClient(client, prepared.version).sendTransaction(prepared.instructions);
      const timestamp = new Date().toISOString(); // event-time only; never part of server HTML
      setReceipt({ index, signature: result.context.signature, clientTimestamp: timestamp });
      setPrepared(null); setPhase("idle");
      // Mark locally after confirmed send, preventing another click if refresh is slow.
      const confirmed = { ...agreement, milestones: agreement.milestones.map((m, i) => i === index ? { ...m, paid: true, payer: prepared.payer } : m) };
      setAgreement(confirmed);
      try { const stored = await load(); setAgreement(stored); await refreshBalances(stored); }
      catch { setNotice("Payment confirmed. Balances/status refresh is pending; do not pay again. Use Refresh status."); }
    } catch (error) { setError(message(error)); setPrepared(null); setPhase("idle"); }
  }

  if (loading) return <div className="form-panel" aria-busy="true" aria-label="Loading agreement"><div className="skeleton h-16 w-full" /></div>;
  if (!agreement || !milestone || !progress) return <div className="form-panel error-empty-state" role="alert"><h1>Agreement unavailable</h1><p>{error}</p><button className="secondary-button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div className="form-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">2 · Approve / Pay Split</p><h1>One agreement. Every teammate included.</h1>
          <p className="font-mono text-xs break-all">Agreement {agreement.address}</p></div>
        <span className="verified-chip"><ShieldCheck size={16} aria-hidden="true" />{progress.active ? "Active / Locked" : "Pending approvals"}</span>
      </div>
      <section aria-labelledby="approval-heading">
        <div className="section-title-row"><h2 id="approval-heading">Recipient approval</h2><span role="status" className="font-mono tabular-nums">{progress.approved} of {progress.total} members approved</span></div>
        <p className="field-help">Wallets, shares and milestones are immutable. Each member signs their own share onchain. Approval does not transfer tokens.</p>
        <ul className="recipient-list mt-4">
          {agreement.recipients.map((recipient, i) => (
            <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4" key={recipient}>
              <button className="secondary-button font-mono" type="button" title={recipient} onClick={() => void copy(recipient)} aria-label={`Copy recipient ${i + 1} address`}>{truncateAddress(recipient, 6)}{copied === recipient ? " · Copied" : ""}</button>
              <span className="font-mono tabular-nums">{(agreement.sharesBps[i] / 100).toFixed(2)}%</span>
              <span>{agreement.approvalMask & (1 << i) ? "Approved" : "Awaiting approval"}</span>
            </li>
          ))}
        </ul>
        <div className="action-row mt-4">
          <div className="cta-with-help"><button className="primary-button" type="button" disabled={!!approvalReason || busy} aria-describedby="approval-reason" aria-busy={phase === "approving"} onClick={() => void approve()}>
            {phase === "approving" ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : null}
            {alreadyApproved ? "Share already approved" : memberIndex >= 0 ? `Approve my ${(agreement.sharesBps[memberIndex] / 100).toFixed(2)}% share` : "Approve assigned share"}
          </button>{approvalReason ? <p id="approval-reason" className="field-help">{approvalReason}</p> : null}</div>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden="true" />Refresh status</button>
        </div>
      </section>
      <section className="preview-section" aria-labelledby="milestones-heading">
        <h2 id="milestones-heading">Milestone payment</h2>
        <label className="field-label mt-4" htmlFor="milestone-select">Project milestone</label>
        <select id="milestone-select" className="text-input" value={index} disabled={busy} onChange={(event) => { setIndex(Number(event.target.value)); setPrepared(null); setPhase("idle"); setError(null); }}>
          {agreement.milestones.map((m, i) => <option key={i} value={i}>{m.name} — {formatTokenAmount(m.amount)} mock USDC — {m.paid ? "Paid" : "Unpaid"}</option>)}
        </select>
        <div className="payment-grid mt-5">
          <div><p className="field-label">Fixed milestone amount</p><strong className="block break-words font-mono text-2xl sm:text-3xl tabular-nums">{formatTokenAmount(milestone.amount)} mock USDC</strong><p className="field-help">Funds move directly from the paying client to the approved recipients in one atomic transaction.</p></div>
          <div className="payer-balance"><span>Wallet balance</span><strong className="break-all font-mono tabular-nums">{payerBalance == null ? "—" : `${formatTokenAmount(payerBalance)} mock USDC`}</strong></div>
        </div>
        <h3 className="mt-6">Allocation preview</h3>
        <p className="field-help">Integer token units; any rounding remainder goes to the final recipient.</p>
        <ul className="recipient-list">
          {agreement.recipients.map((recipient, i) => <li className="preview-row" key={recipient}>
            <span title={recipient} className="font-mono">{truncateAddress(recipient, 6)}</span>
            <span className="font-mono tabular-nums">{(agreement.sharesBps[i] / 100).toFixed(2)}%</span>
            <strong className="break-all font-mono tabular-nums">{formatTokenAmount(allocations[i])} mock USDC</strong>
            <span className="balance-cell break-all font-mono tabular-nums">Balance: {balances[i] == null ? "—" : `${formatTokenAmount(balances[i])} mock USDC`}</span>
          </li>)}
        </ul>
        {phase === "ready" && preparedForSelection && !paymentReason ? <div className="success-banner" role="status"><Check size={18} aria-hidden="true" /><div><strong>Simulation passed.</strong><p>All transfers fit one atomic transaction. The next click requests one signature.</p></div></div> : null}
        <div className="action-row">
          <button type="button" className="secondary-button flex-1" disabled={!!paymentReason || busy} aria-describedby="milestone-payment-reason" aria-busy={phase === "simulating"} onClick={() => void simulate()}>{phase === "simulating" ? "Simulating…" : "Simulate milestone payment"}</button>
          <div className="cta-with-help"><button type="button" className="primary-button" disabled={!!paymentReason || busy || !preparedForSelection} aria-describedby="milestone-payment-reason" aria-busy={phase === "signing"} onClick={() => void pay()}>{phase === "signing" ? "Check wallet…" : "Sign atomic payment"}</button>
            <p id="milestone-payment-reason" className="field-help">{paymentReason ?? (preparedForSelection ? "" : "Simulate the selected milestone first")}</p></div>
        </div>
      </section>
      {error ? <div className="error-banner" role="alert"><strong>Request failed.</strong><span className="whitespace-pre-wrap">{error}</span></div> : null}
      {notice ? <p role="status" className="field-help">{notice}</p> : null}
      {milestone.paid ? <section className="preview-section" aria-labelledby="receipt-heading">
        <div className="section-title-row"><h2 id="receipt-heading">Payment receipt</h2><span className="verified-chip">Paid</span></div>
        <p>{milestone.name} · <strong className="font-mono tabular-nums">{formatTokenAmount(milestone.amount)} mock USDC</strong></p>
        <ul className="mt-4 space-y-4">{agreement.recipients.map((recipient, i) => <li key={recipient}>
          <p>Recipient {i + 1} · <strong className="font-mono tabular-nums">{formatTokenAmount(allocations[i])} mock USDC</strong></p>
          <p className="font-mono text-xs break-all select-all">{recipient}</p>
        </li>)}</ul>
        {receipt?.index === index ? <><p className="font-mono text-xs break-all select-all mt-5">{receipt.signature}</p>
          <a className="primary-button mt-4 w-fit" href={explorerTransactionUrl(receipt.signature)} target="_blank" rel="noreferrer">View transaction <ExternalLink size={16} aria-hidden="true" /></a></> : <p className="field-help">Looking up the confirmed payment signature… Use Refresh status if it does not appear.</p>}
        {milestone.paidAt > 0n ? <p className="field-help">Onchain time: <time dateTime={new Date(Number(milestone.paidAt) * 1000).toISOString()}>{new Date(Number(milestone.paidAt) * 1000).toISOString()}</time></p>
          : receipt?.index === index && receipt.clientTimestamp ? <p className="field-help">Client time: <time dateTime={receipt.clientTimestamp}>{receipt.clientTimestamp}</time></p> : null}
        <p className="mt-4 text-success">QazSplit never held the funds</p>
      </section> : null}
    </div>
  );
}
