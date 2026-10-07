"use client";

import { ClientProvider } from "@solana/react";

import { solanaClient } from "@/lib/solana-client";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClientProvider client={solanaClient}>{children}</ClientProvider>;
}

