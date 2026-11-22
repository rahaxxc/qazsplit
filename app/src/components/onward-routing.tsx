"use client";

import { address, getBase58Decoder, isTransactionModifyingSigner, type Transaction } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { Check, Circle, CircleX, ExternalLink, LoaderCircle, RefreshCw, Route } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SplitAgreement } from "@/lib/agreement-client";
import { DEVNET_CHAIN } from "@/lib/constants";
import { explorerAddressUrl, explorerTransactionUrl, truncateAddress } from "@/lib/format";
import {
  describeRoutingError, loadStoredRoutings, mergeRestoredRoutings, removeStoredRouting, routingApi, saveFinalStatus, saveStoredRouting, withRoutingLock,
  RoutingApiError, type DescribedRoutingError, type RoutingEstimate, type RoutingTransfer, type StoredRouting,
} from "@/lib/multihopper/client";
import { RoutingBundleError } from "@/lib/multihopper/errors";
import { PRIORITY_FEE_CAP_LAMPORTS, createOutflowGuard } from "@/lib/multihopper/inspection";
import {
  assertKeeperFundingTrackable, assertNoDuplicateKeeperFunding, clearKeeperFunding, keeperFundingNotice, noticeFromReconciliation, reconcileKeeperFunding,
  recordKeeperFunding, sendTrackedKeeperFunding, type KeeperFundingNotice,
} from "@/lib/multihopper/keeper-funding";
import {
  addSpentLamports, clearLifecycleJournals, ensureActivated, mergeBroadcastSignatures, outflowLimitLamports, readBroadcastSignatures, readSpentLamports,
  requiredBalanceLamports, saveBroadcastSignatures, signatureEntry, verifyDelivery, type ActivationOutcome, type DeliveryResult, type DeliveryRpc,
} from "@/lib/multihopper/lifecycle";
import {
  ARRIVAL_PRESETS, DEFAULT_ARRIVAL_SECONDS, DEFAULT_HOPS, MAX_HOPS, MIN_HOPS, buildRecoveryMessage, buildRoutingApprovalMessage, formatSol,
  isAwaitingSignature, isTerminalStatus, parseSolAmount, validateDestination, type RecoveryRequest, type RoutingRequest,
} from "@/lib/multihopper/shared";
import {
  assertBundleNotExpired, assertSameAccount, executeBundle, guarded, planBundle, planGroup, sendAndConfirmTransaction, signBundle, stepLabel,
  type BroadcastEvent, type BundleStep, type ConfirmBroadcastBody, type PreSendCheck, type PreparedTxs,
} from "@/lib/multihopper/transactions";
import { assertDevnet } from "@/lib/qazsplit-client";
import type { AppClient } from "@/lib/solana-client";

type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
type LiveAccount = () => string | null;
type StepRow = { key: string; label: string; state: "pending" | "sending" | "confirmed" | "failed"; signature?: string };
type Phase = "idle" | "reconciling" | "preparing" | "review" | "signing" | "broadcasting" | "activating" | "recovering";
type Review = { steps: BundleStep[]; limitLamports: bigint; balanceLamports: bigint; requiredLamports: bigint; expiresAtMs: number };

const POLL_MS = 10_000;
const APPROVAL_REUSE_MS = 240_000; // the server accepts a signed approval for 300 s
const PREVIEW_TTL_MS = 120_000; // a fee preview older than this must be refreshed (audit M2)
const TYPICAL_BUNDLE_SIZE = 8; // fee headroom for the preview balance check; the real count is used before signing
const HOP_OPTIONS = Array.from({ length: MAX_HOPS - MIN_HOPS + 1 }, (_, i) => MIN_HOPS + i);
const STATUS_LABELS: Record<string, string> = {
  quote: "Quote ready · awaiting your signatures",
  awaiting_signature: "Awaiting your signatures",
  processing: "Processing · MultiHopper is verifying the deployment",
  active: "Routing in progress",
  completed: "Completed per MultiHopper",
  failed: "Failed",
  expired: "Expired",
  refunded: "Refunded",
};

/** Why this wallet cannot complete MultiHopper routing, or null when it can. */
function walletCapability(connected: Connected): string | null {
  if (!connected.signer) return "This wallet is read-only. Connect a wallet that can sign.";
  if (connected.account.chains?.length && !connected.account.chains.includes(DEVNET_CHAIN)) return "This wallet account is not available on Solana devnet. Switch your wallet to devnet.";
  if (!connected.account.features?.includes("solana:signMessage")) return "Your wallet must support message signing to prove you own it. Try Phantom or Solflare.";
  if (!isTransactionModifyingSigner(connected.signer)) return "Your wallet must be able to sign transactions without sending them. Try Phantom or Solflare.";
  const versions = connected.supportedTransactionVersions;
  if (!versions.has(0) || !versions.has("legacy")) return "MultiHopper requires a wallet that signs both legacy and version 0 transactions. Try Phantom or Solflare.";
  return null;
}

const sol = (lamports: bigint | number | string | null | undefined) => (lamports == null ? "—" : `${formatSol(lamports)} SOL`);

function Detail({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`m-0 break-all text-right font-mono tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

function ExplorerLink({ signature, children }: { signature: string; children?: React.ReactNode }) {
  return (
    <a className="inline-flex items-center gap-1 underline" href={explorerTransactionUrl(signature)} target="_blank" rel="noreferrer">
      {children ?? "Explorer"} <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

/**
 * Optional, recipient-initiated onward routing after a Paid milestone. Fully separate from
 * QazSplit settlement: nothing here builds or sends a pay_milestone transaction, and a routing
 * failure cannot affect the payout that already confirmed.
 */
export function OnwardRouting({ agreement, milestoneIndex }: { agreement: SplitAgreement; milestoneIndex: number }) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const wallet = connected?.account.address;
  // The account connected *now*, read by in-flight flows to stop if the wallet switched accounts.
  const live = useRef<string | null>(null);
  useEffect(() => { live.current = wallet ?? null; }, [wallet]);
  const liveAccount = useCallback(() => live.current, []);
  if (!connected || !wallet) return null;
  return <RoutingPanel key={wallet} client={client} connected={connected} wallet={wallet} liveAccount={liveAccount} agreementAddress={agreement.address} milestoneIndex={milestoneIndex} />;
}

function RoutingPanel({ client, connected, wallet, liveAccount, agreementAddress, milestoneIndex }: {
  client: AppClient; connected: Connected; wallet: string; liveAccount: LiveAccount; agreementAddress: string; milestoneIndex: number;
}) {
  const [enabled, setEnabled] = useState(false);
  // Remounted per wallet (keyed), and only ever rendered after the agreement loads in the browser.
  const [stored, setStored] = useState<StoredRouting[]>(() => loadStoredRoutings(wallet));
  const [created, setCreated] = useState<Record<number, RoutingTransfer>>({});
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  // Routings restored from MultiHopper carry no agreement, so they are listed on every agreement page.
  const mine = stored.filter((entry) => entry.agreement === agreementAddress || entry.restored);

  async function restore() {
    if (restoring) return;
    setRestoring(true); setRestoreMessage(null);
    try {
      const request: RecoveryRequest = { wallet, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: window.location.origin };
      const signature = await client.wallet.signMessage(new TextEncoder().encode(buildRecoveryMessage(request)));
      const { routings } = await routingApi.recoverAccess({ ...request, signature: getBase58Decoder().decode(signature) });
      setStored(mergeRestoredRoutings(wallet, routings.map(({ transfer, accessToken }): StoredRouting => ({
        transferId: transfer.id, accessToken, agreement: "", milestoneIndex: -1, destination: transfer.recipientWallet ?? "",
        amountLamports: transfer.amountLamports ?? "0", createdAt: transfer.createdAt ?? new Date().toISOString(), restored: true,
        final: isTerminalStatus(transfer.status) ? transfer : null,
      }))));
      setRestoreMessage(routings.length
        ? `Found ${routings.length} routing(s) from this wallet in the last 30 days.`
        : "MultiHopper has no QazSplit routings from this wallet in the last 30 days.");
    } catch (failure) {
      setRestoreMessage(describeRoutingError(failure).message);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="preview-section" aria-labelledby="onward-routing-heading">
      <div className="section-title-row">
        <div>
          <h2 id="onward-routing-heading">Optional onward routing</h2>
          <p>After your payout, you can route some SOL from your own wallet through MultiHopper. It is a separate transfer and entirely optional.</p>
        </div>
        <span className="network-badge"><Route size={14} aria-hidden="true" />MultiHopper · devnet SOL</span>
      </div>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 font-semibold" htmlFor="onward-routing-toggle">
        <input id="onward-routing-toggle" type="checkbox" className="mt-1 h-4 w-4" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Route SOL onward with MultiHopper</span>
      </label>
      <p className="field-help">Your milestone payout is final and stays Paid whatever happens here. Routing spends devnet SOL from your connected wallet, not the mock-USDC payout, and nothing moves until you sign in your wallet.</p>
      {enabled ? (
        <RoutingForm client={client} connected={connected} wallet={wallet} agreementAddress={agreementAddress} milestoneIndex={milestoneIndex}
          onCreated={(entry, transfer) => { setStored(saveStoredRouting(wallet, entry)); setCreated((current) => ({ ...current, [entry.transferId]: transfer })); }} />
      ) : null}
      {mine.length ? (
        <div className="mt-6">
          <h3 className="font-semibold">Your onward routings</h3>
          <p className="field-help">Saved on this device. Status comes from MultiHopper; delivery is checked on devnet.</p>
          <ul>{mine.map((entry) => (
            <li key={entry.transferId}>
              <RoutingTransferCard client={client} connected={connected} wallet={wallet} liveAccount={liveAccount} entry={entry} initial={created[entry.transferId] ?? null}
                onRemove={() => setStored(removeStoredRouting(wallet, entry.transferId))} />
            </li>
          ))}</ul>
        </div>
      ) : null}
      <div className="mt-4">
        <button type="button" className="secondary-button" disabled={restoring || !connected.account.features?.includes("solana:signMessage")} aria-busy={restoring} onClick={() => void restore()}>
          {restoring ? <><LoaderCircle className="spin" size={16} aria-hidden="true" />Check wallet…</> : "Restore routings started on another device"}
        </button>
        <p className="field-help">{restoreMessage ?? "Signs a message that moves no funds, then lists your QazSplit routings from MultiHopper."}</p>
      </div>
    </section>
  );
}

function RoutingForm({ client, connected, wallet, agreementAddress, milestoneIndex, onCreated }: {
  client: AppClient; connected: Connected; wallet: string; agreementAddress: string; milestoneIndex: number;
  onCreated: (entry: StoredRouting, transfer: RoutingTransfer) => void;
}) {
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [hops, setHops] = useState<number>(DEFAULT_HOPS);
  const [arrivalSeconds, setArrivalSeconds] = useState<number>(DEFAULT_ARRIVAL_SECONDS);
  const [quote, setQuote] = useState<{ key: string; estimate: RoutingEstimate; balance: bigint | null; stale: boolean } | null>(null);
  const [phase, setPhase] = useState<"edit" | "estimating" | "review" | "approving">("edit");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A signed approval is reused only for an identical retry (e.g. after a network error).
  const approval = useRef<{ key: string; request: RoutingRequest; signature: string; signedAt: number } | null>(null);

  // Previews expire: fees and the wallet balance are re-read rather than trusted indefinitely.
  useEffect(() => {
    if (!quote || quote.stale) return;
    const timer = setTimeout(() => setQuote((current) => (current === quote ? { ...current, stale: true } : current)), PREVIEW_TTL_MS);
    return () => clearTimeout(timer);
  }, [quote]);

  const amountResult = parseSolAmount(amount);
  const destinationResult = validateDestination(destination, wallet);
  const lamports = amountResult.ok ? amountResult.value : null;
  const key = `${amount.trim()}|${destination.trim()}|${hops}|${arrivalSeconds}`;
  const current = quote?.key === key && !quote.stale ? quote : null; // any edit, or age, invalidates the preview
  const capability = walletCapability(connected);
  const required = current?.estimate.requiredSolUpFrontLamports ?? null;
  const minimum = current?.estimate.minTransferAmountLamports ?? null;
  const neededBalance = current ? requiredBalanceLamports({ requiredSolUpFrontLamports: required, transactionCount: TYPICAL_BUNDLE_SIZE, alreadySpentLamports: 0n }) : null;
  const inputReason = !amountResult.ok ? amountResult.message : !destinationResult.ok ? destinationResult.message : null;
  // Fails closed (audit M1): an unknown balance or requirement blocks the request instead of passing it.
  const reviewReason = capability ?? inputReason ?? (!current ? (quote?.key === key && quote.stale ? "This fee preview expired. Preview fees again." : "Preview fees for these exact inputs first.")
    : minimum != null && lamports != null && lamports < BigInt(minimum) ? `MultiHopper's minimum for SOL is ${sol(minimum)}.`
      : neededBalance == null ? "MultiHopper did not quote the SOL needed up front, so QazSplit can't check your balance. Try again later."
        : current.balance == null ? "QazSplit couldn't read your wallet balance. Preview fees again."
          : current.balance < neededBalance ? `Your wallet needs about ${sol(neededBalance)} (up-front amount plus network fees) before signing.` : null);
  const busy = phase === "estimating" || phase === "approving";
  const reviewing = phase === "review" || phase === "approving";

  function changed() { setPhase("edit"); setAcknowledged(false); setError(null); }

  async function preview() {
    if (inputReason || lamports == null || busy) return;
    const previewKey = key;
    setPhase("estimating"); setError(null);
    try {
      const [{ estimate }, balance] = await Promise.all([
        routingApi.estimate({ amountLamports: lamports.toString(), hops, arrivalSeconds }),
        client.rpc.getBalance(address(wallet), { commitment: "confirmed" }).send().then((result) => BigInt(result.value)).catch(() => null),
      ]);
      setQuote({ key: previewKey, estimate, balance, stale: false });
    } catch (failure) {
      setError(describeRoutingError(failure).message);
    } finally {
      setPhase("edit");
    }
  }

  async function approve() {
    if (!current || reviewReason || !acknowledged || lamports == null || !destinationResult.ok || busy) return;
    setPhase("approving"); setError(null);
    try {
      let pending = approval.current?.key === key && Date.now() - approval.current.signedAt < APPROVAL_REUSE_MS ? approval.current : null;
      if (!pending) {
        const request: RoutingRequest = {
          wallet, agreement: agreementAddress, milestoneIndex, amountLamports: lamports.toString(), destination: destinationResult.value,
          hops, arrivalSeconds, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: window.location.origin,
        };
        const signature = await client.wallet.signMessage(new TextEncoder().encode(buildRoutingApprovalMessage(request)));
        pending = { key, request, signature: getBase58Decoder().decode(signature), signedAt: Date.now() };
        approval.current = pending;
      }
      const result = await routingApi.create({ ...pending.request, signature: pending.signature });
      approval.current = null;
      onCreated({
        transferId: result.transfer.id, accessToken: result.accessToken, agreement: agreementAddress, milestoneIndex,
        destination: pending.request.destination, amountLamports: pending.request.amountLamports, createdAt: new Date().toISOString(),
        previewReceivesLamports: current.estimate.hopAmountRaw,
      }, result.transfer);
      setAmount(""); setDestination(""); setQuote(null); setAcknowledged(false); setPhase("edit");
    } catch (failure) {
      // Keep the signed approval only for transient failures; anything else needs a fresh one.
      const transient = failure instanceof RoutingApiError && (failure.status === 0 || failure.status >= 500 || failure.code === "MH_072" || failure.code === "MH_004" || failure.status === 429);
      if (!transient) approval.current = null;
      setError(describeRoutingError(failure).message);
      setPhase("review");
    }
  }

  return (
    <div className="mt-4">
      {capability ? <p className="field-help text-danger">{capability}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="routing-amount">Amount to route (SOL)</label>
          <input id="routing-amount" className="text-input font-mono" inputMode="decimal" autoComplete="off" placeholder="0.25" value={amount}
            disabled={busy || reviewing} aria-invalid={!!amount && !amountResult.ok} aria-describedby="routing-amount-help"
            onChange={(event) => { setAmount(event.target.value); changed(); }} />
          <p id="routing-amount-help" className="field-help">{amount && !amountResult.ok ? amountResult.message : "Spent from your wallet's devnet SOL, MultiHopper fees included."}</p>
        </div>
        <div>
          <label className="field-label" htmlFor="routing-destination">Destination wallet</label>
          <input id="routing-destination" className="text-input font-mono" autoComplete="off" spellCheck={false} placeholder="Solana address" value={destination}
            disabled={busy || reviewing} aria-invalid={!!destination && !destinationResult.ok} aria-describedby="routing-destination-help"
            onChange={(event) => { setDestination(event.target.value); changed(); }} />
          <p id="routing-destination-help" className="field-help">{destination && !destinationResult.ok ? destinationResult.message : "The wallet that finally receives the routed SOL."}</p>
        </div>
        <div>
          <label className="field-label" htmlFor="routing-hops">Hops</label>
          <select id="routing-hops" className="text-input" value={hops} disabled={busy || reviewing} onChange={(event) => { setHops(Number(event.target.value)); changed(); }}>
            {HOP_OPTIONS.map((option) => <option key={option} value={option}>{option} hops</option>)}
          </select>
          <p className="field-help">Each hop adds MultiHopper&apos;s per-hop charge.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="routing-arrival">Arrival target</label>
          <select id="routing-arrival" className="text-input" value={arrivalSeconds} disabled={busy || reviewing} onChange={(event) => { setArrivalSeconds(Number(event.target.value)); changed(); }}>
            {ARRIVAL_PRESETS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
          </select>
          <p className="field-help">Approximate delivery time after deployment.</p>
        </div>
      </div>
      <div className="action-row">
        <button type="button" className="secondary-button" disabled={!!inputReason || busy || reviewing} aria-busy={phase === "estimating"} onClick={() => void preview()}>
          {phase === "estimating" ? <><LoaderCircle className="spin" size={17} aria-hidden="true" />Estimating…</> : "Preview fees"}
        </button>
      </div>
      {quote?.key === key && quote.stale && !busy ? <p className="field-help" role="status">This fee preview is more than 2 minutes old. Preview fees again before continuing.</p> : null}
      {current ? (
        <div className="mt-5" aria-label="Fee preview">
          <h3 className="font-semibold">Fee preview</h3>
          <dl className="mt-2">
            <Detail label="You route" value={sol(lamports)} />
            <Detail label="Destination receives (quoted)" value={sol(current.estimate.hopAmountRaw)} strong />
            <Detail label={`Percent fee${current.estimate.percentFeeBps != null ? ` (${(current.estimate.percentFeeBps / 100).toFixed(2)}%)` : ""}`} value={sol(current.estimate.percentFeeRaw)} />
            <Detail label={`Per-hop charge${current.estimate.tier ? ` · ${current.estimate.tier}` : ""}`} value={sol(current.estimate.totalFlatFeeLamports)} />
            {current.estimate.screeningFeeLamports ? <Detail label="Compliance screening fee (not refunded)" value={sol(current.estimate.screeningFeeLamports)} /> : null}
            <Detail label="SOL needed in wallet before signing (MultiHopper)" value={sol(required)} />
            <Detail label="Refundable after settlement" value={sol(current.estimate.refundableLamports)} />
            <Detail label="Net cost to your wallet" value={sol(current.estimate.netCostLamports)} />
            <Detail label="Your wallet now" value={current.balance == null ? "Unavailable" : sol(current.balance)} />
          </dl>
          <p className="field-help">
            {current.estimate.priceSource === "onchain_pool" ? "Quote from MultiHopper's onchain fee schedule." : "Estimate. MultiHopper re-checks pricing when the transactions are prepared."}
            {current.estimate.cappedAtTierBoundary ? " Capped at a fee-tier boundary: your wallet spends slightly less than the amount." : ""}
            {current.estimate.isTestMode ? " Test-mode API key (devnet)." : ""}
            {" "}QazSplit re-checks the quote and your balance right before you sign, and stops the bundle if it would take more SOL than quoted.
          </p>
          {!reviewing ? (
            <div className="action-row">
              <div className="cta-with-help">
                <button type="button" className="primary-button" disabled={!!reviewReason || busy} aria-describedby="routing-review-reason" onClick={() => setPhase("review")}>Review transfer</button>
                {reviewReason ? <p id="routing-review-reason" className="field-help">{reviewReason}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {reviewing && current && lamports != null && destinationResult.ok ? (
        <div className="mt-5 rounded-lg border border-line p-4" aria-label="Review onward routing">
          <h3 className="font-semibold">Review onward routing</h3>
          <dl className="mt-2">
            <Detail label="From (your wallet)" value={<span title={wallet}>{truncateAddress(wallet, 6)}</span>} />
            <Detail label="To" value={<span title={destinationResult.value}>{destinationResult.value}</span>} />
            <Detail label="Amount" value={sol(lamports)} />
            <Detail label="Destination receives (quoted)" value={sol(current.estimate.hopAmountRaw)} strong />
            <Detail label="Hops · arrival target" value={`${hops} · ${ARRIVAL_PRESETS.find((option) => option.seconds === arrivalSeconds)?.label ?? `${arrivalSeconds} s`}`} />
            <Detail label="Network" value="Solana devnet · MultiHopper devnet API" />
          </dl>
          <ol className="field-help list-decimal space-y-1 pl-5">
            <li>Approve a message in your wallet. It names this site, proves this wallet is yours and requests a MultiHopper quote. It moves no funds.</li>
            <li>Review MultiHopper&apos;s prepared transactions here, then sign them in one wallet approval. QazSplit broadcasts them in MultiHopper&apos;s required order.</li>
            <li>Track activation and delivery here. If routing fails, your QazSplit payout stays Paid.</li>
          </ol>
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm" htmlFor="routing-acknowledge">
            <input id="routing-acknowledge" type="checkbox" className="mt-1 h-4 w-4" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>I understand this is a separate SOL transfer from my wallet and that my QazSplit payout is already final.</span>
          </label>
          <div className="action-row">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setPhase("edit"); setAcknowledged(false); }}>Edit</button>
            <button type="button" className="primary-button" disabled={!acknowledged || busy || !!reviewReason} aria-busy={phase === "approving"} onClick={() => void approve()}>
              {phase === "approving" ? <><LoaderCircle className="spin" size={17} aria-hidden="true" />Check wallet…</> : "Approve request in wallet"}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="error-banner" role="alert"><strong>Routing request failed.</strong><span>{error}</span><span className="text-xs">Your QazSplit payout is unaffected.</span></div> : null}
    </div>
  );
}

function initialRows(steps: readonly BundleStep[]): StepRow[] {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.group, (counts.get(step.group) ?? 0) + 1);
  const rows: StepRow[] = [];
  for (const step of steps) {
    rows.push({ key: `${step.group}-${step.index}`, label: `${stepLabel(step, counts.get(step.group))} · ${step.version === "legacy" ? "legacy" : "v0"} transaction`, state: "pending" });
    if (step.group === "keeperFunding") rows.push({ key: "confirm-keeperFunding", label: "Record keeper funding with MultiHopper", state: "pending" });
  }
  rows.push({ key: "confirm-final", label: "Activate the transfer with MultiHopper", state: "pending" });
  return rows;
}

function applyProgress(rows: StepRow[], event: BroadcastEvent): StepRow[] {
  if (event.type === "wait") return rows;
  const key = event.type === "step" ? `${event.step.group}-${event.step.index}` : `confirm-${event.stage}`;
  const state = event.state === "sending" ? "sending" : "confirmed";
  return rows.map((row) => (row.key === key ? { ...row, state, signature: event.type === "step" ? event.signature ?? row.signature : row.signature } : row));
}

/** What the recipient checks before the wallet prompt: every transaction, its signers and programs, and QazSplit's spending bound. */
function BundleReview({ review, wallet, onDecide }: { review: Review; wallet: string; onDecide: (approved: boolean) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((review.expiresAtMs - now) / 1000));
  const counts = new Map<string, number>();
  for (const step of review.steps) counts.set(step.group, (counts.get(step.group) ?? 0) + 1);
  return (
    <div className="mt-4 rounded-lg border border-line p-4" aria-label="Review prepared transactions">
      <h5 className="font-semibold">Review before signing</h5>
      <p className="field-help">QazSplit decoded every transaction MultiHopper prepared. Each one only uses recognized programs and cannot move tokens or change ownership of your wallet.</p>
      <ol className="mt-2 space-y-3">
        {review.steps.map((step) => (
          <li key={`${step.group}-${step.index}`} className="border-t border-line pt-2 text-sm">
            <strong>{stepLabel(step, counts.get(step.group))}</strong> · {step.version === "legacy" ? "legacy" : "v0"}
            <div className="field-help">
              Signers: {step.review.signers.map((signer) => (signer.address === wallet ? "you" : signer.role === "multihopper-presigned" ? `MultiHopper (pre-signed ${truncateAddress(signer.address, 4)})` : truncateAddress(signer.address, 4))).join(", ")}
            </div>
            <div className="field-help">Programs: {step.review.programs.join(", ")}</div>
            {step.review.systemOutflowLamports ? <div className="field-help">Direct SOL transfer from your wallet: {sol(step.review.systemOutflowLamports)}</div> : null}
          </li>
        ))}
      </ol>
      <dl className="mt-3">
        <Detail label="Your wallet now" value={sol(review.balanceLamports)} />
        <Detail label="Needed for these transactions (quoted)" value={sol(review.requiredLamports)} />
        <Detail label="QazSplit stops the bundle above" value={sol(review.limitLamports)} strong />
        <Detail label="Prepared transactions expire in" value={seconds ? `about ${seconds} s` : "expired"} />
      </dl>
      <p className="field-help">Your wallet may add a small priority fee to transactions only you sign (capped at 0.005 SOL each). Every transaction is simulated on devnet right before it is sent.</p>
      <div className="action-row">
        <button type="button" className="secondary-button" onClick={() => onDecide(false)}>Cancel</button>
        <button type="button" className="primary-button" disabled={!seconds} onClick={() => onDecide(true)}>Sign {review.steps.length} transaction(s) in wallet</button>
      </div>
    </div>
  );
}

function deliveryLabel(delivery: DeliveryResult | null): string | null {
  if (!delivery) return null;
  switch (delivery.state) {
    case "verified": return `Verified on devnet: ${sol(delivery.deliveredLamports)} reached the destination from MultiHopper transactions.`;
    case "partial": return `Devnet shows ${sol(delivery.deliveredLamports)} reaching the destination from MultiHopper transactions, less than quoted so far.`;
    case "not-found": return "No SOL from MultiHopper transactions has reached the destination on devnet yet.";
    default: return `Delivery could not be checked: ${delivery.reason}`;
  }
}

function RoutingTransferCard({ client, connected, wallet, liveAccount, entry, initial, onRemove }: {
  client: AppClient; connected: Connected; wallet: string; liveAccount: LiveAccount; entry: StoredRouting; initial: RoutingTransfer | null; onRemove: () => void;
}) {
  const [transfer, setTransfer] = useState<RoutingTransfer | null>(initial ?? entry.final ?? null);
  const [statusError, setStatusError] = useState<DescribedRoutingError | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [rows, setRows] = useState<StepRow[]>([]);
  const [error, setError] = useState<DescribedRoutingError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [activation, setActivation] = useState<ActivationOutcome["state"] | null>(null);
  const [delivery, setDelivery] = useState<DeliveryResult | null>(null);
  const [quoteAcknowledged, setQuoteAcknowledged] = useState(false);
  const [recoverySignatures, setRecoverySignatures] = useState<string[]>([]);
  // An unresolved keeper-funding record (from this or another tab, or before a reload) blocks Resume.
  const [keeperNotice, setKeeperNotice] = useState<KeeperFundingNotice | null>(() => keeperFundingNotice(entry.transferId));
  const decision = useRef<((approved: boolean) => void) | null>(null);
  const activationRef = useRef(activation);
  const cachedFinal = useRef(entry.final && isTerminalStatus(entry.final.status) ? entry.final : null);
  const deliveryChecked = useRef<string | null>(null);
  const busy = phase !== "idle" && phase !== "review";
  const capability = walletCapability(connected);
  const confirmKeeper = (body: ConfirmBroadcastBody) => routingApi.confirmBroadcast(entry.transferId, entry.accessToken, body);

  // Re-evaluates time-based state (quote expiry) without reading the clock during render.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { activationRef.current = activation; }, [activation]);
  // Leaving the page while the review is open cancels it; nothing has been signed at that point.
  useEffect(() => () => decision.current?.(false), []);

  /** Establishes what happened to any earlier keeper funding. Never prepares or signs anything. */
  async function reconcile() {
    const result = await reconcileKeeperFunding({ transferId: entry.transferId, rpc: client.rpc, confirm: confirmKeeper });
    setKeeperNotice(noticeFromReconciliation(result));
    return result;
  }

  async function checkKeeperFunding() {
    if (busy) return;
    setError(null); setPhase("reconciling");
    try {
      await withRoutingLock(entry.transferId, async () => { await assertDevnet(client); await reconcile(); });
    } catch (failure) {
      setError(describeRoutingError(failure));
    } finally {
      setPhase("idle");
      setRefresh((count) => count + 1);
    }
  }

  useEffect(() => {
    // A finished routing is shown from this device's cache until the recipient refreshes (audit M4).
    if (refresh === 0 && cachedFinal.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void tick(), POLL_MS); return; }
      try {
        const { transfer: next } = await routingApi.status(entry.transferId, entry.accessToken);
        if (!active) return;
        setTransfer(next); setStatusError(null);
        saveFinalStatus(wallet, next);
        // Poll while MultiHopper works, and while a broadcast bundle waits for activation.
        const waiting = !isTerminalStatus(next.status) && (!isAwaitingSignature(next.status) || activationRef.current === "pending");
        if (waiting) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (failure) {
        if (!active) return;
        const described = describeRoutingError(failure);
        setStatusError(described);
        const retryAfterMs = failure instanceof RoutingApiError && failure.retryAfterSeconds ? failure.retryAfterSeconds * 1_000 : POLL_MS * 2;
        if (described.code !== "UNAUTHORIZED" && described.code !== "TRANSFER_NOT_FOUND") timer = setTimeout(() => void tick(), retryAfterMs);
      }
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [entry.transferId, entry.accessToken, refresh, wallet]);

  const checkDelivery = useCallback(async () => {
    if (!transfer) return;
    const result = await verifyDelivery({
      rpc: client.rpc as unknown as DeliveryRpc, destination: entry.destination || transfer.recipientWallet || "", expectedLamports: transfer.recipientReceivesLamports,
      createdAt: transfer.createdAt, reportedSignatures: transfer.hopSignatures,
    });
    setDelivery(result);
  }, [client, entry.destination, transfer]);

  // Independent check: MultiHopper's "completed" is confirmed against the destination's devnet history.
  useEffect(() => {
    if (transfer?.status !== "completed" || deliveryChecked.current === `${transfer.id}:${refresh}`) return;
    deliveryChecked.current = `${transfer.id}:${refresh}`;
    void checkDelivery();
  }, [transfer?.status, transfer?.id, refresh, checkDelivery]);

  /** Re-checks the quote and balance right before signing; fails closed when either is unknown (audits M1/M3). */
  async function spendingLimits(count: number) {
    if (!transfer?.hops || !transfer.arrivalSeconds) {
      throw new RoutingBundleError("VALIDATION_UNAVAILABLE", "QazSplit couldn't read this transfer's hops and arrival time to re-check its quote. Refresh status and try again.");
    }
    let estimate: RoutingEstimate;
    let balanceLamports: bigint;
    try {
      [{ estimate }, balanceLamports] = await Promise.all([
        routingApi.estimate({ amountLamports: entry.amountLamports, hops: transfer.hops, arrivalSeconds: transfer.arrivalSeconds }),
        client.rpc.getBalance(address(wallet), { commitment: "confirmed" }).send().then((result) => BigInt(result.value)),
      ]);
    } catch (failure) {
      if (failure instanceof RoutingApiError && failure.status === 429) throw failure;
      throw new RoutingBundleError("VALIDATION_UNAVAILABLE", "QazSplit couldn't re-check the quote and your balance before signing, so nothing was signed. Try again shortly.");
    }
    if (estimate.requiredSolUpFrontLamports == null) {
      throw new RoutingBundleError("VALIDATION_UNAVAILABLE", "MultiHopper did not quote the SOL needed up front, so QazSplit can't bound what this bundle may spend. Nothing was signed.");
    }
    const alreadySpentLamports = readSpentLamports(entry.transferId);
    const requiredLamports = requiredBalanceLamports({ requiredSolUpFrontLamports: estimate.requiredSolUpFrontLamports, transactionCount: count, alreadySpentLamports }) ?? 0n;
    if (balanceLamports < requiredLamports) {
      throw new RoutingBundleError("INSUFFICIENT_SOL", `Your wallet holds ${sol(balanceLamports)} but needs about ${sol(requiredLamports)} for these transactions. Nothing was signed. Add devnet SOL, then resume.`);
    }
    const limitLamports = outflowLimitLamports({
      requiredSolUpFrontLamports: estimate.requiredSolUpFrontLamports, amountLamports: BigInt(entry.amountLamports), transactionCount: count, alreadySpentLamports,
      priorityFeeCapLamports: PRIORITY_FEE_CAP_LAMPORTS,
    });
    return { limitLamports, balanceLamports, requiredLamports };
  }

  async function expiryTime(lastValidBlockHeight: number | null): Promise<number> {
    const fallback = Date.now() + 60_000;
    if (lastValidBlockHeight == null) return fallback;
    try {
      const height = await client.rpc.getBlockHeight({ commitment: "confirmed" }).send();
      return Date.now() + Math.max(0, Number(BigInt(lastValidBlockHeight) - height)) * 400; // ~400 ms per block
    } catch { return fallback; }
  }

  function walletSigner() {
    const signer = connected.signer;
    if (capability || !signer || !isTransactionModifyingSigner(signer)) {
      setError({ message: capability ?? "This wallet cannot sign prepared transactions.", code: "WALLET_UNSUPPORTED", resumable: false, requiresNewQuote: false });
      return null;
    }
    return signer;
  }

  async function signAndBroadcast() {
    if (busy || phase === "review") return;
    const signer = walletSigner();
    if (!signer) return;
    setError(null); setNotice(null); setRows([]); setActivation(null); setPhase("reconciling");
    try {
      await withRoutingLock(entry.transferId, async () => {
        await assertDevnet(client);
        // Reconcile any earlier keeper funding first: /prepare would emit another one while it may still land.
        const keeper = await reconcile();
        if (keeper.outcome === "pending" || keeper.outcome === "unknown") return; // shown as a pending check; nothing prepared
        if (transfer?.expiresAt && isAwaitingSignature(transfer.status) && Date.parse(transfer.expiresAt) <= Date.now()) {
          throw new RoutingApiError(410, "MH_034", "This quote expired.");
        }
        setPhase("preparing");
        const prepared = await routingApi.prepare(entry.transferId, entry.accessToken);
        if (prepared.transfer) setTransfer(prepared.transfer);
        const preparedTxs: PreparedTxs = prepared.preparedTxs;
        assertNoDuplicateKeeperFunding(preparedTxs, keeper);
        const planned = planBundle(preparedTxs, wallet, connected.supportedTransactionVersions);
        assertKeeperFundingTrackable(preparedTxs, planned);
        let signed: BundleStep[] = [];
        let guard: PreSendCheck | null = null;
        if (planned.length) {
          const limits = await spendingLimits(planned.length);
          const expiresAtMs = await expiryTime(preparedTxs.lastValidBlockHeight);
          setRows(initialRows(planned));
          setReview({ steps: planned, ...limits, expiresAtMs });
          setPhase("review");
          // The cross-tab lock stays held while the recipient reviews, so no other tab can prepare meanwhile.
          let expired = false;
          const approved = await new Promise<boolean>((resolve) => {
            decision.current = resolve;
            setTimeout(() => { expired = true; resolve(false); }, Math.max(0, expiresAtMs - Date.now()));
          });
          decision.current = null;
          setReview(null);
          if (!approved) {
            setRows([]);
            setNotice(expired ? "The prepared transactions expired before you approved them. Nothing was signed; prepare again." : "Cancelled. Nothing was signed.");
            return;
          }
          assertSameAccount(wallet, liveAccount);
          await assertBundleNotExpired(client.rpc, preparedTxs.lastValidBlockHeight);
          setPhase("signing");
          // One wallet approval for the whole bundle; declining leaves nothing half-broadcast.
          signed = await signBundle(planned, signer, wallet, { currentAccount: liveAccount });
          await assertBundleNotExpired(client.rpc, preparedTxs.lastValidBlockHeight);
          assertSameAccount(wallet, liveAccount);
          const outflow = createOutflowGuard({ rpc: client.rpc, wallet, limitLamports: limits.limitLamports });
          guard = {
            check: (transaction) => outflow.check(transaction),
            record: (lamports) => { outflow.record(lamports); addSpentLamports(entry.transferId, lamports); },
          };
        } else {
          setRows(initialRows([])); // everything is on chain already: only the activation call remains
        }
        setPhase("broadcasting");
        const sendOne = (transaction: Transaction) => sendAndConfirmTransaction(client.rpc, transaction, { lastValidBlockHeight: preparedTxs.lastValidBlockHeight });
        const result = await executeBundle({
          steps: signed,
          sendAndConfirm: guarded(guard, (step) => sendOne(step.transaction)),
          // A resume only sends what is missing; the final call reports everything that landed, as documented.
          confirmBroadcast: (body) => confirmKeeper(mergeBroadcastSignatures(readBroadcastSignatures(entry.transferId), body)),
          keeperFunding: {
            send: guarded(guard, (step) => sendTrackedKeeperFunding({ transferId: entry.transferId, transaction: step.transaction, prepared: preparedTxs, send: sendOne })),
            confirm: (body) => recordKeeperFunding({ transferId: entry.transferId, signature: body.keeperFundingSignature as string, confirm: confirmKeeper }),
          },
          onProgress: (event) => {
            if (event.type === "step" && event.state === "confirmed" && event.signature) {
              const landed = signatureEntry(event.step.group, event.signature);
              if (landed) saveBroadcastSignatures(entry.transferId, landed);
            }
            setRows((current) => applyProgress(current, event));
          },
        });
        if (result.transfer.transfer) setTransfer(result.transfer.transfer);
        // A successful HTTP response is not activation: the returned status must leave "awaiting" (audit H1).
        setPhase("activating");
        const outcome = await ensureActivated(result.transfer.transfer, {
          status: async () => (await routingApi.status(entry.transferId, entry.accessToken)).transfer,
          prepare: () => routingApi.prepare(entry.transferId, entry.accessToken),
          confirm: async (body) => (await confirmKeeper(body)).transfer,
          signatures: readBroadcastSignatures(entry.transferId) ?? result.signatures,
        });
        if (outcome.transfer) setTransfer(outcome.transfer);
        setActivation(outcome.state);
        if (outcome.state === "needs-resume") {
          setError({ message: "Some routing transactions are still missing on devnet. Resume to sign only those.", code: "ACTIVATION_INCOMPLETE", resumable: true, requiresNewQuote: false });
        }
      });
    } catch (failure) {
      setReview(null);
      setRows((current) => current.map((row) => (row.state === "sending" ? { ...row, state: "failed" } : row)));
      setError(describeRoutingError(failure));
    } finally {
      // The saved keeper-funding record, not the error, decides whether Resume may be offered again.
      setKeeperNotice((current) => current ?? keeperFundingNotice(entry.transferId));
      setPhase("idle");
      setRefresh((count) => count + 1); // re-read status: MultiHopper and the chain are the source of truth
    }
  }

  /** Rescue (stuck transfer) or rent reclaim (completed): MultiHopper-built transactions that return SOL to this wallet. */
  async function recover(kind: "rescue" | "reclaim-rent") {
    if (busy || phase === "review") return;
    const signer = walletSigner();
    if (!signer) return;
    setError(null); setNotice(null); setRecoverySignatures([]); setPhase("recovering");
    const landed: string[] = [];
    try {
      await withRoutingLock(entry.transferId, async () => {
        await assertDevnet(client);
        const { recoveryTxs } = await routingApi.prepareRecovery(entry.transferId, entry.accessToken, kind);
        const planned = planGroup(kind === "rescue" ? "rescue" : "reclaimRent", recoveryTxs.transactions, wallet, connected.supportedTransactionVersions);
        if (!planned.length) throw new RoutingBundleError("RECOVERY_EMPTY", "MultiHopper returned no recovery transactions.");
        setRows(planned.map((step) => ({ key: `${step.group}-${step.index}`, label: `${stepLabel(step, planned.length)} · ${step.version === "legacy" ? "legacy" : "v0"} transaction`, state: "pending" })));
        const signed = await signBundle(planned, signer, wallet, { currentAccount: liveAccount });
        await assertBundleNotExpired(client.rpc, recoveryTxs.lastValidBlockHeight);
        // These return SOL to this wallet, so only network fees and a capped priority fee may leave it.
        const outflow = createOutflowGuard({ rpc: client.rpc, wallet, limitLamports: BigInt(planned.length) * (20_000n + PRIORITY_FEE_CAP_LAMPORTS) });
        try {
          for (const step of signed) {
            const key = `${step.group}-${step.index}`;
            const lamports = await outflow.check(step.transaction);
            setRows((current) => current.map((row) => (row.key === key ? { ...row, state: "sending" } : row)));
            const signature = await sendAndConfirmTransaction(client.rpc, step.transaction, { lastValidBlockHeight: recoveryTxs.lastValidBlockHeight });
            outflow.record(lamports);
            landed.push(signature);
            setRows((current) => current.map((row) => (row.key === key ? { ...row, state: "confirmed", signature } : row)));
          }
        } finally {
          // Report whatever landed, even if a later recovery transaction failed.
          if (landed.length) {
            const confirmed = await routingApi.confirmRecovery(entry.transferId, entry.accessToken, kind, landed);
            setTransfer(confirmed.transfer);
            setRecoverySignatures([...landed]);
          }
        }
      });
    } catch (failure) {
      setRows((current) => current.map((row) => (row.state === "sending" ? { ...row, state: "failed" } : row)));
      setError(describeRoutingError(failure));
    } finally {
      setPhase("idle");
      setRefresh((count) => count + 1);
    }
  }

  const status = transfer?.status ?? null;
  const awaiting = !!status && isAwaitingSignature(status);
  // MultiHopper locked a different destination amount than the preview showed: the recipient must see it (audit M2).
  const quoteChanged = !!entry.previewReceivesLamports && !!transfer?.recipientReceivesLamports && entry.previewReceivesLamports !== transfer.recipientReceivesLamports;
  const quoteExpired = awaiting && !!transfer?.expiresAt && Date.parse(transfer.expiresAt) <= clock;
  // While keeper funding may still land or is unacknowledged, the only offered action is checking it.
  const keeperBlocking = !!keeperNotice && (!status || awaiting);
  const broadcastBefore = !!readBroadcastSignatures(entry.transferId);
  const canSign = awaiting && !error?.requiresNewQuote && !keeperBlocking && !quoteExpired && (!quoteChanged || quoteAcknowledged);
  const removable = !busy && phase !== "review" && ((!!status && isTerminalStatus(status)) || statusError?.code === "UNAUTHORIZED" || !!error?.requiresNewQuote || quoteExpired);
  const signLabel = phase === "reconciling" ? "Checking keeper funding…" : phase === "preparing" ? "Preparing…" : phase === "signing" ? "Check wallet…"
    : phase === "broadcasting" ? "Broadcasting…" : phase === "activating" ? "Confirming activation…" : phase === "review" ? "Waiting for your review"
      : broadcastBefore && !error ? "Check and activate" : error || rows.length ? "Resume" : "Prepare transactions";
  const keeperTitle = keeperNotice?.kind === "pending" ? "Waiting for keeper funding to settle"
    : keeperNotice?.kind === "unknown" ? "Keeper funding status unknown" : "Keeper funding needs a check";
  // "Completed" is only ever shown as MultiHopper's claim until devnet confirms delivery.
  const badge = !status ? "Loading status…"
    : status === "completed" ? (delivery?.state === "verified" ? "Delivered · verified on devnet" : "Completed per MultiHopper · checking delivery")
      : awaiting && activation === "pending" ? "Broadcast confirmed · waiting for MultiHopper to activate"
        : STATUS_LABELS[status] ?? status;
  return (
    <article className="border-t border-line py-5" aria-label={`Onward routing ${entry.transferId}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">Transfer #{entry.transferId}</h4>
        <span className={delivery?.state === "verified" && status === "completed" ? "verified-chip" : "network-badge"} role="status">{badge}</span>
      </div>
      <p className="field-help">
        {sol(entry.amountLamports)} to {entry.destination
          ? <a className="font-mono underline" href={explorerAddressUrl(entry.destination)} target="_blank" rel="noreferrer" title={entry.destination}>{truncateAddress(entry.destination, 6)}</a>
          : "—"}
        {entry.restored ? " · restored from MultiHopper" : ` · after milestone ${entry.milestoneIndex + 1}`}
      </p>
      {transfer ? (
        <dl className="mt-2">
          {transfer.recipientReceivesLamports ? <Detail label="Destination receives (locked quote)" value={sol(transfer.recipientReceivesLamports)} strong /> : null}
          {transfer.progress ? <Detail label="Hops completed" value={`${transfer.progress.hopsCompleted} of ${transfer.progress.hopsTotal}`} /> : null}
          {transfer.phase ? <Detail label="Phase" value={transfer.phase} /> : null}
          {transfer.supportBundleId ? <Detail label="MultiHopper support reference" value={transfer.supportBundleId} /> : null}
          {transfer.expiresAt && awaiting ? <Detail label="Quote expires" value={<time dateTime={transfer.expiresAt}>{transfer.expiresAt}</time>} /> : null}
          {transfer.completedAt ? <Detail label="Completed (MultiHopper)" value={<time dateTime={transfer.completedAt}>{transfer.completedAt}</time>} /> : null}
          {transfer.lastError?.message ? <Detail label="Last MultiHopper error" value={`${transfer.lastError.code ? `${transfer.lastError.code}: ` : ""}${transfer.lastError.message}`} /> : null}
        </dl>
      ) : null}
      {quoteChanged && awaiting ? (
        <div className="mt-3 rounded-lg border border-line p-3" role="status">
          <strong className="block">MultiHopper locked a different amount</strong>
          <p className="field-help">The preview quoted {sol(entry.previewReceivesLamports)} for the destination; the transfer will deliver {sol(transfer?.recipientReceivesLamports)}.</p>
          <label className="mt-2 flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={quoteAcknowledged} onChange={(event) => setQuoteAcknowledged(event.target.checked)} />
            <span>Continue with the locked amount</span>
          </label>
        </div>
      ) : null}
      {quoteExpired ? <p className="field-help" role="status">This quote expired before it was funded. Remove it and create a new routing.</p> : null}
      {review ? <BundleReview review={review} wallet={wallet} onDecide={(approved) => decision.current?.(approved)} /> : null}
      {rows.length ? (
        <ol className="mt-3 space-y-2" aria-label="Broadcast progress">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
              {row.state === "confirmed" ? <Check size={16} className="text-success" aria-hidden="true" />
                : row.state === "sending" ? <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  : row.state === "failed" ? <CircleX size={16} className="text-danger" aria-hidden="true" /> : <Circle size={16} className="text-muted" aria-hidden="true" />}
              <span>{row.label}</span>
              <span className="sr-only">{row.state}</span>
              {row.signature ? <ExplorerLink signature={row.signature} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {activation === "pending" ? (
        <p className="field-help" role="status">Every transaction is confirmed on devnet, but MultiHopper has not activated the transfer yet. QazSplit keeps checking; nothing more needs signing.</p>
      ) : null}
      {status === "completed" ? (
        <div className="mt-3" aria-label="Delivery verification">
          <p className="field-help" role="status">{deliveryLabel(delivery) ?? "Checking the destination's devnet history…"}</p>
          {delivery && (delivery.state === "verified" || delivery.state === "partial") ? (
            <ul className="space-y-1">{delivery.credits.map((credit) => (
              <li key={credit.signature} className="text-sm">+{sol(credit.lamports)} · <ExplorerLink signature={credit.signature} /></li>
            ))}</ul>
          ) : null}
          <button type="button" className="secondary-button mt-2" disabled={busy} onClick={() => void checkDelivery()}>Re-check delivery on devnet</button>
        </div>
      ) : null}
      {transfer?.hopSignatures.length ? (
        <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3">Hop transactions (reported by MultiHopper)</summary>
          <ul className="space-y-1">{transfer.hopSignatures.map((signature) => (
            <li key={signature}><a className="font-mono text-xs break-all underline" href={explorerTransactionUrl(signature)} target="_blank" rel="noreferrer">{signature}</a></li>
          ))}</ul>
        </details>
      ) : null}
      {recoverySignatures.length ? (
        <p className="field-help" role="status">Recovery transactions confirmed on devnet: {recoverySignatures.map((signature) => <ExplorerLink key={signature} signature={signature}>{truncateAddress(signature, 4)}</ExplorerLink>)}</p>
      ) : null}
      {statusError ? <p className="field-help" role="status">{statusError.message}</p> : null}
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {keeperBlocking && keeperNotice ? (
        <div className="mt-3 rounded-lg border border-line p-3" role="status" aria-label="Keeper funding check">
          <strong className="block">{keeperTitle}</strong>
          <p className="field-help">{keeperNotice.message}</p>
          {keeperNotice.signature ? <ExplorerLink signature={keeperNotice.signature}>Keeper-funding transaction</ExplorerLink> : null}
          <p className="field-help">QazSplit won&apos;t request another keeper funding for this routing until this is resolved.</p>
          <button type="button" className="secondary-button mt-2" disabled={busy} aria-busy={phase === "reconciling"} onClick={() => void checkKeeperFunding()}>
            {phase === "reconciling" ? <><LoaderCircle className="spin" size={16} aria-hidden="true" />Checking…</> : "Check keeper funding status"}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="error-banner" role="alert">
          <strong>Routing did not finish.</strong>
          <span>{error.message}</span>
          <span className="text-xs">Your QazSplit payout is unaffected.{error.code ? ` Code: ${error.code}.` : ""}{error.requiresNewQuote ? " Create a new routing above." : ""}</span>
        </div>
      ) : null}
      <div className="action-row">
        {canSign ? (
          <div className="cta-with-help">
            <button type="button" className="primary-button" disabled={busy || phase === "review" || !!capability} aria-busy={busy} onClick={() => void signAndBroadcast()}>
              {busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : null}{signLabel}
            </button>
            <p className="field-help">{capability ?? "QazSplit prepares MultiHopper's transactions and shows them to you before your wallet asks for one approval."}</p>
          </div>
        ) : null}
        {transfer?.recovery?.canRescue ? (
          <button type="button" className="secondary-button" disabled={busy || phase === "review" || !!capability} onClick={() => void recover("rescue")}>
            {phase === "recovering" ? <><LoaderCircle className="spin" size={16} aria-hidden="true" />Recovering…</> : `Rescue ${transfer.recovery.rescuableLamports ? sol(transfer.recovery.rescuableLamports) : "locked SOL"}`}
          </button>
        ) : null}
        {transfer?.recovery?.canReclaimRent ? (
          <button type="button" className="secondary-button" disabled={busy || phase === "review" || !!capability} onClick={() => void recover("reclaim-rent")}>
            {`Reclaim ${transfer.recovery.reclaimableLamports ? sol(transfer.recovery.reclaimableLamports) : ""} rent`}
          </button>
        ) : null}
        <button type="button" className="secondary-button" disabled={busy || phase === "review"} onClick={() => setRefresh((count) => count + 1)}><RefreshCw size={16} aria-hidden="true" />Refresh routing status</button>
        {removable ? <button type="button" className="secondary-button" onClick={() => { clearKeeperFunding(entry.transferId); clearLifecycleJournals(entry.transferId); onRemove(); }}>Remove from this device</button> : null}
      </div>
    </article>
  );
}
