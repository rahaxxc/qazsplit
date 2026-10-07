import { rpcTransactionPlanner, rpcTransactionPlanSendingExecutor } from "@solana/kit-plugin-rpc";

import type { AppClient } from "./solana-client";

export type WalletTransactionVersion = 0 | 1;

export function getWalletTransactionVersion(
  supportedVersions: ReadonlySet<"legacy" | 0 | 1>,
): WalletTransactionVersion | null {
  if (supportedVersions.has(1)) return 1;
  if (supportedVersions.has(0)) return 0;
  return null;
}

export function getTransactionClient(client: AppClient, version: WalletTransactionVersion): AppClient {
  if (version === 1) return client;
  // Reuse the wallet and devnet RPC. Rebind the single-transaction sender to
  // the v0 planner; never split a payment into multiple transactions.
  return client
    .use(rpcTransactionPlanner({ version: 0 }))
    .use(rpcTransactionPlanSendingExecutor());
}
