import { createMultiHopperClient } from "@/lib/multihopper/server/api";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { enforceRateLimit } from "@/lib/multihopper/server/guards";
import { assertOwnedTransfer, authorizeTransferAccess, json, parseTransferId, toErrorResponse, toPublicTransfer } from "@/lib/multihopper/server/http";

export const maxDuration = 30;

/** Transfer status for its owner only (GET /transfers/{id} upstream). */
export async function GET(request: Request, { params }: { params: Promise<{ transferId: string }> }): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "status");
    const transferId = parseTransferId((await params).transferId);
    const claims = await authorizeTransferAccess(request, config.tokenSecret, transferId);
    const transfer = await createMultiHopperClient(config).getTransfer(transferId);
    assertOwnedTransfer(transfer, claims);
    return json({ transfer: toPublicTransfer(transfer) });
  } catch (error) {
    return toErrorResponse(error, "status");
  }
}
