import { address, getAddressEncoder, getBase64Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { deriveAgreementAddress } from "../../agreement-client";
import { DEVNET_GENESIS_HASH, MOCK_USDC_MINT, PROGRAM_ADDRESS } from "../../constants";
import { RoutingContextError, assertRecipientOfPaidMilestone } from "./context";

const creator = address("HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ");
const recipients = ["aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq"].map(address);

// Same 705-byte SplitAgreement layout the existing agreement tests use.
async function agreementAccount(paid: boolean) {
  const [pda, bump] = await deriveAgreementAddress(creator, 1n);
  const bytes = new Uint8Array(705); const view = new DataView(bytes.buffer);
  bytes.set([243, 36, 127, 10, 214, 64, 81, 69]); bytes[8] = 1;
  bytes.set(getAddressEncoder().encode(creator), 9); bytes.set(getAddressEncoder().encode(MOCK_USDC_MINT), 41);
  view.setBigUint64(73, 1n, true); bytes[81] = 3;
  recipients.forEach((recipient, i) => bytes.set(getAddressEncoder().encode(recipient), 82 + i * 32));
  [5000, 3000, 2000].forEach((share, i) => view.setUint16(242 + i * 2, share, true));
  bytes[252] = bump; bytes[253] = 7; bytes[254] = 1; bytes[255] = 6;
  bytes.set(new TextEncoder().encode("Design"), 256); view.setBigUint64(288, 10_000_001n, true);
  if (paid) { bytes[296] = 1; bytes.set(getAddressEncoder().encode(creator), 297); view.setBigInt64(329, 1_791_590_400n, true); view.setBigUint64(337, 100n, true); }
  return { pda, data: getBase64Decoder().decode(bytes) };
}

function rpc(options: { paid?: boolean; owner?: string; genesis?: string; missing?: boolean; offline?: boolean; data?: string } = {}) {
  const getAccountInfo = vi.fn(() => ({ send: async () => {
    if (options.offline) throw new Error("fetch failed");
    const account = await agreementAccount(options.paid ?? true);
    return { value: options.missing ? null : { owner: options.owner ?? PROGRAM_ADDRESS, data: [options.data ?? account.data, "base64"] } };
  } }));
  return { getGenesisHash: () => ({ send: async () => options.genesis ?? DEVNET_GENESIS_HASH }), getAccountInfo } as never;
}

describe("routing context: recipient of a Paid milestone", () => {
  it("allows a configured recipient once the milestone is Paid", async () => {
    const { pda } = await agreementAccount(true);
    await expect(assertRecipientOfPaidMilestone({ wallet: recipients[1], agreement: pda, milestoneIndex: 0 }, { rpc: rpc() })).resolves.toBeUndefined();
  });

  it.each([
    ["an outsider (the payer)", { wallet: creator }, {}, "NOT_A_RECIPIENT"],
    ["an unpaid milestone", {}, { paid: false }, "MILESTONE_NOT_PAID"],
    ["a missing milestone", { milestoneIndex: 3 }, {}, "MILESTONE_NOT_PAID"],
    ["a missing account", {}, { missing: true }, "AGREEMENT_NOT_FOUND"],
    ["a foreign owner", {}, { owner: creator }, "AGREEMENT_NOT_FOUND"],
    ["corrupt account data", {}, { data: "AAAA" }, "AGREEMENT_NOT_FOUND"],
    ["a non-devnet RPC", {}, { genesis: "mainnet-genesis" }, "RPC_UNAVAILABLE"],
    ["an RPC outage", {}, { offline: true }, "RPC_UNAVAILABLE"],
  ])("rejects %s", async (_, input, rpcOptions, code) => {
    const { pda } = await agreementAccount(true);
    const error = await assertRecipientOfPaidMilestone({ wallet: recipients[0], agreement: pda, milestoneIndex: 0, ...input }, { rpc: rpc(rpcOptions) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoutingContextError);
    expect((error as RoutingContextError).code).toBe(code);
  });
});
