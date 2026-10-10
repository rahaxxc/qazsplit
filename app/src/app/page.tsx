import { ArrowDown } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { CreateSplitForm } from "@/components/create-split-form";

export default function Home() {
  return (
    <AppShell>
      <section className="intro-grid">
        <div className="intro-copy">
          <p className="eyebrow">Non-custodial team payments</p>
          <h2>Set the split once. Let the client pay everyone.</h2>
          <p>
            QazSplit records an immutable allocation on Solana devnet. The client approves one
            transaction; every recipient transfer succeeds together or the whole payment rolls
            back.
          </p>
        </div>
        <div className="flow-note" aria-label="Payment flow summary">
          <span>Client wallet</span>
          <ArrowDown size={18} aria-hidden="true" />
          <strong>One atomic transaction</strong>
          <ArrowDown size={18} aria-hidden="true" />
          <span>2–5 recipient wallets</span>
        </div>
      </section>
      <CreateSplitForm withMilestones />
    </AppShell>
  );
}
