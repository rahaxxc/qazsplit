import { createMultiHopperClient } from "@/lib/multihopper/server/api";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { enforceRateLimit } from "@/lib/multihopper/server/guards";
import { assertOwnedTransfer, authorizeTransferAccess, json, logRoutingEvent, parseTransferId, toErrorResponse, toPublicTransfer } from "@/lib/multihopper/server/http";

export const maxDuration = 30;

/**
 * Returns the unsigned (server partially signed) transaction bundle. Resumable: MultiHopper
 * returns null/empty groups for anything already confirmed onchain, so calling it again after a
 * partial broadcast never re-funds the keeper. Each call uses a fresh Idempotency-Key, as documented.
 */
export async function POST(request: Request, { params }: { params: Promise<{ transferId: string }> }): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "prepare");
    const transferId = parseTransferId((await params).transferId);
    const claims = await authorizeTransferAccess(request, config.tokenSecret, transferId);
    const prepared = await createMultiHopperClient(config).prepareTransfer(transferId, `qzs-prepare-${crypto.randomUUID()}`);
    assertOwnedTransfer(prepared.transfer, claims);
    const tx = prepared.preparedTxs;
    logRoutingEvent("info", "transfer_prepared", {
      transferId, keeperFunding: tx.keeperFundingTx != null, routeInit: tx.routeInitTxs.length, orchestratorInit: tx.orchestratorInitTx != null,
      sessionInit: tx.sessionInitTxs.length, dispersionInit: tx.dispersionInitTxs.length, nothingToDo: tx.nothingToDo,
    });
    return json({ transfer: prepared.transfer ? toPublicTransfer(prepared.transfer) : null, preparedTxs: tx });
  } catch (error) {
    return toErrorResponse(error, "prepare");
  }
}
