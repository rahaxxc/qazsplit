import { createMultiHopperClient } from "@/lib/multihopper/server/api";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { enforceRateLimit } from "@/lib/multihopper/server/guards";
import {
  assertOwnedTransfer, authorizeTransferAccess, json, logRoutingEvent, parseConfirmBroadcastBody, parseTransferId, readJsonBody, toErrorResponse,
  toPublicTransfer,
} from "@/lib/multihopper/server/http";

export const maxDuration = 30;

/**
 * Records broadcast signatures. Called twice per attempt: right after keeperFundingTx confirms,
 * then after every remaining group confirms. MultiHopper verifies the chain itself, so a bad or
 * premature report changes nothing; each call gets a fresh Idempotency-Key, as documented.
 */
export async function POST(request: Request, { params }: { params: Promise<{ transferId: string }> }): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "confirm");
    const transferId = parseTransferId((await params).transferId);
    const claims = await authorizeTransferAccess(request, config.tokenSecret, transferId);
    const body = parseConfirmBroadcastBody(await readJsonBody(request));
    const transfer = await createMultiHopperClient(config).confirmBroadcast(transferId, body, `qzs-confirm-${crypto.randomUUID()}`);
    assertOwnedTransfer(transfer, claims);
    logRoutingEvent("info", "broadcast_confirmed", {
      transferId, keeperFundingOnly: body.routeInitSignatures.length === 0 && !body.orchestratorInitSignature && !body.sessionInitSignatures,
      status: transfer?.status ?? null,
    });
    return json({ transfer: transfer ? toPublicTransfer(transfer) : null });
  } catch (error) {
    return toErrorResponse(error, "confirm-broadcast");
  }
}
