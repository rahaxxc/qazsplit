import Link from "next/link";

import { WalletButton } from "./wallet-button";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="site-header">
        <div className="page-container flex min-h-20 items-center justify-between gap-4">
          <Link
            href="/"
            className="brand-mark focus-ring"
            aria-label="QazSplit home"
          >
            <span className="brand-symbol" aria-hidden="true">
              Q
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight">QazSplit</span>
              <span className="block text-xs text-muted">Atomic team payments</span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="network-badge">Devnet only</span>
            <WalletButton />
          </div>
        </div>
      </header>
      <nav className="page-container flex flex-wrap gap-3 pt-4" aria-label="Main navigation">
        <Link href="/" className="secondary-button">Create Split</Link>
        <Link href="/history" className="secondary-button">History</Link>
      </nav>
      <main className="page-container py-10 sm:py-14">{children}</main>
      <footer className="page-container border-t border-line py-6 text-xs text-muted">
        Test tokens only. QazSplit never holds payer funds.
      </footer>
    </div>
  );
}

