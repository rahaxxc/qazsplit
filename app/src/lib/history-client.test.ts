import { address, getAddressEncoder, getBase58Decoder, getBase64Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS_HASH, MOCK_USDC_MINT, PROGRAM_ADDRESS } from "./constants";
import { deriveSplitConfigAddress } from "./qazsplit-client";
import { deriveAgreementAddress } from "./agreement-client";
import { fetchWalletHistory, relatedSplits } from "./history-client";
import type { AppClient } from "./solana-client";

const wallet = address("DENNUUamXbytAJBV5EfvvLPwUZpQBbCpis1rU7unmUDn");
const recipient = address("aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX");
const other = address("FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8");
async function fixture(legacy = false) {
  const [pda, bump] = await (legacy ? deriveSplitConfigAddress : deriveAgreementAddress)(wallet, 42n);
  const bytes = new Uint8Array(legacy ? 253 : 705); const view = new DataView(bytes.buffer);
  bytes.set(legacy ? [49,201,50,228,22,142,12,222] : [243,36,127,10,214,64,81,69]); bytes[8] = 1;
  bytes.set(getAddressEncoder().encode(wallet), 9); bytes.set(getAddressEncoder().encode(MOCK_USDC_MINT), 41);
  view.setBigUint64(73, 42n, true); bytes[81] = 2;
  [recipient, other].forEach((r, i) => bytes.set(getAddressEncoder().encode(r), 82 + i * 32));
  [5000,5000].forEach((s, i) => view.setUint16(242 + i * 2, s, true)); bytes[252] = bump;
  if (!legacy) {
    bytes[253] = 3; bytes[254] = 1; bytes[255] = 6; bytes.set(new TextEncoder().encode("Design"), 256);
    view.setBigUint64(288, 10_000_001n, true); bytes[296] = 1;
    bytes.set(getAddressEncoder().encode(wallet), 297); view.setBigInt64(329, 1791590400n, true); view.setBigUint64(337, 100n, true);
  }
  const ixData = legacy ? new Uint8Array(16) : Uint8Array.from([144,47,174,151,82,121,153,126,0]);
  if (legacy) { ixData.set([6,45,171,40,49,129,23,89]); new DataView(ixData.buffer).setBigUint64(8, 10_000_001n, true); }
  const ix = { programId: PROGRAM_ADDRESS, accounts: [wallet, pda, MOCK_USDC_MINT], data: getBase58Decoder().decode(ixData) };
  const tx = { slot: 100n, blockTime: 1791590400n, meta: { err: null }, transaction: { message: {
    accountKeys: [{ pubkey: wallet, signer: true }], instructions: [ix],
  } } };
  const account = { pubkey: pda, account: { owner: PROGRAM_ADDRESS, data: [getBase64Decoder().decode(bytes), "base64"] } };
  const rpc = {
    getGenesisHash: vi.fn(() => ({ send: async () => DEVNET_GENESIS_HASH })),
    getProgramAccounts: vi.fn(() => ({ send: async () => [account] })),
    getSignaturesForAddress: vi.fn(() => ({ send: async () => [{ signature: "signature", slot: 100n, err: null }] })),
    getTransaction: vi.fn(() => ({ send: async () => tx })),
  };
  return { client: { rpc } as unknown as AppClient, rpc, tx, ix, account, bytes, pda };
}
describe("wallet history from verified devnet state and transactions", () => {
  it.each([false, true])("recovers %s legacy payments with exact integer allocations", async (legacy) => {
    const f = await fixture(legacy); const result = await fetchWalletHistory(f.client, wallet);
    expect(result.payments).toHaveLength(1); expect(result.payments[0].allocations).toEqual([5_000_000n,5_000_001n]);
    expect(result.payments[0].name).toBe(legacy ? "Legacy split payment" : "Design");
    expect(result.nextBefore).toBeNull(); expect(relatedSplits(result.splits, wallet, result.payments)).toHaveLength(1);
    expect(f.rpc.getTransaction).toHaveBeenCalledWith("signature", expect.objectContaining({ maxSupportedTransactionVersion: 1 }));
  });
  it("includes recipient activity even though the wallet was not the payer", async () => {
    const f = await fixture(); const result = await fetchWalletHistory(f.client, recipient);
    expect(result.payments).toHaveLength(1); expect(relatedSplits(result.splits, recipient, [])).toHaveLength(1);
  });
  it("excludes other wallets' payments and agreements", async () => {
    const f = await fixture(); const stranger = address("HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ");
    const result = await fetchWalletHistory(f.client, stranger);
    expect(result.payments).toEqual([]); expect(relatedSplits(result.splits, stranger, result.payments)).toEqual([]);
  });
  it.each(["failed", "wrong program", "wrong mint", "unsigned payer", "wrong slot", "wrong index", "bad data"])("rejects %s proof", async (kind) => {
    const f = await fixture();
    if (kind === "failed") f.tx.meta.err = {} as never;
    if (kind === "wrong program") f.ix.programId = other;
    if (kind === "wrong mint") f.ix.accounts[2] = other;
    if (kind === "unsigned payer") f.tx.transaction.message.accountKeys[0].signer = false;
    if (kind === "wrong slot") f.tx.slot = 101n;
    if (kind === "wrong index") f.ix.data = getBase58Decoder().decode(Uint8Array.from([144,47,174,151,82,121,153,126,4]));
    if (kind === "bad data") f.ix.data = "invalid0" as never;
    expect((await fetchWalletHistory(f.client, wallet)).payments).toEqual([]);
  });
  it.each(["owner", "layout", "mint", "PDA"])("does not trust invalid %s accounts", async (kind) => {
    const f = await fixture();
    if (kind === "owner") f.account.account.owner = other;
    if (kind === "layout") f.bytes[0] = 0;
    if (kind === "mint") f.bytes.set(getAddressEncoder().encode(other), 41);
    if (kind === "PDA") f.account.pubkey = other;
    f.account.account.data[0] = getBase64Decoder().decode(f.bytes);
    expect((await fetchWalletHistory(f.client, wallet)).splits).toEqual([]);
  });
  it("refuses non-devnet before querying any accounts", async () => {
    const f = await fixture(); f.rpc.getGenesisHash.mockReturnValue({ send: async () => "mainnet" });
    await expect(fetchWalletHistory(f.client, wallet)).rejects.toThrow("devnet-only");
    expect(f.rpc.getProgramAccounts).not.toHaveBeenCalled();
  });
  it("paginates older activity and reuses validated configs", async () => {
    const f = await fixture();
    const cursor = "4vJCE5o1zkkNsG2DbuwEfPmujnq2JjYPiRhJDysJLsg1KKXZhDutk1VAjp6uei1U3gKuZmtU6kNJNJeDVKuQXgeG";
    f.rpc.getSignaturesForAddress.mockReturnValue({ send: async () => Array.from({ length: 5 }, () => ({ signature: cursor, slot: 100n, err: null })) });
    const first = await fetchWalletHistory(f.client, wallet); expect(first.nextBefore).toBe(cursor);
    f.rpc.getProgramAccounts.mockClear();
    await fetchWalletHistory(f.client, wallet, cursor, first.splits);
    expect(f.rpc.getSignaturesForAddress).toHaveBeenLastCalledWith(PROGRAM_ADDRESS, expect.objectContaining({ before: cursor }));
    expect(f.rpc.getProgramAccounts).not.toHaveBeenCalled();
  });
  it("reports unavailable RPC history instead of claiming an empty complete archive", async () => {
    const f = await fixture(); f.rpc.getTransaction.mockReturnValue({ send: async () => null as never });
    const result = await fetchWalletHistory(f.client, wallet); expect(result.unavailable).toBe(1);
  });
});
