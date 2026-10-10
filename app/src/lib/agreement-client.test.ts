import { address, AccountRole, createNoopSigner, getAddressEncoder, getAddressDecoder, getBase58Decoder, getBase64Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS_HASH, MOCK_USDC_MINT, PROGRAM_ADDRESS } from "./constants";
import { buildApproveSplitInstruction, buildPayMilestoneInstructions, buildProposeSplitInstruction, decodeAgreement, deriveAgreementAddress, getApprovalProgress, fetchAgreement, fetchMilestoneSignature, fetchSplitKind } from "./agreement-client";
import { simulateInstructions } from "./qazsplit-client";
import type { AppClient } from "./solana-client";

const creator = address("HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ");
const recipients = ["aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq"].map(address);
async function fixture() {
  const [pda, bump] = await deriveAgreementAddress(creator, 1n);
  const bytes = new Uint8Array(705);
  const view = new DataView(bytes.buffer);
  bytes.set([243, 36, 127, 10, 214, 64, 81, 69]);
  bytes[8] = 1;
  bytes.set(getAddressEncoder().encode(creator), 9);
  bytes.set(getAddressEncoder().encode(MOCK_USDC_MINT), 41);
  view.setBigUint64(73, 1n, true);
  bytes[81] = 3;
  recipients.forEach((recipient, i) => bytes.set(getAddressEncoder().encode(recipient), 82 + i * 32));
  [5000, 3000, 2000].forEach((share, i) => view.setUint16(242 + i * 2, share, true));
  bytes[252] = bump;
  bytes[253] = 7;
  bytes[254] = 1;
  bytes[255] = 6;
  bytes.set(new TextEncoder().encode("Design"), 256);
  view.setBigUint64(288, 10_000_001n, true);
  return { pda, bytes, view };
}

describe("agreement wire format and guards", () => {
  it("encodes proposed fixed terms and requires only the creator signature", async () => {
    const built = await buildProposeSplitInstruction({ creator, splitId: 1n, recipients, sharesBps: [5000, 3000, 2000], milestones: [{ name: "Design", amount: 10_000_001n }] });
    expect([...built.instruction.data!.slice(0, 8)]).toEqual([38, 104, 30, 96, 107, 245, 76, 252]);
    expect(built.instruction.accounts?.filter((a) => a.role >= AccountRole.READONLY_SIGNER).map((a) => a.address)).toEqual([creator]);
    expect(built.splitConfig).toEqual((await fixture()).pda);
  });
  it("requires the approving recipient's signature and writable agreement", async () => {
    const ix = buildApproveSplitInstruction(recipients[0], (await fixture()).pda);
    expect(ix.accounts?.[0]).toEqual({ address: recipients[0], role: AccountRole.READONLY_SIGNER });
    expect(ix.accounts?.[1].role).toEqual(AccountRole.WRITABLE);
  });
  it("decodes immutable terms and 3 of 3 Active status", async () => {
    const { pda, bytes } = await fixture();
    const agreement = await decodeAgreement(pda, bytes);
    expect(agreement.milestones[0]).toMatchObject({ name: "Design", amount: 10_000_001n, paid: false });
    expect(getApprovalProgress(agreement)).toEqual({ approved: 3, total: 3, active: true });
    expect(agreement.recipients).toEqual(recipients);
  });
  it("keeps 2 of 3 Pending and forbids building a payment", async () => {
    const { pda, bytes } = await fixture(); bytes[253] = 3;
    const agreement = await decodeAgreement(pda, bytes);
    expect(getApprovalProgress(agreement)).toEqual({ approved: 2, total: 3, active: false });
    await expect(buildPayMilestoneInstructions({ payer: createNoopSigner(creator), agreement, milestoneIndex: 0 })).rejects.toThrow("Every recipient");
  });
  it("builds one direct payer-to-recipient milestone instruction with no client-supplied amount", async () => {
    const { pda, bytes } = await fixture();
    const agreement = await decodeAgreement(pda, bytes);
    const built = await buildPayMilestoneInstructions({ payer: createNoopSigner(creator), agreement, milestoneIndex: 0 });
    const ix = built.instructions.at(-1)!;
    expect(ix.programAddress).toBe(PROGRAM_ADDRESS);
    expect([...ix.data!]).toEqual([144, 47, 174, 151, 82, 121, 153, 126, 0]);
    expect(ix.accounts?.[1]).toEqual({ address: pda, role: AccountRole.WRITABLE });
    expect(built.recipientAtas).toHaveLength(3);
    expect(built.instructions).toHaveLength(4);
  });
  it("blocks already paid/invalid milestones and non-mock mints", async () => {
    const { pda, bytes } = await fixture();
    const agreement = await decodeAgreement(pda, bytes);
    const input = { payer: createNoopSigner(creator), agreement, milestoneIndex: 1 };
    await expect(buildPayMilestoneInstructions(input)).rejects.toThrow("does not exist");
    agreement.milestones[0].paid = true; input.milestoneIndex = 0;
    await expect(buildPayMilestoneInstructions(input)).rejects.toThrow("already been paid");
    agreement.mint = creator;
    await expect(buildPayMilestoneInstructions(input)).rejects.toThrow("mock-USDC");
  });
  it.each(["length", "discriminator", "count", "approval bits", "PDA", "UTF-8", "zero amount"])("rejects corrupt %s before displaying agreement terms", async (kind) => {
    const fixtureData = await fixture(); let { bytes, pda } = fixtureData;
    if (kind === "length") bytes = bytes.slice(1);
    if (kind === "discriminator") bytes[0] = 0;
    if (kind === "count") bytes[254] = 6;
    if (kind === "approval bits") bytes[253] = 128;
    if (kind === "PDA") pda = creator;
    if (kind === "UTF-8") bytes[256] = 255;
    if (kind === "zero amount") fixtureData.view.setBigUint64(288, 0n, true);
    await expect(decodeAgreement(pda, bytes)).rejects.toThrow();
  });
  it("requires the real program owner and devnet genesis before loading", async () => {
    const { pda, bytes } = await fixture();
    const owner = { value: { owner: PROGRAM_ADDRESS, data: [getBase64Decoder().decode(bytes), "base64"] } };
    const rpc = { getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }), getAccountInfo: () => ({ send: async () => owner }) };
    const client = { rpc } as unknown as AppClient;
    expect(await fetchSplitKind(client, pda)).toBe("agreement");
    expect((await fetchAgreement(client, pda)).address).toBe(pda);
    owner.value.owner = creator;
    await expect(fetchAgreement(client, pda)).rejects.toThrow("owned by QazSplit");
    rpc.getGenesisHash = () => ({ send: async () => "mainnet" });
    await expect(fetchAgreement(client, pda)).rejects.toThrow("devnet-only");
  });
  it.each(["valid", "other milestone", "other agreement", "failed", "other program"])("receipt lookup verifies %s transactions", async (kind) => {
    const { pda, bytes } = await fixture(); const agreement = await decodeAgreement(pda, bytes);
    agreement.milestones[0] = { ...agreement.milestones[0], paid: true, paidSlot: 100n, paidAt: 1n, payer: creator };
    const ix = { programId: kind === "other program" ? creator : PROGRAM_ADDRESS,
      accounts: [creator, kind === "other agreement" ? creator : pda],
      data: getBase58Decoder().decode(Uint8Array.from([144,47,174,151,82,121,153,126,kind === "other milestone" ? 1 : 0])) };
    const client = { rpc: {
      getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }),
      getSignaturesForAddress: () => ({ send: async () => [{ signature: "known-good", err: null, slot: 100n }] }),
      getTransaction: () => ({ send: async () => ({ meta: { err: kind === "failed" ? { InstructionError: [0, "InvalidArgument"] } : null }, transaction: { message: { instructions: [ix] } } }) }),
    } } as unknown as AppClient;
    expect(await fetchMilestoneSignature(client, agreement, 0)).toBe(kind === "valid" ? "known-good" : null);
  });
  it.each([0, 1] as const)("maximum proposal and payment fit one actual v%s transaction", async (version) => {
    const { pda, bytes } = await fixture(); const agreement = await decodeAgreement(pda, bytes);
    agreement.recipients = [...recipients, getAddressDecoder().decode(new Uint8Array(32).fill(4)), getAddressDecoder().decode(new Uint8Array(32).fill(5))];
    agreement.sharesBps = Array(5).fill(2000); agreement.approvalMask = 31;
    const proposed = await buildProposeSplitInstruction({ creator, splitId: 1n, recipients: agreement.recipients, sharesBps: agreement.sharesBps, milestones: Array(5).fill({ name: "x".repeat(32), amount: 1n }) });
    const payment = await buildPayMilestoneInstructions({ payer: createNoopSigner(creator), agreement, milestoneIndex: 0 });
    const simulate = vi.fn(() => ({ send: async () => ({ value: { err: null, logs: [], unitsConsumed: 100n } }) }));
    const client = { rpc: {
      getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }),
      getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: creator, lastValidBlockHeight: 100n } }) }), simulateTransaction: simulate,
    } } as unknown as AppClient;
    await simulateInstructions(client, creator, [proposed.instruction], version);
    await simulateInstructions(client, creator, payment.instructions, version);
    for (const call of simulate.mock.calls as unknown as [string][]) {
      const wire = getBase64Encoder().encode(call[0]); const tx = getTransactionDecoder().decode(wire);
      expect(wire.length).toBeLessThanOrEqual(version === 0 ? 1232 : 4096);
      expect(getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version).toBe(version);
      expect(Object.keys(tx.signatures)).toHaveLength(1);
    }
  });
});
