import {
  address, createClient, createNoopSigner, extendClient,
  getAddressDecoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { describe, expect, it, vi } from "vitest";

import { DEVNET_GENESIS_HASH, DEVNET_RPC_URL, MOCK_USDC_MINT } from "./constants";
import { buildCreateSplitInstruction, buildExecuteSplitInstructions, simulateInstructions, type SplitConfig } from "./qazsplit-client";
import type { AppClient } from "./solana-client";
import { getTransactionClient, getWalletTransactionVersion } from "./transaction-compat";

const payer = address("HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ");
const recipients = [
  "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX",
  "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8",
  "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq",
].map(address).concat([
  getAddressDecoder().decode(new Uint8Array(32).fill(4)),
  getAddressDecoder().decode(new Uint8Array(32).fill(5)),
]);

function mockClient(genesisHash = DEVNET_GENESIS_HASH) {
  const simulate = vi.fn(() => ({ send: async () => ({ value: { err: null, logs: [], unitsConsumed: 100n } }) }));
  return {
    simulate,
    client: { rpc: {
      getGenesisHash: () => ({ send: async () => genesisHash }),
      getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: payer, lastValidBlockHeight: 100n } }) }),
      simulateTransaction: simulate,
    } } as unknown as AppClient,
  };
}

describe("wallet transaction compatibility", () => {
  it("prefers v1, falls back to v0, and rejects unsupported versions", () => {
    expect(getWalletTransactionVersion(new Set([0, 1]))).toBe(1);
    expect(getWalletTransactionVersion(new Set(["legacy", 0]))).toBe(0);
    expect(getWalletTransactionVersion(new Set(["legacy"]))).toBeNull();
    expect(getWalletTransactionVersion(new Set())).toBeNull();
  });

  it("rebinds the v0 planner without duplicating the wallet/RPC or changing the v1 client", async () => {
    const wallet = { test: "shared wallet state" };
    const base = createClient()
      .use((client) => extendClient(client, { payer: createNoopSigner(payer), wallet }))
      .use(solanaRpc({ rpcUrl: DEVNET_RPC_URL, transactionConfig: { version: 1 } })) as unknown as AppClient;
    const built = await buildCreateSplitInstruction({ creator: payer, mint: MOCK_USDC_MINT, splitId: 1n, recipients: recipients.slice(0, 3), sharesBps: [5000, 3000, 2000] });
    const compatible = getTransactionClient(base, 0);
    expect(compatible.wallet).toBe(base.wallet);
    expect(compatible.rpc).toBe(base.rpc);
    expect(compatible.payer).toBe(base.payer);
    expect((await compatible.planTransaction([built.instruction])).version).toBe(0);
    expect((await base.planTransaction([built.instruction])).version).toBe(1);
    expect(getTransactionClient(base, 1)).toBe(base);
  });

  it.each([0, 1] as const)("simulates Create and a five-recipient atomic payment using actual v%s wire bytes", async (version) => {
    const { client, simulate } = mockClient();
    const built = await buildCreateSplitInstruction({ creator: payer, mint: MOCK_USDC_MINT, splitId: 2n, recipients, sharesBps: [2000, 2000, 2000, 2000, 2000] });
    const config: SplitConfig = { address: built.splitConfig, version: 1, creator: payer, mint: MOCK_USDC_MINT, splitId: 2n, recipients, sharesBps: [2000, 2000, 2000, 2000, 2000], bump: 0 };
    const payment = await buildExecuteSplitInstructions({ payer: createNoopSigner(payer), config, amount: 10_000_000n });
    await simulateInstructions(client, payer, [built.instruction], version);
    await simulateInstructions(client, payer, payment.instructions, version);
    expect(simulate).toHaveBeenCalledTimes(2);
    const calls = simulate.mock.calls as unknown as [string, { sigVerify: boolean }][];
    for (const [wire, options] of calls) {
      const bytes = getBase64Encoder().encode(wire);
      const transaction = getTransactionDecoder().decode(bytes);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      expect(message.version).toBe(version);
      expect(bytes.length).toBeLessThanOrEqual(version === 0 ? 1232 : 4096);
      expect(options.sigVerify).toBe(false);
    }
    const paymentTx = getTransactionDecoder().decode(getBase64Encoder().encode(calls[1][0]));
    const paymentMessage = getCompiledTransactionMessageDecoder().decode(paymentTx.messageBytes);
    const instructionCount = paymentMessage.version === 1
      ? paymentMessage.numInstructions
      : paymentMessage.instructions.length;
    expect(instructionCount).toBe(payment.instructions.length + (version === 0 ? 1 : 0));
  });

  it("still rejects non-devnet RPC before simulation", async () => {
    const { client, simulate } = mockClient("wrong-genesis");
    await expect(simulateInstructions(client, payer, [], 0)).rejects.toThrow(/devnet/i);
    expect(simulate).not.toHaveBeenCalled();
  });
});
