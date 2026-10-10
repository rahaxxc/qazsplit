import { address, getBase58Encoder, getBase64Encoder, signature, type Address } from "@solana/kit";
import { decodeAgreement, getApprovalProgress, type SplitAgreement } from "./agreement-client";
import { MOCK_USDC_MINT, PROGRAM_ADDRESS } from "./constants";
import { assertDevnet, decodeSplitConfig, type SplitConfig } from "./qazsplit-client";
import type { AppClient } from "./solana-client";
import { calculateAllocations } from "./split-math";

export type HistorySplit = { kind: "agreement" | "legacy"; config: SplitConfig; agreement?: SplitAgreement };
export type HistoryPayment = {
  id: string; signature: string; split: Address; name: string; amount: bigint;
  payer: Address; recipients: Address[]; allocations: bigint[]; timestamp: bigint | null;
};
export type WalletHistory = { splits: HistorySplit[]; payments: HistoryPayment[]; nextBefore: string | null; unavailable: number };
const PAGE_SIZE = 5;
const PAY = [144,47,174,151,82,121,153,126];
const EXECUTE = [6,45,171,40,49,129,23,89];
const startsWith = (data: Uint8Array, expected: number[]) => expected.every((b, i) => data[i] === b);

export function relatedSplits(splits: HistorySplit[], wallet: string, payments: HistoryPayment[]): HistorySplit[] {
  return splits.filter(({ config, agreement }) => config.creator === wallet || config.recipients.includes(address(wallet)) ||
    agreement?.milestones.some((m) => m.paid && m.payer === wallet) || payments.some((p) => p.split === config.address && p.payer === wallet));
}

// The MVP has no indexer: enumerate only this program's two known account layouts,
// then page confirmed program activity. Never substitute browser-local receipts for proof.
export async function fetchWalletHistory(client: AppClient, wallet: string, before?: string, knownSplits?: HistorySplit[]): Promise<WalletHistory> {
  const walletAddress = address(wallet);
  await assertDevnet(client);
  const splits: HistorySplit[] = knownSplits ? [...knownSplits] : [];
  if (!knownSplits) {
    for (const size of [253, 705]) {
      const accounts = await client.rpc.getProgramAccounts(PROGRAM_ADDRESS, { commitment: "confirmed", encoding: "base64",
        filters: [{ dataSize: BigInt(size) }, { memcmp: { offset: 41n, bytes: MOCK_USDC_MINT, encoding: "base58" } }],
      }).send({ abortSignal: AbortSignal.timeout(20_000) });
      for (const { pubkey, account } of accounts) {
        if (account.owner !== PROGRAM_ADDRESS || splits.some((s) => s.config.address === pubkey)) continue;
        try {
          const data = Uint8Array.from(getBase64Encoder().encode(account.data[0]));
          if (data.length !== size) continue;
          const config = size === 705 ? await decodeAgreement(pubkey, data) : await decodeSplitConfig(pubkey, data);
          if (config.mint !== MOCK_USDC_MINT || new Set(config.recipients).size !== config.recipients.length) continue;
          splits.push(size === 705 ? { kind: "agreement", config, agreement: config as SplitAgreement } : { kind: "legacy", config });
        } catch { /* Unsupported/corrupt accounts must not become payment evidence. */ }
      }
    }
  }
  const candidates = await client.rpc.getSignaturesForAddress(PROGRAM_ADDRESS, {
    commitment: "confirmed", limit: PAGE_SIZE, ...(before ? { before: signature(before) } : {}),
  }).send({ abortSignal: AbortSignal.timeout(20_000) });
  const payments: HistoryPayment[] = [];
  let unavailable = 0;
  // Sequential, small pages avoid a burst of getTransaction calls to the public RPC.
  for (const candidate of candidates) {
    if (candidate.err != null) continue;
    const tx = await client.rpc.getTransaction(candidate.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }).send({ abortSignal: AbortSignal.timeout(20_000) });
    if (!tx) { unavailable++; continue; }
    if (!tx.meta || tx.meta.err != null) continue;
    for (const [instructionIndex, ix] of tx.transaction.message.instructions.entries()) {
      if (!("data" in ix) || ix.programId !== PROGRAM_ADDRESS) continue;
      const stored = splits.find((s) => s.config.address === ix.accounts[1]);
      if (!stored || ix.accounts[2] !== MOCK_USDC_MINT) continue;
      const payer = ix.accounts[0];
      if (!payer || !tx.transaction.message.accountKeys.some((a) => a.pubkey === payer && a.signer)) continue;
      if (payer !== walletAddress && stored.config.creator !== walletAddress && !stored.config.recipients.includes(walletAddress)) continue;
      let data: Uint8Array;
      try { data = Uint8Array.from(getBase58Encoder().encode(ix.data)); } catch { continue; }
      let amount: bigint; let name: string;
      if (stored.kind === "agreement") {
        if (data.length !== 9 || !startsWith(data, PAY)) continue;
        const milestone = stored.agreement!.milestones[data[8]];
        if (!milestone?.paid || milestone.payer !== payer || milestone.paidSlot !== tx.slot || !getApprovalProgress(stored.agreement!).active) continue;
        amount = milestone.amount; name = milestone.name;
      } else {
        if (data.length !== 16 || !startsWith(data, EXECUTE)) continue;
        amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8, true);
        if (amount <= 0n) continue;
        name = "Legacy split payment";
      }
      payments.push({ id: `${candidate.signature}:${instructionIndex}`, signature: candidate.signature, split: stored.config.address,
        name, amount, payer, recipients: stored.config.recipients, allocations: calculateAllocations(amount, stored.config.sharesBps), timestamp: tx.blockTime });
    }
  }
  return { splits, payments, unavailable, nextBefore: candidates.length === PAGE_SIZE ? candidates.at(-1)!.signature : null };
}
