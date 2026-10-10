import { AccountRole, address, getAddressDecoder, getAddressEncoder, getBase64Encoder, getBase58Encoder, getProgramDerivedAddress, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { MOCK_USDC_MINT, PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS } from "./constants";
import { assertDevnet, buildExecuteSplitInstructions, type SplitConfig } from "./qazsplit-client";
import type { AppClient } from "./solana-client";
import { calculateAllocations } from "./split-math";

export const AGREEMENT_DISCRIMINATOR = [243, 36, 127, 10, 214, 64, 81, 69] as const;
const PROPOSE_DISCRIMINATOR = [38, 104, 30, 96, 107, 245, 76, 252];
const APPROVE_DISCRIMINATOR = [45, 15, 173, 153, 242, 122, 252, 246];
const PAY_DISCRIMINATOR = [144, 47, 174, 151, 82, 121, 153, 126];
const U64_MAX = (1n << 64n) - 1n;

export type MilestoneInput = { name: string; amount: bigint };
export type Milestone = MilestoneInput & { paid: boolean; payer: Address; paidAt: bigint; paidSlot: bigint };
export type SplitAgreement = SplitConfig & { approvalMask: number; milestones: Milestone[] };

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function integer(value: bigint | number, length: 2 | 4 | 8): Uint8Array {
  const result = new Uint8Array(length); const view = new DataView(result.buffer);
  if (length === 8) {
    if (BigInt(value) < 0n || BigInt(value) > U64_MAX) throw new Error("Amount or split ID exceeds u64.");
    view.setBigUint64(0, BigInt(value), true);
  } else if (length === 4) view.setUint32(0, Number(value), true);
  else view.setUint16(0, Number(value), true);
  return result;
}
export function getApprovalProgress(agreement: SplitAgreement) {
  const total = agreement.recipients.length;
  const approved = agreement.recipients.filter((_, i) => (agreement.approvalMask & (1 << i)) !== 0).length;
  return { approved, total, active: approved === total };
}
export function validateMilestones(milestones: readonly MilestoneInput[]): void {
  if (milestones.length < 1 || milestones.length > 5) throw new Error("Use between one and five milestones.");
  for (const milestone of milestones) {
    if (!milestone.name.trim() || new TextEncoder().encode(milestone.name).length > 32) throw new Error("Enter milestone names of 1–32 UTF-8 bytes.");
    if (milestone.amount <= 0n || milestone.amount > U64_MAX) throw new Error("Enter positive milestone amounts with at most six decimals, within u64.");
  }
}
export async function deriveAgreementAddress(creator: Address, splitId: bigint) {
  return getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode("agreement"), getAddressEncoder().encode(creator), integer(splitId, 8)] });
}
export async function buildProposeSplitInstruction(input: {
  creator: Address; splitId: bigint; recipients: readonly Address[]; sharesBps: readonly number[]; milestones: readonly MilestoneInput[];
}): Promise<{ instruction: Instruction; splitConfig: Address }> {
  calculateAllocations(1n, input.sharesBps);
  if (input.recipients.length !== input.sharesBps.length || new Set(input.recipients).size !== input.recipients.length) throw new Error("Enter valid unique recipients with matching shares.");
  validateMilestones(input.milestones);
  const [splitConfig] = await deriveAgreementAddress(input.creator, input.splitId);
  return { splitConfig, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: input.creator, role: AccountRole.WRITABLE_SIGNER },
      { address: MOCK_USDC_MINT, role: AccountRole.READONLY },
      { address: splitConfig, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: bytes(Uint8Array.from(PROPOSE_DISCRIMINATOR), integer(input.splitId, 8), integer(input.recipients.length, 4),
      ...input.recipients.map((r) => Uint8Array.from(getAddressEncoder().encode(r))), integer(input.sharesBps.length, 4), ...input.sharesBps.map((s) => integer(s, 2)),
      integer(input.milestones.length, 4), ...input.milestones.map((m) => {
        const name = new TextEncoder().encode(m.name); return bytes(integer(name.length, 4), name, integer(m.amount, 8));
      })),
  } };
}
export function buildApproveSplitInstruction(recipient: Address, agreement: Address): Instruction {
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: recipient, role: AccountRole.READONLY_SIGNER }, { address: agreement, role: AccountRole.WRITABLE },
  ], data: Uint8Array.from(APPROVE_DISCRIMINATOR) };
}
export async function buildPayMilestoneInstructions(input: { payer: TransactionSigner; agreement: SplitAgreement; milestoneIndex: number }) {
  if (input.agreement.mint !== MOCK_USDC_MINT) throw new Error("Only the QazSplit mock-USDC mint is supported.");
  if (!getApprovalProgress(input.agreement).active) throw new Error("Every recipient must approve before payment.");
  const milestone = input.agreement.milestones[input.milestoneIndex];
  if (!Number.isInteger(input.milestoneIndex) || !milestone) throw new Error("The selected milestone does not exist.");
  if (milestone.paid) throw new Error("This milestone has already been paid.");
  // Reuse the existing direct-transfer account/ATA construction, never a vault.
  const built = await buildExecuteSplitInstructions({ payer: input.payer, config: input.agreement, amount: milestone.amount });
  const payment = built.instructions.at(-1)!;
  return { ...built, instructions: [...built.instructions.slice(0, -1), {
    ...payment,
    accounts: payment.accounts!.map((account, i) => i === 1 ? { ...account, role: AccountRole.WRITABLE } : account),
    data: Uint8Array.from([...PAY_DISCRIMINATOR, input.milestoneIndex]),
  }] };
}

export async function decodeAgreement(accountAddress: Address, data: Uint8Array): Promise<SplitAgreement> {
  if (data.length !== 705 || AGREEMENT_DISCRIMINATOR.some((b, i) => data[i] !== b)) throw new Error("Invalid agreement account layout.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decodeAddress = (offset: number) => getAddressDecoder().decode(data.slice(offset, offset + 32));
  const count = data[81]; const milestoneCount = data[254]; const approvalMask = data[253];
  if (data[8] !== 1 || count < 2 || count > 5 || milestoneCount < 1 || milestoneCount > 5 || approvalMask >= (1 << count)) throw new Error("Invalid agreement version, counts, or approval flags.");
  const agreement: SplitAgreement = {
    address: accountAddress, version: data[8], creator: decodeAddress(9), mint: decodeAddress(41), splitId: view.getBigUint64(73, true),
    recipients: Array.from({ length: count }, (_, i) => decodeAddress(82 + i * 32)),
    sharesBps: Array.from({ length: count }, (_, i) => view.getUint16(242 + i * 2, true)),
    bump: data[252], approvalMask, milestones: [],
  };
  if (new Set(agreement.recipients).size !== count) throw new Error("Invalid duplicate agreement recipients.");
  calculateAllocations(1n, agreement.sharesBps);
  for (let i = 0; i < milestoneCount; i++) {
    const offset = 255 + i * 90; const nameLength = data[offset];
    if (nameLength < 1 || nameLength > 32 || data[offset + 41] > 1) throw new Error("Invalid milestone record.");
    agreement.milestones.push({
      name: new TextDecoder("utf-8", { fatal: true }).decode(data.slice(offset + 1, offset + 1 + nameLength)),
      amount: view.getBigUint64(offset + 33, true), paid: data[offset + 41] === 1,
      payer: decodeAddress(offset + 42), paidAt: view.getBigInt64(offset + 74, true), paidSlot: view.getBigUint64(offset + 82, true),
    });
  }
  validateMilestones(agreement.milestones);
  const [expected, bump] = await deriveAgreementAddress(agreement.creator, agreement.splitId);
  if (expected !== accountAddress || bump !== agreement.bump) throw new Error("Agreement PDA does not match its immutable terms.");
  return agreement;
}

export async function fetchAgreement(client: AppClient, agreementAddress: string): Promise<SplitAgreement> {
  const data = await fetchSplitAccount(client, agreementAddress);
  return decodeAgreement(address(agreementAddress), data);
}
async function fetchSplitAccount(client: AppClient, accountAddress: string) {
  await assertDevnet(client);
  const response = await client.rpc.getAccountInfo(address(accountAddress), { commitment: "confirmed", encoding: "base64" }).send();
  if (!response.value) throw new Error("Split was not found on devnet.");
  if (response.value.owner !== PROGRAM_ADDRESS) throw new Error("Split is not owned by QazSplit.");
  return Uint8Array.from(getBase64Encoder().encode(response.value.data[0]));
}
export async function fetchSplitKind(client: AppClient, accountAddress: string): Promise<"agreement" | "legacy"> {
  const data = await fetchSplitAccount(client, accountAddress);
  if (data.length === 705 && AGREEMENT_DISCRIMINATOR.every((b, i) => data[i] === b)) return "agreement";
  if (data.length === 253 && [49, 201, 50, 228, 22, 142, 12, 222].every((b, i) => data[i] === b)) return "legacy";
  throw new Error("This account is not a supported QazSplit agreement.");
}

// The signature is not available inside a Solana instruction. Recover it from the
// small bounded account history and verify the successful top-level payment instruction.
export async function fetchMilestoneSignature(client: AppClient, agreement: SplitAgreement, index: number): Promise<string | null> {
  await assertDevnet(client);
  const milestone = agreement.milestones[index];
  if (!milestone?.paid) return null;
  const signatures = await client.rpc.getSignaturesForAddress(agreement.address, { commitment: "confirmed", limit: 100 }).send();
  for (const candidate of signatures.filter((s) => s.err == null && s.slot === milestone.paidSlot)) {
    const tx = await client.rpc.getTransaction(candidate.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }).send();
    if (!tx || tx.meta?.err != null) continue;
    for (const ix of tx.transaction.message.instructions) {
      if (!("data" in ix) || ix.programId !== PROGRAM_ADDRESS || ix.accounts[1] !== agreement.address || ix.accounts[0] !== milestone.payer) continue;
      const data = getBase58Encoder().encode(ix.data);
      if (data.length === 9 && PAY_DISCRIMINATOR.every((byte, i) => data[i] === byte) && data[8] === index) return candidate.signature;
    }
  }
  return null;
}
