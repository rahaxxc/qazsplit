"use client";

import { useClient } from "@solana/react";
import { useEffect, useState } from "react";
import { fetchSplitKind } from "@/lib/agreement-client";
import type { AppClient } from "@/lib/solana-client";
import { AgreementForm } from "./agreement-form";
import { PaySplitForm } from "./pay-split-form";

// One existing payment URL supports both legacy immutable configs and agreements.
export function SplitPayment({ splitAddress }: { splitAddress: string }) {
  const client = useClient<AppClient>();
  const [kind, setKind] = useState<"agreement" | "legacy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchSplitKind(client, splitAddress).then((kind) => { if (active) setKind(kind); })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : "Could not load this split."); });
    return () => { active = false; };
  }, [client, splitAddress, retry]);
  if (error) return <div className="form-panel error-empty-state" role="alert"><h1>Payment link unavailable</h1><p>{error}</p><button className="secondary-button" onClick={() => { setError(null); setRetry((r) => r + 1); }}>Retry</button></div>;
  if (!kind) return <div className="form-panel" aria-busy="true" aria-label="Loading split"><div className="skeleton h-16 w-full" /></div>;
  return kind === "agreement" ? <AgreementForm splitAddress={splitAddress} /> : <PaySplitForm splitAddress={splitAddress} />;
}
