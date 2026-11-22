import { createMultiHopperClient, type MultiHopperTransfer } from "@/lib/multihopper/server/api";
import { checkApprovalFreshness, issueAccessToken, verifyRecoveryApproval } from "@/lib/multihopper/server/auth";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { assertSignedOrigin, enforceRateLimit } from "@/lib/multihopper/server/guards";
import { RequestError, json, logRoutingEvent, readJsonBody, toErrorResponse, toPublicTransfer } from "@/lib/multihopper/server/http";
import { EXTERNAL_ID_PREFIX, ROUTING_ERROR_CODES, validateRecoveryRequest } from "@/lib/multihopper/shared";

export const maxDuration = 60;

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const LOOKBACK_DAYS = 30;
const MAX_RESULTS = 20;

/**
 * Restores routing access on a new device or after site data was cleared (audit H3). The wallet
 * signs a recovery message (no funds, no transfer); the server then lists recent MultiHopper
 * transfers for this deployment's key and issues access tokens only for QazSplit transfers whose
 * sourceOwner is that wallet. Each token still only reads and drives its one transfer, and every
 * transaction still needs the wallet's own signature.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "recover");
    const body = await readJsonBody(request);
    const validated = validateRecoveryRequest(body);
    if (!validated.ok) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, validated.message);
    const recovery = validated.value;
    assertSignedOrigin(request, recovery.origin);
    const freshness = checkApprovalFreshness(recovery.issuedAt);
    if (freshness !== "fresh") {
      throw new RequestError(401, ROUTING_ERROR_CODES.approvalExpired, freshness === "expired"
        ? "This recovery approval has expired. Approve it again." : "This recovery approval is dated in the future. Check your device clock.");
    }
    if (!(await verifyRecoveryApproval(recovery, (body as { signature?: unknown }).signature))) {
      throw new RequestError(401, ROUTING_ERROR_CODES.invalidSignature, "The wallet signature does not match this recovery request.");
    }
    const client = createMultiHopperClient(config);
    const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    const found: MultiHopperTransfer[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, total } = await client.listTransfers({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, fromDate });
      found.push(...items.filter((transfer) => transfer.sourceOwner === recovery.wallet && !!transfer.externalId?.startsWith(EXTERNAL_ID_PREFIX)));
      if (items.length < PAGE_SIZE || (total != null && (page + 1) * PAGE_SIZE >= total)) break;
    }
    const routings = await Promise.all(found.slice(0, MAX_RESULTS).map(async (transfer) => ({
      transfer: toPublicTransfer(transfer),
      // The agreement and milestone are not stored with MultiHopper, so restored tokens carry none.
      accessToken: await issueAccessToken(config.tokenSecret, { transferId: transfer.id, wallet: recovery.wallet, agreement: "", milestoneIndex: -1 }),
    })));
    logRoutingEvent("info", "access_recovered", { count: routings.length });
    return json({ routings });
  } catch (error) {
    return toErrorResponse(error, "recover");
  }
}
