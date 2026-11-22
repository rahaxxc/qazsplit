import { MultiHopperApiError, createMultiHopperClient, type MultiHopperTransfer } from "@/lib/multihopper/server/api";
import { checkApprovalFreshness, issueAccessToken, verifyRoutingApproval } from "@/lib/multihopper/server/auth";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { assertRecipientOfPaidMilestone } from "@/lib/multihopper/server/context";
import { assertSignedOrigin, enforceRateLimit } from "@/lib/multihopper/server/guards";
import { RequestError, json, logRoutingEvent, readJsonBody, toErrorResponse, toPublicTransfer } from "@/lib/multihopper/server/http";
import {
  ROUTING_ERROR_CODES, SOL_DECIMALS, SOL_MINT, SOL_SYMBOL, externalIdForRequest, lamportsToTokenString, validateRoutingRequest,
  type RoutingRequest,
} from "@/lib/multihopper/shared";

// Worst case: two devnet reads (6 s each) + create (15 s) + by-external (10 s) (audit M7).
export const maxDuration = 60;

function assertMatchesRequest(transfer: MultiHopperTransfer, request: RoutingRequest, externalId: string): void {
  const mismatch = transfer.sourceOwner !== request.wallet
    || (transfer.externalId != null && transfer.externalId !== externalId)
    || (transfer.recipientWallet != null && transfer.recipientWallet !== request.destination)
    || (transfer.amountRaw != null && transfer.amountRaw !== request.amountLamports)
    || (transfer.tokenMint != null && transfer.tokenMint !== SOL_MINT);
  if (mismatch) throw new RequestError(409, ROUTING_ERROR_CODES.transferMismatch, "An existing transfer with this request ID does not match this request.");
}

/**
 * Creates a quoted MultiHopper transfer for a recipient who signed the exact routing request.
 * Creating moves no funds; the recipient still signs every prepared transaction in their wallet.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "create");
    const body = await readJsonBody(request);
    const validated = validateRoutingRequest(body);
    if (!validated.ok) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, validated.message);
    const routing = validated.value;
    assertSignedOrigin(request, routing.origin);

    const freshness = checkApprovalFreshness(routing.issuedAt);
    if (freshness !== "fresh") {
      throw new RequestError(401, ROUTING_ERROR_CODES.approvalExpired, freshness === "expired"
        ? "This routing approval has expired. Review and approve it again." : "This routing approval is dated in the future. Check your device clock.");
    }
    const signature = (body as { signature?: unknown }).signature;
    if (!(await verifyRoutingApproval(routing, signature))) {
      throw new RequestError(401, ROUTING_ERROR_CODES.invalidSignature, "The wallet signature does not match this routing request.");
    }
    // Settlement first, routing second: only a recipient of a Paid milestone may continue.
    await assertRecipientOfPaidMilestone(routing);

    const client = createMultiHopperClient(config);
    const externalId = externalIdForRequest(routing.requestId);
    let transfer: MultiHopperTransfer;
    let reused = false;
    try {
      // externalId (derived from the signed request) makes retries of one approval return one transfer
      // (MH_033 → by-external below). The Idempotency-Key is random per attempt, as documented, so a
      // cached upstream error is never replayed to a retry (audit M8).
      transfer = await client.createTransfer({
        tokenMint: SOL_MINT,
        amountRaw: routing.amountLamports,
        amountTokens: lamportsToTokenString(BigInt(routing.amountLamports)),
        tokenDecimals: SOL_DECIMALS,
        tokenSymbol: SOL_SYMBOL,
        sourceOwner: routing.wallet,
        recipientWallet: routing.destination,
        hops: routing.hops,
        arrivalSeconds: routing.arrivalSeconds,
        externalId,
      }, `qzs-create-${crypto.randomUUID()}`);
    } catch (error) {
      if (!(error instanceof MultiHopperApiError && error.code === "MH_033")) throw error;
      transfer = await client.getTransferByExternalId(externalId); // duplicate externalId: return the original
      reused = true;
    }
    assertMatchesRequest(transfer, routing, externalId);

    const accessToken = await issueAccessToken(config.tokenSecret, {
      transferId: transfer.id, wallet: routing.wallet, agreement: routing.agreement, milestoneIndex: routing.milestoneIndex,
    });
    logRoutingEvent("info", "transfer_created", { transferId: transfer.id, status: transfer.status, reused });
    return json({ transfer: toPublicTransfer(transfer), accessToken, reused });
  } catch (error) {
    return toErrorResponse(error, "create");
  }
}
