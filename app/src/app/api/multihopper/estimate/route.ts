import { createMultiHopperClient } from "@/lib/multihopper/server/api";
import { readMultiHopperConfig } from "@/lib/multihopper/server/config";
import { enforceRateLimit } from "@/lib/multihopper/server/guards";
import { RequestError, json, readJsonBody, toErrorResponse } from "@/lib/multihopper/server/http";
import { ROUTING_ERROR_CODES, SOL_DECIMALS, SOL_MINT, validateArrivalSeconds, validateHops, validateLamports } from "@/lib/multihopper/shared";

export const maxDuration = 30;

/** Quotes a SOL routing without creating anything (POST /transfers/estimate upstream). */
export async function POST(request: Request): Promise<Response> {
  try {
    const config = readMultiHopperConfig();
    enforceRateLimit(request, "estimate"); // anonymous: protects the shared MultiHopper key (audit M4)
    const body = await readJsonBody(request);
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    for (const result of [validateLamports(input.amountLamports), validateHops(input.hops), validateArrivalSeconds(input.arrivalSeconds)]) {
      if (!result.ok) throw new RequestError(400, ROUTING_ERROR_CODES.invalidRequest, result.message);
    }
    const estimate = await createMultiHopperClient(config).estimate({
      tokenMint: SOL_MINT,
      amountRaw: input.amountLamports as string,
      tokenDecimals: SOL_DECIMALS,
      hops: input.hops as number,
      arrivalSeconds: input.arrivalSeconds as number,
    });
    return json({ estimate });
  } catch (error) {
    return toErrorResponse(error, "estimate");
  }
}
