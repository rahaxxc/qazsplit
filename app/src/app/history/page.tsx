import { AppShell } from "@/components/app-shell";
import { WalletHistory } from "@/components/wallet-history";

export default function HistoryPage() {
  return <AppShell><section className="form-panel" aria-labelledby="history-heading">
    <div className="panel-heading"><div><p className="eyebrow">Your devnet activity</p><h1 id="history-heading">Agreements & payment history</h1><p>Find your splits, check approvals, and reopen payment receipts. No account or login required.</p></div><span className="token-chip">Mock USDC only</span></div>
    <WalletHistory />
  </section></AppShell>;
}
