"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useClient } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { getApprovalProgress } from "@/lib/agreement-client";
import { explorerTransactionUrl, truncateAddress } from "@/lib/format";
import { fetchWalletHistory, relatedSplits, type WalletHistory as HistoryData } from "@/lib/history-client";
import type { AppClient } from "@/lib/solana-client";
import { formatTokenAmount } from "@/lib/split-math";

const subscribe = () => () => {};
export function WalletHistory() {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const wallet = mounted ? connected?.account.address : null;
  return wallet ? <ConnectedHistory key={wallet} wallet={wallet} client={client} /> :
    <div className="py-8"><p>Connect your wallet to see your agreements and payments.</p><p className="field-help">Use the wallet button above. Reading history does not request a signature.</p></div>;
}

function ConnectedHistory({ wallet, client }: { wallet: string; client: AppClient }) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    let active = true;
    const id = ++request.current;
    void fetchWalletHistory(client, wallet).then((result) => { if (active && request.current === id) setData(result); })
      .catch(() => { if (active && request.current === id) setError("Could not load devnet history. Check your connection and retry."); })
      .finally(() => { if (active && request.current === id) setLoading(false); });
    return () => { active = false; };
  }, [client, wallet]);

  async function load(older = false) {
    const id = ++request.current; setLoading(true); setError(null);
    try {
      const result = await fetchWalletHistory(client, wallet, older ? data?.nextBefore ?? undefined : undefined, older ? data?.splits : undefined);
      if (request.current !== id) return;
      setData(older && data ? { ...result, unavailable: data.unavailable + result.unavailable,
        payments: [...new Map([...data.payments, ...result.payments].map((p) => [p.id, p])).values()] } : result);
    } catch { if (request.current === id) setError("Could not load devnet history. Check your connection and retry."); }
    finally { if (request.current === id) setLoading(false); }
  }
  const splits = data ? relatedSplits(data.splits, wallet, data.payments) : [];
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <p className="field-help">Wallet <span className="font-mono" title={wallet}>{truncateAddress(wallet, 6)}</span> · Onchain devnet records</p>
      <button type="button" className="secondary-button" disabled={loading} aria-busy={loading} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />Refresh history</button>
    </div>
    {error ? <div className="error-banner" role="alert"><strong>{error}</strong><button type="button" className="secondary-button w-fit" disabled={loading} onClick={() => void load()}>Retry</button></div> : null}
    {loading ? <div role="status" aria-live="polite" className="space-y-3 py-4"><p className="field-help">Loading devnet history…</p>{!data ? [0,1,2].map((n) => <div key={n} className="skeleton h-16" aria-hidden="true" />) : null}</div> : null}
    {data ? <>
      <section aria-labelledby="my-agreements-heading" className="preview-section">
        <h2 id="my-agreements-heading" className="font-semibold mb-4">My agreements</h2>
        {splits.length ? <ul>{splits.map(({ config, agreement }) => {
          const progress = agreement ? getApprovalProgress(agreement) : null;
          return <li key={config.address} className="border-t border-line py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link href={`/pay/${config.address}`} className="secondary-button" title={config.address}>Open split {truncateAddress(config.address, 6)}</Link>
              <span className="verified-chip">{progress ? progress.active ? "Active / Locked" : "Pending approvals" : "Legacy / Locked"}</span>
            </div>
            <p className="field-help">{config.creator === wallet ? "Created by you" : config.recipients.includes(wallet as typeof config.creator) ? "You are a recipient" : "You paid this split"}
              {progress ? <> · <span className="font-mono tabular-nums">{progress.approved} of {progress.total}</span> members approved</> : " · Original split, no approval requirement"}</p>
            {agreement ? <ul className="mt-3 space-y-2">{agreement.milestones.map((m, i) => <li key={i} className="flex flex-wrap justify-between gap-2 text-sm"><span>{m.name} · {m.paid ? "Paid" : "Unpaid"}</span><span className="font-mono tabular-nums break-all">{formatTokenAmount(m.amount)} mock USDC</span></li>)}</ul> : null}
          </li>;
        })}</ul> : <div className="py-5"><p>No agreements yet</p><p className="field-help">Create a split, join as a recipient, or load older activity to find splits you paid.</p><Link href="/" className="primary-button mt-4">Create a split</Link></div>}
      </section>
      <section aria-labelledby="payment-history-heading" className="pt-6">
        <h2 id="payment-history-heading" className="font-semibold mb-2">Payment history</h2>
        <p className="field-help mb-4">Confirmed payments only. Older activity loads in small pages; RPC retention may limit historical details.</p>
        {data.unavailable ? <p role="status" className="field-help mb-4">Some transaction details are unavailable from this RPC. This is not a complete archive; refresh to retry.</p> : null}
        {data.payments.length ? <ul>{data.payments.map((p) => <li key={p.id} className="border-t border-line py-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{p.name}</h3><strong className="font-mono tabular-nums break-all">{formatTokenAmount(p.amount)} mock USDC</strong></div>
          <p className="field-help">Paid{p.timestamp != null ? ` · ${new Date(Number(p.timestamp) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}` : " · Time unavailable"}</p>
          <details className="mt-3"><summary className="min-h-11 py-3 cursor-pointer focus-ring rounded-lg">Payment receipt</summary>
            <p className="field-help break-all">Payer: {p.payer}</p>
            <ul className="my-3 space-y-3">{p.recipients.map((r, i) => <li key={r} className="text-sm"><p className="font-mono text-xs break-all select-all">{r}</p><strong className="font-mono tabular-nums">{formatTokenAmount(p.allocations[i])} mock USDC</strong></li>)}</ul>
            <p className="font-mono text-xs break-all select-all">{p.signature}</p><p className="field-help">QazSplit never held the funds</p>
          </details>
          <div className="flex flex-wrap gap-3 mt-3"><Link className="secondary-button" href={`/pay/${p.split}`}>Open agreement</Link><a className="secondary-button" href={explorerTransactionUrl(p.signature)} target="_blank" rel="noreferrer">Explorer <ExternalLink size={16} aria-hidden="true" /></a></div>
        </li>)}</ul> : <p className="field-help py-5">No payments in the loaded activity.</p>}
        {data.nextBefore ? <button type="button" className="secondary-button mt-5" disabled={loading} onClick={() => void load(true)}>Load older activity</button> : <p className="field-help mt-5">End of activity available from this RPC.</p>}
      </section>
    </> : null}
  </div>;
}
