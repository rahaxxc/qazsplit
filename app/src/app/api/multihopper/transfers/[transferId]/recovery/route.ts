import { createMultiHopperClient } from "@/lib/multihopper/server/api";
import { decodeSignature } from "@/lib/multihopper/server/auth";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { enforceRateLimit } from "@/lib/multihopper/server/guards";
import {
  RequestError, assertOwnedTransfer, authorizeTransferAccess, json, logRoutingEvent, parseTransferId, readJsonBody, toErrorResponse, toPublicTransfer,
} from "@/lib/multihopper/server/http";
import { ROUTING_ERROR_CODES } from "@/lib/multihopper/shared";

export const maxDuration = 30;

const MAX_SIGNATURES = 32;

type RecoveryBody = { kind: "rescue" | "reclaim-rent"; step: "prepare" | "confirm"; signatures: string[] };

function parseBody(body: unknown): RecoveryBody {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const invalid = (message: string) => new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, message);
  if (!input) throw invalid("Request body must be a JSON object.");
  if (input.kind !== "rescue" && input.kind !== "reclaim-rent") throw invalid("kind must be rescue or reclaim-rent.");
  if (input.step !== "prepare" && input.step !== "confirm") throw invalid("step must be prepare or confirm.");
  if (input.step === "prepare") return { kind: input.kind, step: "prepare", signatures: [] };
  const signatures = input.signatures;
  if (!Array.isArray(signatures) || !signatures.length || signatures.length > MAX_SIGNATURES || signatures.some((item) => !decodeSignature(item))) {
    throw invalid("signatures must list 1 to 32 base58 transaction signatures.");
  }
  return { kind: input.kind, step: "confirm", signatures: signatures as string[] };
}

/**
 * Returns SOL locked in a stuck transfer's onchain accounts to the recipient's wallet (rescue), or
 * the step-account rent after it completed (reclaim-rent) (audit H3). Only offered when MultiHopper
 * reports `recovery.canRescue` / `canReclaimRent`. MultiHopper builds the transactions; the browser
 * checks and signs them, and this route never sees anything but public signatures.
 */
export async function POST(request: Request, { params }: { params: Promise<{ transferId: string }> }): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "recovery");
    const transferId = parseTransferId((await params).transferId);
    const claims = await authorizeTransferAccess(request, config.tokenSecret, transferId);
    const body = parseBody(await readJsonBody(request));
    const client = createMultiHopperClient(config);
    const current = await client.getTransfer(transferId);
    assertOwnedTransfer(current, claims);
    if (body.step === "prepare") {
      const available = body.kind === "rescue" ? current.recovery?.canRescue : current.recovery?.canReclaimRent;
      if (!available) {
        throw new RequestError(409, ROUTING_ERROR_CODES.recoveryNotAvailable,
          body.kind === "rescue" ? "MultiHopper reports nothing to rescue for this transfer." : "MultiHopper reports no rent to reclaim for this transfer.");
      }
      const prepared = await client.prepareRecovery(transferId, body.kind, `qzs-${body.kind}-prepare-${crypto.randomUUID()}`);
      logRoutingEvent("info", "recovery_prepared", { transferId, kind: body.kind, transactions: prepared.transactions.length });
      return json({ transfer: toPublicTransfer(current), recoveryTxs: prepared });
    }
    const confirmed = await client.confirmRecovery(transferId, body.kind, body.signatures, `qzs-${body.kind}-confirm-${crypto.randomUUID()}`);
    const transfer = confirmed.transfer ?? (await client.getTransfer(transferId));
    assertOwnedTransfer(transfer, claims);
    logRoutingEvent("info", "recovery_confirmed", { transferId, kind: body.kind, status: transfer.status });
    return json({ transfer: toPublicTransfer(transfer), confirmed: confirmed.confirmed });
  } catch (error) {
    return toErrorResponse(error, "recovery");
  }
}
