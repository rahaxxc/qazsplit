import "server-only";

import { address, createSolanaRpc, getBase64Encoder } from "@solana/kit";

import { decodeAgreement } from "../../agreement-client";
import { DEVNET_GENESIS_HASH, DEVNET_RPC_URL, PROGRAM_ADDRESS } from "../../constants";

// Two sequential reads must fit, with the MultiHopper calls, inside the create route's budget (audit M7).
const RPC_TIMEOUT_MS = 6_000;

export type RoutingContextCode = "AGREEMENT_NOT_FOUND" | "NOT_A_RECIPIENT" | "MILESTONE_NOT_PAID" | "RPC_UNAVAILABLE";

export class RoutingContextError extends Error {
  constructor(readonly code: RoutingContextCode, message: string) {
    super(message);
    this.name = "RoutingContextError";
  }
}

type ContextRpc = Pick<ReturnType<typeof createSolanaRpc>, "getGenesisHash" | "getAccountInfo">;

/**
 * Onward routing is only offered after settlement: the wallet must be a configured recipient of
 * a QazSplit agreement whose selected milestone is already Paid onchain. This reads state only;
 * it never builds, simulates or sends a QazSplit instruction.
 */
export async function assertRecipientOfPaidMilestone(
  input: { wallet: string; agreement: string; milestoneIndex: number },
  options: { rpc?: ContextRpc } = {},
): Promise<void> {
  const rpc = options.rpc ?? createSolanaRpc(DEVNET_RPC_URL);
  let data: Uint8Array;
  try {
    const genesisHash = await rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    if (genesisHash !== DEVNET_GENESIS_HASH) throw new RoutingContextError("RPC_UNAVAILABLE", "The server's Solana RPC is not devnet.");
    const account = await rpc.getAccountInfo(address(input.agreement), { commitment: "confirmed", encoding: "base64" })
      .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    if (!account.value || account.value.owner !== PROGRAM_ADDRESS) {
      throw new RoutingContextError("AGREEMENT_NOT_FOUND", "This QazSplit agreement was not found on devnet.");
    }
    data = Uint8Array.from(getBase64Encoder().encode(account.value.data[0]));
  } catch (error) {
    if (error instanceof RoutingContextError) throw error;
    throw new RoutingContextError("RPC_UNAVAILABLE", "Devnet RPC is unavailable. Try again shortly.");
  }
  let agreement: Awaited<ReturnType<typeof decodeAgreement>>;
  try {
    agreement = await decodeAgreement(address(input.agreement), data);
  } catch {
    throw new RoutingContextError("AGREEMENT_NOT_FOUND", "This account is not a valid QazSplit agreement.");
  }
  if (!agreement.recipients.some((recipient) => recipient === input.wallet)) {
    throw new RoutingContextError("NOT_A_RECIPIENT", "Only a recipient of this agreement can route funds onward.");
  }
  if (agreement.milestones[input.milestoneIndex]?.paid !== true) {
    throw new RoutingContextError("MILESTONE_NOT_PAID", "Onward routing is available only after this milestone is Paid.");
  }
}
